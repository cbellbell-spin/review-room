import { createHash, randomBytes, randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { buildClaudePluginZip } from './claude-plugin-package.js';
import { generateSlug } from './slug.js';
import {
  addEvent,
  createDocument,
  createDocumentAccessToken,
  deriveReviewRoomCapabilities,
  getDocumentBySlug,
  resolveDocumentAccess,
  reviewRoomRoleToShareRole,
  shareRoleToReviewRoomRole,
  type DocumentRow,
  type ReviewRoomAssignmentTaskRow,
  type ReviewRoomDocumentMemberRow,
  type ReviewRoomDocumentRow,
  type ReviewRoomPublishedVersionRow,
  type ReviewRoomRole,
} from './db.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import {
  clearReviewRoomSessionCookie,
  getReviewRoomSessionCookie,
  setReviewRoomSessionCookie,
} from './cookies.js';
import {
  addHostedDocumentEvent,
  createHostedReviewRoomDocument,
  getHostedDocumentBySlug,
  isHostedReviewRoomDbEnabled,
  resolveHostedDocumentAccess,
} from './hosted-review-room-db.js';
import {
  storeCreatePublishedVersion,
  storeCreateAgentReviewRun,
  storeCreateReviewRoomDeviceEnrollment,
  storeCreateReviewRoomDocumentRecord,
  storeCreateReviewRoomHistoryEvent,
  storeCreateReviewRoomIdentityInvitation,
  storeCreateReviewRoomSession,
  storeCreateReviewRoomAgentCredential,
  storeCancelAgentReviewRun,
  storeConsumeReviewRoomDeviceEnrollment,
  storeConsumeReviewRoomIdentityInvitation,
  storeGetAssignmentTask,
  storeGetAgentReviewRun,
  storeGetReviewRoomDeviceEnrollmentBySecret,
  storeGetLatestPublishedVersion,
  storeGetReviewRoomDocumentByProofSlug,
  storeGetReviewRoomDocumentMemberForProofSlug,
  storeGetReviewRoomDocumentMemberForProofSlugAndToken,
  storeGetReviewRoomIdentity,
  storeGetLatestReviewRoomAgentCredential,
  storeExpireAgentReviewRunLeases,
  storeListReviewRoomDocumentMembersForProofSlug,
  storeListAssignmentTasks,
  storeListAgentReviewRuns,
  storeListPublishedVersions,
  storeListReviewRoomAgents,
  storeListReviewRoomDocuments,
  storeListReviewRoomHistoryEvents,
  storeListReviewRoomIdentities,
  storeListReviewRoomSessions,
  storeResolveReviewRoomSession,
  storeRemoveReviewRoomDocumentMember,
  storeRevokeReviewRoomSessionById,
  storeRevokeReviewRoomSession,
  storeQueueAgentReviewRunRetry,
  storeUpdateAssignmentTaskStatus,
  storeUpsertReviewRoomIdentity,
  storeUpsertReviewRoomDocumentMember,
} from './review-room-store.js';
import {
  REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
  REVIEW_ROOM_LOCAL_WORKSPACE_NAME,
  normalizeReviewRoomIdentityId,
  reviewRoomActorForIdentity,
} from './review-room-identity.js';
import type { ShareRole } from './share-types.js';

export const reviewRoomRoutes = Router();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildReviewRoomOpenPath(slug: string): string {
  return `/d/${encodeURIComponent(slug)}?rr=1`;
}

