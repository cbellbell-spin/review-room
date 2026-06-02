import { createHash, randomUUID } from 'crypto';
import { createClient, type Client, type ResultSet } from '@libsql/client';
import type {
  DocumentRow,
  ReviewRoomDocumentMemberRow,
  ReviewRoomDocumentRow,
  ReviewRoomIdentityRow,
  ReviewRoomRole,
} from './db.js';
import { deriveReviewRoomCapabilities, reviewRoomRoleToShareRole, type DocumentAccessRow } from './db.js';
import type { ShareRole } from './share-types.js';

type SqlValue = null | string | number | bigint | ArrayBuffer | boolean | Uint8Array | Date;

export type HostedEngineExecutionResult = {
  status: number;
  body: Record<string, unknown>;
};

let client: Client | null = null;
let initialized = false;

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
  ]);
  const now = new Date().toISOString();
  await db.batch([
    [
      `INSERT INTO review_room_workspaces (id, name, created_at, updated_at)
       VALUES ('local', 'Local Review Room', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [now, now],
    ],
    [
      `INSERT INTO review_room_identities (id, workspace_id, kind, display_name, manager_identity_id, created_at, updated_at)
       VALUES ('local-human', 'local', 'human', 'Local reviewer', NULL, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [now, now],
    ],
    [
      `INSERT INTO review_room_identities (id, workspace_id, kind, display_name, manager_identity_id, created_at, updated_at)
       VALUES ('agent-reviewer', 'local', 'agent', 'Review agent', 'local-human', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [now, now],
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

export async function getHostedReviewRoomIdentity(id: string = 'local-human'): Promise<ReviewRoomIdentityRow | null> {
  return execute<ReviewRoomIdentityRow>(`
    SELECT id, workspace_id, kind, display_name, manager_identity_id, created_at, updated_at
    FROM review_room_identities
    WHERE id = ?
    LIMIT 1
  `, [id]);
}

export async function listHostedReviewRoomIdentities(workspaceId: string = 'local'): Promise<ReviewRoomIdentityRow[]> {
  return executeAll<ReviewRoomIdentityRow>(`
    SELECT id, workspace_id, kind, display_name, manager_identity_id, created_at, updated_at
    FROM review_room_identities
    WHERE workspace_id = ?
    ORDER BY kind DESC, display_name ASC
  `, [workspaceId]);
}

export async function getHostedReviewRoomDocumentMemberForProofSlug(
  proofSlug: string,
  identityId: string = 'local-human',
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

export async function getHostedReviewRoomDocumentMemberForProofSlugAndToken(
  proofSlug: string,
  token: string | null | undefined,
): Promise<ReviewRoomDocumentMemberRow | null> {
  const trimmed = (token || '').trim();
  if (!trimmed) return null;
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
      AND m.proof_access_token = ?
    LIMIT 1
  `, [proofSlug, trimmed]);
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

export async function listHostedReviewRoomDocuments(workspaceId: string = 'local', limit: number = 50): Promise<ReviewRoomDocumentRow[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
  return executeAll<ReviewRoomDocumentRow>(`
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
    WHERE rr.workspace_id = ?
      AND d.deleted_at IS NULL
      AND d.share_state != 'DELETED'
    ORDER BY rr.updated_at DESC
    LIMIT ?
  `, [workspaceId, safeLimit]);
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

export async function createHostedReviewRoomDocumentRecord(input: {
  workspaceId?: string;
  title: string;
  proofSlug: string;
  proofDocId?: string | null;
  source?: 'created' | 'registered';
  ownerIdentityId?: string;
  createdByIdentityId?: string;
}): Promise<ReviewRoomDocumentRow> {
  const db = await ensureHostedReviewRoomDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();
  const workspaceId = input.workspaceId || 'local';
  const ownerIdentityId = input.ownerIdentityId || 'local-human';
  const createdByIdentityId = input.createdByIdentityId || ownerIdentityId;
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
  await upsertHostedReviewRoomDocumentMember({
    reviewRoomDocumentId: id,
    identityId: ownerIdentityId,
    role: 'owner',
    proofSlug: input.proofSlug,
  });
  const row = await getHostedReviewRoomDocumentByProofSlug(input.proofSlug);
  if (!row) throw new Error('Hosted Review Room document record was not persisted.');
  return row;
}

export async function createHostedReviewRoomDocument(input: {
  slug: string;
  title: string;
  markdown: string;
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
  const workspaceId = input.workspaceId || 'local';
  const identityId = input.identityId || 'local-human';
  const marksJson = '{}';
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
      comments: { method: 'POST', href: `/documents/${slug}/bridge/comments` },
      title: { method: 'PUT', href: `/api/documents/${slug}/title` },
    },
    agent: {
      what: 'Review Room is a collaborative document review editor.',
      stateApi: `/documents/${slug}/state`,
      agentStateApi: `/api/agent/${slug}/state`,
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
