import { createHash, randomBytes, randomUUID } from 'crypto';
import { createClient, type Client, type ResultSet } from '@libsql/client';
import type {
  DocumentRow,
  ReviewRoomAgentRow,
  ReviewRoomDocumentMemberRow,
  ReviewRoomDocumentRow,
  ReviewRoomHistoryEventRow,
  ReviewRoomIdentityRow,
  ReviewRoomRole,
} from './db.js';
import { deriveReviewRoomCapabilities, reviewRoomRoleToShareRole, type DocumentAccessRow } from './db.js';
import type { ShareRole } from './share-types.js';
import { applyAgentEditOperations, type AgentEditOperation } from './agent-edit-ops.js';
import { parseDocumentOpRequest, resolveDocumentOpRoute, type DocumentOpType } from './document-ops.js';
import { isGetOnlyActionsEnabled } from './get-only-actions.js';
import {
  REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
  REVIEW_ROOM_LOCAL_AGENT_ID,
  REVIEW_ROOM_LOCAL_AGENT_NAME,
  REVIEW_ROOM_LOCAL_HUMAN_ID,
  REVIEW_ROOM_LOCAL_HUMAN_NAME,
  REVIEW_ROOM_LOCAL_WORKSPACE_NAME,
} from './review-room-identity.js';
import { applyProofSuggestionByProofSpanId, stripAllProofSpanTags } from './proof-span-strip.js';

type SqlValue = null | string | number | bigint | ArrayBuffer | boolean | Uint8Array | Date;

export type HostedEngineExecutionResult = {
  status: number;
  body: Record<string, unknown>;
};

export type HostedDocumentEventRow = {
  id: number;
  document_slug: string;
  document_revision: number | null;
  event_type: string;
  event_data: string;
  actor: string;
  idempotency_key: string | null;
  mutation_route: string | null;
  tombstone_revision: number | null;
  created_at: string;
  acked_by: string | null;
  acked_at: string | null;
};

export type HostedGetActionAlias = {
  alias: string;
  role: ShareRole;
  expiresAt: string;
};

let client: Client | null = null;
let initialized = false;

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shortSecret(bytes: number = 9): string {
  return randomBytes(bytes).toString('base64url');
}

export function isHostedReviewRoomDbEnabled(): boolean {
  return Boolean((process.env.TURSO_DATABASE_URL || '').trim());
}

function getClient(): Client {
  if (!isHostedReviewRoomDbEnabled()) {
    throw new Error('TURSO_DATABASE_URL is required for hosted Review Room persistence.');
  }
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL as string,
      authToken: (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined,
    });
  }
  return client;
}