function appendTokenToPath(path: string, token: string | null): string {
  if (!token) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function buildReviewRoomEnrollmentPath(secret: string): string {
  return `/review-room/session/enroll?enroll=${encodeURIComponent(secret)}`;
}

function getExplicitReviewRoomIdentityId(req: Request): string | null {
  const fromHeader = req.header('x-review-room-identity-id');
  if (fromHeader && fromHeader.trim()) return normalizeReviewRoomIdentityId(fromHeader);
  const fromQuery = typeof req.query.identityId === 'string' ? req.query.identityId.trim() : '';
  return fromQuery ? normalizeReviewRoomIdentityId(fromQuery) : null;
}

async function getReviewRoomSession(req: Request) {
  return storeResolveReviewRoomSession(getReviewRoomSessionCookie(req));
}

async function getCurrentReviewRoomIdentityId(req: Request): Promise<string> {
  const session = await getReviewRoomSession(req);
  return session?.identity_id ?? getExplicitReviewRoomIdentityId(req) ?? normalizeReviewRoomIdentityId(null);
}

function getPresentedShareToken(req: Request): string | null {
  const fromHeader = req.header('x-share-token')?.trim();
  if (fromHeader) return fromHeader;
  const authorization = req.header('authorization')?.trim() ?? '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const fromQuery = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  return fromQuery || null;
}

function parseReviewRoomRoleInput(value: unknown): ReviewRoomRole | null {
  return value === 'owner' || value === 'editor' || value === 'commenter' || value === 'viewer'
    ? value
    : null;
}

type ParsedReviewRoomReference = {
  slug: string;
  token: string | null;
  error: { code: string; error: string } | null;
};

const REVIEW_ROOM_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function invalidReviewRoomLink(): ParsedReviewRoomReference {
  return {
    slug: '',
    token: null,
    error: {
      code: 'INVALID_DOCUMENT_LINK',
      error: 'Paste a Review Room /d/... link or a document slug. Direct Google Docs and SharePoint links are not supported yet.',
    },
  };
}

function validateReviewRoomSlug(slug: string): ParsedReviewRoomReference {
  if (!slug) {
    return {
      slug: '',
      token: null,
      error: { code: 'DOCUMENT_SLUG_REQUIRED', error: 'Document slug is required.' },
    };
  }
  if (!REVIEW_ROOM_SLUG_PATTERN.test(slug)) {
    return {
      slug: '',
      token: null,
      error: {
        code: 'INVALID_DOCUMENT_SLUG',
        error: 'Use a Review Room document slug or a /d/... link.',
      },
    };
  }
  return { slug, token: null, error: null };
}

function parseProofSlugInput(value: string): ParsedReviewRoomReference {
  const trimmed = value.trim();
  if (!trimmed) return validateReviewRoomSlug('');
  try {
    const parsed = new URL(trimmed, 'http://review-room.local');
    const match = parsed.pathname.match(/^\/d\/([^/?#]+)\/?$/);
    if (match?.[1]) {
      const result = validateReviewRoomSlug(decodeURIComponent(match[1]).trim());
      return { ...result, token: parsed.searchParams.get('token')?.trim() || null };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
      return invalidReviewRoomLink();
    }
  } catch {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return invalidReviewRoomLink();
  }
  return validateReviewRoomSlug(trimmed.split(/[?#]/)[0]?.trim() ?? '');
}

// Engine seams: the Proof document engine still differs between the local
// better-sqlite3 runtime and the hosted libSQL runtime. Review Room product
// state below these helpers is single-path through review-room-store.
async function engineGetDocumentBySlug(slug: string): Promise<DocumentRow | undefined> {
  if (isHostedReviewRoomDbEnabled()) return getHostedDocumentBySlug(slug);
  return getDocumentBySlug(slug);
}

async function engineResolveDocumentAccess(slug: string, token: string): Promise<unknown> {
  if (isHostedReviewRoomDbEnabled()) return resolveHostedDocumentAccess(slug, token);
  return resolveDocumentAccess(slug, token);
}

async function engineResolveReviewRoomRole(slug: string, token: string): Promise<ReviewRoomRole | null> {
  const access = await engineResolveDocumentAccess(slug, token);
  const role = access && typeof access === 'object' && 'role' in access
    ? (access as { role?: unknown }).role
    : null;
  return role === 'viewer' || role === 'commenter' || role === 'editor' || role === 'owner_bot'
    ? shareRoleToReviewRoomRole(role as ShareRole)
    : null;
}

async function engineAddDocumentEvent(slug: string, eventType: string, eventData: unknown, actor: string): Promise<void> {
  if (isHostedReviewRoomDbEnabled()) {
    await addHostedDocumentEvent(slug, eventType, eventData, actor);
    return;
  }
  addEvent(slug, eventType, eventData, actor);
}

function reviewRoomRegisterErrorForState(shareState: string): { status: number; code: string; error: string } | null {
  if (shareState === 'ACTIVE') return null;
  if (shareState === 'PAUSED') {
    return {
      status: 409,
      code: 'DOCUMENT_PAUSED',
      error: 'This document is paused. Resume it before registering it in Review Room.',
    };
  }
  if (shareState === 'REVOKED') {
    return {
      status: 403,
      code: 'DOCUMENT_REVOKED',
      error: 'This document has been revoked and cannot be registered in Review Room.',
    };
  }
  if (shareState === 'DELETED') {
    return {
      status: 410,
      code: 'DOCUMENT_DELETED',
      error: 'This document was deleted and cannot be registered in Review Room.',
    };
  }
  return {
    status: 409,
    code: 'DOCUMENT_UNAVAILABLE',
    error: 'This document is currently unavailable and cannot be registered in Review Room.',
  };
}

function reviewRoomSourceLabel(source: ReviewRoomDocumentRow['source'] | string): string {
  if (source === 'registered') return 'Registered document';
  if (source === 'imported') return 'Imported file';
  return 'Created in Review Room';
}

function serializeDocument(
  row: ReviewRoomDocumentRow,
  member: ReviewRoomDocumentMemberRow | null = null,
): Record<string, unknown> {
  const role = member?.role ?? null;
  const shareRole = role ? reviewRoomRoleToShareRole(role) : null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    proofSlug: row.proof_slug,
    proofDocId: row.proof_doc_id,
    source: row.source,
    sourceLabel: reviewRoomSourceLabel(row.source),
    shareState: row.share_state,
    currentRole: role,
    currentShareRole: shareRole,
    capabilities: deriveReviewRoomCapabilities(role, row.share_state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    proofCreatedAt: row.proof_created_at,
    proofUpdatedAt: row.proof_updated_at,
    openPath: appendTokenToPath(buildReviewRoomOpenPath(row.proof_slug), member?.proof_access_token ?? null),
    statePath: `/documents/${encodeURIComponent(row.proof_slug)}/state`,
    historyPath: `/review-room/api/documents/${encodeURIComponent(row.proof_slug)}/history`,
    baselinePath: `/review-room/api/documents/${encodeURIComponent(row.proof_slug)}/baselines`,
  };
}

function serializeDocumentMember(
  member: ReviewRoomDocumentMemberRow,
  identity: Awaited<ReturnType<typeof storeGetReviewRoomIdentity>> | null,
  includeRoleToken: boolean = false,
  includeAccessToken: boolean = false,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    documentId: member.review_room_document_id,
    identityId: member.identity_id,
    identityKind: identity?.kind ?? null,
    displayName: identity?.display_name ?? member.identity_id,
    role: member.role,
    shareRole: reviewRoomRoleToShareRole(member.role),
    createdAt: member.created_at,
    updatedAt: member.updated_at,
    openPath: appendTokenToPath(buildReviewRoomOpenPath(member.proof_slug), includeRoleToken ? member.proof_access_token ?? null : null),
  };
  if (includeAccessToken) payload.accessToken = member.proof_access_token ?? null;
  return payload;
}

function serializeAgentReviewRun(
  run: Awaited<ReturnType<typeof storeGetAgentReviewRun>>,
  credential?: Awaited<ReturnType<typeof storeGetLatestReviewRoomAgentCredential>>,
): Record<string, unknown> | null {
  if (!run) return null;
  return {
    id: run.id,
    documentId: run.document_id,
    agentId: run.agent_id,
    requestedByIdentityId: run.requested_by_identity_id,
    status: run.status,
    attemptCount: run.attempt_count,
    scope: run.scope,
    instructions: run.instructions,
    claimedByAgentId: run.agent_id || null,
    leaseExpiresAt: run.lease_expires_at,
    claimedAt: run.claimed_at,
    heartbeatAt: run.heartbeat_at,
    resultCount: run.result_count,
    failedOutputCount: run.failed_output_count,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    cancelledAt: run.cancelled_at,
    agentAccessExpiresAt: credential?.expires_at ?? null,
    agentAccessRevokedAt: credential?.revoked_at ?? null,
  };
}

type ReviewRoomDocumentAccess = {
  identityId: string;
  document: ReviewRoomDocumentRow;
  member: ReviewRoomDocumentMemberRow | null;
  capabilities: ReturnType<typeof deriveReviewRoomCapabilities>;
};

async function getReviewRoomDocumentAccess(req: Request, proofSlug: string): Promise<ReviewRoomDocumentAccess | null> {
  const document = await storeGetReviewRoomDocumentByProofSlug(proofSlug);
  if (!document) return null;
  const session = await getReviewRoomSession(req);
  const explicitIdentityId = session?.identity_id ?? getExplicitReviewRoomIdentityId(req);
  const token = getPresentedShareToken(req);
  const tokenMember = explicitIdentityId
    ? null
    : await storeGetReviewRoomDocumentMemberForProofSlugAndToken(proofSlug, token);
  const identityId = explicitIdentityId ?? tokenMember?.identity_id ?? await getCurrentReviewRoomIdentityId(req);
  const member = tokenMember ?? await storeGetReviewRoomDocumentMemberForProofSlug(proofSlug, identityId);
  return {
    identityId: member?.identity_id ?? identityId,
    document,
    member,
    capabilities: member
      ? deriveReviewRoomCapabilities(member.role, document.share_state)
      : deriveReviewRoomCapabilities(null, document.share_state),
  };
}

function sendDocumentMissing(res: Response): void {
  res.status(404).json({ success: false, code: 'DOCUMENT_MISSING', error: 'No Review Room document exists for that slug.' });
}

function sendReviewRoomForbidden(res: Response, code: string, error: string): void {
  res.status(403).json({ success: false, code, error });
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function serializeAgent(row: {
  id: string;
  workspace_id: string;
  owner_identity_id: string;
  manager_identity_id: string;
  name: string;
  description: string | null;
  integration_type: string;
  capabilities_json: string;
  created_at: string;
  updated_at: string;
}): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerIdentityId: row.owner_identity_id,
    managerIdentityId: row.manager_identity_id,
    name: row.name,
    description: row.description,
    integrationType: row.integration_type,
    capabilities: parseJsonArray(row.capabilities_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeHistoryEvent(row: {
  id: string;
  workspace_id: string;
  document_id: string | null;
  actor_id: string;
  actor_type: string;
  event_type: string;
  target_type: string | null;
  target_id: string | null;
  before_json: string | null;
  after_json: string | null;
  rationale: string | null;
  metadata_json: string;
  created_at: string;
}): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    documentId: row.document_id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    eventType: row.event_type,
    targetType: row.target_type,
    targetId: row.target_id,
    before: parseJsonObject(row.before_json),
    after: parseJsonObject(row.after_json),
    rationale: row.rationale,
    metadata: parseJsonObject(row.metadata_json) ?? {},
    createdAt: row.created_at,
  };
}

function serializePublishedVersion(row: ReviewRoomPublishedVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    proofRevision: row.proof_revision,
    contentLength: row.content_snapshot.length,
    createdByIdentityId: row.created_by_identity_id,
    createdAt: row.created_at,
    note: row.note,
  };
}

function serializeAssignmentTask(
  row: ReviewRoomAssignmentTaskRow,
  labels: Map<string, string> = new Map(),
  sourceText: string | null = null,
): Record<string, unknown> {
  const assigneeKey = `${row.assigned_to_actor_type}:${row.assigned_to_actor_id}`;
  return {
    id: row.id,
    documentId: row.document_id,
    proofEventId: row.proof_event_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceText,
    createdByActorId: row.created_by_actor_id,
    createdByActorType: row.created_by_actor_type,
    assignedToActorId: row.assigned_to_actor_id,
    assignedToActorType: row.assigned_to_actor_type,
    assignedToLabel: labels.get(assigneeKey) ?? row.assigned_to_actor_id,
    managerIdentityId: row.manager_identity_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function buildAssignmentTaskLabels(workspaceId: string): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const [agents, identities] = await Promise.all([
    storeListReviewRoomAgents(workspaceId),
    storeListReviewRoomIdentities(workspaceId),
  ]);
  for (const agent of agents) labels.set(`agent:${agent.id}`, agent.name);
  for (const identity of identities) labels.set(`${identity.kind}:${identity.id}`, identity.display_name);
  return labels;
}

function sourceTextForTask(task: ReviewRoomAssignmentTaskRow, marks: Record<string, unknown>): string | null {
  if (!task.source_id) return null;
  const mark = marks[task.source_id];
  if (!mark || typeof mark !== 'object' || Array.isArray(mark)) return null;
  const data = mark as Record<string, unknown>;
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim();
  if (typeof data.quote === 'string' && data.quote.trim()) return data.quote.trim();
  return null;
}

function parseTaskStatusFilter(value: unknown): 'open' | 'running' | 'delegated' | 'dismissed' | 'completed' | 'all' | null {
  if (typeof value !== 'string' || !value.trim()) return 'all';
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'open'
    || normalized === 'running'
    || normalized === 'delegated'
    || normalized === 'dismissed'
    || normalized === 'completed'
    || normalized === 'all'
  ) return normalized;
  return null;
}

function renderReviewRoomHome(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Review Room</title>
  <style>
    :root {
      --rr-bg: #f7f8f3;
      --rr-surface: #ffffff;
      --rr-surface-soft: #fbfcf8;
      --rr-ink: #1f2933;
      --rr-muted: #607064;
      --rr-border: #dfe5d7;
      --rr-border-soft: #edf1e9;
      --rr-control-border: #cbd7c6;
      --rr-accent: #266854;
      --rr-on-accent: #ffffff;
      --rr-accent-soft: #eef4e9;
      --rr-danger: #b42318;
      --rr-radius: 6px;
      --rr-radius-pill: 999px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--rr-ink);
      background: var(--rr-bg);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, textarea { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    .topbar {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 24px;
      border-bottom: 1px solid var(--rr-border);
      background: rgba(247, 248, 243, 0.94);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    .brand { font-weight: 700; letter-spacing: 0; }
    .topbar-right { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .nav { display: flex; align-items: center; gap: 8px; color: var(--rr-muted); font-size: 14px; }
    .nav a { color: inherit; text-decoration: none; padding: 8px 10px; border-radius: 6px; }
    .nav a[aria-current="page"] { color: var(--rr-ink); background: #e8eee2; }
    .workspace-chip {
      padding: 4px 9px;
      border-radius: 999px;
      background: var(--rr-accent-soft);
      color: #4c5f4f;
      font-size: 12px;
      font-weight: 650;
      white-space: nowrap;
    }
    .profile-control { position: relative; }
    .profile-button {
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 220px;
      padding: 6px 10px;
      border: 1px solid var(--rr-control-border);
      border-radius: 999px;
      background: #fff;
      color: var(--rr-ink);
      cursor: pointer;
      font-size: 13px;
      font-weight: 650;
    }
    .profile-button-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .profile-avatar {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: var(--rr-accent-soft);
      color: var(--rr-accent);
      font-size: 11px;
      font-weight: 750;
      flex: 0 0 auto;
    }
    .profile-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      width: min(340px, calc(100vw - 32px));
      display: none;
      gap: 14px;
      padding: 16px;
      border: 1px solid var(--rr-border);
      border-radius: 10px;
      background: #fff;
      box-shadow: 0 18px 48px rgba(31, 41, 51, 0.16);
      z-index: 20;
    }
    .profile-menu[data-open="true"] { display: grid; }
    .profile-heading { display: grid; gap: 3px; }
    .profile-name { font-weight: 700; overflow-wrap: anywhere; }
    .profile-session { color: var(--rr-muted); font-size: 12px; }
    .profile-form { padding: 0; gap: 8px; }
    .profile-form-actions { display: flex; align-items: center; gap: 10px; }
    .profile-form-actions .button { min-height: 34px; }
    .profile-status { min-height: 18px; color: var(--rr-muted); font-size: 12px; }
    .profile-guidance {
      display: grid;
      gap: 6px;
      padding-top: 12px;
      border-top: 1px solid var(--rr-border-soft);
      color: var(--rr-muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .profile-signout {
      justify-self: start;
      border: 0;
      background: transparent;
      color: var(--rr-danger);
      padding: 0;
      cursor: pointer;
      font-weight: 650;
    }
    .profile-device-link {
      justify-self: start;
      min-height: 32px;
      border-radius: 999px;
      border: 1px solid var(--rr-control-border);
      background: #fff;
      color: var(--rr-accent);
      padding: 6px 10px;
      cursor: pointer;
      font-weight: 700;
      font-size: 12px;
    }
    .profile-device-result {
      display: none;
      gap: 6px;
      padding: 9px;
      border: 1px solid var(--rr-border-soft);
      border-radius: 8px;
      color: var(--rr-muted);
    }
    .profile-device-result[data-open="true"] { display: grid; }
    .profile-sessions { display: grid; gap: 7px; }
    .profile-session-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px;
      border: 1px solid var(--rr-border-soft);
      border-radius: 8px;
    }
    .profile-session-row strong { color: var(--rr-ink); }
    .profile-session-meta { color: var(--rr-muted); overflow-wrap: anywhere; }
    main {
      width: min(860px, 100%);
      margin: 0 auto;
      padding: 28px 24px 48px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 18px;
      align-items: start;
    }
    h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }
    p { margin: 0; color: var(--rr-muted); line-height: 1.5; }
    .panel { background: var(--rr-surface); border: 1px solid var(--rr-border); border-radius: 8px; }
    .panel-header { padding: 18px 18px 0; }
    .doc-list { display: grid; gap: 0; margin-top: 14px; }
    .doc-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      padding: 16px 18px;
      border-top: 1px solid var(--rr-border-soft);
    }
    .doc-title { font-weight: 650; margin-bottom: 5px; overflow-wrap: anywhere; }
    .doc-meta { font-size: 13px; color: #718073; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .doc-source { padding: 2px 7px; border-radius: 999px; background: var(--rr-accent-soft); color: #4c5f4f; font-size: 12px; font-weight: 650; }
    .primary-action {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 18px;
      border-top: 1px solid var(--rr-border-soft);
    }
    .button {
      border: 1px solid var(--rr-accent);
      background: var(--rr-accent);
      color: #fff;
      border-radius: 6px;
      min-height: 36px;
      padding: 8px 12px;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-weight: 650;
    }
    .button.secondary { background: #fff; color: var(--rr-accent); }
    .button:focus-visible {
      outline: 2px solid var(--rr-accent);
      outline-offset: 2px;
    }
    .form-note { font-size: 13px; color: var(--rr-muted); }
    form { display: grid; gap: 12px; padding: 18px; }
    form + form { border-top: 1px solid var(--rr-border-soft); }
    .import-form { padding: 0; }
    .import-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .drop-target {
      border: 1px dashed #b8c8b3;
      background: var(--rr-surface-soft);
      border-radius: 8px;
      padding: 14px;
      display: grid;
      gap: 10px;
      transition: border-color 120ms ease, background 120ms ease;
    }
    .drop-target[data-active="true"] {
      border-color: var(--rr-accent);
      background: #f4f8f2;
    }
    .drop-target-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .drop-target-copy {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .drop-target-title { font-weight: 700; color: #374539; }
    .selected-file { color: var(--rr-muted); font-size: 13px; overflow-wrap: anywhere; }
    .selected-file[data-selected="true"] { color: #374539; font-weight: 650; }
    .file-input {
      border: 1px solid var(--rr-control-border);
      background: #fff;
    }
    .secondary-details {
      border-top: 1px solid var(--rr-border-soft);
      overflow: hidden;
    }
    .secondary-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 15px 18px;
      cursor: pointer;
      list-style: none;
    }
    .secondary-summary::-webkit-details-marker { display: none; }
    .secondary-summary::after {
      content: "Open";
      border: 1px solid var(--rr-control-border);
      border-radius: 6px;
      padding: 7px 10px;
      color: var(--rr-accent);
      font-size: 13px;
      font-weight: 650;
      background: #fff;
      flex-shrink: 0;
    }
    .secondary-details[open] .secondary-summary::after { content: "Close"; }
    .secondary-title { display: grid; gap: 3px; min-width: 0; }
    .secondary-title strong { font-size: 15px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 650; color: #374539; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--rr-control-border);
      border-radius: 6px;
      padding: 10px 11px;
      background: #fff;
      color: var(--rr-ink);
    }
    textarea { min-height: 190px; resize: vertical; line-height: 1.45; }
    .pill { padding: 4px 8px; border-radius: 999px; background: var(--rr-accent-soft); color: #4c5f4f; font-size: 12px; }
    .empty { padding: 24px 18px; color: var(--rr-muted); border-top: 1px solid var(--rr-border-soft); }
    .error { color: var(--rr-danger); font-size: 13px; min-height: 18px; }
    .section-title { font-size: 16px; font-weight: 700; margin: 0; }
    .download-list { display: grid; gap: 10px; padding: 18px; border-top: 1px solid var(--rr-border-soft); }
    .download-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }
    .download-copy { display: grid; gap: 3px; min-width: 0; }
    .download-title { font-weight: 700; }
    .download-note { color: var(--rr-muted); font-size: 13px; line-height: 1.45; }
    details.panel { overflow: hidden; }
    summary.panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      cursor: pointer;
      padding-bottom: 18px;
      list-style: none;
    }
    summary.panel-header::-webkit-details-marker { display: none; }
    summary.panel-header::after {
      content: "Open";
      border: 1px solid var(--rr-control-border);
      border-radius: 6px;
      padding: 7px 10px;
      color: var(--rr-accent);
      font-size: 13px;
      font-weight: 650;
      background: #fff;
      flex-shrink: 0;
    }
    details[open] summary.panel-header::after { content: "Close"; }
    @media (max-width: 840px) {
      main { grid-template-columns: 1fr; padding: 20px 16px 40px; }
      .topbar { padding: 0 16px; }
      .workspace-chip { display: none; }
      .doc-row { grid-template-columns: 1fr; }
      .download-row { align-items: flex-start; flex-direction: column; }
      .import-actions { align-items: stretch; flex-direction: column; }
    }
    @media (max-width: 560px) {
      .topbar { gap: 8px; }
      .brand { white-space: nowrap; }
      .nav { display: none; }
      .profile-button { max-width: 190px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">Review Room</div>
      <div class="topbar-right">
        <nav class="nav" aria-label="Review Room navigation">
          <a href="/review-room" aria-current="page">Documents</a>
          <a href="/agent-docs">Agent API</a>
        </nav>
        <span id="workspace-chip" class="workspace-chip">Local Review Room</span>
        <div id="profile-control" class="profile-control">
          <button id="profile-button" class="profile-button" type="button" aria-haspopup="dialog" aria-expanded="false">
            <span id="profile-avatar" class="profile-avatar" aria-hidden="true">?</span>
            <span id="profile-button-label" class="profile-button-label">Profile</span>
            <span aria-hidden="true">▾</span>
          </button>
          <section id="profile-menu" class="profile-menu" role="dialog" aria-label="Review Room profile">
            <div class="profile-heading">
              <div id="profile-name" class="profile-name">Review Room profile</div>
              <div id="profile-session" class="profile-session"></div>
            </div>
            <form id="profile-form" class="profile-form">
              <label for="profile-display-name">Display name</label>
              <input id="profile-display-name" name="displayName" maxlength="120" autocomplete="name" required>
              <div class="profile-form-actions">
                <button id="profile-save" class="button secondary" type="submit">Save name</button>
                <span id="profile-status" class="profile-status" role="status"></span>
              </div>
            </form>
            <div class="profile-guidance">
              <p id="profile-continuity-copy"></p>
              <p id="profile-device-copy"></p>
              <button id="profile-enrollment" class="profile-device-link" type="button">Create device enrollment link</button>
              <div id="profile-enrollment-result" class="profile-device-result"></div>
              <div id="profile-sessions" class="profile-sessions"></div>
              <button id="profile-signout" class="profile-signout" type="button">Sign out this device</button>
            </div>
          </section>
        </div>
      </div>
    </header>
    <main>
      <aside class="panel" aria-labelledby="create-heading">
        <div class="panel-header">
          <h1 id="create-heading">Create or import</h1>
          <p>Start fresh, or bring in a Markdown/Text file for review.</p>
        </div>
        <div class="primary-action">
          <button id="new-document-button" class="button" type="button">Create new document</button>
          <form id="import-form" class="import-form">
            <div id="import-drop-zone" class="drop-target" role="region" aria-labelledby="import-drop-heading" data-active="false">
              <div class="drop-target-main">
                <div class="drop-target-copy">
                  <span id="import-drop-heading" class="drop-target-title">Import Markdown or Text</span>
                  <span id="import-file-name" class="selected-file">Drop a file here or choose one below.</span>
                </div>
                <label id="choose-file-button" class="button secondary choose-file-button" for="import-file" role="button" tabindex="0" aria-describedby="import-file-name">Choose File</label>
              </div>
              <input id="import-file" class="visually-hidden file-input" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" tabindex="-1" aria-hidden="true">
            </div>
            <div class="import-actions">
              <button id="import-document-button" class="button secondary" type="submit">Import and open</button>
              <span class="form-note">Supports .md, .markdown, and .txt files.</span>
            </div>
          </form>
          <div id="form-error" class="error" role="alert"></div>
        </div>
      </aside>
      <section class="panel" aria-labelledby="docs-heading">
        <div class="panel-header">
          <h1 id="docs-heading">Open a document</h1>
          <p>Browse documents already in this Review Room workspace.</p>
        </div>
        <div id="documents" class="doc-list" aria-live="polite">
          <div class="empty">Loading documents...</div>
        </div>
      </section>
      <section class="panel" aria-labelledby="existing-link-heading">
        <details class="secondary-details">
          <summary class="secondary-summary">
            <span class="secondary-title">
              <strong id="existing-link-heading">Open existing Review Room link</strong>
              <span class="form-note">For documents already shared from Review Room or Proof.</span>
            </span>
          </summary>
          <form id="register-form">
            <p class="form-note">Accepts Review Room document slugs or /d/... links. Direct Google Docs and SharePoint imports are not supported yet.</p>
            <label>
              Review Room slug or URL
              <input id="proof-slug" name="proofSlug" placeholder="abc123 or /d/abc123?token=..." autocomplete="off">
            </label>
            <label>
              Access token
              <input id="proof-token" name="token" placeholder="Optional if the URL includes one" autocomplete="off">
            </label>
            <button class="button secondary" type="submit">Add and open</button>
            <div id="register-error" class="error" role="alert"></div>
          </form>
        </details>
      </section>
      <section class="panel" aria-labelledby="agent-plugin-heading">
        <div class="panel-header">
          <h1 id="agent-plugin-heading">Use Claude with Review Room</h1>
          <p>Install the Cowork plugin to give Claude the Review Room MCP tools for reading, commenting, replying, resolving, and proposing edits.</p>
        </div>
        <div class="download-list">
          <div class="download-row">
            <div class="download-copy">
              <div class="download-title">Claude/Cowork plugin</div>
              <div class="download-note">Includes the MCP connection and Review Room skill instructions.</div>
            </div>
            <a class="button secondary" href="/review-room/claude-plugin.zip" download>Download plugin</a>
          </div>
          <p class="form-note">Setup details are in <a href="/agent-docs">Agent API</a>.</p>
        </div>
      </section>
    </main>
  </div>
  <script>
    const documentsEl = document.getElementById('documents');
    const workspaceChip = document.getElementById('workspace-chip');
    const profileControl = document.getElementById('profile-control');
    const profileButton = document.getElementById('profile-button');
    const profileButtonLabel = document.getElementById('profile-button-label');
    const profileAvatar = document.getElementById('profile-avatar');
    const profileMenu = document.getElementById('profile-menu');
    const profileName = document.getElementById('profile-name');
    const profileSession = document.getElementById('profile-session');
    const profileForm = document.getElementById('profile-form');
    const profileDisplayName = document.getElementById('profile-display-name');
    const profileSave = document.getElementById('profile-save');
    const profileStatus = document.getElementById('profile-status');
    const profileContinuityCopy = document.getElementById('profile-continuity-copy');
    const profileDeviceCopy = document.getElementById('profile-device-copy');
    const profileEnrollment = document.getElementById('profile-enrollment');
    const profileEnrollmentResult = document.getElementById('profile-enrollment-result');
    const profileSessions = document.getElementById('profile-sessions');
    const profileSignout = document.getElementById('profile-signout');
    const newDocumentButton = document.getElementById('new-document-button');
    const importForm = document.getElementById('import-form');
    const importDropZone = document.getElementById('import-drop-zone');
    const importFileInput = document.getElementById('import-file');
    const chooseFileButton = document.getElementById('choose-file-button');
    const importFileName = document.getElementById('import-file-name');
    const importDocumentButton = document.getElementById('import-document-button');
    const registerForm = document.getElementById('register-form');
    const errorEl = document.getElementById('form-error');
    const registerErrorEl = document.getElementById('register-error');
    const identityStorageKey = 'proof.reviewRoom.identityId.v1';
    let currentIdentityPayload = null;
    let selectedImportFile = null;

    function createBrowserIdentityId() {
      const randomPart = window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      return 'browser-' + randomPart;
    }

    function getBrowserIdentityId() {
      try {
        const existing = window.localStorage.getItem(identityStorageKey);
        if (existing && existing.trim()) return existing.trim();
        const created = createBrowserIdentityId();
        window.localStorage.setItem(identityStorageKey, created);
        return created;
      } catch {
        if (!window.__proofReviewRoomIdentityId) {
          window.__proofReviewRoomIdentityId = createBrowserIdentityId();
        }
        return window.__proofReviewRoomIdentityId;
      }
    }

    function reviewRoomHeaders(extra) {
      return Object.assign({
        'x-review-room-identity-id': getBrowserIdentityId(),
      }, extra || {});
    }

    function formatDate(value) {
      try { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
      catch { return value || ''; }
    }

    function absoluteReviewRoomUrl(path) {
      try { return new URL(path, window.location.origin).toString(); }
      catch { return String(path || ''); }
    }

    async function copyText(value) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch {}
      return false;
    }

    function renderDocuments(docs) {
      if (!docs.length) {
        documentsEl.innerHTML = '<div class="empty">No Review Room documents yet.</div>';
        return;
      }
      documentsEl.innerHTML = docs.map((doc) => {
        const title = escapeHtml(doc.title || 'Untitled review');
        const source = escapeHtml(doc.sourceLabel || (doc.source === 'registered' ? 'Registered document' : doc.source === 'imported' ? 'Imported file' : 'Created in Review Room'));
        const meta = escapeHtml('Slug ' + doc.proofSlug + ' · Updated ' + formatDate(doc.proofUpdatedAt || doc.updatedAt));
        return '<article class="doc-row">'
          + '<div><div class="doc-title">' + title + '</div><div class="doc-meta"><span class="doc-source">' + source + '</span><span>' + meta + '</span></div></div>'
          + '<a class="button secondary" href="' + encodeURI(doc.openPath) + '">Open</a>'
          + '</article>';
      }).join('');
    }

    function renderIdentity(payload) {
      workspaceChip.textContent = payload.workspace && payload.workspace.name ? payload.workspace.name : 'Review Room';
      currentIdentityPayload = payload;
      const identity = payload.currentIdentity || {};
      const displayName = identity.display_name || identity.displayName || identity.id || 'Review Room user';
      const sessionActive = Boolean(payload.session && payload.session.active);
      profileButtonLabel.textContent = displayName;
      profileAvatar.textContent = displayName.trim().slice(0, 1).toUpperCase() || '?';
      profileName.textContent = displayName;
      profileDisplayName.value = displayName;
      profileSession.textContent = sessionActive ? 'Linked on this browser' : 'Local browser identity';
      profileContinuityCopy.textContent = sessionActive
        ? 'A one-time invitation linked this identity to this browser. Signing out ends that identity session here; shared document links can still grant document access.'
        : 'This identity currently lives only in this browser. Accepting an owner invitation links a stable collaborator identity here.';
      profileDeviceCopy.textContent = sessionActive
        ? 'Create a short-lived one-use enrollment link to carry this same identity to another browser. Losing every authenticated device remains a separate recovery decision.'
        : 'Device enrollment is available after this browser has an authenticated Review Room session.';
      profileEnrollment.hidden = !sessionActive;
      profileEnrollmentResult.dataset.open = 'false';
      profileEnrollmentResult.textContent = '';
      profileSessions.innerHTML = '';
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      if (sessionActive && sessions.length) {
        const heading = document.createElement('strong');
        heading.textContent = 'Active devices';
        profileSessions.appendChild(heading);
        for (const deviceSession of sessions) {
          if (!deviceSession.id) continue;
          const row = document.createElement('div');
          row.className = 'profile-session-row';
          const details = document.createElement('div');
          const title = document.createElement('strong');
          title.textContent = deviceSession.current ? 'This browser' : 'Enrolled browser';
          const meta = document.createElement('div');
          meta.className = 'profile-session-meta';
          meta.textContent = 'Last used ' + formatDate(deviceSession.lastSeenAt) + '; created ' + formatDate(deviceSession.createdAt);
          details.append(title, meta);
          const revoke = document.createElement('button');
          revoke.type = 'button';
          revoke.className = 'profile-signout';
          revoke.textContent = deviceSession.current ? 'Sign out' : 'Revoke';
          revoke.addEventListener('click', async () => {
            revoke.disabled = true;
            profileStatus.textContent = deviceSession.current ? 'Signing out…' : 'Revoking device…';
            try {
              const response = await fetch('/review-room/api/sessions/' + encodeURIComponent(deviceSession.id), {
                method: 'DELETE',
                headers: reviewRoomHeaders(),
              });
              if (!response.ok) throw new Error('Could not revoke that device session.');
              if (deviceSession.current) window.location.href = '/review-room';
              await load();
              profileStatus.textContent = 'Device revoked.';
            } catch (error) {
              profileStatus.textContent = error instanceof Error ? error.message : String(error);
              revoke.disabled = false;
            }
          });
          row.append(details, revoke);
          profileSessions.appendChild(row);
        }
      }
      profileSignout.hidden = !sessionActive;
    }

    function setProfileMenuOpen(open) {
      profileMenu.dataset.open = open ? 'true' : 'false';
      profileButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) window.setTimeout(() => profileDisplayName.focus(), 0);
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    async function load() {
      const [docsResponse, identityResponse] = await Promise.all([
        fetch('/review-room/api/documents', { headers: reviewRoomHeaders() }),
        fetch('/review-room/api/identity', { headers: reviewRoomHeaders() }),
      ]);
      const docsPayload = await docsResponse.json();
      const identityPayload = await identityResponse.json();
      renderDocuments(docsPayload.documents || []);
      renderIdentity(identityPayload);
    }

    profileButton.addEventListener('click', () => {
      setProfileMenuOpen(profileMenu.dataset.open !== 'true');
    });

    document.addEventListener('mousedown', (event) => {
      if (profileMenu.dataset.open !== 'true' || profileControl.contains(event.target)) return;
      setProfileMenuOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && profileMenu.dataset.open === 'true') {
        setProfileMenuOpen(false);
        profileButton.focus();
      }
    });

    profileForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const displayName = profileDisplayName.value.trim();
      if (!displayName) return;
      profileSave.disabled = true;
      profileStatus.textContent = 'Saving…';
      try {
        const response = await fetch('/review-room/api/identity', {
          method: 'PATCH',
          headers: reviewRoomHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ displayName }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not save display name.');
        renderIdentity(Object.assign({}, currentIdentityPayload || {}, { currentIdentity: payload.currentIdentity }));
        profileStatus.textContent = 'Saved.';
      } catch (error) {
        profileStatus.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        profileSave.disabled = false;
      }
    });

    profileEnrollment.addEventListener('click', async () => {
      profileEnrollment.disabled = true;
      profileStatus.textContent = 'Creating enrollment link…';
      try {
        const response = await fetch('/review-room/api/session/enrollments', {
          method: 'POST',
          headers: reviewRoomHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({}),
        });
        const payload = await response.json();
        if (!response.ok || !payload.enrollmentPath) throw new Error(payload.error || 'Could not create enrollment link.');
        const url = absoluteReviewRoomUrl(payload.enrollmentPath);
        const copied = await copyText(url);
        profileEnrollmentResult.dataset.open = 'true';
        profileEnrollmentResult.innerHTML = '';
        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'profile-device-link';
        copyButton.textContent = 'Copy enrollment link';
        copyButton.addEventListener('click', async () => {
          const didCopy = await copyText(url);
          profileStatus.textContent = didCopy ? 'Enrollment link copied.' : url;
        });
        const note = document.createElement('span');
        note.textContent = 'Expires ' + formatDate(payload.enrollmentExpiresAt) + ' and can be used once. Creating another link revokes the previous unused one.';
        profileEnrollmentResult.append(copyButton, note);
        profileStatus.textContent = copied ? 'Enrollment link copied.' : 'Enrollment link created.';
      } catch (error) {
        profileStatus.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        profileEnrollment.disabled = false;
      }
    });

    profileSignout.addEventListener('click', async () => {
      profileSignout.disabled = true;
      profileStatus.textContent = 'Signing out…';
      try {
        const response = await fetch('/review-room/api/session/logout', {
          method: 'POST',
          headers: reviewRoomHeaders(),
        });
        if (!response.ok) throw new Error('Could not sign out this device.');
        window.location.href = '/review-room';
      } catch (error) {
        profileStatus.textContent = error instanceof Error ? error.message : String(error);
        profileSignout.disabled = false;
      }
    });

    newDocumentButton.addEventListener('click', async () => {
      errorEl.textContent = '';
      newDocumentButton.disabled = true;
      newDocumentButton.textContent = 'Creating...';
      const response = await fetch('/review-room/api/documents', {
        method: 'POST',
        headers: reviewRoomHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title: 'Untitled document', markdown: '' }),
      });
      const payload = await response.json();
      if (!response.ok) {
        errorEl.textContent = payload.error || 'Could not create document.';
        newDocumentButton.disabled = false;
        newDocumentButton.textContent = 'Create new document';
        return;
      }
      window.location.href = payload.openPath;
    });

    function isSupportedImportFile(file) {
      if (!file) return false;
      const lowerName = file.name.toLowerCase();
      return lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || lowerName.endsWith('.txt')
        || file.type === 'text/markdown' || file.type === 'text/plain';
    }

    function resetSelectedImportFile(message) {
      selectedImportFile = null;
      importFileInput.value = '';
      importFileName.dataset.selected = 'false';
      importFileName.textContent = message || 'Drop a file here or choose one below.';
    }

    function selectImportFile(file) {
      errorEl.textContent = '';
      if (!file) {
        resetSelectedImportFile();
        errorEl.textContent = 'Choose a Markdown or Text file to import.';
        return false;
      }
      if (!isSupportedImportFile(file)) {
        resetSelectedImportFile();
        errorEl.textContent = 'Review Room can import .md, .markdown, and .txt files right now.';
        return false;
      }
      selectedImportFile = file;
      importFileName.dataset.selected = 'true';
      importFileName.textContent = file.name;
      return true;
    }

    async function importReviewRoomFile(file) {
      if (!selectImportFile(file)) return;
      importDocumentButton.disabled = true;
      importDocumentButton.textContent = 'Importing...';
      try {
        const markdown = await file.text();
        const title = file.name.replace(/\\.(markdown|md|txt)$/i, '').trim() || 'Imported document';
        const response = await fetch('/review-room/api/documents', {
          method: 'POST',
          headers: reviewRoomHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ title, markdown, source: 'imported' }),
        });
        const payload = await response.json();
        if (!response.ok) {
          errorEl.textContent = payload.error || 'Could not import document.';
          importDocumentButton.disabled = false;
          importDocumentButton.textContent = 'Import and open';
          return;
        }
        window.location.href = payload.openPath;
      } catch (error) {
        errorEl.textContent = error instanceof Error ? error.message : String(error);
        importDocumentButton.disabled = false;
        importDocumentButton.textContent = 'Import and open';
      }
    }

    chooseFileButton.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      importFileInput.click();
    });

    importFileInput.addEventListener('change', () => {
      selectImportFile(importFileInput.files && importFileInput.files[0]);
    });

    for (const eventName of ['dragenter', 'dragover']) {
      importDropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        importDropZone.dataset.active = 'true';
      });
    }

    for (const eventName of ['dragleave', 'drop']) {
      importDropZone.addEventListener(eventName, () => {
        importDropZone.dataset.active = 'false';
      });
    }

    importDropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      selectImportFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
    });

    importForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await importReviewRoomFile(selectedImportFile || (importFileInput.files && importFileInput.files[0]));
    });

    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      registerErrorEl.textContent = '';
      const proofSlug = document.getElementById('proof-slug').value.trim();
      const token = document.getElementById('proof-token').value.trim();
      if (token && /\\s/.test(token)) {
        registerErrorEl.textContent = 'Access token must be a single token value.';
        return;
      }
      const response = await fetch('/review-room/api/documents/register', {
        method: 'POST',
        headers: reviewRoomHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ proofSlug, token }),
      });
      const payload = await response.json();
      if (!response.ok) {
        registerErrorEl.textContent = payload.error || 'Could not register document.';
        return;
      }
      registerErrorEl.textContent = payload.message || 'Opening document...';
      window.setTimeout(() => {
        window.location.href = payload.openPath || payload.document.openPath;
      }, 80);
    });

    load().catch((error) => {
      documentsEl.innerHTML = '<div class="empty">Could not load Review Room documents.</div>';
      errorEl.textContent = error.message || String(error);
      registerErrorEl.textContent = error.message || String(error);
    });
  </script>
