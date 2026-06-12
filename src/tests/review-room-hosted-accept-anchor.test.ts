import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

import { applyProofSuggestionByProofSpanId } from '../../server/proof-span-strip.js';

function assert(condition: boolean, message: string): void {
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
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Unit coverage for the span-identity resolver (the production failure shape:
// a delete suggestion whose run is split across two spans and contains inline
// markdown that a raw quote substring match cannot survive).
// ---------------------------------------------------------------------------
function unitTests(): void {
  const markId = 'm-split-delete';
  const splitDelete = [
    '# Guide',
    '',
    `<span data-proof="suggestion" data-id="${markId}" data-by="human:CB" data-kind="delete">A document opens in Review Room mode when the URL includes</span> <span data-proof="suggestion" data-id="${markId}" data-by="human:CB" data-kind="delete">\`rr=1\`.</span> On the current Vercel preview, realtime sync may be unavailable.`,
    '',
  ].join('\n');

  const deleted = applyProofSuggestionByProofSpanId(splitDelete, markId, 'delete', '');
  assert(deleted.matched, 'split delete should resolve by span id');
  assert(!deleted.markdown.includes('data-proof'), 'result must be free of proof spans');
  assert(!deleted.markdown.includes('A document opens'), 'deleted sentence head must be gone');
  assert(!deleted.markdown.includes('rr=1'), 'deleted sentence tail must be gone');
  assert(deleted.markdown.includes('On the current Vercel preview'), 'surrounding text must remain');

  const replaceId = 'm-replace';
  const replaceDoc = `Intro.\n\n<span data-proof="suggestion" data-id="${replaceId}" data-kind="replace">old text</span>\n\nTail.`;
  const replaced = applyProofSuggestionByProofSpanId(replaceDoc, replaceId, 'replace', 'new text');
  assert(replaced.matched && replaced.markdown.includes('new text') && !replaced.markdown.includes('old text'), 'replace should swap span content');
  assert((replaced.markdown.match(/new text/g) ?? []).length === 1, 'replace must not duplicate content across split handling');

  const insertId = 'm-insert';
  const insertDoc = `<span data-proof="suggestion" data-id="${insertId}" data-kind="insert">Anchor.</span>`;
  const inserted = applyProofSuggestionByProofSpanId(insertDoc, insertId, 'insert', ' Added.');
  assert(inserted.matched && inserted.markdown === 'Anchor. Added.', `insert should append after anchor, got ${JSON.stringify(inserted.markdown)}`);

  const noSpan = applyProofSuggestionByProofSpanId('Just clean text.', 'missing', 'delete', '');
  assert(!noSpan.matched && noSpan.markdown === 'Just clean text.', 'missing span id must report unmatched with stripped markdown');

  console.log('  unit: span-identity resolver handles split/markdown/replace/insert');
}

async function integrationTests(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `rr-hosted-accept-${Date.now()}-${randomUUID()}.db`);
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = '';
  process.env.PROOF_TRUST_PROXY_HEADERS = '1';

  const { createReviewRoomExpressApp } = await import('../../server/index.js');
  const app = createReviewRoomExpressApp();
  const port = await getFreePort();
  const server = app.listen(port, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const db = createClient({ url: `file:${dbPath}` });

  try {
    const created = await json<{ proof: { slug: string; accessToken: string } }>(
      await fetch(`${base}/review-room/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hosted accept anchor', markdown: '# Guide\n\nPlaceholder.' }),
      }),
    );
    const { slug, accessToken } = created.proof;
    const authHeaders = {
      'Content-Type': 'application/json',
      'x-share-token': accessToken,
      'X-Proof-Client-Version': '0.31.0',
      'X-Proof-Client-Build': 'test',
      'X-Proof-Client-Protocol': '3',
    };

    // --- Regression: accept an already-polluted document --------------------
    // Reproduce the production row shape: the canonical markdown carries the
    // suggestion's own spans (split across an inline-code boundary) and the
    // stored quote is rendered text without the backticks. Seed it directly so
    // we exercise the legacy polluted state the write chokepoint now prevents.
    const markId = 'm1781237801687_5';
    const pollutedMarkdown = [
      '# Guide',
      '',
      `<span data-proof="suggestion" data-id="${markId}" data-by="human:CB" data-kind="delete">A document opens in Review Room mode when the URL includes</span> <span data-proof="suggestion" data-id="${markId}" data-by="human:CB" data-kind="delete">\`rr=1\`.</span> On the current Vercel preview, realtime sync may be unavailable.`,
      '',
    ].join('\n');
    const marksJson = JSON.stringify({
      [markId]: {
        kind: 'delete',
        suggestionKind: 'delete',
        by: 'human:CB',
        createdAt: new Date().toISOString(),
        status: 'pending',
        quote: 'A document opens in Review Room mode when the URL includes rr=1.',
      },
    });
    await db.execute({
      sql: 'UPDATE documents SET markdown = ?, marks = ? WHERE slug = ?',
      args: [pollutedMarkdown, marksJson, slug],
    });

    const acceptResponse = await fetch(`${base}/api/agent/${slug}/marks/accept`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ markId, by: 'human:tester' }),
    });
    const acceptBody = await acceptResponse.text();
    assert(
      acceptResponse.status === 200,
      `Accept on a polluted hosted doc must succeed, got ${acceptResponse.status}: ${acceptBody.slice(0, 300)}`,
    );

    const state = await json<{ markdown: string; content?: string }>(
      await fetch(`${base}/api/agent/${slug}/state`, { headers: authHeaders }),
    );
    assert(!state.markdown.includes('data-proof'), 'accepted document must be free of proof spans');
    assert(!state.markdown.includes('A document opens'), 'accepted delete must remove the target sentence');
    assert(!state.markdown.includes('rr=1'), 'accepted delete must remove the inline-code tail');
    assert(state.markdown.includes('On the current Vercel preview'), 'surrounding content must survive accept');

    // --- Root fix: the write chokepoint strips proof spans on save ----------
    const commentSpanMarkdown = '# Guide\n\n<span data-proof="comment" data-id="c1" data-by="human:CB">Reviewed paragraph.</span>\n';
    const saveResponse = await fetch(`${base}/api/documents/${slug}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ markdown: commentSpanMarkdown, actor: 'human:tester' }),
    });
    assert(saveResponse.ok, `Document save must succeed, got ${saveResponse.status}`);
    const afterSave = await json<{ markdown: string }>(
      await fetch(`${base}/api/agent/${slug}/state`, { headers: authHeaders }),
    );
    assert(!afterSave.markdown.includes('data-proof'), 'saved canonical markdown must not retain proof spans');
    assert(afterSave.markdown.includes('Reviewed paragraph.'), 'saved markdown must keep the inner text');

    console.log('  integration: polluted-doc accept succeeds and save de-pollutes canonical markdown');
  } finally {
    db.close();
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

async function run(): Promise<void> {
  unitTests();
  await integrationTests();
  console.log('✓ Review Room hosted accept anchor resolution passed');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
