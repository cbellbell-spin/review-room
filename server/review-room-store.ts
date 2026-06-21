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
  `CREATE TABLE IF NOT EXISTS review_room_agent_credentials (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    review_request_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by_identity_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_room_agent_credentials_request ON review_room_agent_credentials(review_request_id, created_at)`,
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
  `CREATE TABLE IF NOT EXISTS review_room_agent_review_runs (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    requested_by_identity_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 1,
    model TEXT,
    scope TEXT NOT NULL DEFAULT 'document',
    instructions TEXT,
    claim_token_hash TEXT,
    lease_expires_at TEXT,
    claimed_at TEXT,
    heartbeat_at TEXT,
    cancelled_at TEXT,
    result_count INTEGER NOT NULL DEFAULT 0,
    failed_output_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE (document_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_room_agent_runs_document_created ON review_room_agent_review_runs(document_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_review_room_agent_runs_one_active_v2 ON review_room_agent_review_runs(document_id) WHERE status IN ('queued', 'claimed', 'running')`,
  `CREATE TABLE IF NOT EXISTS review_room_agent_review_outputs (
    run_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    item_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    mark_id TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, item_key)
  )`,
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
  `CREATE TABLE IF NOT EXISTS review_room_identity_invitations (
    id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    review_room_document_id TEXT NOT NULL,
    proof_slug TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by_identity_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_room_identity_invites_identity ON review_room_identity_invitations(identity_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS review_room_sessions (
    id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_room_sessions_identity ON review_room_sessions(identity_id, expires_at)`,
];

export type ReviewRoomAgentReviewRunStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'lease_expired';

