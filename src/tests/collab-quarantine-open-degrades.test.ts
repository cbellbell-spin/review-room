import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `proof-collab-quarantine-open-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousProofEnv = process.env.PROOF_ENV;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDbEnvInit = process.env.PROOF_DB_ENV_INIT;
  const previousEmbeddedWs = process.env.COLLAB_EMBEDDED_WS;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  process.env.COLLAB_EMBEDDED_WS = '1';
  delete process.env.PROOF_DB_ENV_INIT;

  const [{ apiRoutes }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/collab.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  try {
    await collab.startCollabRuntimeEmbedded(address.port);

    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'quarantined collab open',
        markdown: '# Quarantined open\n\nThe document should still open without live collaboration.',
        marks: {},
      }),
    });
    const created = await mustJson<{ slug: string; ownerSecret: string }>(createRes, 'create');

    collab.__unsafeSetAutoCollabQuarantineForTests(created.slug, {
      reason: 'projection_guard_pathological_repeat',
      durationMs: 45_000,
    });

    const authHeaders = {
      ...CLIENT_HEADERS,
      'x-share-token': created.ownerSecret,
    };

    const openContextRes = await fetch(`${httpBase}/api/documents/${created.slug}/open-context`, {
      headers: authHeaders,
    });
    const openContext = await mustJson<{
      success?: boolean;
      collabAvailable?: boolean;
      code?: string;
      retryAfterMs?: number | null;
      doc?: { markdown?: string };
      capabilities?: { canRead?: boolean; canEdit?: boolean };
    }>(openContextRes, 'open-context');
    assert(openContextRes.status === 200, `Expected open-context status 200, got ${openContextRes.status}`);
    assert(openContext.success === true, 'Expected open-context success=true');
    assert(openContext.collabAvailable === false, 'Expected open-context to disable live collab');
    assert(openContext.code === 'COLLAB_AUTO_QUARANTINED', `Expected COLLAB_AUTO_QUARANTINED, got ${String(openContext.code)}`);
    assert((openContext.retryAfterMs ?? 0) > 0, 'Expected open-context retryAfterMs');
    assert(openContext.doc?.markdown?.includes('The document should still open'), 'Expected open-context document body');
    assert(openContext.capabilities?.canRead === true, 'Expected open-context read capability');

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: authHeaders,
    });
    const sessionPayload = await mustJson<{
      success?: boolean;
      collabAvailable?: boolean;
      code?: string;
      retryAfterMs?: number | null;
      capabilities?: { canRead?: boolean; canEdit?: boolean };
    }>(sessionRes, 'collab-session');
    assert(sessionRes.status === 200, `Expected collab-session status 200, got ${sessionRes.status}`);
    assert(sessionPayload.success === true, 'Expected collab-session success=true');
    assert(sessionPayload.collabAvailable === false, 'Expected collab-session to disable live collab');
    assert(sessionPayload.code === 'COLLAB_AUTO_QUARANTINED', `Expected COLLAB_AUTO_QUARANTINED, got ${String(sessionPayload.code)}`);
    assert((sessionPayload.retryAfterMs ?? 0) > 0, 'Expected collab-session retryAfterMs');
    assert(sessionPayload.capabilities?.canRead === true, 'Expected collab-session read capability');

    const refreshRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-refresh`, {
      method: 'POST',
      headers: authHeaders,
    });
    const refreshPayload = await refreshRes.json() as {
      error?: string;
      collabAvailable?: boolean;
      code?: string;
      retryAfterMs?: number | null;
    };
    assert(refreshRes.status === 503, `Expected collab-refresh status 503, got ${refreshRes.status}`);
    assert(refreshPayload.collabAvailable === false, 'Expected collab-refresh to report live collab unavailable');
    assert(refreshPayload.code === 'COLLAB_AUTO_QUARANTINED', `Expected refresh COLLAB_AUTO_QUARANTINED, got ${String(refreshPayload.code)}`);
    assert((refreshPayload.retryAfterMs ?? 0) > 0, 'Expected collab-refresh retryAfterMs');

    console.log('✓ quarantined live-collab documents open through degraded collab payloads');
  } finally {
    collab.__unsafeClearAutoCollabQuarantineForTests();
    await collab.stopCollabRuntime();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = previousProofEnv;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = previousDbEnvInit;
    if (previousEmbeddedWs === undefined) delete process.env.COLLAB_EMBEDDED_WS;
    else process.env.COLLAB_EMBEDDED_WS = previousEmbeddedWs;

    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
