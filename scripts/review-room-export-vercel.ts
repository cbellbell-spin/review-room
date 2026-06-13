import { createClient, type Client } from '@libsql/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type SqlValue = null | string | number | bigint | ArrayBuffer | boolean | Uint8Array | Date;
type JsonRow = Record<string, unknown>;

const CORE_DOCUMENT_TABLES = [
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

type ExportBundle = {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    kind: 'vercel-turso';
    urlHost: string | null;
    tokenPolicy: 'omitted';
  };
  filters: {
    slugs: string[];
    includeDeleted: boolean;
  };
  tables: Record<string, JsonRow[]>;
  counts: Record<string, number>;
};

function parseArgs(argv: string[]): {
  out: string;
  slugs: string[];
  includeDeleted: boolean;
} {
  const args = [...argv];
  const result = {
    out: '',
    slugs: [] as string[],
    includeDeleted: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--out') {
      result.out = requireValue(args, '--out');
      continue;
    }
    if (arg === '--slug') {
      result.slugs.push(requireValue(args, '--slug'));
      continue;
    }
    if (arg === '--include-deleted') {
      result.includeDeleted = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!result.out) {
    throw new Error('Missing --out <path>');
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
  console.log(`Export legacy Vercel/Turso Review Room documents.

Usage:
  TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run migrate:review-room:export -- --out /tmp/review-room-export.json

Options:
  --out <path>          Required JSON bundle path.
  --slug <slug>         Export one slug. Repeat to export a subset.
  --include-deleted     Include documents with share_state='DELETED' or deleted_at set.

Secrets:
  document_access rows, owner secrets, and Review Room member tokens are intentionally omitted.
`);
}

function getTursoClient(): Client {
  const url = (process.env.TURSO_DATABASE_URL || '').trim();
  if (!url) throw new Error('TURSO_DATABASE_URL is required.');
  return createClient({
    url,
    authToken: (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined,
  });
}

async function tableExists(db: Client, table: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    args: [table],
  });
  return result.rows.length > 0;
}

async function selectAll(db: Client, sql: string, args: SqlValue[] = []): Promise<JsonRow[]> {
  const result = await db.execute({ sql, args });
  return result.rows.map((row) => jsonSafeRow(row as Record<string, unknown>));
}

