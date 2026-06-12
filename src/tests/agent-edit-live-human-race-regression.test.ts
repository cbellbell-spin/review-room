import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type CreateResponse = { slug: string; ownerSecret: string };
type StateResponse = { updatedAt: string; content?: string; markdown?: string };
type EditResponse = {
  success?: boolean;
  code?: string;
  recommendedEndpoint?: string;
  collab?: {
    status?: string;
    markdownStatus?: string;
    fragmentStatus?: string;
  };
};
type SnapshotResponse = {
  revision: number | null;
  mutationBase?: { token?: string };
  blocks?: Array<{ ref?: string; markdown?: string }>;
};
type CollabSessionResponse = {
  success: boolean;
  session: {
    collabWsUrl: string;
    slug: string;
    token: string;
    role: string;
  };
};

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

function markdownIncludesToken(markdown: string, token: string): boolean {
  return markdown.includes(token) || markdown.includes(token.replace(/_/g, '\\_'));
}

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-human-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

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

  const ydoc = new Y.Doc();
  let provider: HocuspocusProvider | null = null;
  let connected = false;
  let synced = false;

  try {
    const parser = await getHeadlessMilkdownParser();
    const initialMarkdown = [
      '# Human + agent race',
      '',
      '## Headers Test',
      '',
      'base',
      '',
      '## Tail',
      '',
      'tail',
      '',
    ].join('\n');

    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Human + agent race regression',
        markdown: initialMarkdown,
        marks: {},
      }),
    });
    const created = await mustJson<CreateResponse>(createRes, 'create');

    const collabSessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const collabSession = await mustJson<CollabSessionResponse>(collabSessionRes, 'collab-session');
    assert(collabSession.success === true, 'Expected successful collab session');

    provider = new HocuspocusProvider({
      url: normalizeWsBase(collabSession.session.collabWsUrl),
      name: collabSession.session.slug,
      document: ydoc,
      parameters: {
        token: collabSession.session.token,
        role: collabSession.session.role,
      },
      token: collabSession.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) synced = true;
    });

    await waitFor(() => connected, 10_000, 'provider connected');
    await waitFor(() => synced, 10_000, 'provider synced');

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const state = await mustJson<StateResponse>(stateRes, 'state');

    const humanMarker = `HUMAN_${Date.now()}`;
    const agentMarker = `AGENT_${Date.now()}`;
    const humanMarkdown = `${initialMarkdown}\n${humanMarker}\n`;
    ydoc.transact(() => {
      const markdownText = ydoc.getText('markdown');
      if (markdownText.length > 0) markdownText.delete(0, markdownText.length);
      markdownText.insert(0, humanMarkdown);

      const fragment = ydoc.getXmlFragment('prosemirror');
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      prosemirrorToYXmlFragment(parser.parseMarkdown(humanMarkdown) as any, fragment as any);
    }, 'human-edit');

    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:r2c2',
        baseUpdatedAt: state.updatedAt,
        operations: [
          {
            op: 'append',
            section: 'Headers Test',
            content: `\n\n${agentMarker}`,
          },
        ],
      }),
    });
    assert(editRes.status === 409, `Expected legacy /edit status 409, got ${editRes.status}`);
    const edit = await editRes.json() as EditResponse;
    assert(edit.success === false, 'Expected legacy /edit to hard-fail with active live collab');
    assert(edit.code === 'LEGACY_EDIT_UNSAFE', `Expected LEGACY_EDIT_UNSAFE, got ${String(edit.code)}`);
    assert(
      edit.recommendedEndpoint === `/api/agent/${created.slug}/edit/v2`,
      `Expected /edit/v2 guidance, got ${String(edit.recommendedEndpoint)}`,
    );

    await waitForAsync(async () => {
      const latestRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: {
          ...CLIENT_HEADERS,
          'x-share-token': created.ownerSecret,
        },
      });
      const latest = await mustJson<StateResponse>(latestRes, 'latest-state-after-legacy-block');
      const content = typeof latest.content === 'string'
        ? latest.content
        : (typeof latest.markdown === 'string' ? latest.markdown : '');
      return markdownIncludesToken(content, humanMarker) && !markdownIncludesToken(content, agentMarker);
    }, 10_000, 'state contains only human marker after blocked legacy edit');

    const snapshotRes = await fetch(`${httpBase}/api/agent/${created.slug}/snapshot`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const snapshot = await mustJson<SnapshotResponse>(snapshotRes, 'snapshot');
    const baseBlockRef = snapshot.blocks?.find((block) => typeof block.markdown === 'string' && block.markdown.includes('base'))?.ref;
    assert(typeof baseBlockRef === 'string' && baseBlockRef.length > 0, 'Expected snapshot block ref for base paragraph');

    // With a live collab client attached the snapshot may report revision=null
    // (canonical read not mutation-ready) and supply mutationBase.token instead.
    const mutationBaseToken = typeof snapshot.mutationBase?.token === 'string' && snapshot.mutationBase.token.trim()
      ? snapshot.mutationBase.token.trim()
      : null;
    const editBase = mutationBaseToken
      ? { baseToken: mutationBaseToken }
      : { baseRevision: snapshot.revision };
    assert(
      mutationBaseToken !== null || (Number.isInteger(snapshot.revision) && (snapshot.revision as number) > 0),
      'Expected snapshot to provide a usable mutation base (mutationBase.token or revision)',
    );

    const editV2Res = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:r2c2',
        ...editBase,
        operations: [
          {
            op: 'insert_after',
            ref: baseBlockRef,
            blocks: [{ markdown: agentMarker }],
          },
        ],
      }),
    });
    const editV2 = await mustJson<EditResponse>(editV2Res, 'edit/v2');
    assert(editV2.success === true, 'Expected /edit/v2 success');
    assert(editV2.collab?.status === 'confirmed', `Expected confirmed collab status, got ${String(editV2.collab?.status)}`);

    let lastStateContent = '';
    try {
      await waitForAsync(async () => {
        const latestRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
          headers: {
            ...CLIENT_HEADERS,
            'x-share-token': created.ownerSecret,
          },
        });
        const latest = await mustJson<StateResponse>(latestRes, 'latest-state');
        lastStateContent = typeof latest.content === 'string'
          ? latest.content
          : (typeof latest.markdown === 'string' ? latest.markdown : '');
        return markdownIncludesToken(lastStateContent, humanMarker) && markdownIncludesToken(lastStateContent, agentMarker);
      }, 10_000, 'state contains human + agent markers');
    } catch (error) {
      throw new Error(`State did not converge to human+agent content. Last state: ${JSON.stringify(lastStateContent)}. ${(error as Error).message}`);
    }

    await waitFor(
      () => {
        const content = ydoc.getText('markdown').toString();
        return markdownIncludesToken(content, humanMarker) && markdownIncludesToken(content, agentMarker);
      },
      10_000,
      'ydoc contains human + agent markers',
    );

    console.log('✓ live human + agent race blocks legacy /edit and converges via /edit/v2');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
      try {
        (provider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
    ydoc.destroy();
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
        // ignore cleanup errors
      }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
