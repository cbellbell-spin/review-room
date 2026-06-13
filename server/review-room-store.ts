import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient, type Client, type ResultSet } from '@libsql/client';
import type {
  ReviewRoomAgentRow,
  ReviewRoomAssignmentTaskRow,
  ReviewRoomAssignmentTaskStatus,
  ReviewRoomDocumentMemberRow,
  ReviewRoomDocumentRow,
  ReviewRoomHistoryEventRow,
  ReviewRoomIdentityRow,
  ReviewRoomPublishedVersionRow,
  ReviewRoomRole,
} from './db.js';
import { reviewRoomRoleToShareRole } from './db.js';
import type { ShareRole } from './share-types.js';
import {
  REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
  REVIEW_ROOM_LOCAL_AGENT_ID,
  REVIEW_ROOM_LOCAL_AGENT_NAME,
  REVIEW_ROOM_LOCAL_HUMAN_ID,
  REVIEW_ROOM_LOCAL_HUMAN_NAME,
  REVIEW_ROOM_LOCAL_WORKSPACE_NAME,
} from './review-room-identity.js';

// Single Review Room product-state store. The same libSQL client and SQL serve
// both deployments: hosted points at Turso (TURSO_DATABASE_URL), local points a
// file: URL at the engine's SQLite database, where the review_room_* tables and
// the documents/document_access tables it touches share one schema with hosted.
// Engine-owned tables (documents, document_events, ...) are never created here.

type SqlValue = null | string | number | bigint | ArrayBuffer | boolean | Uint8Array | Date;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client: Client | null = null;
let initialized = false;

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveStoreUrl(): { url: string; authToken?: string } {
  const tursoUrl = (process.env.TURSO_DATABASE_URL || '').trim();
  if (tursoUrl) {
    return { url: tursoUrl, authToken: (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined };
  }
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'proof-share.db');
  return { url: `file:${dbPath}` };
}

function isLocalFileStore(): boolean {
  return !(process.env.TURSO_DATABASE_URL || '').trim();
}

function getClient(): Client {
  if (!client) {
    const { url, authToken } = resolveStoreUrl();
    client = createClient({ url, authToken });
  }
  return client;
}

const REVIEW_ROOM_TABLE_DDL = [
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
];

async function ensureStore(): Promise<Client> {
  const db = getClient();
  if (initialized) return db;
  if (isLocalFileStore()) {
    await db.execute('PRAGMA busy_timeout = 5000');
    await db.execute('PRAGMA journal_mode = WAL');
  }
  for (const ddl of REVIEW_ROOM_TABLE_DDL) {
    await db.execute(ddl);
  }
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

async function execute<T>(sql: string, args: SqlValue[] = []): Promise<T | null> {
  const db = await ensureStore();
  return firstRow<T>(await db.execute({ sql, args }));
}

async function executeAll<T>(sql: string, args: SqlValue[] = []): Promise<T[]> {
  const db = await ensureStore();
  const result = await db.execute({ sql, args });
  return result.rows as T[];
}

export async function storeGetReviewRoomIdentity(id: string = REVIEW_ROOM_LOCAL_HUMAN_ID): Promise<ReviewRoomIdentityRow | null> {
  return execute<ReviewRoomIdentityRow>(`
    SELECT id, workspace_id, kind, display_name, manager_identity_id, created_at, updated_at
    FROM review_room_identities
    WHERE id = ?
    LIMIT 1
  `, [id]);
}

export async function storeUpsertReviewRoomIdentity(input: {
  id: string;
  workspaceId?: string;
  kind?: 'human' | 'agent';
  displayName?: string | null;
  managerIdentityId?: string | null;
}): Promise<ReviewRoomIdentityRow> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const id = input.id.trim();
  const workspaceId = input.workspaceId || REVIEW_ROOM_DEFAULT_WORKSPACE_ID;
  const kind = input.kind === 'agent' ? 'agent' : 'human';
  const displayName = input.displayName?.trim() || id;
  await db.execute({
    sql: `INSERT INTO review_room_identities (id, workspace_id, kind, display_name, manager_identity_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            kind = excluded.kind,
            display_name = excluded.display_name,
            manager_identity_id = excluded.manager_identity_id,
            updated_at = excluded.updated_at`,
    args: [id, workspaceId, kind, displayName, input.managerIdentityId ?? null, now, now],
  });
  const row = await storeGetReviewRoomIdentity(id);
  if (!row) throw new Error('Review Room identity was not persisted.');
  return row;
}

