import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketServer } from 'ws';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

function normalizeWsBase(collabWsUrl: string): string {
  const raw = collabWsUrl.replace(/\?slug=.*$/, '');
  try {
    const url = new URL(raw);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
  }
}

type CreateResponse = { slug: string; ownerSecret: string };

type SuggestResponse = {
  marks?: Record<string, { kind?: string; content?: string }>;
};

type CollabSessionResponse = {
  success: boolean;
  session: {
    collabWsUrl: string;
    slug: string;
    token: string;
    role: string;
    accessEpoch: number;
  };
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `proof-marks-accept-live-viewer-stability-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_EDIT_COLLAB_STABILITY_MS = '500';
  process.env.AGENT_EDIT_COLLAB_STABILITY_SAMPLE_MS = '50';
  process.env.COLLAB_DEBUG_CANONICAL_STABILITY = '1';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  const createRes = await fetch(`${httpBase}/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Suggestion accept stability regression',
      markdown: 'Hello open source',
      marks: {},
    }),
  });
  const created = await mustJson<CreateResponse>(createRes, 'create');

  const suggestRes = await fetch(`${httpBase}/api/agent/${created.slug}/marks/suggest-replace`, {
    method: 'POST',
    headers: {
      ...CLIENT_HEADERS,
      'Content-Type': 'application/json',
      'x-share-token': created.ownerSecret,
    },
    body: JSON.stringify({
      quote: 'open source',
      content: 'OSS',
      by: 'ai:test',
    }),
  });
  assert(suggestRes.ok, `Expected suggestion ok, got HTTP ${suggestRes.status}`);
  const suggestPayload = await mustJson<SuggestResponse>(suggestRes, 'suggest');
  const suggestionId = Object.entries(suggestPayload.marks ?? {}).find(([, value]) => value?.kind === 'replace')?.[0] ?? '';
  assert(suggestionId.length > 0, 'Expected suggestion id');

  const collabSessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
    headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
  });
  const collabSession = await mustJson<CollabSessionResponse>(collabSessionRes, 'collab-session');
  assert(collabSession.success === true, 'Expected successful collab session');

  const collabClients: Array<{ ydoc: Y.Doc; provider: HocuspocusProvider }> = [];
  async function connectCollab(session: CollabSessionResponse['session'], label: string): Promise<{ ydoc: Y.Doc; provider: HocuspocusProvider }> {
    const ydoc = new Y.Doc();
    let connected = false;
    let synced = false;
    const provider = new HocuspocusProvider({
      url: normalizeWsBase(session.collabWsUrl),
      name: session.slug,
      document: ydoc,
      parameters: {
        token: session.token,
        role: session.role,
      },
      token: session.token,
      preserveConnection: false,
      broadcast: false,
    });
    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) synced = true;
    });
    const client = { ydoc, provider };
    collabClients.push(client);
    await waitFor(() => connected && synced, 10_000, `${label} provider connected+synced`);
    return client;
  }

  try {
    const liveViewer = await connectCollab(collabSession.session, 'live viewer');

    // Accept intentionally bumps the document access epoch and invalidates the
    // collab room, so the pre-accept provider never observes the accepted mark.
    // The contract under test: accept converges canonically, stale-epoch client
    // writes are dropped, and a fresh collab session rehydrates the finalized doc.
    const acceptRes = await fetch(`${httpBase}/api/agent/${created.slug}/marks/accept`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({ markId: suggestionId, by: 'human:editor' }),
    });
    const acceptPayload = await mustJson<{
      success?: boolean;
      collab?: { status?: string; markdownConfirmed?: boolean | null; fragmentConfirmed?: boolean | null; canonicalConfirmed?: boolean | null };
    }>(acceptRes, 'accept');
    assert(acceptPayload.success === true, 'Expected accept success');
    assert(
      acceptPayload.collab?.status === 'confirmed',
      `Expected collab status confirmed, got ${String(acceptPayload.collab?.status)}`,
    );
    assert(
      acceptPayload.collab?.canonicalConfirmed === true,
      `Expected canonicalConfirmed true, got ${String(acceptPayload.collab?.canonicalConfirmed)}`,
    );

    // A stale viewer echoing the old room state (mark deletion + pre-accept text)
    // must not clobber the accepted canonical content.
    liveViewer.ydoc.transact(() => {
      const staleText = liveViewer.ydoc.getText('markdown');
      if (staleText.length > 0) staleText.delete(0, staleText.length);
      staleText.insert(0, 'Hello open source');
      liveViewer.ydoc.getMap('marks').delete(suggestionId);
    }, 'test-stale-viewer-echo');
    await sleep(150);

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const state = await mustJson<{ markdown?: string; content?: string }>(stateRes, 'state');
    const markdown = typeof state.markdown === 'string' ? state.markdown : (state.content || '');
    assert(markdown.includes('OSS'), 'Expected accepted suggestion to persist in canonical markdown');

    const refreshedSessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const refreshedSession = await mustJson<CollabSessionResponse>(refreshedSessionRes, 'refreshed collab-session');
    assert(refreshedSession.success === true, 'Expected successful refreshed collab session');
    assert(
      refreshedSession.session.accessEpoch > collabSession.session.accessEpoch,
      `Expected accept to bump the access epoch, got ${refreshedSession.session.accessEpoch} (was ${collabSession.session.accessEpoch})`,
    );

    const rehydrated = await connectCollab(refreshedSession.session, 'rehydrated viewer');
    await waitFor(
      () => rehydrated.ydoc.getText('markdown').toString().includes('OSS'),
      5_000,
      'rehydrated collab doc reflects accepted content',
    );
    const rehydratedMark = rehydrated.ydoc.getMap('marks').get(suggestionId) as Record<string, unknown> | undefined;
    assert(
      rehydratedMark === undefined || rehydratedMark.status === 'accepted',
      `Expected rehydrated mark to be finalized, got ${JSON.stringify(rehydratedMark)}`,
    );

    console.log('✓ marks/accept invalidates the collab room and rehydrates the accepted document');
  } finally {
    for (const client of collabClients) {
      try {
        client.provider.disconnect();
        client.provider.destroy();
      } catch {
        // ignore
      }
      client.ydoc.destroy();
    }
    await collab.stopCollabRuntime();
    try {
      wss.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore
      }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