</body>
</html>`;
}

reviewRoomRoutes.get('/review-room', (_req: Request, res: Response) => {
  res.type('html').send(renderReviewRoomHome());
});

reviewRoomRoutes.get('/review-room/claude-plugin.zip', (_req: Request, res: Response) => {
  try {
    const archive = buildClaudePluginZip();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="review-room-claude-plugin.zip"');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(archive);
  } catch (error) {
    console.error('[review-room] failed to build Claude plugin zip', error);
    res.status(500).type('text/plain').send('Could not build the Claude plugin download.');
  }
});

reviewRoomRoutes.get('/review-room/api/identity', async (req: Request, res: Response) => {
  const identityId = await getCurrentReviewRoomIdentityId(req);
  const session = await getReviewRoomSession(req);
  const sessions = session ? await storeListReviewRoomSessions(session.identity_id) : [];
  res.json({
    success: true,
    workspace: {
      id: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
      name: REVIEW_ROOM_LOCAL_WORKSPACE_NAME,
    },
    currentIdentity: await storeGetReviewRoomIdentity(identityId),
    session: session ? { active: true, expiresAt: session.expires_at } : { active: false },
    sessions: sessions.map((row) => ({
      id: row.id,
      identityId: row.identity_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      current: row.id === session?.id,
    })),
    identities: await storeListReviewRoomIdentities(REVIEW_ROOM_DEFAULT_WORKSPACE_ID),
  });
});

reviewRoomRoutes.get('/review-room/session/accept', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const secret = typeof req.query.invite === 'string' ? req.query.invite.trim() : '';
  if (!secret) {
    res.status(400).type('text/plain').send('This identity invitation is invalid.');
    return;
  }
  const invitation = await storeConsumeReviewRoomIdentityInvitation(secret);
  if (!invitation) {
    res.status(410).type('text/plain').send('This identity invitation has expired or was already used.');
    return;
  }
  const identity = await storeGetReviewRoomIdentity(invitation.identity_id);
  const member = await storeGetReviewRoomDocumentMemberForProofSlug(invitation.proof_slug, invitation.identity_id);
  if (!identity || !member) {
    res.status(409).type('text/plain').send('This invitation no longer has a matching collaborator membership.');
    return;
  }
  const { session, secret: sessionSecret } = await storeCreateReviewRoomSession(invitation.identity_id);
  const maxAgeSec = Math.max(1, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000));
  setReviewRoomSessionCookie(req, res, sessionSecret, maxAgeSec);
  const openPath = appendTokenToPath(buildReviewRoomOpenPath(invitation.proof_slug), member.proof_access_token ?? null);
  if (req.accepts(['html', 'json']) === 'json') {
    res.json({
      success: true,
      identity: { id: identity.id, displayName: identity.display_name },
      session: { active: true, expiresAt: session.expires_at },
      openPath,
    });
    return;
  }
  res.redirect(303, openPath);
});

reviewRoomRoutes.post('/review-room/api/session/enrollments', async (req: Request, res: Response) => {
  const session = await getReviewRoomSession(req);
  if (!session) {
    res.status(401).json({
      success: false,
      code: 'SESSION_REQUIRED',
      error: 'Create a device enrollment link from an authenticated Review Room browser.',
    });
    return;
  }
  const { enrollment, secret } = await storeCreateReviewRoomDeviceEnrollment({
    identityId: session.identity_id,
    createdBySessionId: session.id,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    enrollment: {
      id: enrollment.id,
      identityId: enrollment.identity_id,
      expiresAt: enrollment.expires_at,
      createdAt: enrollment.created_at,
    },
    enrollmentPath: buildReviewRoomEnrollmentPath(secret),
    enrollmentExpiresAt: enrollment.expires_at,
  });
});

reviewRoomRoutes.get('/review-room/session/enroll', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const secret = typeof req.query.enroll === 'string' ? req.query.enroll.trim() : '';
  if (!secret) {
    res.status(400).type('text/plain').send('This device enrollment link is invalid.');
    return;
  }
  const enrollment = await storeGetReviewRoomDeviceEnrollmentBySecret(secret);
  if (!enrollment) {
    res.status(400).type('text/plain').send('This device enrollment link is invalid.');
    return;
  }
  const existingSession = await getReviewRoomSession(req);
  if (existingSession?.identity_id === enrollment.identity_id) {
    if (req.accepts(['html', 'json']) === 'json') {
      res.status(409).json({
        success: false,
        code: 'ALREADY_ENROLLED',
        error: 'This browser is already enrolled for this Review Room identity.',
        session: { active: true, expiresAt: existingSession.expires_at },
      });
      return;
    }
    res.status(409).type('text/plain').send('This browser is already enrolled for this Review Room identity.');
    return;
  }
  const nowMs = Date.now();
  if (enrollment.revoked_at) {
    res.status(410).type('text/plain').send('This device enrollment link was revoked.');
    return;
  }
  if (enrollment.accepted_at) {
    res.status(410).type('text/plain').send('This device enrollment link was already used.');
    return;
  }
  if (Date.parse(enrollment.expires_at) <= nowMs) {
    res.status(410).type('text/plain').send('This device enrollment link has expired.');
    return;
  }
  const consumed = await storeConsumeReviewRoomDeviceEnrollment(secret);
  if (!consumed) {
    res.status(410).type('text/plain').send('This device enrollment link has expired, was revoked, or was already used.');
    return;
  }
  const identity = await storeGetReviewRoomIdentity(consumed.identity_id);
  if (!identity) {
    res.status(409).type('text/plain').send('This device enrollment link no longer has a matching Review Room identity.');
    return;
  }
  const { session, secret: sessionSecret } = await storeCreateReviewRoomSession(consumed.identity_id);
  const maxAgeSec = Math.max(1, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000));
  setReviewRoomSessionCookie(req, res, sessionSecret, maxAgeSec);
  if (req.accepts(['html', 'json']) === 'json') {
    res.json({
      success: true,
      identity: { id: identity.id, displayName: identity.display_name },
      session: { active: true, id: session.id, expiresAt: session.expires_at },
    });
    return;
  }
  res.redirect(303, '/review-room');
});

reviewRoomRoutes.post('/review-room/api/session/logout', async (req: Request, res: Response) => {
  const secret = getReviewRoomSessionCookie(req);
  await storeRevokeReviewRoomSession(secret);
  clearReviewRoomSessionCookie(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true });
});

reviewRoomRoutes.delete('/review-room/api/sessions/:sessionId', async (req: Request, res: Response) => {
  const session = await getReviewRoomSession(req);
  if (!session) {
    res.status(401).json({ success: false, code: 'SESSION_REQUIRED', error: 'A Review Room session is required.' });
    return;
  }
  const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId.trim() : '';
  if (!sessionId) {
    res.status(400).json({ success: false, code: 'SESSION_ID_REQUIRED', error: 'Session id is required.' });
    return;
  }
  const revoked = await storeRevokeReviewRoomSessionById({ sessionId, identityId: session.identity_id });
  if (!revoked) {
    res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', error: 'That device session was not found.' });
    return;
  }
  if (sessionId === session.id) clearReviewRoomSessionCookie(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, sessionId, revoked: true, current: sessionId === session.id });
});

reviewRoomRoutes.patch('/review-room/api/identity', async (req: Request, res: Response) => {
  const identityId = await getCurrentReviewRoomIdentityId(req);
  const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim().slice(0, 120) : '';
  if (!displayName) {
    res.status(400).json({ success: false, code: 'DISPLAY_NAME_REQUIRED', error: 'Display name is required.' });
    return;
  }
  const existing = await storeGetReviewRoomIdentity(identityId);
  const identity = await storeUpsertReviewRoomIdentity({
    id: identityId,
    workspaceId: existing?.workspace_id ?? REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
    kind: existing?.kind === 'agent' ? 'agent' : 'human',
    managerIdentityId: existing?.manager_identity_id ?? null,
    displayName,
  });
  res.json({ success: true, currentIdentity: identity });
});

reviewRoomRoutes.get('/review-room/api/agents', async (_req: Request, res: Response) => {
  const agents = await storeListReviewRoomAgents(REVIEW_ROOM_DEFAULT_WORKSPACE_ID);
  res.json({
    success: true,
    agents: agents.map(serializeAgent),
  });
});

reviewRoomRoutes.get('/review-room/api/documents', async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
  const identityId = await getCurrentReviewRoomIdentityId(req);
  const rows = await storeListReviewRoomDocuments(REVIEW_ROOM_DEFAULT_WORKSPACE_ID, Number.isFinite(limit) ? limit : 50);
  const documents = (await Promise.all(
    rows.map(async (row) => {
      const member = await storeGetReviewRoomDocumentMemberForProofSlug(row.proof_slug, identityId);
      return member ? serializeDocument(row, member) : null;
    }),
  )).filter((document): document is Record<string, unknown> => Boolean(document));
  res.json({
    success: true,
    currentIdentity: await storeGetReviewRoomIdentity(identityId),
    documents,
  });
});

reviewRoomRoutes.get('/review-room/api/documents/:proofSlug/review-runs', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const access = proofSlug ? await getReviewRoomDocumentAccess(req, proofSlug) : null;
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canRead) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_FORBIDDEN', 'Your Review Room role cannot read agent review runs.');
    return;
  }
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20;
  await storeExpireAgentReviewRunLeases(access.document.id);
  const runs = await storeListAgentReviewRuns(access.document.id, Number.isFinite(limit) ? limit : 20);
  res.json({
    success: true,
    canStart: access.capabilities.canRequestAgentReview,
    runs: await Promise.all(runs.map(async (run) => (
      serializeAgentReviewRun(run, await storeGetLatestReviewRoomAgentCredential(run.id))
    ))),
  });
});

reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/review-runs', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const access = proofSlug ? await getReviewRoomDocumentAccess(req, proofSlug) : null;
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canRequestAgentReview) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_AGENT_REVIEW_FORBIDDEN', 'Only the document owner can start an agent review.');
    return;
  }
  const providedKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.trim() : '';
  const idempotencyKey = (providedKey || randomUUID()).slice(0, 120);
  const scope = typeof req.body?.scope === 'string' && req.body.scope.trim()
    ? req.body.scope.trim().slice(0, 120)
    : 'document';
  const instructions = typeof req.body?.instructions === 'string' && req.body.instructions.trim()
    ? req.body.instructions.trim().slice(0, 4000)
    : null;
  await storeExpireAgentReviewRunLeases(access.document.id);
  const created = await storeCreateAgentReviewRun({
    documentId: access.document.id,
    requestedByIdentityId: access.identityId,
    idempotencyKey,
    scope,
    instructions,
  });
  if (!created.reused) {
    await storeCreateReviewRoomHistoryEvent({
      documentId: access.document.id,
      actorId: access.identityId,
      actorType: 'human',
      eventType: 'agent_review.requested',
      targetType: 'agent_review_run',
      targetId: created.run.id,
      after: { status: 'queued', scope, instructions },
    });
  }
  res.status(created.reused ? 200 : 202).json({
    success: true,
    reused: created.reused,
    run: serializeAgentReviewRun(created.run),
  });
});

reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/review-runs/:runId/retry', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const runId = String(req.params.runId || '').trim();
  const access = proofSlug ? await getReviewRoomDocumentAccess(req, proofSlug) : null;
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canRequestAgentReview) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_AGENT_REVIEW_FORBIDDEN', 'Only the document owner can retry an agent review.');
    return;
  }
  const existing = await storeGetAgentReviewRun(runId);
  if (!existing || existing.document_id !== access.document.id) {
    res.status(404).json({ success: false, code: 'AGENT_REVIEW_RUN_MISSING', error: 'Agent review run not found.' });
    return;
  }
  const queued = await storeQueueAgentReviewRunRetry(runId);
  if (!queued) {
    res.status(409).json({ success: false, code: 'AGENT_REVIEW_RETRY_NOT_ALLOWED', error: 'Only failed agent reviews can be retried.' });
    return;
  }
  await storeCreateReviewRoomHistoryEvent({
    documentId: access.document.id,
    actorId: access.identityId,
    actorType: 'human',
    eventType: 'agent_review.requeued',
    targetType: 'agent_review_run',
    targetId: runId,
    before: { status: existing.status },
    after: { status: 'queued', attemptCount: queued.attempt_count },
  });
  res.status(202).json({ success: true, run: serializeAgentReviewRun(queued) });
});

reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/review-runs/:runId/agent-credential', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const runId = String(req.params.runId || '').trim();
  const access = proofSlug ? await getReviewRoomDocumentAccess(req, proofSlug) : null;
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canRequestAgentReview) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_AGENT_CREDENTIAL_FORBIDDEN', 'Only the document owner can create agent access.');
    return;
  }
  const run = await storeGetAgentReviewRun(runId);
  if (!run || run.document_id !== access.document.id) {
    res.status(404).json({ success: false, code: 'AGENT_REVIEW_RUN_MISSING', error: 'Review request not found.' });
    return;
  }
  if (run.status !== 'queued') {
    res.status(409).json({ success: false, code: 'AGENT_CREDENTIAL_NOT_ALLOWED', error: 'Agent access can only be created while a review request is waiting.' });
    return;
  }
  const previous = await storeGetLatestReviewRoomAgentCredential(runId);
  const agentId = previous?.agent_id || `ai:review-agent-${runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
  const requestedName = typeof req.body?.agentName === 'string' ? req.body.agentName.trim() : '';
  const agentName = (requestedName || 'External review agent').slice(0, 120);
  const secret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const credential = await storeCreateReviewRoomAgentCredential({
    documentId: access.document.id,
    reviewRequestId: runId,
    agentId,
    agentName,
    tokenHash: createHash('sha256').update(secret).digest('hex'),
    createdByIdentityId: access.identityId,
    expiresAt,
  });
  await storeCreateReviewRoomHistoryEvent({
    documentId: access.document.id,
    actorId: access.identityId,
    actorType: 'human',
    eventType: 'agent_access.created',
    targetType: 'agent_review_run',
    targetId: runId,
    after: { agentId, expiresAt },
  });
  res.status(201).json({
    success: true,
    credential: {
      id: credential.id,
      reviewRequestId: credential.review_request_id,
      agentId: credential.agent_id,
      agentName,
      token: secret,
      expiresAt: credential.expires_at,
    },
  });
});

reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/review-runs/:runId/cancel', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const runId = String(req.params.runId || '').trim();
  const access = proofSlug ? await getReviewRoomDocumentAccess(req, proofSlug) : null;
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canRequestAgentReview) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_AGENT_REVIEW_FORBIDDEN', 'Only the document owner can cancel a review request.');
    return;
  }
  const existing = await storeGetAgentReviewRun(runId);
  if (!existing || existing.document_id !== access.document.id) {
    res.status(404).json({ success: false, code: 'AGENT_REVIEW_RUN_MISSING', error: 'Review request not found.' });
    return;
  }
  const cancelled = await storeCancelAgentReviewRun(runId);
  if (!cancelled) {
    res.status(409).json({ success: false, code: 'AGENT_REVIEW_CANCEL_NOT_ALLOWED', error: 'Only active review requests can be cancelled.' });
    return;
  }
  await storeCreateReviewRoomHistoryEvent({
    documentId: access.document.id,
    actorId: access.identityId,
    actorType: 'human',
    eventType: 'agent_review.cancelled',
    targetType: 'agent_review_run',
    targetId: runId,
    before: { status: existing.status },
    after: { status: 'cancelled' },
  });
  res.json({ success: true, run: serializeAgentReviewRun(cancelled) });
});

reviewRoomRoutes.get('/review-room/api/documents/:proofSlug/history', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
  const since = typeof req.query.since === 'string' && req.query.since.trim() ? req.query.since.trim() : null;
  if (!proofSlug) {
    res.status(400).json({ success: false, code: 'DOCUMENT_SLUG_REQUIRED', error: 'Document slug is required.' });
    return;
  }
  const access = await getReviewRoomDocumentAccess(req, proofSlug);
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canRead) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_FORBIDDEN', 'Your Review Room role cannot read this document history.');
    return;
  }
  const events = await storeListReviewRoomHistoryEvents({
    documentId: access.document.id,
    limit: Number.isFinite(limit) ? limit : 100,
    since,
  });
  res.json({
    success: true,
    document: serializeDocument(access.document, access.member),
    events: events.map(serializeHistoryEvent),
  });
});

reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/audit/:eventId/reviewed', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const eventId = String(req.params.eventId || '').trim();
  const identityId = await getCurrentReviewRoomIdentityId(req);
  if (!proofSlug || !eventId) {
    res.status(400).json({ success: false, code: 'AUDIT_TARGET_REQUIRED', error: 'Document slug and audit event id are required.' });
    return;
  }
  const access = await getReviewRoomDocumentAccess(req, proofSlug);
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canComment) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_AUDIT_FORBIDDEN', 'Comment access is required to review direct changes.');
    return;
  }
  const events = await storeListReviewRoomHistoryEvents({
    documentId: access.document.id,
    limit: 500,
  });
  const target = events.find((event) => event.id === eventId);
  if (!target || target.event_type !== 'document.direct_mutation') {
    res.status(404).json({ success: false, code: 'AUDIT_EVENT_MISSING', error: 'No direct-change audit event exists for that document.' });
    return;
  }
  const existing = events.find((event) => (
    event.event_type === 'audit.reviewed'
    && event.target_type === 'review_room_history_event'
    && event.target_id === eventId
  ));
  if (existing) {
    res.json({
      success: true,
      alreadyReviewed: true,
      event: serializeHistoryEvent(existing),
    });
    return;
  }
  const reviewed = await storeCreateReviewRoomHistoryEvent({
    workspaceId: access.document.workspace_id,
    documentId: access.document.id,
    actorId: identityId,
    actorType: 'human',
    eventType: 'audit.reviewed',
    targetType: 'review_room_history_event',
    targetId: eventId,
    before: { status: 'open' },
    after: { status: 'reviewed' },
    metadata: {
      proofSlug,
      reviewedEventType: 'document.direct_mutation',
    },
  });
  res.status(201).json({
    success: true,
    alreadyReviewed: false,
    event: serializeHistoryEvent(reviewed),
  });
});

