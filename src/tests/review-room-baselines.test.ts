import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-baselines-${Date.now()}-${randomUUID()}.db`);
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = '';
  process.env.PROOF_TRUST_PROXY_HEADERS = '1';

  const { createReviewRoomExpressApp } = await import('../../server/index.js');
  const app = createReviewRoomExpressApp();
  const port = await getFreePort();
  const server = app.listen(port, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  try {
    const created = await json<{
      success: boolean;
      document: { proofSlug: string; baselinePath?: string; historyPath?: string };
    }>(await fetch(`${base}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Baseline test',
        markdown: '# Baseline test\n\nDraft paragraph.',
      }),
    }));
    assert(created.success === true, 'Expected document creation success');
    const slug = created.document.proofSlug;

    const empty = await json<{
      success: boolean;
      latest: null;
      baselines: unknown[];
    }>(await fetch(`${base}/review-room/api/documents/${slug}/baselines`));
    assert(empty.success === true, 'Expected empty baseline list success');
    assert(empty.latest === null, 'Expected no latest baseline before publish');
    assert(empty.baselines.length === 0, 'Expected no baseline rows before publish');

    const first = await json<{
      success: boolean;
      baseline: {
        id: string;
        versionNumber: number;
        proofRevision: number | null;
        contentLength: number;
        note: string | null;
        createdAt: string;
      };
    }>(await fetch(`${base}/review-room/api/documents/${slug}/baselines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Ready for first review' }),
    }));
    assert(first.success === true, 'Expected first baseline creation success');
    assert(first.baseline.versionNumber === 1, 'Expected first baseline version number');
    assert(first.baseline.note === 'Ready for first review', 'Expected baseline note to persist');
    assert(first.baseline.contentLength > 0, 'Expected baseline to report snapshot length');

    await sleep(5);

    const second = await json<{
      success: boolean;
      baseline: { id: string; versionNumber: number; createdAt: string };
    }>(await fetch(`${base}/review-room/api/documents/${slug}/baselines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Second checkpoint' }),
    }));
    assert(second.success === true, 'Expected second baseline creation success');
    assert(second.baseline.versionNumber === 2, 'Expected second baseline version number');

    const listed = await json<{
      success: boolean;
      latest: { id: string; versionNumber: number } | null;
      baselines: Array<{ id: string; versionNumber: number; contentLength: number }>;
    }>(await fetch(`${base}/review-room/api/documents/${slug}/baselines`));
    assert(listed.success === true, 'Expected baseline list success');
    assert(listed.latest?.id === second.baseline.id, 'Expected latest baseline to be the newest version');
    assert(
      listed.baselines.map((baseline) => baseline.versionNumber).join(',') === '2,1',
      `Expected newest-first baseline order, got ${listed.baselines.map((baseline) => baseline.versionNumber).join(',')}`,
    );
    assert(listed.baselines.every((baseline) => baseline.contentLength > 0), 'Expected list rows to include compact snapshot lengths');

    const history = await json<{
      success: boolean;
      events: Array<{
        eventType?: string;
        targetType?: string;
        targetId?: string;
        before?: { versionNumber?: number };
        after?: { versionNumber?: number; note?: string };
      }>;
    }>(await fetch(`${base}/review-room/api/documents/${slug}/history?limit=20`));
    assert(history.success === true, 'Expected history success');
    assert(
      history.events.some((event) => (
        event.eventType === 'baseline.created'
        && event.targetType === 'published_version'
        && event.targetId === second.baseline.id
        && event.before?.versionNumber === 1
        && event.after?.versionNumber === 2
      )),
      'Expected second baseline history event to reference previous baseline',
    );

    const sinceFirst = await json<{ success: boolean; events: Array<{ eventType?: string; targetId?: string }> }>(
      await fetch(`${base}/review-room/api/documents/${slug}/history?limit=20&since=${encodeURIComponent(first.baseline.createdAt)}`),
    );
    assert(sinceFirst.success === true, 'Expected since-filtered history success');
    assert(
      sinceFirst.events.some((event) => event.eventType === 'baseline.created' && event.targetId === second.baseline.id),
      'Expected history since the first baseline to include the second baseline event',
    );

    console.log('✓ Review Room publish baselines');
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