export async function storeListReviewRoomIdentities(workspaceId: string = REVIEW_ROOM_DEFAULT_WORKSPACE_ID): Promise<ReviewRoomIdentityRow[]> {
  return executeAll<ReviewRoomIdentityRow>(`
    SELECT id, workspace_id, kind, display_name, manager_identity_id, created_at, updated_at
    FROM review_room_identities
    WHERE workspace_id = ?
    ORDER BY kind DESC, display_name ASC
  `, [workspaceId]);
}

export async function storeListReviewRoomAgents(workspaceId: string = REVIEW_ROOM_DEFAULT_WORKSPACE_ID): Promise<ReviewRoomAgentRow[]> {
  return executeAll<ReviewRoomAgentRow>(`
    SELECT
      id,
      workspace_id,
      owner_identity_id,
      manager_identity_id,
      name,
      description,
      integration_type,
      capabilities_json,
      created_at,
      updated_at
    FROM review_room_agents
    WHERE workspace_id = ?
    ORDER BY name ASC
  `, [workspaceId]);
}

const DOCUMENT_SELECT = `
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
`;

export async function storeGetReviewRoomDocumentByProofSlug(proofSlug: string): Promise<ReviewRoomDocumentRow | null> {
  return execute<ReviewRoomDocumentRow>(`
    ${DOCUMENT_SELECT}
    WHERE rr.proof_slug = ?
    LIMIT 1
  `, [proofSlug]);
}

export async function storeListReviewRoomDocuments(workspaceId: string = REVIEW_ROOM_DEFAULT_WORKSPACE_ID, limit: number = 50): Promise<ReviewRoomDocumentRow[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
  return executeAll<ReviewRoomDocumentRow>(`
    ${DOCUMENT_SELECT}
    WHERE rr.workspace_id = ?
      AND d.deleted_at IS NULL
      AND d.share_state != 'DELETED'
    ORDER BY rr.updated_at DESC
    LIMIT ?
  `, [workspaceId, safeLimit]);
}