export type ReviewRoomAgentReviewRun = {
  id: string;
  document_id: string;
  agent_id: string;
  requested_by_identity_id: string;
  idempotency_key: string;
  status: ReviewRoomAgentReviewRunStatus;
  attempt_count: number;
  model: string | null;
  scope: string;
  instructions: string | null;
  claim_token_hash: string | null;
  lease_expires_at: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  cancelled_at: string | null;
  result_count: number;
  failed_output_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type ReviewRoomAgentReviewOutput = {
  run_id: string;
  item_key: string;
  item_type: string;
  status: 'pending' | 'applied' | 'failed';
  mark_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewRoomAgentCredential = {
  id: string;
  document_id: string;
  review_request_id: string;
  agent_id: string;
  token_hash: string;
  created_by_identity_id: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  proof_slug?: string;
  request_status?: ReviewRoomAgentReviewRunStatus;
};

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
  // The review-request protocol replaced an unshipped provider-runner experiment.
  // Keep local development databases forward-compatible while the schema is still pre-release.
  for (const column of [
    "scope TEXT NOT NULL DEFAULT 'document'",
    'instructions TEXT',
    'claim_token_hash TEXT',
    'lease_expires_at TEXT',
    'claimed_at TEXT',
    'heartbeat_at TEXT',
    'cancelled_at TEXT',
  ]) {
    try {
      await db.execute(`ALTER TABLE review_room_agent_review_runs ADD COLUMN ${column}`);
    } catch {
      // Existing databases already have the column.
    }
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
  const result = await db.execute({
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

export type ReviewRoomIdentityInvitation = {
  id: string;
  identity_id: string;
  review_room_document_id: string;
  proof_slug: string;
  created_by_identity_id: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type ReviewRoomSession = {
  id: string;
  identity_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_seen_at: string;
};

export async function storeCreateReviewRoomIdentityInvitation(input: {
  identityId: string;
  reviewRoomDocumentId: string;
  proofSlug: string;
  createdByIdentityId: string;
  ttlMs?: number;
}): Promise<{ invitation: ReviewRoomIdentityInvitation; secret: string }> {
  const now = new Date();
  const id = randomUUID();
  const secret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 7 * 24 * 60 * 60 * 1000)).toISOString();
  const db = await ensureStore();
  await db.batch([
    {
      sql: `UPDATE review_room_identity_invitations
            SET revoked_at = ?
            WHERE identity_id = ?
              AND review_room_document_id = ?
              AND accepted_at IS NULL
              AND revoked_at IS NULL`,
      args: [now.toISOString(), input.identityId, input.reviewRoomDocumentId],
    },
    {
      sql: `INSERT INTO review_room_identity_invitations (
              id, identity_id, review_room_document_id, proof_slug, token_hash,
              created_by_identity_id, expires_at, accepted_at, revoked_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      args: [
        id,
        input.identityId,
        input.reviewRoomDocumentId,
        input.proofSlug,
        hashSecret(secret),
        input.createdByIdentityId,
        expiresAt,
        now.toISOString(),
      ],
    },
  ]);
  const invitation = await execute<ReviewRoomIdentityInvitation>(`
    SELECT id, identity_id, review_room_document_id, proof_slug, created_by_identity_id,
           expires_at, accepted_at, revoked_at, created_at
    FROM review_room_identity_invitations WHERE id = ? LIMIT 1
  `, [id]);
  if (!invitation) throw new Error('Review Room identity invitation was not persisted.');
  return { invitation, secret };
}

export async function storeConsumeReviewRoomIdentityInvitation(secret: string): Promise<ReviewRoomIdentityInvitation | null> {
  const now = new Date().toISOString();
  return execute<ReviewRoomIdentityInvitation>(`
    UPDATE review_room_identity_invitations
    SET accepted_at = ?
    WHERE token_hash = ?
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > ?
    RETURNING id, identity_id, review_room_document_id, proof_slug, created_by_identity_id,
              expires_at, accepted_at, revoked_at, created_at
  `, [now, hashSecret(secret), now]);
}

export async function storeCreateReviewRoomSession(identityId: string, ttlMs: number = 30 * 24 * 60 * 60 * 1000): Promise<{
  session: ReviewRoomSession;
  secret: string;
}> {
  const now = new Date();
  const id = randomUUID();
  const secret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const db = await ensureStore();
  await db.execute({
    sql: `INSERT INTO review_room_sessions (id, identity_id, token_hash, expires_at, revoked_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    args: [id, identityId, hashSecret(secret), expiresAt, now.toISOString(), now.toISOString()],
  });
  const session = await execute<ReviewRoomSession>(`
    SELECT id, identity_id, expires_at, revoked_at, created_at, last_seen_at
    FROM review_room_sessions WHERE id = ? LIMIT 1
  `, [id]);
  if (!session) throw new Error('Review Room session was not persisted.');
  return { session, secret };
}

export async function storeResolveReviewRoomSession(secret: string | null | undefined): Promise<ReviewRoomSession | null> {
  const trimmed = (secret ?? '').trim();
  if (!trimmed) return null;
  const now = new Date().toISOString();
  return execute<ReviewRoomSession>(`
    SELECT id, identity_id, expires_at, revoked_at, created_at, last_seen_at
    FROM review_room_sessions
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    LIMIT 1
  `, [hashSecret(trimmed), now]);
}

export async function storeRevokeReviewRoomSession(secret: string | null | undefined): Promise<boolean> {
  const trimmed = (secret ?? '').trim();
  if (!trimmed) return false;
  const result = await (await ensureStore()).execute({
    sql: `UPDATE review_room_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
    args: [new Date().toISOString(), hashSecret(trimmed)],
  });
  return result.rowsAffected > 0;
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

export async function storeCreateReviewRoomAgentCredential(input: {
  documentId: string;
  reviewRequestId: string;
  agentId: string;
  agentName: string;
  tokenHash: string;
  createdByIdentityId: string;
  expiresAt: string;
}): Promise<ReviewRoomAgentCredential> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  await storeUpsertReviewRoomIdentity({
    id: input.agentId,
    kind: 'agent',
    displayName: input.agentName,
    managerIdentityId: input.createdByIdentityId,
  });
  await db.execute({
    sql: `INSERT INTO review_room_agents (
            id, workspace_id, owner_identity_id, manager_identity_id, name, description,
            integration_type, capabilities_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'external', ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            manager_identity_id = excluded.manager_identity_id,
            name = excluded.name,
            capabilities_json = excluded.capabilities_json,
            updated_at = excluded.updated_at`,
    args: [
      input.agentId,
      REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
      input.createdByIdentityId,
      input.createdByIdentityId,
      input.agentName,
      'External BYO agent with request-scoped Review Room access.',
      JSON.stringify(['read', 'comment', 'suggest', 'claim', 'heartbeat', 'complete', 'fail', 'release']),
      now,
      now,
    ],
  });
  await db.execute({
    sql: `UPDATE review_room_agent_credentials
          SET revoked_at = ?
          WHERE review_request_id = ? AND revoked_at IS NULL`,
    args: [now, input.reviewRequestId],
  });
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO review_room_agent_credentials (
            id, document_id, review_request_id, agent_id, token_hash,
            created_by_identity_id, expires_at, revoked_at, last_used_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    args: [
      id,
      input.documentId,
      input.reviewRequestId,
      input.agentId,
      input.tokenHash,
      input.createdByIdentityId,
      input.expiresAt,
      now,
    ],
  });
  const credential = await storeGetReviewRoomAgentCredential(id);
  if (!credential) throw new Error('Review Room agent credential was not persisted.');
  return credential;
}

export async function storeGetReviewRoomAgentCredential(id: string): Promise<ReviewRoomAgentCredential | null> {
  return execute<ReviewRoomAgentCredential>(`
    SELECT * FROM review_room_agent_credentials WHERE id = ? LIMIT 1
  `, [id]);
}

export async function storeGetLatestReviewRoomAgentCredential(reviewRequestId: string): Promise<ReviewRoomAgentCredential | null> {
  return execute<ReviewRoomAgentCredential>(`
    SELECT * FROM review_room_agent_credentials
    WHERE review_request_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `, [reviewRequestId]);
}

export async function storeResolveReviewRoomAgentCredential(
  proofSlug: string,
  token: string,
): Promise<ReviewRoomAgentCredential | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const tokenHash = hashSecret(trimmed);
  return execute<ReviewRoomAgentCredential>(`
    SELECT c.*, d.proof_slug, r.status AS request_status
    FROM review_room_agent_credentials c
    JOIN review_room_documents d ON d.id = c.document_id
    JOIN review_room_agent_review_runs r ON r.id = c.review_request_id
    WHERE d.proof_slug = ?
      AND c.token_hash = ?
      AND c.revoked_at IS NULL
      AND c.expires_at > ?
      AND r.status IN ('queued', 'claimed', 'running')
    LIMIT 1
  `, [proofSlug, tokenHash, new Date().toISOString()]);
}

export async function storeTouchReviewRoomAgentCredential(id: string): Promise<void> {
  const db = await ensureStore();
  await db.execute({
    sql: `UPDATE review_room_agent_credentials SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL`,
    args: [new Date().toISOString(), id],
  });
}

export async function storeRevokeReviewRoomAgentCredentials(reviewRequestId: string): Promise<number> {
  const db = await ensureStore();
  const result = await db.execute({
    sql: `UPDATE review_room_agent_credentials
          SET revoked_at = ?
          WHERE review_request_id = ? AND revoked_at IS NULL`,
    args: [new Date().toISOString(), reviewRequestId],
  });
  return Number(result.rowsAffected ?? 0);
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

export async function storeCreateAgentReviewRun(input: {
  documentId: string;
  requestedByIdentityId: string;
  idempotencyKey: string;
  scope?: string;
  instructions?: string | null;
}): Promise<{ run: ReviewRoomAgentReviewRun; reused: boolean }> {
  const db = await ensureStore();
  const existing = await storeGetAgentReviewRunByIdempotencyKey(input.documentId, input.idempotencyKey);
  if (existing) return { run: existing, reused: true };
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO review_room_agent_review_runs (
        id, document_id, agent_id, requested_by_identity_id, idempotency_key, status, attempt_count,
        model, scope, instructions, result_count, failed_output_count, error_code, error_message,
        created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, '', ?, ?, 'queued', 1, NULL, ?, ?, 0, 0, NULL, NULL, ?, ?, NULL, NULL)`,
      args: [
        id,
        input.documentId,
        input.requestedByIdentityId,
        input.idempotencyKey,
        (input.scope || 'document').slice(0, 120),
        input.instructions?.slice(0, 4000) ?? null,
        now,
        now,
      ],
    });
  } catch (error) {
    const raced = await storeGetAgentReviewRunByIdempotencyKey(input.documentId, input.idempotencyKey);
    if (raced) return { run: raced, reused: true };
    const active = await storeGetActiveAgentReviewRun(input.documentId);
    if (active) return { run: active, reused: true };
    throw error;
  }
  const run = await storeGetAgentReviewRun(id);
  if (!run) throw new Error('Review Room agent review run was not persisted.');
  return { run, reused: false };
}

export async function storeGetAgentReviewRun(id: string): Promise<ReviewRoomAgentReviewRun | null> {
  return execute<ReviewRoomAgentReviewRun>(`
    SELECT * FROM review_room_agent_review_runs WHERE id = ? LIMIT 1
  `, [id]);
}

export async function storeGetAgentReviewRunByIdempotencyKey(
  documentId: string,
  idempotencyKey: string,
): Promise<ReviewRoomAgentReviewRun | null> {
  return execute<ReviewRoomAgentReviewRun>(`
    SELECT * FROM review_room_agent_review_runs
    WHERE document_id = ? AND idempotency_key = ?
    LIMIT 1
  `, [documentId, idempotencyKey]);
}

export async function storeGetActiveAgentReviewRun(documentId: string): Promise<ReviewRoomAgentReviewRun | null> {
  return execute<ReviewRoomAgentReviewRun>(`
    SELECT * FROM review_room_agent_review_runs
    WHERE document_id = ? AND status IN ('queued', 'claimed', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `, [documentId]);
}

export async function storeListAgentReviewRuns(documentId: string, limit: number = 20): Promise<ReviewRoomAgentReviewRun[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  return executeAll<ReviewRoomAgentReviewRun>(`
    SELECT * FROM review_room_agent_review_runs
    WHERE document_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `, [documentId, safeLimit]);
}

export async function storeClaimAgentReviewRun(input: {
  id: string;
  agentId: string;
  claimTokenHash: string;
  leaseExpiresAt: string;
}): Promise<ReviewRoomAgentReviewRun | null> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE review_room_agent_review_runs
          SET status = 'claimed', agent_id = ?, claim_token_hash = ?, lease_expires_at = ?,
              claimed_at = ?, heartbeat_at = ?, error_code = NULL, error_message = NULL,
              started_at = NULL, completed_at = NULL, cancelled_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'queued'`,
    args: [input.agentId, input.claimTokenHash, input.leaseExpiresAt, now, now, now, input.id],
  });
  if (Number(result.rowsAffected ?? 0) <= 0) return null;
  return storeGetAgentReviewRun(input.id);
}

export async function storeHeartbeatAgentReviewRun(input: {
  id: string;
  claimTokenHash: string;
  leaseExpiresAt: string;
}): Promise<ReviewRoomAgentReviewRun | null> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE review_room_agent_review_runs
          SET status = 'running', heartbeat_at = ?, lease_expires_at = ?,
              started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ? AND claim_token_hash = ? AND status IN ('claimed', 'running')
            AND lease_expires_at > ?`,
    args: [now, input.leaseExpiresAt, now, now, input.id, input.claimTokenHash, now],
  });
  if (Number(result.rowsAffected ?? 0) <= 0) return null;
  return storeGetAgentReviewRun(input.id);
}

export async function storeCompleteAgentReviewRun(input: {
  id: string;
  claimTokenHash: string;
  resultCount: number;
  failedOutputCount: number;
}): Promise<ReviewRoomAgentReviewRun | null> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE review_room_agent_review_runs
          SET status = 'completed', result_count = ?, failed_output_count = ?,
              error_code = NULL, error_message = NULL, completed_at = ?,
              lease_expires_at = NULL, claim_token_hash = NULL, updated_at = ?
          WHERE id = ? AND claim_token_hash = ? AND status IN ('claimed', 'running')
            AND lease_expires_at > ?`,
    args: [input.resultCount, input.failedOutputCount, now, now, input.id, input.claimTokenHash, now],
  });
  if (Number(result.rowsAffected ?? 0) <= 0) return null;
  await storeRevokeReviewRoomAgentCredentials(input.id);
  return storeGetAgentReviewRun(input.id);
}

export async function storeFailAgentReviewRun(input: {
  id: string;
  claimTokenHash?: string;
  code: string;
  message: string;
  resultCount?: number;
  failedOutputCount?: number;
}): Promise<ReviewRoomAgentReviewRun | null> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE review_room_agent_review_runs
          SET status = 'failed', error_code = ?, error_message = ?,
              result_count = COALESCE(?, result_count), failed_output_count = COALESCE(?, failed_output_count),
              claim_token_hash = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('claimed', 'running')
            AND (? IS NULL OR claim_token_hash = ?)`,
    args: [input.code, input.message.slice(0, 1000), input.resultCount ?? null, input.failedOutputCount ?? null, now, now, input.id, input.claimTokenHash ?? null, input.claimTokenHash ?? null],
  });
  if (Number(result.rowsAffected ?? 0) <= 0) return null;
  await storeRevokeReviewRoomAgentCredentials(input.id);
  return storeGetAgentReviewRun(input.id);
}

