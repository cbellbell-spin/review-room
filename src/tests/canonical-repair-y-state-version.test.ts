import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `proof-canonical-repair-y-state-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = dbPath;

  const [db, canonical] = await Promise.all([
    import('../../server/db.js'),
    import('../../server/canonical-document.js'),
  ]);

  try {
    const slug = `repair-y-state-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug, '# Repair version\n\nStale row.', {}, 'Repair version');

    const parser = await getHeadlessMilkdownParser();
    const canonicalMarkdown = '# Repair version\n\nRecovered from authoritative Yjs.';
    const ydoc = new Y.Doc();
    ydoc.getText('markdown').insert(0, canonicalMarkdown);
    prosemirrorToYXmlFragment(parser.parseMarkdown(canonicalMarkdown) as any, ydoc.getXmlFragment('prosemirror') as any);

    db.saveYSnapshot(slug, 1, Y.encodeStateAsUpdate(ydoc));
    db.replaceDocumentProjection(slug, '# Repair version\n\nStale projection.', {}, 1);
    db.getDb().prepare(`
      UPDATE documents
      SET y_state_version = 2
      WHERE slug = ?
    `).run(slug);

    assert(db.getLatestYStateVersion(slug) === 1, 'Expected latest persisted Yjs state to remain at version 1');
    assert(db.getDocumentBySlug(slug)?.y_state_version === 2, 'Expected canonical row to be ahead at y_state_version=2');
    assert(db.getDocumentProjectionBySlug(slug)?.y_state_version === 1, 'Expected projection to be stale at y_state_version=1');

    const repaired = await canonical.repairCanonicalProjection(slug, {
      enforceProjectionGuard: true,
      allowAuthoritativeGrowth: true,
    });
    assert(repaired.ok === true, `Expected repair success, got ${repaired.ok === false ? repaired.code : 'ok'}`);
    assert(repaired.yStateVersion === 2, `Expected repair yStateVersion=2, got ${String(repaired.yStateVersion)}`);
    assert(db.getDocumentBySlug(slug)?.y_state_version === 2, 'Expected repair not to lower the canonical row y_state_version');
    assert(db.getDocumentProjectionBySlug(slug)?.y_state_version === 2, 'Expected projection y_state_version to match the canonical row');
    assert(
      db.getDocumentProjectionBySlug(slug)?.markdown.includes('Recovered from authoritative Yjs.') === true,
      'Expected projection content to be rebuilt from authoritative Yjs',
    );

    console.log('✓ canonical repair preserves document y_state_version while syncing stale projections');
  } finally {
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