async function ensureHostedReviewRoomDatabase(): Promise<Client> {
  const db = getClient();
  if (initialized) return db;
  await db.batch([
    `CREATE TABLE IF NOT EXISTS documents (
      slug TEXT PRIMARY KEY,
      doc_id TEXT UNIQUE,
      title TEXT,
      markdown TEXT NOT NULL,
      marks TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      y_state_version INTEGER NOT NULL DEFAULT 0,
      share_state TEXT NOT NULL DEFAULT 'ACTIVE',
      access_epoch INTEGER NOT NULL DEFAULT 0,
      collab_bootstrap_epoch INTEGER NOT NULL DEFAULT 0,
      live_collab_seen_at TEXT,
      live_collab_access_epoch INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      owner_id TEXT,
      owner_secret TEXT,
      owner_secret_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_doc_id ON documents(doc_id)`,
    `CREATE INDEX IF NOT EXISTS idx_documents_share_state ON documents(share_state)`,
    `CREATE TABLE IF NOT EXISTS document_projections (
      document_slug TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      y_state_version INTEGER NOT NULL DEFAULT 0,
      markdown TEXT NOT NULL,
      marks_json TEXT NOT NULL DEFAULT '{}',
      plain_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      health TEXT NOT NULL DEFAULT 'healthy',
      health_reason TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS document_access (
      token_id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      role TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_document_access_slug ON document_access(document_slug)`,
    `CREATE INDEX IF NOT EXISTS idx_document_access_secret ON document_access(secret_hash)`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS document_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      document_revision INTEGER,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      actor TEXT NOT NULL,
      idempotency_key TEXT,
      mutation_route TEXT,
      tombstone_revision INTEGER,
      created_at TEXT NOT NULL,
      acked_by TEXT,
      acked_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS mutation_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      document_revision INTEGER,
      event_id INTEGER,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      actor TEXT NOT NULL,
      idempotency_key TEXT,
      mutation_route TEXT,
      tombstone_revision INTEGER,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS review_room_workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS review_room_identities (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      manager_identity_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS review_room_documents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      proof_slug TEXT NOT NULL UNIQUE,
      proof_doc_id TEXT,
      source TEXT NOT NULL DEFAULT 'created',
      owner_identity_id TEXT NOT NULL,
      created_by_identity_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_review_room_documents_workspace_updated ON review_room_documents(workspace_id, updated_at)`,
    `CREATE TABLE IF NOT EXISTS review_room_document_members (
      review_room_document_id TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      role TEXT NOT NULL,
      proof_access_token_id TEXT,
      proof_access_token TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (review_room_document_id, identity_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_review_room_members_token ON review_room_document_members(proof_access_token)`,
    `CREATE TABLE IF NOT EXISTS review_room_agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      owner_identity_id TEXT NOT NULL,
      manager_identity_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      integration_type TEXT NOT NULL DEFAULT 'local',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_review_room_agents_workspace_name ON review_room_agents(workspace_id, name)`,
    `CREATE INDEX IF NOT EXISTS idx_review_room_agents_manager ON review_room_agents(manager_identity_id, updated_at)`,
    `CREATE TABLE IF NOT EXISTS review_room_document_agent_settings (
      document_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      auto_accept_mode TEXT NOT NULL DEFAULT 'off',
      allowed_auto_accept_categories_json TEXT NOT NULL DEFAULT '[]',
      created_by_identity_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (document_id, agent_id)
    )`,
    `CREATE TABLE IF NOT EXISTS review_room_assignment_tasks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      proof_event_id INTEGER,
      source_type TEXT NOT NULL,
      source_id TEXT,
      created_by_actor_id TEXT NOT NULL,
      created_by_actor_type TEXT NOT NULL,
      assigned_to_actor_id TEXT NOT NULL,
      assigned_to_actor_type TEXT NOT NULL,
      manager_identity_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_review_room_tasks_document_status ON review_room_assignment_tasks(document_id, status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_review_room_tasks_assignee_status ON review_room_assignment_tasks(assigned_to_actor_id, status, created_at)`,
    `CREATE TABLE IF NOT EXISTS review_room_published_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      proof_revision INTEGER,
      content_snapshot TEXT NOT NULL,
      created_by_identity_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      note TEXT,
      UNIQUE (document_id, version_number)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_review_room_published_versions_document ON review_room_published_versions(document_id, version_number)`,
    `CREATE TABLE IF NOT EXISTS review_room_history_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      document_id TEXT,
      actor_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      before_json TEXT,
      after_json TEXT,
      rationale TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_review_room_history_document_created ON review_room_history_events(document_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_review_room_history_workspace_created ON review_room_history_events(workspace_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS get_action_aliases (
      alias_hash TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_get_action_aliases_slug ON get_action_aliases(document_slug, expires_at)`,
    `CREATE TABLE IF NOT EXISTS get_action_draft_chunks (
      document_slug TEXT NOT NULL,
      alias_hash TEXT NOT NULL,
      draft_key TEXT NOT NULL,
      field TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (document_slug, alias_hash, draft_key, field, chunk_index)
    )`,
  ]);
  const now = new Date().toISOString();
  await db.batch([
    [
      `INSERT INTO review_room_workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [REVIEW_ROOM_DEFAULT_WORKSPACE_ID, REVIEW_ROOM_LOCAL_WORKSPACE_NAME, now, now],
    ],
    [
      `INSERT INTO review_room_identities (id, workspace_id, kind, display_name, manager_identity_id, created_at, updated_at)
       VALUES (?, ?, 'human', ?, NULL, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [REVIEW_ROOM_LOCAL_HUMAN_ID, REVIEW_ROOM_DEFAULT_WORKSPACE_ID, REVIEW_ROOM_LOCAL_HUMAN_NAME, now, now],
    ],
    [
      `INSERT INTO review_room_identities (id, workspace_id, kind, display_name, manager_identity_id, created_at, updated_at)
       VALUES (?, ?, 'agent', ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        REVIEW_ROOM_LOCAL_AGENT_ID,
        REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
        REVIEW_ROOM_LOCAL_AGENT_NAME,
        REVIEW_ROOM_LOCAL_HUMAN_ID,
        now,
        now,
      ],
    ],
    [
      `INSERT INTO review_room_agents (
        id, workspace_id, owner_identity_id, manager_identity_id, name, description, integration_type,
        capabilities_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`,
      [
        REVIEW_ROOM_LOCAL_AGENT_ID,
        REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
        REVIEW_ROOM_LOCAL_HUMAN_ID,
        REVIEW_ROOM_LOCAL_HUMAN_ID,
        REVIEW_ROOM_LOCAL_AGENT_NAME,
        'Default local review agent used for early Review Room task flows.',
        JSON.stringify(['comment', 'question', 'suggestion', 'redline']),
        now,
        now,
      ],
    ],
  ]);
  initialized = true;
  return db;
}

function firstRow<T>(result: ResultSet): T | null {
  return (result.rows[0] as T | undefined) ?? null;
}

function parseMarks(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
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

function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function splitHostedMarkdownBlocks(markdown: string): string[] {
  const normalized = (markdown ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function joinHostedMarkdownBlocks(blocks: string[]): string {
  return blocks.map((block) => block.trim()).filter(Boolean).join('\n\n');
}

function parseHostedBlockRef(ref: unknown): number | null {
  if (typeof ref !== 'string') return null;
  const match = ref.match(/^b(\d+)$/i);
  if (!match) return null;
  const ordinal = Number.parseInt(match[1], 10);
  if (!Number.isFinite(ordinal) || ordinal < 1) return null;
  return ordinal - 1;
}

function buildHostedSnapshotBody(doc: DocumentRow): Record<string, unknown> {
  const blocks = splitHostedMarkdownBlocks(doc.markdown).map((markdown, index) => ({
    ref: `b${index + 1}`,
    id: `hosted:${doc.doc_id}:r${doc.revision}:b${index + 1}`,
    type: markdown.startsWith('#') ? 'heading' : 'paragraph',
    markdown,
    markdownHash: hashMarkdown(markdown),
    textPreview: plainText(markdown).slice(0, 200),
  }));

  return {
    success: true,
    slug: doc.slug,
    revision: doc.revision,
    readSource: 'hosted_libsql',
    projectionFresh: true,
    repairPending: false,
    mutationReady: true,
    generatedAt: new Date().toISOString(),
    blocks,
    _links: {
      editV2: { method: 'POST', href: `/api/agent/${doc.slug}/edit/v2` },
      state: `/api/agent/${doc.slug}/state`,
      docs: '/agent-docs',
    },
    collab: {
      available: false,
      reason: 'hosted-libsql-serverless',
    },
  };
}

type HostedEditV2Operation =
  | { op: 'replace_block'; ref: string; block: { markdown: string } }
  | { op: 'insert_after'; ref: string; blocks: Array<{ markdown: string }> }
  | { op: 'insert_before'; ref: string; blocks: Array<{ markdown: string }> }
  | { op: 'delete_block'; ref: string }
  | { op: 'replace_range'; fromRef: string; toRef: string; blocks: Array<{ markdown: string }> }
  | { op: 'find_replace_in_block'; ref: string; find: string; replace: string; occurrence?: 'first' | 'all' };

function normalizeHostedEditV2Operations(raw: unknown): { operations: HostedEditV2Operation[] } | { error: string; opIndex?: number } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'operations must be a non-empty array' };
  }
  if (raw.length > 100) {
    return { error: 'Too many operations', opIndex: 100 };
  }

  const operations: HostedEditV2Operation[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'Invalid operation payload', opIndex: i };
    }
    const op = entry as Record<string, unknown>;
    if (op.op === 'replace_block') {
      const block = op.block;
      if (typeof op.ref !== 'string' || !block || typeof block !== 'object' || Array.isArray(block) || typeof (block as Record<string, unknown>).markdown !== 'string') {
        return { error: 'replace_block requires ref + block.markdown', opIndex: i };
      }
      operations.push({ op: 'replace_block', ref: op.ref, block: { markdown: (block as Record<string, string>).markdown } });
      continue;
    }
    if (op.op === 'insert_after' || op.op === 'insert_before') {
      if (typeof op.ref !== 'string' || !Array.isArray(op.blocks)) {
        return { error: `${op.op} requires ref + blocks`, opIndex: i };
      }
      const blocks = op.blocks.map((block) => (
        block && typeof block === 'object' && !Array.isArray(block) && typeof (block as Record<string, unknown>).markdown === 'string'
          ? { markdown: (block as Record<string, string>).markdown }
          : null
      ));
      if (blocks.some((block) => block === null)) {
        return { error: `${op.op} blocks must include markdown`, opIndex: i };
      }
      operations.push({ op: op.op, ref: op.ref, blocks: blocks as Array<{ markdown: string }> });
      continue;
    }
    if (op.op === 'delete_block') {
      if (typeof op.ref !== 'string') return { error: 'delete_block requires ref', opIndex: i };
      operations.push({ op: 'delete_block', ref: op.ref });
      continue;
    }
    if (op.op === 'replace_range') {
      if (typeof op.fromRef !== 'string' || typeof op.toRef !== 'string' || !Array.isArray(op.blocks)) {
        return { error: 'replace_range requires fromRef + toRef + blocks', opIndex: i };
      }
      const blocks = op.blocks.map((block) => (
        block && typeof block === 'object' && !Array.isArray(block) && typeof (block as Record<string, unknown>).markdown === 'string'
          ? { markdown: (block as Record<string, string>).markdown }
          : null
      ));
      if (blocks.some((block) => block === null)) {
        return { error: 'replace_range blocks must include markdown', opIndex: i };
      }
      operations.push({ op: 'replace_range', fromRef: op.fromRef, toRef: op.toRef, blocks: blocks as Array<{ markdown: string }> });
      continue;
    }
    if (op.op === 'find_replace_in_block') {
      if (typeof op.ref !== 'string' || typeof op.find !== 'string' || typeof op.replace !== 'string') {
        return { error: 'find_replace_in_block requires ref + find + replace', opIndex: i };
      }
      const occurrence = op.occurrence === 'all' ? 'all' : 'first';
      operations.push({ op: 'find_replace_in_block', ref: op.ref, find: op.find, replace: op.replace, occurrence });
      continue;
    }
    return { error: `Unknown op: ${String(op.op)}`, opIndex: i };
  }

  return { operations };
}

function applyHostedEditV2Operations(markdown: string, operations: HostedEditV2Operation[]): { markdown: string } | { error: string; code: string; opIndex: number } {
  const blocks = splitHostedMarkdownBlocks(markdown);
  for (let opIndex = 0; opIndex < operations.length; opIndex += 1) {
    const op = operations[opIndex];
    if (op.op === 'replace_block') {
      const idx = parseHostedBlockRef(op.ref);
      if (idx === null || idx < 0 || idx >= blocks.length) return { error: 'Invalid ref', code: 'INVALID_REF', opIndex };
      blocks.splice(idx, 1, op.block.markdown.trim());
      continue;
    }
    if (op.op === 'insert_after' || op.op === 'insert_before') {
      const idx = parseHostedBlockRef(op.ref);
      if (idx === null || idx < 0 || idx >= blocks.length) return { error: 'Invalid ref', code: 'INVALID_REF', opIndex };
      const inserts = op.blocks.map((block) => block.markdown.trim()).filter(Boolean);
      blocks.splice(op.op === 'insert_after' ? idx + 1 : idx, 0, ...inserts);
      continue;
    }
    if (op.op === 'delete_block') {
      const idx = parseHostedBlockRef(op.ref);
      if (idx === null || idx < 0 || idx >= blocks.length) return { error: 'Invalid ref', code: 'INVALID_REF', opIndex };
      blocks.splice(idx, 1);
      continue;
    }
    if (op.op === 'replace_range') {
      const fromIdx = parseHostedBlockRef(op.fromRef);
      const toIdx = parseHostedBlockRef(op.toRef);
      if (fromIdx === null || toIdx === null || fromIdx < 0 || toIdx < 0 || fromIdx >= blocks.length || toIdx >= blocks.length) {
        return { error: 'Invalid range ref', code: 'INVALID_REF', opIndex };
      }
      if (fromIdx > toIdx) return { error: 'fromRef must be before toRef', code: 'INVALID_RANGE', opIndex };
      const inserts = op.blocks.map((block) => block.markdown.trim()).filter(Boolean);
      blocks.splice(fromIdx, toIdx - fromIdx + 1, ...inserts);
      continue;
    }
    if (op.op === 'find_replace_in_block') {
      const idx = parseHostedBlockRef(op.ref);
      if (idx === null || idx < 0 || idx >= blocks.length) return { error: 'Invalid ref', code: 'INVALID_REF', opIndex };
      if (!op.find) return { error: 'find must be non-empty', code: 'INVALID_OPERATIONS', opIndex };
      const current = blocks[idx];
      if (!current.includes(op.find)) return { error: 'find target not found', code: 'FIND_TARGET_NOT_FOUND', opIndex };
      blocks[idx] = op.occurrence === 'all'
        ? current.split(op.find).join(op.replace)
        : current.replace(op.find, op.replace);
    }
  }
  return { markdown: joinHostedMarkdownBlocks(blocks) };
}

async function execute<T>(sql: string, args: SqlValue[] = []): Promise<T | null> {
  const db = await ensureHostedReviewRoomDatabase();
  return firstRow<T>(await db.execute({ sql, args }));
}

async function executeAll<T>(sql: string, args: SqlValue[] = []): Promise<T[]> {
  const db = await ensureHostedReviewRoomDatabase();
  const result = await db.execute({ sql, args });
  return result.rows as T[];
}

export async function getHostedDocumentBySlug(slug: string): Promise<DocumentRow | undefined> {
  return (await execute<DocumentRow>('SELECT * FROM documents WHERE slug = ? LIMIT 1', [slug])) ?? undefined;
}

export async function resolveHostedDocumentAccess(
  slug: string,
  secret: string | null | undefined,
): Promise<(DocumentAccessRow & { tokenId: string }) | null> {
  const trimmed = (secret || '').trim();
  if (!trimmed) return null;
  const row = await execute<DocumentAccessRow>(`
    SELECT token_id, document_slug, role, secret_hash, created_at, revoked_at
    FROM document_access
    WHERE document_slug = ? AND secret_hash = ? AND revoked_at IS NULL
    LIMIT 1
  `, [slug, hashSecret(trimmed)]);
  return row ? { ...row, tokenId: row.token_id } : null;
}

export async function resolveHostedDocumentAccessRole(slug: string, secret: string | null | undefined): Promise<ShareRole | null> {
  const access = await resolveHostedDocumentAccess(slug, secret);
  return access?.role ?? null;
}

export async function createHostedGetActionAlias(
  slug: string,
  secret: string | null | undefined,
): Promise<HostedGetActionAlias | null> {
  const access = await resolveHostedDocumentAccess(slug, secret);
  if (!access) return null;
  const db = await ensureHostedReviewRoomDatabase();
  const now = new Date();
  const expires = new Date(now.getTime() + 60 * 60 * 1000);
  const alias = shortSecret();
  await db.execute({
    sql: `INSERT INTO get_action_aliases (alias_hash, document_slug, role, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [hashSecret(alias), slug, access.role, now.toISOString(), expires.toISOString()],
  });
  return { alias, role: access.role, expiresAt: expires.toISOString() };
}

export async function resolveHostedGetActionAlias(
  slug: string,
  alias: string | null | undefined,
): Promise<HostedGetActionAlias | null> {
  const trimmed = (alias || '').trim();
  if (!trimmed) return null;
  const row = await execute<{ role: ShareRole; expires_at: string }>(`
    SELECT role, expires_at
    FROM get_action_aliases
    WHERE document_slug = ? AND alias_hash = ? AND expires_at > ?
    LIMIT 1
  `, [slug, hashSecret(trimmed), new Date().toISOString()]);
  return row ? { alias: trimmed, role: row.role, expiresAt: row.expires_at } : null;
}

export async function storeHostedGetActionDraftChunk(input: {
  slug: string;
  alias: string;
  draftKey: string;
  field: string;
  chunkIndex: number;
  chunkText: string;
}): Promise<{ chunkCount: number; bytes: number; expiresAt: string }> {
  const db = await ensureHostedReviewRoomDatabase();
  const now = new Date();
  const expires = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const aliasHash = hashSecret(input.alias);
  await db.execute({
    sql: `INSERT INTO get_action_draft_chunks (
            document_slug, alias_hash, draft_key, field, chunk_index, chunk_text, created_at, expires_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (document_slug, alias_hash, draft_key, field, chunk_index)
          DO UPDATE SET chunk_text = excluded.chunk_text, expires_at = excluded.expires_at`,
    args: [
      input.slug,
      aliasHash,
      input.draftKey,
      input.field,
      input.chunkIndex,
      input.chunkText,
      now.toISOString(),
      expires,
    ],
  });
  const rows = await executeAll<{ chunk_text: string }>(`
    SELECT chunk_text
    FROM get_action_draft_chunks
    WHERE document_slug = ? AND alias_hash = ? AND draft_key = ? AND field = ? AND expires_at > ?
    ORDER BY chunk_index ASC
  `, [input.slug, aliasHash, input.draftKey, input.field, now.toISOString()]);
  return {
    chunkCount: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.chunk_text.length, 0),
    expiresAt: expires,
  };
}

export async function readHostedGetActionDraftField(input: {
  slug: string;
  alias: string;
  draftKey: string;
  field: string;
}): Promise<string | null> {
  const rows = await executeAll<{ chunk_index: number; chunk_text: string }>(`
    SELECT chunk_index, chunk_text
    FROM get_action_draft_chunks
    WHERE document_slug = ? AND alias_hash = ? AND draft_key = ? AND field = ? AND expires_at > ?
    ORDER BY chunk_index ASC
  `, [input.slug, hashSecret(input.alias), input.draftKey, input.field, new Date().toISOString()]);
  if (!rows.length) return null;
  for (let i = 0; i < rows.length; i += 1) {
    if (Number(rows[i].chunk_index) !== i) return null;
  }
  return rows.map((row) => row.chunk_text).join('');
}

export async function listHostedDocumentEvents(
  slug: string,
  afterId: number,
  limit: number = 100,
): Promise<HostedDocumentEventRow[]> {
  const safeAfter = Number.isFinite(afterId) ? Math.max(0, Math.trunc(afterId)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 100;
  return executeAll<HostedDocumentEventRow>(`
    SELECT *
    FROM document_events
    WHERE document_slug = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `, [slug, safeAfter, safeLimit]);
}

export async function ackHostedDocumentEvents(slug: string, upToId: number, ackedBy: string): Promise<number> {
  const db = await ensureHostedReviewRoomDatabase();
  const safeUpTo = Number.isFinite(upToId) ? Math.max(0, Math.trunc(upToId)) : 0;
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `
      UPDATE document_events
      SET acked_by = ?, acked_at = ?
      WHERE document_slug = ? AND id <= ? AND acked_at IS NULL
    `,
    args: [ackedBy, now, slug, safeUpTo],
  });
  return Number(result.rowsAffected ?? 0);
}

export async function getHostedReviewRoomDocumentMemberForProofSlug(
  proofSlug: string,
  identityId: string = REVIEW_ROOM_LOCAL_HUMAN_ID,
): Promise<ReviewRoomDocumentMemberRow | null> {
  return execute<ReviewRoomDocumentMemberRow>(`
    SELECT
      m.review_room_document_id,
      m.identity_id,
      m.role,
      m.proof_access_token_id,
      m.proof_access_token,
      m.created_at,
      m.updated_at,
      rr.proof_slug
    FROM review_room_document_members m
    JOIN review_room_documents rr ON rr.id = m.review_room_document_id
    WHERE rr.proof_slug = ?
      AND m.identity_id = ?
    LIMIT 1
  `, [proofSlug, identityId]);
}

export async function getHostedReviewRoomDocumentByProofSlug(proofSlug: string): Promise<ReviewRoomDocumentRow | null> {
  return execute<ReviewRoomDocumentRow>(`
    SELECT
      rr.id,
      rr.workspace_id,
      rr.title,
      rr.proof_slug,
      rr.proof_doc_id,
      rr.source,
      rr.owner_identity_id,
      rr.created_by_identity_id,
      rr.created_at,
      rr.updated_at,
      d.title AS proof_title,
      d.share_state,
      d.created_at AS proof_created_at,
      d.updated_at AS proof_updated_at
    FROM review_room_documents rr
    JOIN documents d ON d.slug = rr.proof_slug
    WHERE rr.proof_slug = ?
    LIMIT 1
  `, [proofSlug]);
}

export async function createHostedReviewRoomHistoryEvent(input: {
  workspaceId?: string;
  documentId?: string | null;
  actorId: string;
  actorType: ReviewRoomHistoryEventRow['actor_type'];
  eventType: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  rationale?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<ReviewRoomHistoryEventRow> {
  const db = await ensureHostedReviewRoomDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO review_room_history_events (
      id, workspace_id, document_id, actor_id, actor_type, event_type, target_type, target_id,
      before_json, after_json, rationale, metadata_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.workspaceId || REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
      input.documentId ?? null,
      input.actorId,
      input.actorType,
      input.eventType,
      input.targetType ?? null,
      input.targetId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.rationale ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
    ],
  });
  const row = await execute<ReviewRoomHistoryEventRow>(`
    SELECT *
    FROM review_room_history_events
    WHERE id = ?
    LIMIT 1
  `, [id]);
  if (!row) throw new Error('Hosted Review Room history event was not persisted.');
  return row;
}

export async function createHostedDocumentAccessToken(
  slug: string,
  role: ShareRole,
): Promise<{ tokenId: string; secret: string }> {
  const db = await ensureHostedReviewRoomDatabase();
  const now = new Date().toISOString();
  const tokenId = randomUUID();
  const secret = randomUUID();
  await db.execute({
    sql: `INSERT INTO document_access (token_id, document_slug, role, secret_hash, created_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, NULL)`,
    args: [tokenId, slug, role, hashSecret(secret), now],
  });
  return { tokenId, secret };
}

export async function upsertHostedReviewRoomDocumentMember(input: {
  reviewRoomDocumentId: string;
  identityId: string;
  role: ReviewRoomRole;
  proofSlug: string;
  proofAccessTokenId?: string | null;
  proofAccessToken?: string | null;
}): Promise<ReviewRoomDocumentMemberRow> {
  const access = input.proofAccessToken
    ? { tokenId: input.proofAccessTokenId ?? null, secret: input.proofAccessToken }
    : await createHostedDocumentAccessToken(input.proofSlug, reviewRoomRoleToShareRole(input.role));
  const now = new Date().toISOString();
  const db = await ensureHostedReviewRoomDatabase();
  await db.execute({
    sql: `INSERT INTO review_room_document_members (
      review_room_document_id, identity_id, role, proof_access_token_id, proof_access_token, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (review_room_document_id, identity_id) DO UPDATE SET
      role = excluded.role,
      proof_access_token_id = excluded.proof_access_token_id,
      proof_access_token = excluded.proof_access_token,
      updated_at = excluded.updated_at`,
    args: [input.reviewRoomDocumentId, input.identityId, input.role, access.tokenId, access.secret, now, now],
  });
  const row = await getHostedReviewRoomDocumentMemberForProofSlug(input.proofSlug, input.identityId);
  if (!row) throw new Error('Hosted Review Room member record was not persisted.');
  return row;
}

export async function createHostedReviewRoomDocument(input: {
  slug: string;
  title: string;
  markdown: string;
  marks?: Record<string, unknown>;
  ownerId: string;
  ownerSecret: string;
  workspaceId?: string;
  identityId?: string;
}): Promise<{
  proofDoc: DocumentRow;
  editorAccess: { tokenId: string; secret: string };
  reviewRoomDocument: ReviewRoomDocumentRow;
  member: ReviewRoomDocumentMemberRow | null;
}> {
  const db = await ensureHostedReviewRoomDatabase();
  const now = new Date().toISOString();
  const docId = randomUUID();
  const editorAccess = { tokenId: randomUUID(), secret: randomUUID() };
  const ownerAccess = { tokenId: randomUUID(), secret: randomUUID() };
  const reviewRoomDocumentId = randomUUID();
  const historyEventId = randomUUID();
  const workspaceId = input.workspaceId || REVIEW_ROOM_DEFAULT_WORKSPACE_ID;
  const identityId = input.identityId || REVIEW_ROOM_LOCAL_HUMAN_ID;
  const marksJson = JSON.stringify(input.marks ?? {});
  const eventPayload = JSON.stringify({ title: input.title, ownerId: input.ownerId, reviewRoom: true });

  await db.batch([
    [
      `INSERT INTO documents (
        slug, doc_id, title, markdown, marks, revision, y_state_version, share_state, access_epoch,
        collab_bootstrap_epoch, live_collab_seen_at, live_collab_access_epoch, active,
        owner_id, owner_secret, owner_secret_hash, created_at, updated_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, 1, 0, 'ACTIVE', 0, 0, NULL, NULL, 1, ?, NULL, ?, ?, ?, NULL)`,
      [input.slug, docId, input.title, input.markdown, marksJson, input.ownerId, hashSecret(input.ownerSecret), now, now],
    ],
    [
      `INSERT INTO document_projections (
        document_slug, revision, y_state_version, markdown, marks_json, plain_text, updated_at, health, health_reason
      )
      VALUES (?, 1, 0, ?, ?, ?, ?, 'healthy', NULL)`,
      [input.slug, input.markdown, marksJson, plainText(input.markdown), now],
    ],
    [
      `INSERT INTO document_access (token_id, document_slug, role, secret_hash, created_at, revoked_at)
       VALUES (?, ?, 'editor', ?, ?, NULL)`,
      [editorAccess.tokenId, input.slug, hashSecret(editorAccess.secret), now],
    ],
    [
      `INSERT INTO document_access (token_id, document_slug, role, secret_hash, created_at, revoked_at)
       VALUES (?, ?, 'owner_bot', ?, ?, NULL)`,
      [ownerAccess.tokenId, input.slug, hashSecret(ownerAccess.secret), now],
    ],
    [
      `INSERT INTO review_room_documents (
        id, workspace_id, title, proof_slug, proof_doc_id, source, owner_identity_id, created_by_identity_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
      [reviewRoomDocumentId, workspaceId, input.title, input.slug, docId, identityId, identityId, now, now],
    ],
    [
      `INSERT INTO review_room_document_members (
        review_room_document_id, identity_id, role, proof_access_token_id, proof_access_token, created_at, updated_at
      )
      VALUES (?, ?, 'owner', ?, ?, ?, ?)`,
      [reviewRoomDocumentId, identityId, ownerAccess.tokenId, ownerAccess.secret, now, now],
    ],
    [
      `INSERT INTO review_room_history_events (
        id, workspace_id, document_id, actor_id, actor_type, event_type, target_type, target_id,
        before_json, after_json, rationale, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, 'human', 'document.created', 'document', ?, NULL, ?, NULL, ?, ?)`,
      [
        historyEventId,
        workspaceId,
        reviewRoomDocumentId,
        identityId,
        reviewRoomDocumentId,
        JSON.stringify({ title: input.title, proofSlug: input.slug, proofDocId: docId }),
        JSON.stringify({ proofSlug: input.slug, source: 'created' }),
        now,
      ],
    ],
    [
      `INSERT INTO events (document_slug, event_type, event_data, actor, created_at)
       VALUES (?, 'review_room.document.created', ?, ?, ?)`,
      [input.slug, eventPayload, input.ownerId, now],
    ],
    [
      `INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, mutation_route, tombstone_revision, created_at
      )
      VALUES (?, 1, 'review_room.document.created', ?, ?, NULL, NULL, NULL, ?)`,
      [input.slug, eventPayload, input.ownerId, now],
    ],
    [
      `INSERT INTO mutation_outbox (
        document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, mutation_route,
        tombstone_revision, created_at, delivered_at
      )
      VALUES (?, 1, last_insert_rowid(), 'review_room.document.created', ?, ?, NULL, NULL, NULL, ?, NULL)`,
      [input.slug, eventPayload, input.ownerId, now],
    ],
  ]);

  const proofDoc = await getHostedDocumentBySlug(input.slug);
  const reviewRoomDocument = await getHostedReviewRoomDocumentByProofSlug(input.slug);
  if (!proofDoc || !reviewRoomDocument) throw new Error('Hosted Review Room document was not persisted.');
  return {
    proofDoc,
    editorAccess,
    reviewRoomDocument,
    member: await getHostedReviewRoomDocumentMemberForProofSlug(input.slug, identityId),
  };
}

export async function addHostedDocumentEvent(
  slug: string,
  eventType: string,
  eventData: unknown,
  actor: string,
): Promise<number> {
  const db = await ensureHostedReviewRoomDatabase();
  const doc = await getHostedDocumentBySlug(slug);
  const now = new Date().toISOString();
  const payload = JSON.stringify(eventData);
  const results = await db.batch([
    [
      `INSERT INTO events (document_slug, event_type, event_data, actor, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [slug, eventType, payload, actor, now],
    ],
    [
      `INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, mutation_route, tombstone_revision, created_at
      )
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      [slug, doc?.revision ?? null, eventType, payload, actor, now],
    ],
    [
      `INSERT INTO mutation_outbox (
        document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, mutation_route,
        tombstone_revision, created_at, delivered_at
      )
      VALUES (?, ?, last_insert_rowid(), ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
      [slug, doc?.revision ?? null, eventType, payload, actor, now],
    ],
  ]);
  const last = results[1];
  return Number(last.lastInsertRowid ?? 0);
}

export async function readHostedDocumentState(slug: string): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  if (doc.share_state === 'REVOKED') {
    return { status: 403, body: { success: false, error: 'Document access revoked' } };
  }
  return {
    status: 200,
    body: {
      success: true,
      slug: doc.slug,
      docId: doc.doc_id,
      title: doc.title,
      shareState: doc.share_state,
      content: doc.markdown,
      markdown: doc.markdown,
      marks: parseMarks(doc.marks),
      updatedAt: doc.updated_at,
      revision: doc.revision,
      readSource: 'hosted_libsql',
      projectionFresh: true,
      repairPending: false,
      mutationReady: true,
    },
  };
}

export async function updateHostedDocument(input: {
  slug: string;
  markdown?: string;
  marks?: Record<string, unknown>;
  title?: string | null;
  actor?: string;
}): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(input.slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  if (doc.share_state === 'REVOKED') {
    return { status: 403, body: { success: false, error: 'Document access has been revoked' } };
  }
  const hasMarkdown = input.markdown !== undefined;
  const hasMarks = input.marks !== undefined;
  const hasTitle = input.title !== undefined;
  if (!hasMarkdown && !hasMarks && !hasTitle) {
    return { status: 400, body: { success: false, error: 'Provide title, marks, and/or markdown' } };
  }

  const db = await ensureHostedReviewRoomDatabase();
  const now = new Date().toISOString();
  // The canonical markdown column must stay free of `<span data-proof>` mark
  // wrappers: marks are persisted structurally and the client re-embeds them
  // for display. Storing the embedded spans pollutes the source text and breaks
  // anchor resolution on accept, so strip them at this single write chokepoint.
  const markdown = hasMarkdown ? stripAllProofSpanTags(input.markdown ?? '') : doc.markdown;
  const marks = hasMarks ? input.marks ?? {} : parseMarks(doc.marks);
  const title = hasTitle ? input.title ?? null : doc.title;
  const reviewRoomTitle = typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'Untitled';
  const revision = Number(doc.revision ?? 1) + (hasMarkdown ? 1 : 0);
  const marksJson = JSON.stringify(marks);
  const actor = input.actor?.trim() || 'review-room:user';
  const eventData = JSON.stringify({
    title,
    markdownUpdated: hasMarkdown,
    marksUpdated: hasMarks,
    titleUpdated: hasTitle,
    directApply: hasMarkdown && actor.startsWith('ai:'),
  });

  const results = await db.batch([
    [
      `UPDATE documents
       SET title = ?, markdown = ?, marks = ?, revision = ?, updated_at = ?
       WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')`,
      [title, markdown, marksJson, revision, now, input.slug],
    ],
    [
      `INSERT INTO document_projections (
        document_slug, revision, y_state_version, markdown, marks_json, plain_text, updated_at, health, health_reason
      )
      VALUES (?, ?, 0, ?, ?, ?, ?, 'healthy', NULL)
      ON CONFLICT (document_slug) DO UPDATE SET
        revision = excluded.revision,
        markdown = excluded.markdown,
        marks_json = excluded.marks_json,
        plain_text = excluded.plain_text,
        updated_at = excluded.updated_at,
        health = 'healthy',
        health_reason = NULL`,
      [input.slug, revision, markdown, marksJson, plainText(markdown), now],
    ],
    [
      `INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, mutation_route, tombstone_revision, created_at
      )
      VALUES (?, ?, 'document.updated', ?, ?, NULL, 'PUT /documents/:slug', NULL, ?)`,
      [input.slug, revision, eventData, actor, now],
    ],
    [
      `INSERT INTO mutation_outbox (
        document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, mutation_route,
        tombstone_revision, created_at, delivered_at
      )
      VALUES (?, ?, last_insert_rowid(), 'document.updated', ?, ?, NULL, 'PUT /documents/:slug', NULL, ?, NULL)`,
      [input.slug, revision, eventData, actor, now],
    ],
    [
      `UPDATE review_room_documents
       SET title = CASE WHEN ? THEN ? ELSE title END,
           updated_at = ?
       WHERE proof_slug = ?`,
      [hasTitle ? 1 : 0, reviewRoomTitle, now, input.slug],
    ],
  ]);

  if (Number(results[0].rowsAffected ?? 0) <= 0) {
    return { status: 409, body: { success: false, error: 'Document changed during update; retry with latest state' } };
  }

  return {
    status: 200,
    body: {
      success: true,
      slug: input.slug,
      title,
      markdown,
      marks,
      updatedAt: now,
      revision,
      shareState: doc.share_state,
    },
  };
}

export async function deleteHostedReviewRoomDocument(slug: string, actor: string = 'review-room:user'): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  const db = await ensureHostedReviewRoomDatabase();
  const now = new Date().toISOString();
  const payload = JSON.stringify({ shareState: 'DELETED' });
  const results = await db.batch([
    [
      `UPDATE documents
       SET share_state = 'DELETED', active = 0, deleted_at = ?, updated_at = ?
       WHERE slug = ?`,
      [now, now, slug],
    ],
    [
      `UPDATE document_access
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE document_slug = ?`,
      [now, slug],
    ],
    [
      `UPDATE review_room_documents
       SET updated_at = ?
       WHERE proof_slug = ?`,
      [now, slug],
    ],
    [
      `INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, mutation_route, tombstone_revision, created_at
      )
      VALUES (?, ?, 'document.deleted', ?, ?, NULL, 'DELETE /documents/:slug', ?, ?)`,
      [slug, doc.revision, payload, actor, doc.revision, now],
    ],
    [
      `INSERT INTO mutation_outbox (
        document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, mutation_route,
        tombstone_revision, created_at, delivered_at
      )
      VALUES (?, ?, last_insert_rowid(), 'document.deleted', ?, ?, NULL, 'DELETE /documents/:slug', ?, ?, NULL)`,
      [slug, doc.revision, payload, actor, doc.revision, now],
    ],
  ]);
  if (Number(results[0].rowsAffected ?? 0) <= 0) {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  return {
    status: 200,
    body: {
      success: true,
      slug,
      shareState: 'DELETED',
      deletedAt: now,
      snapshotUrl: null,
    },
  };
}

async function persistHostedMarks(
  slug: string,
  marks: Record<string, unknown>,
  actor: string,
  eventType: string,
  eventData: Record<string, unknown>,
): Promise<HostedEngineExecutionResult> {
  const db = await ensureHostedReviewRoomDatabase();
  const now = new Date().toISOString();
  const marksJson = JSON.stringify(marks);
  const payload = JSON.stringify(eventData);
  const results = await db.batch([
    [
      `UPDATE documents
       SET marks = ?, updated_at = ?
       WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')`,
      [marksJson, now, slug],
    ],
    [
      `UPDATE document_projections
       SET marks_json = ?, updated_at = ?
       WHERE document_slug = ?`,
      [marksJson, now, slug],
    ],
    [
      `INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, mutation_route, tombstone_revision, created_at
      )
      VALUES (?, (SELECT revision FROM documents WHERE slug = ?), ?, ?, ?, NULL, NULL, NULL, ?)`,
      [slug, slug, eventType, payload, actor, now],
    ],
    [
      `INSERT INTO mutation_outbox (
        document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, mutation_route,
        tombstone_revision, created_at, delivered_at
      )
      VALUES (?, (SELECT revision FROM documents WHERE slug = ?), last_insert_rowid(), ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
      [slug, slug, eventType, payload, actor, now],
    ],
  ]);
  if (Number(results[0].rowsAffected ?? 0) <= 0) {
    return { status: 409, body: { success: false, error: 'Document changed during update; retry with latest state' } };
  }
  const eventId = Number(results[2].lastInsertRowid ?? 0);
  const updated = await getHostedDocumentBySlug(slug);
  return {
    status: 200,
    body: {
      success: true,
      eventId,
      ...(typeof eventData.markId === 'string' ? { markId: eventData.markId } : {}),
      shareState: updated?.share_state ?? 'ACTIVE',
      updatedAt: updated?.updated_at ?? now,
      marks,
    },
  };
}

async function addHostedComment(slug: string, body: Record<string, unknown>): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  if (doc.share_state !== 'ACTIVE') {
    return { status: 403, body: { success: false, error: 'Document is not currently accessible' } };
  }
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return { status: 400, body: { success: false, error: 'Missing text' } };
  const quote = typeof body.quote === 'string' ? body.quote.trim() : '';
  if (quote && !doc.markdown.includes(quote)) {
    return {
      status: 409,
      body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Comment anchor quote not found in document' },
    };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const marks = parseMarks(doc.marks);
  marks[id] = {
    kind: 'comment',
    by,
    createdAt: now,
    quote,
    text,
    threadId: id,
    thread: [],
    resolved: false,
  };
  return persistHostedMarks(slug, marks, by, 'comment.added', { markId: id, by, quote, text });
}

async function replyHostedComment(slug: string, body: Record<string, unknown>): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  if (doc.share_state !== 'ACTIVE') {
    return { status: 403, body: { success: false, error: 'Document is not currently accessible' } };
  }
  const markId = typeof body.markId === 'string' && body.markId.trim() ? body.markId.trim() : '';
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!markId || !text.trim()) return { status: 400, body: { success: false, error: 'Missing markId/text' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { status: 404, body: { success: false, error: 'Mark not found' } };
  }
  const existingRecord = existing as Record<string, unknown>;
  const threadReplies = Array.isArray(existingRecord.thread)
    ? existingRecord.thread as Array<{ by: string; text: string; at: string }>
    : [];
  const normalizedReplies = Array.isArray(existingRecord.replies)
    ? existingRecord.replies as Array<{ by: string; text: string; at: string }>
    : [];
  const baseReplies = normalizedReplies.length >= threadReplies.length ? normalizedReplies : threadReplies;
  const replies = [...baseReplies, { by, text, at: new Date().toISOString() }];
  marks[markId] = {
    ...existingRecord,
    thread: replies,
    replies,
    threadId: typeof existingRecord.threadId === 'string' ? existingRecord.threadId : markId,
  };
  return persistHostedMarks(slug, marks, by, 'comment.replied', { markId, by, text });
}

async function resolveHostedComment(slug: string, body: Record<string, unknown>): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  if (doc.share_state !== 'ACTIVE') {
    return { status: 403, body: { success: false, error: 'Document is not currently accessible' } };
  }
  const markId = typeof body.markId === 'string' && body.markId.trim() ? body.markId.trim() : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { status: 404, body: { success: false, error: 'Mark not found' } };
  }
  const existingRecord = existing as Record<string, unknown>;
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'review-room:user';
  marks[markId] = { ...existingRecord, resolved: true };
  return persistHostedMarks(slug, marks, by, 'comment.resolved', { markId, by });
}

async function unresolveHostedComment(slug: string, body: Record<string, unknown>): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  if (doc.share_state !== 'ACTIVE') {
    return { status: 403, body: { success: false, error: 'Document is not currently accessible' } };
  }
  const markId = typeof body.markId === 'string' && body.markId.trim() ? body.markId.trim() : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { status: 404, body: { success: false, error: 'Mark not found' } };
  }
  const existingRecord = existing as Record<string, unknown>;
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'review-room:user';
  marks[markId] = { ...existingRecord, resolved: false };
  return persistHostedMarks(slug, marks, by, 'comment.unresolved', { markId, by });
}

async function addHostedSuggestion(slug: string, body: Record<string, unknown>): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  if (doc.share_state !== 'ACTIVE') {
    return { status: 403, body: { success: false, error: 'Document is not currently accessible' } };
  }
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'replace';
  const quote = typeof body.quote === 'string' ? body.quote.trim() : '';
  const content = normalizeHostedInsertSuggestionContent(typeof body.content === 'string' ? body.content : '', kind);
  if (!quote && kind !== 'insert') return { status: 400, body: { success: false, error: 'Missing quote' } };
  if (quote && !doc.markdown.includes(quote)) {
    return {
      status: 409,
      body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion anchor quote not found in document' },
    };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const marks = parseMarks(doc.marks);
  marks[id] = {
    kind: 'suggestion',
    suggestionKind: kind,
    by,
    createdAt: now,
    quote,
    content,
    status: body.status === 'accepted' ? 'accepted' : 'pending',
  };
  return persistHostedMarks(slug, marks, by, 'suggestion.added', { markId: id, by, kind, quote, content });
}

function getHostedSuggestionKind(mark: Record<string, unknown>): 'insert' | 'delete' | 'replace' | null {
  const kind = typeof mark.kind === 'string' ? mark.kind : '';
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  const suggestionKind = typeof mark.suggestionKind === 'string' ? mark.suggestionKind : '';
  if (suggestionKind === 'insert' || suggestionKind === 'delete' || suggestionKind === 'replace') return suggestionKind;
  return null;
}

function hostedReviewRoomActorType(actor: string): 'human' | 'agent' {
  return actor.trim().toLowerCase().startsWith('ai:') ? 'agent' : 'human';
}

function hostedSuggestionChangeContent(
  mark: Record<string, unknown>,
  status: 'accepted' | 'rejected',
): { beforeContent: string; afterContent: string } {
  const kind = getHostedSuggestionKind(mark);
  const quote = typeof mark.quote === 'string' ? mark.quote : '';
  const content = typeof mark.content === 'string' ? mark.content : '';
  if (status === 'rejected') return { beforeContent: quote, afterContent: quote };
  if (kind === 'delete') return { beforeContent: quote, afterContent: '' };
  if (kind === 'insert') return { beforeContent: '', afterContent: content };
  return { beforeContent: quote, afterContent: content };
}

function normalizeHostedInsertSuggestionContent(content: string, kind: string): string {
  if (kind !== 'insert' || content.length === 0 || content.startsWith('\n')) return content;
  if (/^(?: {0,3}#{1,6}\s| {0,3}(?:[-*+]|\d+[.)])\s| {0,3}>\s| {0,3}(?:```|~~~)| {0,3}\|)/.test(content)) {
    return `\n\n${content}`;
  }
  return content;
}

async function recordHostedReviewRoomSuggestionDecisionHistory(input: {
  slug: string;
  markId: string;
  status: 'accepted' | 'rejected';
  actor: string;
  mark: Record<string, unknown>;
  beforeRevision?: number | null;
  afterRevision?: number | null;
  eventId?: unknown;
}): Promise<void> {
  const reviewRoomDocument = await getHostedReviewRoomDocumentByProofSlug(input.slug);
  if (!reviewRoomDocument) return;
  const kind = getHostedSuggestionKind(input.mark) ?? 'suggestion';
  const quote = typeof input.mark.quote === 'string' ? input.mark.quote : '';
  const content = typeof input.mark.content === 'string' ? input.mark.content : '';
  const previousStatus = typeof input.mark.status === 'string' ? input.mark.status : 'pending';
  const { beforeContent, afterContent } = hostedSuggestionChangeContent(input.mark, input.status);
  try {
    await createHostedReviewRoomHistoryEvent({
      workspaceId: reviewRoomDocument.workspace_id,
      documentId: reviewRoomDocument.id,
      actorId: input.actor,
      actorType: hostedReviewRoomActorType(input.actor),
      eventType: `suggestion.${input.status}`,
      targetType: 'suggestion',
      targetId: input.markId,
      before: {
        status: previousStatus,
        kind,
        quote,
        content,
        beforeContent,
      },
      after: {
        status: input.status,
        kind,
        quote,
        content,
        afterContent,
      },
      metadata: {
        proofSlug: input.slug,
        proofRevisionBefore: input.beforeRevision ?? null,
        proofRevisionAfter: input.afterRevision ?? null,
        proofEventId: typeof input.eventId === 'number' ? input.eventId : null,
      },
    });
  } catch (error) {
    console.warn('[review-room] Failed to record hosted suggestion decision history:', {
      slug: input.slug,
      markId: input.markId,
      status: input.status,
      error,
    });
  }
}

// Locate a suggestion's quote in clean (span-free) markdown. Tries an exact
// substring match first, then a whitespace-tolerant match so minor projection
// reflow (collapsed or re-wrapped whitespace) does not hard-fail the accept.
function locateHostedQuote(markdown: string, quote: string): { index: number; length: number } | null {
  const exact = markdown.indexOf(quote);
  if (exact >= 0) return { index: exact, length: quote.length };

  const normalizedQuote = quote.replace(/\s+/g, ' ').trim();
  if (!normalizedQuote) return null;
  const pattern = normalizedQuote
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+');
  const match = markdown.match(new RegExp(pattern));
  return match && match.index !== undefined ? { index: match.index, length: match[0].length } : null;
}

function applyHostedAcceptedSuggestion(
  markdown: string,
  markId: string,
  mark: Record<string, unknown>,
): { ok: true; markdown: string } | { ok: false; body: Record<string, unknown> } {
  const kind = getHostedSuggestionKind(mark);
  if (!kind) {
    return { ok: false, body: { success: false, code: 'INVALID_SUGGESTION', error: 'Mark is not an actionable suggestion' } };
  }
  const quote = typeof mark.quote === 'string' ? mark.quote : '';
  const content = typeof mark.content === 'string' ? mark.content : '';

  // Primary path: resolve against the mark's own `<span data-proof>` wrappers.
  // The spans delimit the exact target even when the run is split across spans
  // or contains markdown syntax (e.g. inline code), which a raw quote substring
  // match cannot survive. This also returns clean markdown, de-polluting the doc.
  const bySpan = applyProofSuggestionByProofSpanId(markdown, markId, kind, content);
  if (bySpan.matched) {
    return { ok: true, markdown: bySpan.markdown };
  }

  // Fallback: the mark has no spans in the canonical markdown (clean document).
  // Resolve the quote against the span-stripped text.
  const clean = bySpan.markdown;
  if (kind === 'insert') {
    if (!quote) return { ok: true, markdown: `${clean}${clean.endsWith('\n') ? '' : '\n\n'}${content}` };
    const located = locateHostedQuote(clean, quote);
    if (!located) {
      return { ok: false, body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion anchor quote not found in document' } };
    }
    const insertAt = located.index + located.length;
    return { ok: true, markdown: `${clean.slice(0, insertAt)}${content}${clean.slice(insertAt)}` };
  }
  if (!quote) {
    return { ok: false, body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion requires a quote anchor' } };
  }
  const located = locateHostedQuote(clean, quote);
  if (!located) {
    return { ok: false, body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion anchor quote not found in document' } };
  }
  if (kind === 'delete') {
    return { ok: true, markdown: `${clean.slice(0, located.index)}${clean.slice(located.index + located.length)}` };
  }
  return {
    ok: true,
    markdown: `${clean.slice(0, located.index)}${content}${clean.slice(located.index + located.length)}`,
  };
}

async function updateHostedSuggestionStatus(
  slug: string,
  body: Record<string, unknown>,
  status: 'accepted' | 'rejected',
): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  if (doc.share_state !== 'ACTIVE') {
    return { status: 403, body: { success: false, error: 'Document is not currently accessible' } };
  }
  const markId = typeof body.markId === 'string' && body.markId.trim()
    ? body.markId.trim()
    : typeof body.id === 'string' && body.id.trim()
      ? body.id.trim()
      : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };
  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { status: 404, body: { success: false, error: 'Mark not found' } };
  }
  const existingRecord = existing as Record<string, unknown>;
  if (!getHostedSuggestionKind(existingRecord)) {
    return { status: 400, body: { success: false, code: 'INVALID_MARK', error: 'Mark is not a suggestion' } };
  }
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'review-room:user';
  const nextMarks = {
    ...marks,
    [markId]: {
      ...existingRecord,
      status,
    },
  };
  if (status === 'rejected') {
    const result = await persistHostedMarks(slug, nextMarks, by, 'suggestion.rejected', { markId, status, by });
    if (result.status >= 200 && result.status < 300) {
      const nextDoc = await getHostedDocumentBySlug(slug);
      await recordHostedReviewRoomSuggestionDecisionHistory({
        slug,
        markId,
        status,
        actor: by,
        mark: existingRecord,
        beforeRevision: doc.revision,
        afterRevision: nextDoc?.revision ?? doc.revision + 1,
        eventId: result.body.eventId,
      });
    }
    return result;
  }

  const applied = applyHostedAcceptedSuggestion(doc.markdown, markId, existingRecord);
  if (!applied.ok) return { status: 409, body: applied.body };
  const updated = await updateHostedDocument({
    slug,
    markdown: applied.markdown,
    marks: nextMarks,
    actor: by,
  });
  if (updated.status < 200 || updated.status >= 300) return updated;
  const proofEventId = await addHostedDocumentEvent(slug, 'suggestion.accepted', { markId, status, by }, by);
  const nextDoc = await getHostedDocumentBySlug(slug);
  await recordHostedReviewRoomSuggestionDecisionHistory({
    slug,
    markId,
    status,
    actor: by,
    mark: existingRecord,
    beforeRevision: doc.revision,
    afterRevision: nextDoc?.revision ?? doc.revision + 1,
    eventId: proofEventId,
  });
  return {
    status: 200,
    body: {
      success: true,
      markId,
      status,
      shareState: nextDoc?.share_state ?? doc.share_state,
      updatedAt: nextDoc?.updated_at ?? new Date().toISOString(),
      content: nextDoc?.markdown ?? applied.markdown,
      markdown: nextDoc?.markdown ?? applied.markdown,
      marks: nextMarks,
    },
  };
}

export async function buildHostedAgentSnapshot(slug: string): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found', code: 'NOT_FOUND' } };
  }
  if (doc.share_state === 'REVOKED') {
    return { status: 403, body: { success: false, error: 'Document access revoked', code: 'FORBIDDEN' } };
  }
  return { status: 200, body: buildHostedSnapshotBody(doc) };
}

export async function applyHostedAgentEditV2(slug: string, body: Record<string, unknown>): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, code: 'NOT_FOUND', error: 'Document not found' } };
  }
  if (doc.share_state !== 'ACTIVE') {
    return { status: 403, body: { success: false, code: 'FORBIDDEN', error: 'Document is not currently editable' } };
  }

  const baseRevision = typeof body.baseRevision === 'number' ? body.baseRevision : null;
  if (!Number.isInteger(baseRevision) || baseRevision === null || baseRevision < 1) {
    return { status: 400, body: { success: false, code: 'INVALID_REQUEST', error: 'baseRevision is required' } };
  }
  if (baseRevision !== doc.revision) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'STALE_REVISION',
        error: 'Document changed since baseRevision',
        snapshot: buildHostedSnapshotBody(doc),
      },
    };
  }

  const normalized = normalizeHostedEditV2Operations(body.operations);
  if ('error' in normalized) {
    return {
      status: 400,
      body: { success: false, code: 'INVALID_OPERATIONS', error: normalized.error, opIndex: normalized.opIndex ?? null },
    };
  }

  const applied = applyHostedEditV2Operations(doc.markdown, normalized.operations);
  if ('error' in applied) {
    return {
      status: 400,
      body: { success: false, code: applied.code, error: applied.error, opIndex: applied.opIndex },
    };
  }

  const actor = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const updated = await updateHostedDocument({ slug, markdown: applied.markdown, actor });
  if (updated.status < 200 || updated.status >= 300) return updated;
  const nextDoc = await getHostedDocumentBySlug(slug);
  return {
    status: 200,
    body: {
      success: true,
      slug,
      revision: nextDoc?.revision ?? (doc.revision + 1),
      updatedAt: nextDoc?.updated_at ?? new Date().toISOString(),
      collab: {
        status: 'not_available',
        reason: 'hosted-libsql-serverless',
      },
      collabApplied: false,
      snapshot: nextDoc ? buildHostedSnapshotBody(nextDoc) : null,
    },
  };
}