reviewRoomRoutes.get('/review-room/api/documents/:proofSlug/baselines', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20;
  if (!proofSlug) {
    res.status(400).json({ success: false, code: 'DOCUMENT_SLUG_REQUIRED', error: 'Document slug is required.' });
    return;
  }
  const access = await getReviewRoomDocumentAccess(req, proofSlug);
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canRead) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_FORBIDDEN', 'Your Review Room role cannot read this document baselines.');
    return;
  }
  const baselines = await storeListPublishedVersions(access.document.id, Number.isFinite(limit) ? limit : 20);
  res.json({
    success: true,
    document: serializeDocument(access.document, access.member),
    latest: baselines[0] ? serializePublishedVersion(baselines[0]) : null,
    baselines: baselines.map(serializePublishedVersion),
  });
});

reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/baselines', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const identityId = await getCurrentReviewRoomIdentityId(req);
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  if (!proofSlug) {
    res.status(400).json({ success: false, code: 'DOCUMENT_SLUG_REQUIRED', error: 'Document slug is required.' });
    return;
  }
  const access = await getReviewRoomDocumentAccess(req, proofSlug);
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canCreateBaseline) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_BASELINE_FORBIDDEN', 'Your Review Room role cannot create baselines for this document.');
    return;
  }
  const document = access.document;
  const proofDoc = await engineGetDocumentBySlug(proofSlug);
  if (!proofDoc) {
    res.status(404).json({ success: false, code: 'PROOF_DOCUMENT_MISSING', error: 'The underlying Proof document is missing.' });
    return;
  }
  const previous = await storeGetLatestPublishedVersion(document.id);
  const baseline = await storeCreatePublishedVersion({
    documentId: document.id,
    proofRevision: proofDoc.revision,
    contentSnapshot: proofDoc.markdown,
    createdByIdentityId: identityId,
    note,
  });
  await storeCreateReviewRoomHistoryEvent({
    workspaceId: document.workspace_id,
    documentId: document.id,
    actorId: identityId,
    actorType: 'human',
    eventType: 'baseline.created',
    targetType: 'published_version',
    targetId: baseline.id,
    before: previous ? {
      versionNumber: previous.version_number,
      proofRevision: previous.proof_revision,
      createdAt: previous.created_at,
    } : undefined,
    after: {
      versionNumber: baseline.version_number,
      proofRevision: baseline.proof_revision,
      createdAt: baseline.created_at,
      note: baseline.note,
      contentLength: baseline.content_snapshot.length,
    },
    metadata: { proofSlug },
  });
  res.status(201).json({
    success: true,
    document: serializeDocument(document, access.member),
    baseline: serializePublishedVersion(baseline),
  });
});