export async function storeUpdateReviewRoomDocumentTitleByProofSlug(proofSlug: string, title: string | null): Promise<boolean> {
  const db = await ensureStore();
  const normalizedTitle = typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'Untitled';
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE review_room_documents SET title = ?, updated_at = ? WHERE proof_slug = ?`,
    args: [normalizedTitle, now, proofSlug],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

const MEMBER_SELECT = `
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
`;

export async function storeGetReviewRoomDocumentMemberForProofSlug(
  proofSlug: string,
  identityId: string = REVIEW_ROOM_LOCAL_HUMAN_ID,
): Promise<ReviewRoomDocumentMemberRow | null> {
  return execute<ReviewRoomDocumentMemberRow>(`
    ${MEMBER_SELECT}
    WHERE rr.proof_slug = ?
      AND m.identity_id = ?
    LIMIT 1
  `, [proofSlug, identityId]);
}

export async function storeGetReviewRoomDocumentMemberForProofSlugAndToken(
  proofSlug: string,
  token: string | null | undefined,
): Promise<ReviewRoomDocumentMemberRow | null> {
  const trimmed = (token || '').trim();
  if (!trimmed) return null;
  return execute<ReviewRoomDocumentMemberRow>(`
    ${MEMBER_SELECT}
    WHERE rr.proof_slug = ?
      AND m.proof_access_token = ?
    LIMIT 1
  `, [proofSlug, trimmed]);
}

export async function storeListReviewRoomDocumentMembersForProofSlug(
  proofSlug: string,
): Promise<ReviewRoomDocumentMemberRow[]> {
  return executeAll<ReviewRoomDocumentMemberRow>(`
    ${MEMBER_SELECT}
    WHERE rr.proof_slug = ?
    ORDER BY
      CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'commenter' THEN 2 ELSE 3 END,
      m.updated_at ASC
  `, [proofSlug]);
}

async function storeCreateDocumentAccessToken(
  slug: string,
  role: ShareRole,
): Promise<{ tokenId: string; secret: string }> {
  const db = await ensureStore();
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

export async function storeUpsertReviewRoomDocumentMember(input: {
  reviewRoomDocumentId: string;
  identityId: string;
  role: ReviewRoomRole;
  proofSlug: string;
  proofAccessTokenId?: string | null;
  proofAccessToken?: string | null;
}): Promise<ReviewRoomDocumentMemberRow> {
  const previous = await storeGetReviewRoomDocumentMemberForProofSlug(input.proofSlug, input.identityId);
  const access = input.proofAccessToken
    ? { tokenId: input.proofAccessTokenId ?? null, secret: input.proofAccessToken }
    : await storeCreateDocumentAccessToken(input.proofSlug, reviewRoomRoleToShareRole(input.role));
  const now = new Date().toISOString();
  const db = await ensureStore();
  if (
    previous?.proof_access_token_id
    && previous.proof_access_token_id !== access.tokenId
  ) {
    await db.execute({
      sql: `UPDATE document_access
            SET revoked_at = ?
            WHERE token_id = ?
              AND document_slug = ?
              AND revoked_at IS NULL`,
      args: [now, previous.proof_access_token_id, input.proofSlug],
    });
  }
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
  const row = await storeGetReviewRoomDocumentMemberForProofSlug(input.proofSlug, input.identityId);
  if (!row) throw new Error('Review Room member record was not persisted.');
  return row;
}

async function storeEnsureReviewRoomIdentity(input: {
  id: string;
  workspaceId: string;
  displayName?: string | null;
}): Promise<void> {
  const existing = await storeGetReviewRoomIdentity(input.id);
  if (existing) return;
  await storeUpsertReviewRoomIdentity({
    id: input.id,
    workspaceId: input.workspaceId,
    kind: 'human',
    displayName: input.displayName ?? input.id,
  });
}

export async function storeCreateReviewRoomDocumentRecord(input: {
  workspaceId?: string;
  title: string;
  proofSlug: string;
  proofDocId?: string | null;
  source?: 'created' | 'registered';
  ownerIdentityId?: string;
  createdByIdentityId?: string;
}): Promise<ReviewRoomDocumentRow> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const id = randomUUID();
  const workspaceId = input.workspaceId || REVIEW_ROOM_DEFAULT_WORKSPACE_ID;
  const ownerIdentityId = input.ownerIdentityId || REVIEW_ROOM_LOCAL_HUMAN_ID;
  const createdByIdentityId = input.createdByIdentityId || ownerIdentityId;
  await storeEnsureReviewRoomIdentity({
    id: ownerIdentityId,
    workspaceId,
  });
  if (createdByIdentityId !== ownerIdentityId) {
    await storeEnsureReviewRoomIdentity({
      id: createdByIdentityId,
      workspaceId,
    });
  }
  await db.execute({
    sql: `INSERT INTO review_room_documents (
      id, workspace_id, title, proof_slug, proof_doc_id, source, owner_identity_id, created_by_identity_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      workspaceId,
      input.title,
      input.proofSlug,
      input.proofDocId ?? null,
      input.source ?? 'created',
      ownerIdentityId,
      createdByIdentityId,
      now,
      now,
    ],
  });
  await storeUpsertReviewRoomDocumentMember({
    reviewRoomDocumentId: id,
    identityId: ownerIdentityId,
    role: 'owner',
    proofSlug: input.proofSlug,
  });
  const row = await storeGetReviewRoomDocumentByProofSlug(input.proofSlug);
  if (!row) throw new Error('Review Room document record was not persisted.');
  return row;
}

export async function storeCreateReviewRoomHistoryEvent(input: {
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
  const db = await ensureStore();
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
  if (!row) throw new Error('Review Room history event was not persisted.');
  return row;
}

export async function storeCreateAssignmentTask(input: {
  documentId: string;
  proofEventId?: number | null;
  sourceType: string;
  sourceId?: string | null;
  createdByActorId: string;
  createdByActorType: ReviewRoomAssignmentTaskRow['created_by_actor_type'];
  assignedToActorId: string;
  assignedToActorType: ReviewRoomAssignmentTaskRow['assigned_to_actor_type'];
  managerIdentityId?: string | null;
}): Promise<ReviewRoomAssignmentTaskRow> {
  const db = await ensureStore();
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO review_room_assignment_tasks (
      id, document_id, proof_event_id, source_type, source_id, created_by_actor_id, created_by_actor_type,
      assigned_to_actor_id, assigned_to_actor_type, manager_identity_id, status, created_at, updated_at, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL)`,
    args: [
      id,
      input.documentId,
      input.proofEventId ?? null,
      input.sourceType,
      input.sourceId ?? null,
      input.createdByActorId,
      input.createdByActorType,
      input.assignedToActorId,
      input.assignedToActorType,
      input.managerIdentityId ?? null,
      now,
      now,
    ],
  });
  const row = await storeGetAssignmentTask(id);
  if (!row) throw new Error('Review Room assignment task was not persisted.');
  return row;
}

export async function storeGetAssignmentTask(id: string): Promise<ReviewRoomAssignmentTaskRow | null> {
  return execute<ReviewRoomAssignmentTaskRow>(`
    SELECT *
    FROM review_room_assignment_tasks
    WHERE id = ?
    LIMIT 1
  `, [id]);
}

export async function storeListAssignmentTasks(
  documentId: string,
  status?: ReviewRoomAssignmentTaskStatus | 'all' | null,
): Promise<ReviewRoomAssignmentTaskRow[]> {
  if (status && status !== 'all') {
    return executeAll<ReviewRoomAssignmentTaskRow>(`
      SELECT *
      FROM review_room_assignment_tasks
      WHERE document_id = ?
        AND status = ?
      ORDER BY created_at DESC
    `, [documentId, status]);
  }
  return executeAll<ReviewRoomAssignmentTaskRow>(`
    SELECT *
    FROM review_room_assignment_tasks
    WHERE document_id = ?
    ORDER BY
      CASE status WHEN 'open' THEN 0 WHEN 'running' THEN 1 WHEN 'delegated' THEN 2 WHEN 'dismissed' THEN 3 ELSE 4 END,
      created_at DESC
  `, [documentId]);
}

export async function storeUpdateAssignmentTaskStatus(
  id: string,
  status: Extract<ReviewRoomAssignmentTaskStatus, 'completed' | 'dismissed'>,
): Promise<ReviewRoomAssignmentTaskRow | null> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE review_room_assignment_tasks
          SET status = ?,
              updated_at = ?,
              completed_at = ?
          WHERE id = ?
            AND status = 'open'`,
    args: [status, now, status === 'completed' ? now : null, id],
  });
  if (Number(result.rowsAffected ?? 0) <= 0) return null;
  return storeGetAssignmentTask(id);
}

