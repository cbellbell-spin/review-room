import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type JsonRow = Record<string, unknown>;
type ShareRole = 'viewer' | 'commenter' | 'editor' | 'owner_bot';
type ReviewRoomRole = 'owner' | 'editor' | 'commenter' | 'viewer';

type ExportBundle = {
  schemaVersion: 1;
  generatedAt: string;
  tables: Record<string, JsonRow[]>;
};

type ImportTokenManifest = {
  generatedAt: string;
  baseUrl: string;
  importedFrom: {
    exportGeneratedAt: string;
  };
  documents: Array<{
    slug: string;
    title: string | null;
    docId: string | null;
    reviewRoomDocumentId: string | null;
    tokens: Array<{
      identityId: string;
      role: ReviewRoomRole | 'owner';
      shareRole: ShareRole;
      tokenId: string;
      token: string;
      url: string;
    }>;
  }>;
};

const DOCUMENT_TABLES = [
  'documents',
  'document_projections',
  'events',
  'document_events',
] as const;

const REVIEW_ROOM_TABLES = [
  'review_room_workspaces',
  'review_room_identities',
  'review_room_documents',
  'review_room_document_members',
  'review_room_agents',
  'review_room_document_agent_settings',
  'review_room_assignment_tasks',
  'review_room_published_versions',
  'review_room_history_events',
] as const;

function parseArgs(argv: string[]): {
  input: string;
  database: string;
  tokenOut: string;
  baseUrl: string;
  apply: boolean;
  skipExisting: boolean;
} {
  const args = [...argv];
  const result = {
    input: '',
    database: process.env.DATABASE_PATH || '',
    tokenOut: '',
    baseUrl: process.env.PROOF_PUBLIC_BASE_URL || 'https://review-room.chrisjbell.dev',
    apply: false,
    skipExisting: false,
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
    if (arg === '--token-out') {
      result.tokenOut = requireValue(args, '--token-out');
      continue;
    }
    if (arg === '--base-url') {
      result.baseUrl = requireValue(args, '--base-url').replace(/\/+$/, '');
      continue;
    }
    if (arg === '--apply') {
      result.apply = true;
      continue;
    }
    if (arg === '--skip-existing') {
      result.skipExisting = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!result.input) throw new Error('Missing --in <path>');
  if (!result.database) throw new Error('Missing --database <path> or DATABASE_PATH');
  if (result.apply && !result.tokenOut) {
    throw new Error('Missing --token-out <path>. Fresh tokens can only be viewed at import time.');
  }
  return result;
}

function requireValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Import a Vercel/Turso Review Room export into the Fly SQLite database.

Usage:
  DATABASE_PATH=/data/proof-share.db npm run migrate:review-room:import -- \\
    --in /data/review-room-export.json \\
    --token-out /data/review-room-fly-tokens.json \\
    --apply

Options:
  --in <path>          Required export JSON from review-room-export-vercel.ts.
  --database <path>    Target SQLite DB. Defaults to DATABASE_PATH.
  --token-out <path>   Required with --apply. Receives newly minted Fly URLs/tokens.
  --base-url <url>     URL used in token manifest. Defaults to PROOF_PUBLIC_BASE_URL or Fly production.
  --apply              Write changes. Without this flag the script performs a dry run.
  --skip-existing      Skip source documents whose slug already exists in the target DB.

Security:
  Legacy Vercel tokens are not imported. The importer mints fresh document_access rows.
`);
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tableRows(bundle: ExportBundle, table: string): JsonRow[] {
  const rows = bundle.tables?.[table];
  return Array.isArray(rows) ? rows : [];
}

function stringValue(row: JsonRow, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string' ? value : fallback;
}

function nullableString(row: JsonRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function intValue(row: JsonRow, key: string, fallback = 0): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function roleToShareRole(role: unknown): ShareRole {
  if (role === 'owner') return 'owner_bot';
  if (role === 'editor' || role === 'commenter' || role === 'viewer') return role;
  return 'viewer';
}

function normalizeReviewRoomRole(role: unknown): ReviewRoomRole {
  if (role === 'owner' || role === 'editor' || role === 'commenter' || role === 'viewer') return role;
  return 'viewer';
}

function plainText(markdown: string): string {
  return markdown
    .replace(/<\/?(?:p|br|div|li|ul|ol|blockquote|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function insertRow(
  db: import('better-sqlite3').Database,
  table: string,
  row: JsonRow,
  options: { orIgnore?: boolean } = {},
): void {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const columns = entries.map(([key]) => key);
  const sql = `INSERT ${options.orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})`;
  db.prepare(sql).run(...entries.map(([, value]) => value ?? null));
}

function insertDocumentEvent(
  db: import('better-sqlite3').Database,
  row: JsonRow,
): number {
  const result = db.prepare(`
    INSERT INTO document_events (
      document_slug, document_revision, event_type, event_data, actor, idempotency_key,
      mutation_route, tombstone_revision, created_at, acked_by, acked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stringValue(row, 'document_slug'),
    row.document_revision ?? null,
    stringValue(row, 'event_type', 'unknown'),
    stringValue(row, 'event_data', '{}'),
    stringValue(row, 'actor', 'system:migration'),
    row.idempotency_key ?? null,
    row.mutation_route ?? null,
    row.tombstone_revision ?? null,
    stringValue(row, 'created_at', nowIso()),
    row.acked_by ?? null,
    row.acked_at ?? null,
  );
  return Number(result.lastInsertRowid);
}