reviewRoomRoutes.get('/review-room/api/documents/:proofSlug/tasks', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  if (!proofSlug) {
    res.status(400).json({ success: false, code: 'DOCUMENT_SLUG_REQUIRED', error: 'Document slug is required.' });
    return;
  }
  const status = parseTaskStatusFilter(req.query.status);
  if (!status) {
    res.status(400).json({ success: false, code: 'INVALID_TASK_STATUS', error: 'Task status must be open, running, delegated, dismissed, completed, or all.' });
    return;
  }
  const access = await getReviewRoomDocumentAccess(req, proofSlug);
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canRead) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_FORBIDDEN', 'Your Review Room role cannot read this document tasks.');
    return;
  }
  const document = access.document;
  const [tasks, proofDoc, labels] = await Promise.all([
    storeListAssignmentTasks(document.id, status),
    engineGetDocumentBySlug(proofSlug),
    buildAssignmentTaskLabels(document.workspace_id),
  ]);
  const marks = parseJsonObject(proofDoc?.marks) ?? {};
  res.json({
    success: true,
    document: serializeDocument(document, access.member),
    tasks: tasks.map((task) => serializeAssignmentTask(task, labels, sourceTextForTask(task, marks))),
  });
});

reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/tasks/:taskId/status', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const taskId = String(req.params.taskId || '').trim();
  const identityId = await getCurrentReviewRoomIdentityId(req);
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
  if (!proofSlug || !taskId) {
    res.status(400).json({ success: false, code: 'TASK_TARGET_REQUIRED', error: 'Document slug and task id are required.' });
    return;
  }
  if (status !== 'completed' && status !== 'dismissed') {
    res.status(400).json({ success: false, code: 'INVALID_TASK_STATUS', error: 'Task status must be completed or dismissed.' });
    return;
  }
  const access = await getReviewRoomDocumentAccess(req, proofSlug);
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canUpdateTasks) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_TASK_FORBIDDEN', 'Your Review Room role cannot update tasks for this document.');
    return;
  }
  const document = access.document;
  const before = await storeGetAssignmentTask(taskId);
  if (!before || before.document_id !== document.id) {
    res.status(404).json({ success: false, code: 'TASK_MISSING', error: 'No assignment task exists for that document.' });
    return;
  }
  const task = await storeUpdateAssignmentTaskStatus(taskId, status);
  if (!task) {
    res.status(409).json({ success: false, code: 'TASK_NOT_OPEN', error: 'Only open assignment tasks can be completed or dismissed.' });
    return;
  }
  await storeCreateReviewRoomHistoryEvent({
    workspaceId: document.workspace_id,
    documentId: document.id,
    actorId: identityId,
    actorType: 'human',
    eventType: 'task.status_changed',
    targetType: 'assignment_task',
    targetId: task.id,
    before: { status: before.status },
    after: { status: task.status },
    metadata: {
      proofSlug,
      sourceType: task.source_type,
      sourceId: task.source_id,
      assignedToActorId: task.assigned_to_actor_id,
      assignedToActorType: task.assigned_to_actor_type,
    },
  });
  const labels = await buildAssignmentTaskLabels(document.workspace_id);
  res.json({
    success: true,
    task: serializeAssignmentTask(task, labels),
  });
});

reviewRoomRoutes.get('/review-room/api/documents/:proofSlug/members', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  if (!proofSlug) {
    res.status(400).json({ success: false, code: 'DOCUMENT_SLUG_REQUIRED', error: 'Document slug is required.' });
    return;
  }
  const access = await getReviewRoomDocumentAccess(req, proofSlug);
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canRead) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_FORBIDDEN', 'Your Review Room role cannot read this document members.');
    return;
  }
  const members = await storeListReviewRoomDocumentMembersForProofSlug(proofSlug);
  const identities = new Map(
    (await Promise.all(members.map((member) => storeGetReviewRoomIdentity(member.identity_id))))
      .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity))
      .map((identity) => [identity.id, identity]),
  );
  const canManageMembers = access.capabilities.canManageMembers;
  res.json({
    success: true,
    document: serializeDocument(access.document, access.member),
    currentMember: access.member ? serializeDocumentMember(access.member, identities.get(access.member.identity_id) ?? null) : null,
    members: members.map((member) => serializeDocumentMember(member, identities.get(member.identity_id) ?? null, canManageMembers)),
  });
});

reviewRoomRoutes.post('/review-room/api/documents/:proofSlug/members', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const identityId = normalizeReviewRoomIdentityId(body.identityId);
  const role = parseReviewRoomRoleInput(body.role);
  const displayName = typeof body.displayName === 'string' && body.displayName.trim()
    ? body.displayName.trim().slice(0, 120)
    : identityId;
  if (!proofSlug) {
    res.status(400).json({ success: false, code: 'DOCUMENT_SLUG_REQUIRED', error: 'Document slug is required.' });
    return;
  }
  if (!role) {
    res.status(400).json({ success: false, code: 'INVALID_REVIEW_ROOM_ROLE', error: 'Role must be owner, editor, commenter, or viewer.' });
    return;
  }
  const access = await getReviewRoomDocumentAccess(req, proofSlug);
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canManageMembers) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_MEMBER_FORBIDDEN', 'Only the Review Room document owner can manage collaborator roles.');
    return;
  }
  const identity = await storeUpsertReviewRoomIdentity({
    id: identityId,
    workspaceId: access.document.workspace_id,
    kind: 'human',
    displayName,
  });
  const before = await storeGetReviewRoomDocumentMemberForProofSlug(proofSlug, identityId);
  const member = await storeUpsertReviewRoomDocumentMember({
    reviewRoomDocumentId: access.document.id,
    identityId,
    role,
    proofSlug,
  });
  const { invitation, secret: invitationSecret } = await storeCreateReviewRoomIdentityInvitation({
    identityId,
    reviewRoomDocumentId: access.document.id,
    proofSlug,
    createdByIdentityId: access.identityId,
  });
  await storeCreateReviewRoomHistoryEvent({
    workspaceId: access.document.workspace_id,
    documentId: access.document.id,
    actorId: access.identityId,
    actorType: 'human',
    eventType: before ? 'member.role_changed' : 'member.added',
    targetType: 'document_member',
    targetId: identityId,
    before: before ? { role: before.role } : undefined,
    after: { role: member.role, identityId, displayName: identity.display_name },
    metadata: { proofSlug },
  });
  res.status(before ? 200 : 201).json({
    success: true,
    document: serializeDocument(access.document, access.member),
    member: serializeDocumentMember(member, identity, true, true),
    identityInvitePath: `/review-room/session/accept?invite=${encodeURIComponent(invitationSecret)}`,
    identityInviteExpiresAt: invitation.expires_at,
  });
});

