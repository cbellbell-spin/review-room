import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function postJson(base: string, requestPath: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${requestPath}`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-audit-inbox-${Date.now()}-${randomUUID()}.db`);
  process.env.DATABASE_PATH = dbPath;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.PROOF_TRUST_PROXY_HEADERS = '1';

  const { createReviewRoomExpressApp } = await import('../../server/index.js');
  const app = createReviewRoomExpressApp();
  const port = await getFreePort();
  const server = app.listen(port, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  try {
    const created = await readJson<{
      success: boolean;
      document: { proofSlug: string };
      proof: { accessToken: string };
    }>(await postJson(base, '/review-room/api/documents', {
      title: 'Audit inbox',
      markdown: '# Audit inbox\n\nOriginal paragraph.',
    }));
    assert(created.success === true, 'Expected Review Room document creation success');
    const slug = created.document.proofSlug;

    const directUpdate = await fetch(`${base}/api/documents/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.proof.accessToken,
      },
      body: JSON.stringify({
        markdown: '# Audit inbox\n\nDirectly changed paragraph.',
        actor: 'human:direct-editor',
      }),
    });
    assert(directUpdate.status === 200, `Expected direct document update to succeed, got ${directUpdate.status}`);

    const history = await readJson<{
      success: boolean;
      events: Array<{
        id: string;
        actorId: string;
        actorType: string;
        eventType: string;
        targetType?: string | null;
        targetId?: string | null;
        before?: Record<string, unknown> | null;
        after?: Record<string, unknown> | null;
        metadata?: Record<string, unknown> | null;
      }>;
    }>(await fetch(`${base}/review-room/api/documents/${encodeURIComponent(slug)}/history?limit=20`, { headers: CLIENT_HEADERS }));
    assert(history.success === true, 'Expected Review Room history success');
    const audit = history.events.find((event) => event.eventType === 'document.direct_mutation');
    assert(audit, 'Expected direct update to create a Review Room audit event');
    assert(audit.actorId === 'human:direct-editor', 'Expected audit event to retain the mutation actor');
    assert(audit.actorType === 'human', 'Expected direct human actor type');
    assert(audit.metadata?.route === 'PUT /api/documents/:slug', 'Expected audit event to name the direct route');
    assert(Array.isArray(audit.after?.changedFields), 'Expected audit event to list changed fields');
    assert((audit.after?.changedFields as unknown[]).includes('markdown'), 'Expected markdown to be listed as changed');
    assert(typeof audit.before?.markdownHash === 'string', 'Expected before markdown hash');
    assert(typeof audit.after?.markdownHash === 'string', 'Expected after markdown hash');

    const reviewed = await readJson<{
      success: boolean;
      alreadyReviewed: boolean;
      event: { eventType: string; targetId: string };
    }>(await postJson(base, `/review-room/api/documents/${encodeURIComponent(slug)}/audit/${encodeURIComponent(audit.id)}/reviewed`, {}));
    assert(reviewed.success === true, 'Expected audit review success');
    assert(reviewed.alreadyReviewed === false, 'Expected first audit review not to be idempotent');
    assert(reviewed.event.eventType === 'audit.reviewed', 'Expected audit.reviewed history event');
    assert(reviewed.event.targetId === audit.id, 'Expected audit.reviewed to target the direct mutation');

    const reviewedAgain = await readJson<{ success: boolean; alreadyReviewed: boolean }>(
      await postJson(base, `/review-room/api/documents/${encodeURIComponent(slug)}/audit/${encodeURIComponent(audit.id)}/reviewed`, {}),
    );
    assert(reviewedAgain.success === true, 'Expected idempotent audit review success');
    assert(reviewedAgain.alreadyReviewed === true, 'Expected duplicate audit review to report alreadyReviewed');

    console.log('✓ Review Room direct-change Audit Inbox trail');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