export async function storeCreatePublishedVersion(input: {
  documentId: string;
  proofRevision?: number | null;
  contentSnapshot: string;
  createdByIdentityId: string;
  note?: string | null;
}): Promise<ReviewRoomPublishedVersionRow> {
  const db = await ensureStore();
  const id = randomUUID();
  const now = new Date().toISOString();
  const latest = await execute<{ max_version: number | null }>(`
    SELECT MAX(version_number) AS max_version
    FROM review_room_published_versions
    WHERE document_id = ?
  `, [input.documentId]);
  const versionNumber = Math.max(0, Number(latest?.max_version ?? 0)) + 1;
  await db.execute({
    sql: `INSERT INTO review_room_published_versions (
      id, document_id, version_number, proof_revision, content_snapshot, created_by_identity_id, created_at, note
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.documentId,
      versionNumber,
      input.proofRevision ?? null,
      input.contentSnapshot,
      input.createdByIdentityId,
      now,
      input.note ?? null,
    ],
  });
  const row = await storeGetPublishedVersion(id);
  if (!row) throw new Error('Review Room published version was not persisted.');
  return row;
}

export async function storeGetPublishedVersion(id: string): Promise<ReviewRoomPublishedVersionRow | null> {
  return execute<ReviewRoomPublishedVersionRow>(`
    SELECT *
    FROM review_room_published_versions
    WHERE id = ?
    LIMIT 1
  `, [id]);
}

export async function storeListPublishedVersions(
  documentId: string,
  limit: number = 20,
): Promise<ReviewRoomPublishedVersionRow[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  return executeAll<ReviewRoomPublishedVersionRow>(`
    SELECT *
    FROM review_room_published_versions
    WHERE document_id = ?
    ORDER BY version_number DESC
    LIMIT ?
  `, [documentId, safeLimit]);
}

export async function storeGetLatestPublishedVersion(documentId: string): Promise<ReviewRoomPublishedVersionRow | null> {
  return execute<ReviewRoomPublishedVersionRow>(`
    SELECT *
    FROM review_room_published_versions
    WHERE document_id = ?
    ORDER BY version_number DESC
    LIMIT 1
  `, [documentId]);
}

export async function storeListReviewRoomHistoryEvents(input: {
  workspaceId?: string;
  documentId?: string | null;
  limit?: number;
  since?: string | null;
} = {}): Promise<ReviewRoomHistoryEventRow[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 500));
  if (input.documentId) {
    if (input.since) {
      return executeAll<ReviewRoomHistoryEventRow>(`
        SELECT *
        FROM review_room_history_events
        WHERE document_id = ?
          AND created_at > ?
        ORDER BY created_at DESC
        LIMIT ?
      `, [input.documentId, input.since, safeLimit]);
    }
    return executeAll<ReviewRoomHistoryEventRow>(`
      SELECT *
      FROM review_room_history_events
      WHERE document_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `, [input.documentId, safeLimit]);
  }
  return executeAll<ReviewRoomHistoryEventRow>(`
    SELECT *
    FROM review_room_history_events
    WHERE workspace_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `, [input.workspaceId || REVIEW_ROOM_DEFAULT_WORKSPACE_ID, safeLimit]);
}
