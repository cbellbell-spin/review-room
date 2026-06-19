import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { canonicalizeStoredMarks, type StoredMark } from '../formats/marks';

async function run(): Promise<void> {
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `agent-mounted-slug-${Date.now()}-${randomUUID()}.db`);
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const [{ agentRoutes }, db] = await Promise.all([
    import('../../server/agent-routes'),
    import('../../server/db'),
  ]);

  const slug = 'gf56n8eo';
  const ownerSecret = 'owner-secret';
  const markId = 'mounted-accept-suggestion';
  const createdAt = new Date('2026-06-16T16:00:00.000Z').toISOString();
  db.createDocument(
    slug,
    `<span data-proof="suggestion" data-id="${markId}" data-by="human:test" data-kind="replace">Old text</span>\n\nTail`,
    canonicalizeStoredMarks({
      [markId]: {
        kind: 'replace',
        by: 'human:test',
        createdAt,
        quote: 'Old text',
        content: 'New text',
        status: 'pending',
        startRel: 'char:0',
        endRel: 'char:8',
        range: { from: 1, to: 9 },
      } satisfies StoredMark,
    }),
    'Mounted slug accept regression',
    'owner',
    ownerSecret,
  );

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/agent/:slug', agentRoutes);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start test server');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${base}/api/agent/${slug}/marks/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-share-token': ownerSecret,
      },
      body: JSON.stringify({ markId, by: 'human:test' }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `Mounted slug accept should not return Invalid slug: HTTP ${response.status} ${text}`);
    const document = db.getDocumentBySlug(slug);
    assert(document?.markdown.includes('New text'), 'Expected mounted slug accept to apply replacement');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log('✓ mounted /api/agent/:slug marks/accept resolves slug and accepts');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