export async function applyHostedAgentEdit(slug: string, body: Record<string, unknown>): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  if (doc.share_state !== 'ACTIVE') {
    return { status: 403, body: { success: false, error: 'Document is not currently editable' } };
  }
  const operationsRaw = Array.isArray(body.operations) ? body.operations : [];
  const operations: AgentEditOperation[] = [];
  for (let i = 0; i < operationsRaw.length; i += 1) {
    const op = operationsRaw[i];
    if (!op || typeof op !== 'object' || Array.isArray(op) || typeof (op as Record<string, unknown>).op !== 'string') {
      return { status: 400, body: { success: false, code: 'INVALID_OPERATIONS', error: `Invalid operation at index ${i}` } };
    }
    const record = op as Record<string, unknown>;
    if (record.op === 'append' && typeof record.section === 'string' && typeof record.content === 'string') {
      operations.push({ op: 'append', section: record.section, content: record.content });
      continue;
    }
    if (record.op === 'replace' && typeof record.content === 'string') {
      operations.push({
        op: 'replace',
        search: typeof record.search === 'string' ? record.search : undefined,
        content: record.content,
      });
      continue;
    }
    if (record.op === 'insert' && typeof record.content === 'string') {
      operations.push({
        op: 'insert',
        after: typeof record.after === 'string' ? record.after : undefined,
        content: record.content,
      });
      continue;
    }
    return { status: 400, body: { success: false, code: 'INVALID_OPERATIONS', error: `Unsupported operation at index ${i}` } };
  }
  if (!operations.length) {
    return { status: 400, body: { success: false, code: 'INVALID_OPERATIONS', error: 'operations must be a non-empty array' } };
  }
  const actor = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const applied = applyAgentEditOperations(doc.markdown, operations, { by: actor });
  if (!applied.ok) {
    return {
      status: applied.code === 'ANCHOR_NOT_FOUND' ? 409 : 400,
      body: {
        success: false,
        code: applied.code,
        error: applied.message,
        opIndex: applied.opIndex,
        nextSteps: applied.nextSteps,
      },
    };
  }
  const updated = await updateHostedDocument({ slug, markdown: applied.markdown, actor });
  if (updated.status < 200 || updated.status >= 300) return updated;
  const nextDoc = await getHostedDocumentBySlug(slug);
  return {
    status: 200,
    body: {
      success: true,
      slug,
      updatedAt: nextDoc?.updated_at ?? new Date().toISOString(),
      revision: nextDoc?.revision ?? (doc.revision + 1),
      collabApplied: false,
      collab: { status: 'not_available', reason: 'hosted-libsql-serverless' },
      snapshot: nextDoc ? buildHostedSnapshotBody(nextDoc) : null,
    },
  };
}