reviewRoomRoutes.delete('/review-room/api/documents/:proofSlug/members/:identityId', async (req: Request, res: Response) => {
  const proofSlug = String(req.params.proofSlug || '').trim();
  const identityId = normalizeReviewRoomIdentityId(req.params.identityId);
  if (!proofSlug || !identityId) {
    res.status(400).json({ success: false, code: 'MEMBER_TARGET_REQUIRED', error: 'Document slug and collaborator identity are required.' });
    return;
  }
  const access = await getReviewRoomDocumentAccess(req, proofSlug);
  if (!access) {
    sendDocumentMissing(res);
    return;
  }
  if (!access.capabilities.canManageMembers) {
    sendReviewRoomForbidden(res, 'REVIEW_ROOM_MEMBER_FORBIDDEN', 'Only the document owner can revoke collaborator access.');
    return;
  }
  const member = await storeGetReviewRoomDocumentMemberForProofSlug(proofSlug, identityId);
  if (!member) {
    res.status(404).json({ success: false, code: 'REVIEW_ROOM_MEMBER_MISSING', error: 'That collaborator no longer has access.' });
    return;
  }
  if (member.role === 'owner' || member.identity_id === access.identityId) {
    res.status(409).json({ success: false, code: 'REVIEW_ROOM_OWNER_REQUIRED', error: 'Owner access cannot be revoked from this control.' });
    return;
  }
  await storeRemoveReviewRoomDocumentMember({ proofSlug, identityId });
  await storeCreateReviewRoomHistoryEvent({
    workspaceId: access.document.workspace_id,
    documentId: access.document.id,
    actorId: access.identityId,
    actorType: 'human',
    eventType: 'member.revoked',
    targetType: 'document_member',
    targetId: identityId,
    before: { role: member.role },
    after: { status: 'revoked' },
    metadata: { proofSlug },
  });
  res.json({ success: true, identityId, status: 'revoked' });
});

reviewRoomRoutes.post('/review-room/api/documents', async (req: Request, res: Response) => {
  const identityId = await getCurrentReviewRoomIdentityId(req);
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled document';
  const markdown = typeof body.markdown === 'string' ? body.markdown : '';
  const source: ReviewRoomDocumentRow['source'] = body.source === 'imported' ? 'imported' : 'created';
  const createdEventType = source === 'imported' ? 'document.imported' : 'document.created';
  const engineEventType = source === 'imported' ? 'review_room.document.imported' : 'review_room.document.created';

  const slug = generateSlug();
  const ownerSecret = randomUUID();
  const ownerId = reviewRoomActorForIdentity(identityId);
  if (isHostedReviewRoomDbEnabled()) {
    const hosted = await createHostedReviewRoomDocument({
      slug,
      title,
      markdown,
      ownerId,
      ownerSecret,
      workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
      identityId,
      source,
    });
    const reviewRoomAccessToken = hosted.member?.proof_access_token ?? hosted.editorAccess.secret;
    const openPath = appendTokenToPath(
      buildReviewRoomOpenPath(hosted.proofDoc.slug),
      reviewRoomAccessToken,
    );
    res.status(201).json({
      success: true,
      document: serializeDocument(hosted.reviewRoomDocument, hosted.member),
      openPath,
      proof: {
        slug: hosted.proofDoc.slug,
        docId: hosted.proofDoc.doc_id,
        accessToken: reviewRoomAccessToken,
        ownerSecret,
        statePath: `/documents/${encodeURIComponent(hosted.proofDoc.slug)}/state`,
      },
    });
    return;
  }
  const proofDoc = createDocument(slug, markdown, {}, title, ownerId, ownerSecret);
  const access = createDocumentAccessToken(slug, 'editor');
  refreshSnapshotForSlug(slug);
  addEvent(slug, engineEventType, {
    title,
    ownerId,
    reviewRoom: true,
    source,
  }, ownerId);

  const reviewRoomDocument = await storeCreateReviewRoomDocumentRecord({
    workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
    title,
    proofSlug: proofDoc.slug,
    proofDocId: proofDoc.doc_id,
    source,
    ownerIdentityId: identityId,
    createdByIdentityId: identityId,
  });
  await storeCreateReviewRoomHistoryEvent({
    workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
    documentId: reviewRoomDocument.id,
    actorId: identityId,
    actorType: 'human',
    eventType: createdEventType,
    targetType: 'document',
    targetId: reviewRoomDocument.id,
    after: { title, proofSlug: proofDoc.slug, proofDocId: proofDoc.doc_id },
    metadata: { source },
  });
  const member = await storeGetReviewRoomDocumentMemberForProofSlug(proofDoc.slug, identityId);
  const reviewRoomAccessToken = member?.proof_access_token ?? access.secret;
  const openPath = appendTokenToPath(buildReviewRoomOpenPath(proofDoc.slug), reviewRoomAccessToken);

  res.status(201).json({
    success: true,
    document: serializeDocument(reviewRoomDocument, member),
    openPath,
    proof: {
      slug: proofDoc.slug,
      docId: proofDoc.doc_id,
      accessToken: reviewRoomAccessToken,
      ownerSecret,
      statePath: `/documents/${encodeURIComponent(proofDoc.slug)}/state`,
    },
  });
});

reviewRoomRoutes.post('/review-room/api/documents/register', async (req: Request, res: Response) => {
  const identityId = await getCurrentReviewRoomIdentityId(req);
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const rawProofSlug = typeof body.proofSlug === 'string' ? body.proofSlug : '';
  const parsed = parseProofSlugInput(rawProofSlug);
  const proofSlug = parsed.slug;
  const token = typeof body.token === 'string' && body.token.trim()
    ? body.token.trim()
    : parsed.token;
  if (parsed.error) {
    res.status(400).json({ success: false, ...parsed.error });
    return;
  }
  if (token && /\s/.test(token)) {
    res.status(400).json({
      success: false,
      code: 'INVALID_ACCESS_TOKEN',
      error: 'Access token must be a single token value.',
    });
    return;
  }
  const existing = await storeGetReviewRoomDocumentByProofSlug(proofSlug);
  if (existing) {
    const existingMember = await storeGetReviewRoomDocumentMemberForProofSlug(proofSlug, identityId);
    const tokenMember = existingMember ? null : await storeGetReviewRoomDocumentMemberForProofSlugAndToken(proofSlug, token);
    const accessRole = !existingMember && !tokenMember && token
      ? await engineResolveReviewRoomRole(proofSlug, token)
      : null;
    const authorizedRole = tokenMember?.role ?? accessRole;
    if (!existingMember && !authorizedRole) {
      res.status(403).json({
        success: false,
        code: 'PERMISSION_DENIED',
        error: token
          ? 'The provided token does not grant access to that document.'
          : 'This document is already in Review Room. Paste a Review Room link with its token, or open it from an account that already has access.',
      });
      return;
    }
    if (!existingMember) {
      await storeUpsertReviewRoomIdentity({
        id: identityId,
        workspaceId: existing.workspace_id,
        kind: 'human',
        displayName: identityId,
      });
    }
    const member = existingMember
      ?? await storeUpsertReviewRoomDocumentMember({
        reviewRoomDocumentId: existing.id,
        identityId,
        role: authorizedRole ?? 'viewer',
        proofSlug,
        proofAccessToken: token,
      });
    res.json({
      success: true,
      alreadyRegistered: true,
      document: serializeDocument(existing, member),
      openPath: appendTokenToPath(buildReviewRoomOpenPath(proofSlug), member.proof_access_token ?? token),
      message: 'This document is already in Review Room. Opening your existing access.',
    });
    return;
  }
  const proofDoc = await engineGetDocumentBySlug(proofSlug);
  if (!proofDoc) {
    res.status(404).json({
      success: false,
      code: 'DOCUMENT_MISSING',
      error: 'No document exists for that slug.',
    });
    return;
  }

  if (token && !(await engineResolveDocumentAccess(proofSlug, token))) {
    res.status(403).json({
      success: false,
      code: 'PERMISSION_DENIED',
      error: 'The provided token does not grant access to that document.',
      shareState: proofDoc.share_state,
    });
    return;
  }

  const stateError = reviewRoomRegisterErrorForState(proofDoc.share_state);
  if (stateError) {
    res.status(stateError.status).json({
      success: false,
      code: stateError.code,
      error: stateError.error,
      shareState: proofDoc.share_state,
    });
    return;
  }

  const reviewRoomDocument = await storeCreateReviewRoomDocumentRecord({
    workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
    title: proofDoc.title?.trim() || 'Untitled review',
    proofSlug: proofDoc.slug,
    proofDocId: proofDoc.doc_id,
    source: 'registered',
    ownerIdentityId: identityId,
    createdByIdentityId: identityId,
  });
  const member = await storeGetReviewRoomDocumentMemberForProofSlug(proofDoc.slug, identityId);
  await engineAddDocumentEvent(proofDoc.slug, 'review_room.document.registered', {
    title: reviewRoomDocument.title,
    reviewRoom: true,
  }, `review-room:${identityId}`);
  await storeCreateReviewRoomHistoryEvent({
    workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
    documentId: reviewRoomDocument.id,
    actorId: identityId,
    actorType: 'human',
    eventType: 'document.registered',
    targetType: 'document',
    targetId: reviewRoomDocument.id,
    after: { title: reviewRoomDocument.title, proofSlug: proofDoc.slug, proofDocId: proofDoc.doc_id },
    metadata: { source: 'registered' },
  });

  res.status(201).json({
    success: true,
    document: serializeDocument(reviewRoomDocument, member),
    openPath: appendTokenToPath(buildReviewRoomOpenPath(proofDoc.slug), member?.proof_access_token ?? token),
    message: 'Document added to Review Room. Opening now.',
    proof: {
      slug: proofDoc.slug,
      docId: proofDoc.doc_id,
      shareState: proofDoc.share_state,
      statePath: `/documents/${encodeURIComponent(proofDoc.slug)}/state`,
    },
  });
});