function jsonSafeRow(row: Record<string, unknown>): JsonRow {
  const safe: JsonRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') {
      safe[key] = Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
    } else if (value instanceof ArrayBuffer) {
      safe[key] = Buffer.from(value).toString('base64');
    } else if (value instanceof Uint8Array) {
      safe[key] = Buffer.from(value).toString('base64');
    } else if (value instanceof Date) {
      safe[key] = value.toISOString();
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

async function maybeSelect(
  db: Client,
  table: string,
  sql: string,
  args: SqlValue[] = [],
): Promise<JsonRow[]> {
  if (!(await tableExists(db, table))) return [];
  return selectAll(db, sql, args);
}

async function buildExportBundle(input: {
  db: Client;
  slugs: string[];
  includeDeleted: boolean;
}): Promise<ExportBundle> {
  const { db, includeDeleted } = input;
  const requestedSlugs = Array.from(new Set(input.slugs.map((slug) => slug.trim()).filter(Boolean)));
  const tables: Record<string, JsonRow[]> = {};

  const documentWhere: string[] = [];
  const documentArgs: SqlValue[] = [];
  if (requestedSlugs.length > 0) {
    documentWhere.push(`slug IN (${placeholders(requestedSlugs)})`);
    documentArgs.push(...requestedSlugs);
  }
  if (!includeDeleted) {
    documentWhere.push(`COALESCE(share_state, 'ACTIVE') != 'DELETED'`);
    documentWhere.push(`deleted_at IS NULL`);
  }
  const documentSql = `SELECT * FROM documents${documentWhere.length ? ` WHERE ${documentWhere.join(' AND ')}` : ''} ORDER BY slug`;
  tables.documents = await maybeSelect(db, 'documents', documentSql, documentArgs);
  sanitizeDocumentSecrets(tables.documents);

  const slugs = tables.documents.map((row) => String(row.slug)).filter(Boolean);
  if (requestedSlugs.length > 0) {
    const found = new Set(slugs);
    const missing = requestedSlugs.filter((slug) => !found.has(slug));
    if (missing.length > 0) {
      console.warn(`[export] Warning: ${missing.length} requested slug(s) were not found: ${missing.join(', ')}`);
    }
  }

  if (slugs.length === 0) {
    for (const table of [...CORE_DOCUMENT_TABLES, ...REVIEW_ROOM_TABLES]) {
      tables[table] ??= [];
    }
    return finalizeBundle(tables, requestedSlugs, includeDeleted);
  }

  const slugClause = placeholders(slugs);
  tables.document_projections = await maybeSelect(
    db,
    'document_projections',
    `SELECT * FROM document_projections WHERE document_slug IN (${slugClause}) ORDER BY document_slug`,
    slugs,
  );
  tables.events = await maybeSelect(
    db,
    'events',
    `SELECT * FROM events WHERE document_slug IN (${slugClause}) ORDER BY document_slug, id`,
    slugs,
  );
  tables.document_events = await maybeSelect(
    db,
    'document_events',
    `SELECT * FROM document_events WHERE document_slug IN (${slugClause}) ORDER BY document_slug, id`,
    slugs,
  );

  tables.review_room_documents = await maybeSelect(
    db,
    'review_room_documents',
    `SELECT * FROM review_room_documents WHERE proof_slug IN (${slugClause}) ORDER BY proof_slug`,
    slugs,
  );
  const reviewRoomDocumentIds = tables.review_room_documents
    .map((row) => String(row.id || ''))
    .filter(Boolean);

  if (reviewRoomDocumentIds.length > 0) {
    const rrDocClause = placeholders(reviewRoomDocumentIds);
    tables.review_room_document_members = await maybeSelect(
      db,
      'review_room_document_members',
      `SELECT review_room_document_id, identity_id, role, NULL AS proof_access_token_id, NULL AS proof_access_token, created_at, updated_at
       FROM review_room_document_members
       WHERE review_room_document_id IN (${rrDocClause})
       ORDER BY review_room_document_id, identity_id`,
      reviewRoomDocumentIds,
    );
    tables.review_room_document_agent_settings = await maybeSelect(
      db,
      'review_room_document_agent_settings',
      `SELECT * FROM review_room_document_agent_settings WHERE document_id IN (${rrDocClause}) ORDER BY document_id, agent_id`,
      reviewRoomDocumentIds,
    );
    tables.review_room_assignment_tasks = await maybeSelect(
      db,
      'review_room_assignment_tasks',
      `SELECT * FROM review_room_assignment_tasks WHERE document_id IN (${rrDocClause}) ORDER BY document_id, created_at, id`,
      reviewRoomDocumentIds,
    );
    tables.review_room_published_versions = await maybeSelect(
      db,
      'review_room_published_versions',
      `SELECT * FROM review_room_published_versions WHERE document_id IN (${rrDocClause}) ORDER BY document_id, version_number`,
      reviewRoomDocumentIds,
    );
    tables.review_room_history_events = await maybeSelect(
      db,
      'review_room_history_events',
      `SELECT * FROM review_room_history_events WHERE document_id IN (${rrDocClause}) ORDER BY document_id, created_at, id`,
      reviewRoomDocumentIds,
    );
  } else {
    tables.review_room_document_members = [];
    tables.review_room_document_agent_settings = [];
    tables.review_room_assignment_tasks = [];
    tables.review_room_published_versions = [];
    tables.review_room_history_events = [];
  }

  const workspaceIds = new Set<string>();
  const identityIds = new Set<string>();
  for (const row of tables.review_room_documents) {
    addString(workspaceIds, row.workspace_id);
    addString(identityIds, row.owner_identity_id);
    addString(identityIds, row.created_by_identity_id);
  }
  for (const row of tables.review_room_document_members) {
    addString(identityIds, row.identity_id);
  }
  for (const row of tables.review_room_assignment_tasks) {
    addString(identityIds, row.created_by_actor_id);
    addString(identityIds, row.assigned_to_actor_id);
    addString(identityIds, row.manager_identity_id);
  }
  for (const row of tables.review_room_history_events) {
    addString(workspaceIds, row.workspace_id);
    addString(identityIds, row.actor_id);
  }
  const agentIds = new Set<string>();
  for (const row of tables.review_room_document_agent_settings) {
    addString(agentIds, row.agent_id);
  }

  const workspaceList = Array.from(workspaceIds);
  tables.review_room_workspaces = workspaceList.length > 0
    ? await maybeSelect(
      db,
      'review_room_workspaces',
      `SELECT * FROM review_room_workspaces WHERE id IN (${placeholders(workspaceList)}) ORDER BY id`,
      workspaceList,
    )
    : [];

  const agentList = Array.from(agentIds);
  if (agentList.length > 0) {
    tables.review_room_agents = await maybeSelect(
      db,
      'review_room_agents',
      `SELECT * FROM review_room_agents WHERE id IN (${placeholders(agentList)}) ORDER BY workspace_id, name`,
      agentList,
    );
  } else if (workspaceList.length > 0) {
    tables.review_room_agents = await maybeSelect(
      db,
      'review_room_agents',
      `SELECT * FROM review_room_agents WHERE workspace_id IN (${placeholders(workspaceList)}) ORDER BY workspace_id, name`,
      workspaceList,
    );
  } else {
    tables.review_room_agents = [];
  }

  for (const row of tables.review_room_agents) {
    addString(identityIds, row.owner_identity_id);
    addString(identityIds, row.manager_identity_id);
  }

  const identityList = Array.from(identityIds);
  tables.review_room_identities = identityList.length > 0
    ? await maybeSelect(
      db,
      'review_room_identities',
      `SELECT * FROM review_room_identities WHERE id IN (${placeholders(identityList)}) ORDER BY kind DESC, display_name ASC`,
      identityList,
    )
    : [];

  return finalizeBundle(tables, requestedSlugs, includeDeleted);
}

function addString(set: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim()) set.add(value.trim());
}

function sanitizeDocumentSecrets(rows: JsonRow[]): void {
  for (const row of rows) {
    row.owner_secret = null;
    row.owner_secret_hash = null;
  }
}

function finalizeBundle(
  tables: Record<string, JsonRow[]>,
  requestedSlugs: string[],
  includeDeleted: boolean,
): ExportBundle {
  for (const table of [...CORE_DOCUMENT_TABLES, ...REVIEW_ROOM_TABLES]) {
    tables[table] ??= [];
  }
  const counts = Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [table, rows.length]),
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      kind: 'vercel-turso',
      urlHost: safeHost(process.env.TURSO_DATABASE_URL || ''),
      tokenPolicy: 'omitted',
    },
    filters: {
      slugs: requestedSlugs,
      includeDeleted,
    },
    tables,
    counts,
  };
}

function safeHost(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).host || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = getTursoClient();
  const bundle = await buildExportBundle({
    db,
    slugs: args.slugs,
    includeDeleted: args.includeDeleted,
  });
  mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  console.log(`[export] Wrote ${bundle.counts.documents ?? 0} document(s) to ${args.out}`);
  console.log('[export] Legacy owner/access/member tokens were omitted; import will mint fresh Fly tokens.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