export async function executeHostedDocumentOpByType(
  slug: string,
  op: DocumentOpType,
  payload: Record<string, unknown>,
): Promise<HostedEngineExecutionResult> {
  const opRoute = resolveDocumentOpRoute(op, payload);
  if (!opRoute) return { status: 400, body: { success: false, error: 'Unsupported operation payload' } };
  if (op === 'rewrite.apply') {
    const content = typeof payload.content === 'string' ? payload.content : '';
    if (!content.trim()) return { status: 400, body: { success: false, error: 'rewrite.apply requires content' } };
    const actor = typeof payload.by === 'string' && payload.by.trim() ? payload.by.trim() : 'ai:unknown';
    const updated = await updateHostedDocument({ slug, markdown: content, actor });
    if (updated.status < 200 || updated.status >= 300) return updated;
    const nextDoc = await getHostedDocumentBySlug(slug);
    return {
      status: 200,
      body: {
        success: true,
        slug,
        updatedAt: nextDoc?.updated_at ?? new Date().toISOString(),
        revision: nextDoc?.revision ?? null,
        collabApplied: false,
        collab: { status: 'not_available', reason: 'hosted-libsql-serverless' },
        directApply: true,
        proposedEdits: false,
        reviewableAlternative: {
          type: 'suggestion.add',
          endpoint: `/documents/${encodeURIComponent(slug)}/ops`,
          bridgeEndpoint: `/documents/${encodeURIComponent(slug)}/bridge/suggestions`,
        },
      },
    };
  }
  if (op === 'suggestion.add') return addHostedSuggestion(slug, payload);
  return executeHostedDocumentOperation(slug, opRoute.method, opRoute.path, opRoute.body);
}