export async function storeQueueAgentReviewRunRetry(id: string): Promise<ReviewRoomAgentReviewRun | null> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE review_room_agent_review_runs
          SET status = 'queued', attempt_count = attempt_count + 1,
              agent_id = '', claim_token_hash = NULL, lease_expires_at = NULL, claimed_at = NULL,
              heartbeat_at = NULL, error_code = NULL, error_message = NULL,
              started_at = NULL, completed_at = NULL, cancelled_at = NULL, updated_at = ?
          WHERE id = ? AND status IN ('failed', 'cancelled', 'lease_expired')`,
    args: [now, id],
  });
  if (Number(result.rowsAffected ?? 0) <= 0) return null;
  await storeRevokeReviewRoomAgentCredentials(id);
  return storeGetAgentReviewRun(id);
}

export async function storeReleaseAgentReviewRun(id: string, claimTokenHash: string): Promise<ReviewRoomAgentReviewRun | null> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE review_room_agent_review_runs
          SET status = 'queued', agent_id = '', claim_token_hash = NULL, lease_expires_at = NULL,
              claimed_at = NULL, heartbeat_at = NULL, started_at = NULL, updated_at = ?
          WHERE id = ? AND claim_token_hash = ? AND status IN ('claimed', 'running')`,
    args: [now, id, claimTokenHash],
  });
  if (Number(result.rowsAffected ?? 0) <= 0) return null;
  await storeRevokeReviewRoomAgentCredentials(id);
  return storeGetAgentReviewRun(id);
}