function createAccessToken(
  db: import('better-sqlite3').Database,
  slug: string,
  role: ShareRole,
  createdAt: string,
): { tokenId: string; token: string } {
  const tokenId = randomUUID();
  const token = randomUUID();
  db.prepare(`
    INSERT INTO document_access (token_id, document_slug, role, secret_hash, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(tokenId, slug, role, hashSecret(token), createdAt);
  return { tokenId, token };
}

function buildUrl(baseUrl: string, slug: string, token: string): string {
  const url = new URL(`/d/${encodeURIComponent(slug)}`, baseUrl);
  url.searchParams.set('rr', '1');
  url.searchParams.set('token', token);
  return url.toString();
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
  process.env.PROOF_PUBLIC_BASE_URL = args.baseUrl;

  const { getDb } = await import('../server/db.ts');
  const db = getDb();

  const docs = tableRows(bundle, 'documents');
  const slugs = docs.map((row) => stringValue(row, 'slug')).filter(Boolean);
  const existing = db.prepare(`SELECT slug FROM documents WHERE slug IN (${slugs.map(() => '?').join(', ') || "''"})`)
    .all(...slugs) as Array<{ slug: string }>;
  const existingSlugs = new Set(existing.map((row) => row.slug));
  const importDocs = args.skipExisting ? docs.filter((row) => !existingSlugs.has(stringValue(row, 'slug'))) : docs;

  if (existingSlugs.size > 0 && !args.skipExisting) {
    throw new Error(`Target DB already contains ${existingSlugs.size} slug(s): ${Array.from(existingSlugs).join(', ')}. Use --skip-existing or choose a clean target.`);
  }

  const dryRunSummary = {
    documents: importDocs.length,
    skippedExisting: docs.length - importDocs.length,
    reviewRoomDocuments: tableRows(bundle, 'review_room_documents')
      .filter((row) => importDocs.some((doc) => stringValue(doc, 'slug') === stringValue(row, 'proof_slug'))).length,
  };

  if (!args.apply) {
    console.log(`[import:dry-run] Would import ${dryRunSummary.documents} document(s), ${dryRunSummary.reviewRoomDocuments} Review Room record(s), and skip ${dryRunSummary.skippedExisting} existing document(s).`);
    console.log('[import:dry-run] Re-run with --apply and --token-out <path> to write the Fly database and fresh token manifest.');
    return;
  }

  const importedSlugSet = new Set(importDocs.map((row) => stringValue(row, 'slug')));
  const reviewRoomDocs = tableRows(bundle, 'review_room_documents')
    .filter((row) => importedSlugSet.has(stringValue(row, 'proof_slug')));
  const reviewRoomDocIds = new Set(reviewRoomDocs.map((row) => stringValue(row, 'id')));
  const memberRows = tableRows(bundle, 'review_room_document_members')
    .filter((row) => reviewRoomDocIds.has(stringValue(row, 'review_room_document_id')));
  const eventIdMap = new Map<string, number>();
  const tokenManifest: ImportTokenManifest = {
    generatedAt: nowIso(),
    baseUrl: args.baseUrl,
    importedFrom: { exportGeneratedAt: bundle.generatedAt },
    documents: [],
  };

  const tx = db.transaction(() => {
    for (const row of tableRows(bundle, 'review_room_workspaces')) insertRow(db, 'review_room_workspaces', row, { orIgnore: true });
    for (const row of tableRows(bundle, 'review_room_identities')) insertRow(db, 'review_room_identities', row, { orIgnore: true });
    for (const row of tableRows(bundle, 'review_room_agents')) insertRow(db, 'review_room_agents', row, { orIgnore: true });

    for (const row of importDocs) {
      const slug = stringValue(row, 'slug');
      const markdown = stringValue(row, 'markdown');
      const marks = stringValue(row, 'marks', '{}');
      const revision = Math.max(1, intValue(row, 'revision', 1));
      const accessEpoch = Math.max(1, intValue(row, 'access_epoch', 0) + 1);
      db.prepare(`
        INSERT INTO documents (
          slug, doc_id, title, markdown, marks, revision, y_state_version, share_state, access_epoch,
          collab_bootstrap_epoch, live_collab_seen_at, live_collab_access_epoch, active,
          owner_id, owner_secret, owner_secret_hash, created_at, updated_at, deleted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?)
      `).run(
        slug,
        nullableString(row, 'doc_id') || randomUUID(),
        row.title ?? null,
        markdown,
        marks,
        revision,
        stringValue(row, 'share_state', 'ACTIVE'),
        accessEpoch,
        intValue(row, 'active', 1),
        row.owner_id ?? null,
        stringValue(row, 'created_at', nowIso()),
        stringValue(row, 'updated_at', nowIso()),
        row.deleted_at ?? null,
      );

      const projection = tableRows(bundle, 'document_projections')
        .find((candidate) => stringValue(candidate, 'document_slug') === slug);
      db.prepare(`
        INSERT INTO document_projections (
          document_slug, revision, y_state_version, markdown, marks_json, plain_text, updated_at, health, health_reason
        )
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        slug,
        projection ? intValue(projection, 'revision', revision) : revision,
        projection ? stringValue(projection, 'markdown', markdown) : markdown,
        projection ? stringValue(projection, 'marks_json', marks) : marks,
        projection ? stringValue(projection, 'plain_text', plainText(markdown)) : plainText(markdown),
        projection ? stringValue(projection, 'updated_at', stringValue(row, 'updated_at', nowIso())) : stringValue(row, 'updated_at', nowIso()),
        projection ? stringValue(projection, 'health', 'healthy') : 'healthy',
        projection?.health_reason ?? null,
      );
    }

    for (const row of tableRows(bundle, 'events')) {
      if (!importedSlugSet.has(stringValue(row, 'document_slug'))) continue;
      const copy = { ...row };
      delete copy.id;
      insertRow(db, 'events', copy);
    }

    for (const row of tableRows(bundle, 'document_events')) {
      const slug = stringValue(row, 'document_slug');
      if (!importedSlugSet.has(slug)) continue;
      const oldId = intValue(row, 'id', 0);
      const newId = insertDocumentEvent(db, row);
      if (oldId > 0) eventIdMap.set(`${slug}:${oldId}`, newId);
    }

    for (const row of reviewRoomDocs) insertRow(db, 'review_room_documents', row);

    for (const row of tableRows(bundle, 'review_room_document_agent_settings')) {
      if (reviewRoomDocIds.has(stringValue(row, 'document_id'))) insertRow(db, 'review_room_document_agent_settings', row, { orIgnore: true });
    }

    for (const row of tableRows(bundle, 'review_room_published_versions')) {
      if (reviewRoomDocIds.has(stringValue(row, 'document_id'))) insertRow(db, 'review_room_published_versions', row, { orIgnore: true });
    }

    for (const row of tableRows(bundle, 'review_room_history_events')) {
      if (reviewRoomDocIds.has(stringValue(row, 'document_id'))) insertRow(db, 'review_room_history_events', row, { orIgnore: true });
    }

    for (const row of tableRows(bundle, 'review_room_assignment_tasks')) {
      if (!reviewRoomDocIds.has(stringValue(row, 'document_id'))) continue;
      const copy = { ...row };
      const sourceDoc = reviewRoomDocs.find((doc) => stringValue(doc, 'id') === stringValue(row, 'document_id'));
      const sourceSlug = sourceDoc ? stringValue(sourceDoc, 'proof_slug') : '';
      const oldProofEventId = intValue(row, 'proof_event_id', 0);
      if (sourceSlug && oldProofEventId > 0) {
        copy.proof_event_id = eventIdMap.get(`${sourceSlug}:${oldProofEventId}`) ?? null;
      }
      insertRow(db, 'review_room_assignment_tasks', copy, { orIgnore: true });
    }

    const memberRowsByDocumentId = new Map<string, JsonRow[]>();
    for (const member of memberRows) {
      const list = memberRowsByDocumentId.get(stringValue(member, 'review_room_document_id')) ?? [];
      list.push(member);
      memberRowsByDocumentId.set(stringValue(member, 'review_room_document_id'), list);
    }

    for (const doc of importDocs) {
      const slug = stringValue(doc, 'slug');
      const reviewRoomDocument = reviewRoomDocs.find((row) => stringValue(row, 'proof_slug') === slug);
      const manifestDoc: ImportTokenManifest['documents'][number] = {
        slug,
        title: nullableString(doc, 'title'),
        docId: nullableString(doc, 'doc_id'),
        reviewRoomDocumentId: reviewRoomDocument ? stringValue(reviewRoomDocument, 'id') : null,
        tokens: [],
      };

      if (reviewRoomDocument) {
        const members = memberRowsByDocumentId.get(stringValue(reviewRoomDocument, 'id')) ?? [];
        for (const member of members) {
          const rrRole = normalizeReviewRoomRole(member.role);
          const shareRole = roleToShareRole(rrRole);
          const createdAt = stringValue(member, 'created_at', nowIso());
          const access = createAccessToken(db, slug, shareRole, createdAt);
          db.prepare(`
            INSERT INTO review_room_document_members (
              review_room_document_id, identity_id, role, proof_access_token_id, proof_access_token, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            stringValue(member, 'review_room_document_id'),
            stringValue(member, 'identity_id'),
            rrRole,
            access.tokenId,
            access.token,
            createdAt,
            stringValue(member, 'updated_at', createdAt),
          );
          manifestDoc.tokens.push({
            identityId: stringValue(member, 'identity_id'),
            role: rrRole,
            shareRole,
            tokenId: access.tokenId,
            token: access.token,
            url: buildUrl(args.baseUrl, slug, access.token),
          });
        }
      }

      if (manifestDoc.tokens.length === 0) {
        const access = createAccessToken(db, slug, 'owner_bot', nowIso());
        manifestDoc.tokens.push({
          identityId: stringValue(doc, 'owner_id', 'migration-owner'),
          role: 'owner',
          shareRole: 'owner_bot',
          tokenId: access.tokenId,
          token: access.token,
          url: buildUrl(args.baseUrl, slug, access.token),
        });
      }

      tokenManifest.documents.push(manifestDoc);
    }
  });

  tx();

  mkdirSync(path.dirname(path.resolve(args.tokenOut)), { recursive: true });
  writeFileSync(args.tokenOut, `${JSON.stringify(tokenManifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`[import] Imported ${tokenManifest.documents.length} document(s) into ${args.database}`);
  console.log(`[import] Wrote fresh Fly token manifest to ${args.tokenOut}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