export async function executeHostedAgentOps(slug: string, body: Record<string, unknown>): Promise<HostedEngineExecutionResult> {
  const parsed = parseDocumentOpRequest(body);
  if ('error' in parsed) return { status: 400, body: { success: false, error: parsed.error } };
  return executeHostedDocumentOpByType(slug, parsed.op, parsed.payload);
}

export async function recordHostedAgentPresence(slug: string, body: Record<string, unknown>): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found' } };
  }
  const agentId = typeof body.agentId === 'string' && body.agentId.trim()
    ? body.agentId.trim()
    : typeof body.id === 'string' && body.id.trim()
      ? body.id.trim()
      : 'ai:agent';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : agentId;
  const status = typeof body.status === 'string' && body.status.trim() ? body.status.trim() : 'idle';
  await addHostedDocumentEvent(slug, 'agent.presence', { agentId, name, status }, agentId);
  return {
    status: 200,
    body: {
      success: true,
      slug,
      agentId,
      collabApplied: false,
      collab: { status: 'not_available', reason: 'hosted-libsql-serverless' },
    },
  };
}

export async function executeHostedDocumentOperation(
  slug: string,
  method: string,
  routePath: string,
  body: Record<string, unknown> = {},
): Promise<HostedEngineExecutionResult> {
  if (!isHostedReviewRoomDbEnabled()) {
    return { status: 404, body: { success: false, error: 'Hosted Review Room persistence is not enabled' } };
  }
  if (method === 'GET' && routePath === '/state') return readHostedDocumentState(slug);
  if (method === 'GET' && routePath === '/marks') {
    const doc = await getHostedDocumentBySlug(slug);
    if (!doc) return { status: 404, body: { success: false, error: 'Document not found' } };
    return { status: 200, body: { success: true, marks: parseMarks(doc.marks) } };
  }
  if (method === 'POST' && routePath === '/marks/comment') return addHostedComment(slug, body);
  if (method === 'POST' && routePath === '/marks/suggest-replace') return addHostedSuggestion(slug, { ...body, kind: 'replace' });
  if (method === 'POST' && routePath === '/marks/suggest-insert') return addHostedSuggestion(slug, { ...body, kind: 'insert' });
  if (method === 'POST' && routePath === '/marks/suggest-delete') return addHostedSuggestion(slug, { ...body, kind: 'delete' });
  if (method === 'POST' && routePath === '/marks/reply') return replyHostedComment(slug, body);
  if (method === 'POST' && routePath === '/marks/resolve') return resolveHostedComment(slug, body);
  if (method === 'POST' && routePath === '/marks/unresolve') return unresolveHostedComment(slug, body);
  if (method === 'POST' && routePath === '/marks/accept') return updateHostedSuggestionStatus(slug, body, 'accepted');
  if (method === 'POST' && routePath === '/marks/reject') return updateHostedSuggestionStatus(slug, body, 'rejected');
  return { status: 404, body: { success: false, error: `Unsupported hosted document operation: ${method} ${routePath}` } };
}