export async function storeCancelAgentReviewRun(id: string): Promise<ReviewRoomAgentReviewRun | null> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE review_room_agent_review_runs
          SET status = 'cancelled', claim_token_hash = NULL, lease_expires_at = NULL,
              cancelled_at = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'claimed', 'running')`,
    args: [now, now, now, id],
  });
  if (Number(result.rowsAffected ?? 0) <= 0) return null;
  await storeRevokeReviewRoomAgentCredentials(id);
  return storeGetAgentReviewRun(id);
}

export async function storeExpireAgentReviewRunLeases(documentId?: string): Promise<number> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const expiring = await executeAll<{ id: string }>(`
    SELECT id FROM review_room_agent_review_runs
    WHERE status IN ('claimed', 'running') AND lease_expires_at <= ?
      AND (? IS NULL OR document_id = ?)
  `, [now, documentId ?? null, documentId ?? null]);
  const result = await db.execute({
    sql: `UPDATE review_room_agent_review_runs
          SET status = 'lease_expired', claim_token_hash = NULL, lease_expires_at = NULL,
              error_code = 'AGENT_LEASE_EXPIRED', error_message = 'The external agent lease expired.',
              completed_at = ?, updated_at = ?
          WHERE status IN ('claimed', 'running') AND lease_expires_at <= ?
            AND (? IS NULL OR document_id = ?)`,
    args: [now, now, now, documentId ?? null, documentId ?? null],
  });
  for (const run of expiring) await storeRevokeReviewRoomAgentCredentials(run.id);
  return Number(result.rowsAffected ?? 0);
}

export async function storeCountAgentReviewOutputs(runId: string): Promise<number> {
  const row = await execute<{ count: number }>(`
    SELECT COUNT(*) AS count FROM review_room_agent_review_outputs
    WHERE run_id = ? AND status = 'applied'
  `, [runId]);
  return Number(row?.count ?? 0);
}

export async function storeGetAgentReviewOutput(runId: string, itemKey: string): Promise<ReviewRoomAgentReviewOutput | null> {
  return execute<ReviewRoomAgentReviewOutput>(`
    SELECT * FROM review_room_agent_review_outputs WHERE run_id = ? AND item_key = ? LIMIT 1
  `, [runId, itemKey]);
}

export async function storeReserveAgentReviewOutput(input: {
  runId: string;
  itemKey: string;
  itemType: string;
}): Promise<{ output: ReviewRoomAgentReviewOutput; reserved: boolean }> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  const inserted = await db.execute({
    sql: `INSERT INTO review_room_agent_review_outputs (
            run_id, item_key, item_type, status, mark_id, error_message, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)
          ON CONFLICT (run_id, item_key) DO NOTHING`,
    args: [input.runId, input.itemKey, input.itemType, now, now],
  });
  let reserved = Number(inserted.rowsAffected ?? 0) > 0;
  if (!reserved) {
    const retried = await db.execute({
      sql: `UPDATE review_room_agent_review_outputs
            SET status = 'pending', error_message = NULL, updated_at = ?
            WHERE run_id = ? AND item_key = ? AND status = 'failed'`,
      args: [now, input.runId, input.itemKey],
    });
    reserved = Number(retried.rowsAffected ?? 0) > 0;
  }
  const output = await storeGetAgentReviewOutput(input.runId, input.itemKey);
  if (!output) throw new Error('Review Room agent review output reservation was not persisted.');
  return { output, reserved };
}

export async function storeUpsertAgentReviewOutput(input: {
  runId: string;
  itemKey: string;
  itemType: string;
  status: ReviewRoomAgentReviewOutput['status'];
  markId?: string | null;
  errorMessage?: string | null;
}): Promise<ReviewRoomAgentReviewOutput> {
  const db = await ensureStore();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO review_room_agent_review_outputs (
            run_id, item_key, item_type, status, mark_id, error_message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (run_id, item_key) DO UPDATE SET
            status = excluded.status,
            mark_id = excluded.mark_id,
            error_message = excluded.error_message,
            updated_at = excluded.updated_at`,
    args: [
      input.runId,
      input.itemKey,
      input.itemType,
      input.status,
      input.markId ?? null,
      input.errorMessage?.slice(0, 1000) ?? null,
      now,
      now,
    ],
  });
  const output = await storeGetAgentReviewOutput(input.runId, input.itemKey);
  if (!output) throw new Error('Review Room agent review output was not persisted.');
  return output;
}
