import { readFileSync } from 'node:fs';

type JsonRow = Record<string, unknown>;

type ExportBundle = {
  schemaVersion: 1;
  tables: Record<string, JsonRow[]>;
};

function parseArgs(argv: string[]): { input: string; database: string } {
  const args = [...argv];
  const result = {
    input: '',
    database: process.env.DATABASE_PATH || '',
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--in') {
      result.input = requireValue(args, '--in');
      continue;
    }
    if (arg === '--database') {
      result.database = requireValue(args, '--database');
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error('Missing --in <path>');
  if (!result.database) throw new Error('Missing --database <path> or DATABASE_PATH');
  return result;
}

function requireValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Verify that a Vercel/Turso Review Room export exists in a Fly SQLite database.

Usage:
  DATABASE_PATH=/data/proof-share.db npm run migrate:review-room:verify -- --in /data/review-room-export.json
`);
}

function stringValue(row: JsonRow, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function loadBundle(inputPath: string): ExportBundle {
  const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as ExportBundle;
  if (parsed.schemaVersion !== 1 || !parsed.tables || typeof parsed.tables !== 'object') {
    throw new Error('Unsupported or invalid Review Room migration export bundle.');
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bundle = loadBundle(args.input);
  process.env.DATABASE_PATH = args.database;
  const { getDb } = await import('../server/db.ts');
  const db = getDb();

  const sourceDocs = Array.isArray(bundle.tables.documents) ? bundle.tables.documents : [];
  const problems: string[] = [];
  for (const sourceDoc of sourceDocs) {
    const slug = stringValue(sourceDoc, 'slug');
    if (!slug) continue;
    const targetDoc = db.prepare(`
      SELECT slug, doc_id, title, markdown, revision, owner_secret, owner_secret_hash
      FROM documents
      WHERE slug = ?
      LIMIT 1
    `).get(slug) as JsonRow | undefined;
    if (!targetDoc) {
      problems.push(`${slug}: missing target document`);
      continue;
    }
    if (targetDoc.owner_secret || targetDoc.owner_secret_hash) {
      problems.push(`${slug}: legacy owner secret was imported`);
    }
    if (stringValue(targetDoc, 'markdown') !== stringValue(sourceDoc, 'markdown')) {
      problems.push(`${slug}: markdown mismatch`);
    }
    const tokenCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM document_access
      WHERE document_slug = ? AND revoked_at IS NULL
    `).get(slug) as { count: number };
    if (tokenCount.count < 1) {
      problems.push(`${slug}: no active fresh access token`);
    }
    const projection = db.prepare(`
      SELECT y_state_version, health
      FROM document_projections
      WHERE document_slug = ?
      LIMIT 1
    `).get(slug) as { y_state_version: number; health: string } | undefined;
    if (!projection) {
      problems.push(`${slug}: missing projection`);
    } else if (projection.y_state_version !== 0) {
      problems.push(`${slug}: expected imported projection y_state_version=0`);
    }
  }

  if (problems.length > 0) {
    console.error(`[verify] Found ${problems.length} issue(s):`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(`[verify] OK: ${sourceDocs.length} document(s) match the export and have fresh active tokens.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