export function buildHostedOpenContextBody(input: {
  doc: DocumentRow;
  role: ShareRole;
  reviewRoom?: ReviewRoomDocumentMemberRow | null;
}): Record<string, unknown> {
  const { doc, role, reviewRoom } = input;
  return {
    success: true,
    collabAvailable: false,
    snapshotUrl: null,
    doc: {
      slug: doc.slug,
      docId: doc.doc_id,
      title: doc.title,
      markdown: doc.markdown,
      marks: parseMarks(doc.marks),
      shareState: doc.share_state,
      active: doc.share_state === 'ACTIVE',
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      viewers: 0,
    },
    ...(reviewRoom
      ? {
        reviewRoom: {
          documentId: reviewRoom.review_room_document_id,
          identityId: reviewRoom.identity_id,
          currentRole: reviewRoom.role,
          currentShareRole: reviewRoom.role === 'owner' ? 'owner_bot' : reviewRoom.role,
        },
      }
      : {}),
    capabilities: {
      canRead: doc.share_state === 'ACTIVE' || (role === 'owner_bot' && doc.share_state !== 'DELETED'),
      canComment: doc.share_state === 'ACTIVE' && (role === 'commenter' || role === 'editor' || role === 'owner_bot'),
      canEdit: role === 'owner_bot'
        ? (doc.share_state === 'ACTIVE' || doc.share_state === 'PAUSED')
        : (role === 'editor' && doc.share_state === 'ACTIVE'),
    },
    links: {
      webUrl: `/d/${encodeURIComponent(doc.slug)}`,
      snapshotUrl: null,
    },
    collab: {
      enabled: false,
      reason: 'hosted-libsql-serverless',
    },
  };
}

export async function buildHostedAgentStateBody(
  slug: string,
  token: string | null,
): Promise<HostedEngineExecutionResult> {
  const doc = await getHostedDocumentBySlug(slug);
  if (!doc) return { status: 404, body: { success: false, error: 'Document not found' } };
  const access = token ? await resolveHostedDocumentAccess(slug, token) : null;
  const role = access?.role ?? 'editor';
  if (doc.share_state === 'DELETED') return { status: 410, body: { success: false, error: 'Document deleted' } };
  if (doc.share_state === 'REVOKED' && role !== 'owner_bot') {
    return { status: 403, body: { success: false, error: 'Document access revoked' } };
  }
  if (doc.share_state === 'PAUSED' && role !== 'owner_bot') {
    return { status: 403, body: { success: false, error: 'Document is not currently accessible' } };
  }
  const state = await readHostedDocumentState(slug);
  const advertiseGetOnlyActions = isGetOnlyActionsEnabled();
  const getActionAlias = advertiseGetOnlyActions && access && token ? await createHostedGetActionAlias(slug, token) : null;
  const getActionAuthParam = getActionAlias
    ? `a=${encodeURIComponent(getActionAlias.alias)}`
    : 'token=<token>';
  const body = {
    ...state.body,
    capabilities: deriveReviewRoomCapabilities(
      role === 'owner_bot' ? 'owner' : role as ReviewRoomRole,
      doc.share_state,
    ),
    contract: {
      mutationStage: 'A',
      idempotencyRequired: false,
      preconditionMode: 'optional',
      supportedPreconditions: ['baseRevision', 'baseUpdatedAt'],
      preferredPrecondition: 'baseRevision',
    },
    _links: {
      state: `/documents/${slug}/state`,
      agentState: `/api/agent/${slug}/state`,
      ops: { method: 'POST', href: `/api/agent/${slug}/ops` },
      ...(advertiseGetOnlyActions
        ? {
            getAction: {
              method: 'GET',
              href: `/api/agent/${slug}/action?${getActionAuthParam}&type=suggestion.add&kind=replace&quote=<urlencoded-quote>&content=<urlencoded-content>&by=ai:<agent>`,
              requiresConfirm: true,
              supports: ['comment.add', 'suggestion.add'],
              ...(getActionAlias
                ? {
                    alias: getActionAlias.alias,
                    aliasExpiresAt: getActionAlias.expiresAt,
                    shortHref: `/api/agent/${slug}/action?a=${encodeURIComponent(getActionAlias.alias)}&type=suggestion.add&kind=replace&quote=<short-quote>&contentDraft=<draft>&by=ai:<agent>`,
                  }
                : {}),
            },
          }
        : {}),
      ...(getActionAlias
        ? {
            getActionDraft: {
              method: 'GET',
              href: `/api/agent/${slug}/action/draft?a=${encodeURIComponent(getActionAlias.alias)}&d=<draft>&f=content&i=0&t=<urlencoded-chunk>`,
            },
          }
        : {}),
      comments: { method: 'POST', href: `/documents/${slug}/bridge/comments` },
      title: { method: 'PUT', href: `/api/documents/${slug}/title` },
    },
    agent: {
      what: 'Review Room is a collaborative document review editor.',
      stateApi: `/documents/${slug}/state`,
      agentStateApi: `/api/agent/${slug}/state`,
      opsApi: `/api/agent/${slug}/ops`,
      primaryMutationApi: `/api/agent/${slug}/ops`,
      primaryMutationMethod: 'POST',
      editingGuidance: {
        proposedEdits: 'Use POST /api/agent/:slug/ops with type "suggestion.add" so humans can accept or reject changes.',
        comments: 'Use POST /api/agent/:slug/ops with type "comment.add" for anchored comments.',
        directApply: 'Use edit/v2, edit, or rewrite.apply only when the human explicitly asks for direct application.',
      },
      ...(advertiseGetOnlyActions
        ? {
            getActionApi: `/api/agent/${slug}/action`,
            getActionSupports: ['comment.add', 'suggestion.add'],
            getActionRequiresConfirm: true,
          }
        : {}),
      ...(getActionAlias
        ? {
            getActionAlias: getActionAlias.alias,
            getActionAliasExpiresAt: getActionAlias.expiresAt,
            getActionDraftApi: `/api/agent/${slug}/action/draft`,
            getActionDraftFields: ['quote', 'content', 'text'],
            getActionDraftUse: 'Upload chunks with action/draft, then use quoteDraft, contentDraft, or textDraft on /action.',
          }
        : {}),
      commentReadApi: `/documents/${slug}/state`,
      commentReadPath: 'marks',
      mutationReady: true,
      auth: {
        headerFormat: 'Authorization: Bearer <TOKEN>',
        altHeader: 'x-share-token: <TOKEN>',
      },
    },
  };
  return { status: state.status, body };
}
