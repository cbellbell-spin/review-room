import { randomUUID } from 'crypto';
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
  type DocumentRow,
  type ReviewRoomAssignmentTaskRow,
  type ReviewRoomDocumentMemberRow,
  type ReviewRoomDocumentRow,
  type ReviewRoomPublishedVersionRow,
  type ReviewRoomRole,
} from './db.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import {
  addHostedDocumentEvent,
  createHostedReviewRoomDocument,
  getHostedDocumentBySlug,
  isHostedReviewRoomDbEnabled,
  resolveHostedDocumentAccess,
} from './hosted-review-room-db.js';
import {
  storeCreatePublishedVersion,
  storeCreateReviewRoomDocumentRecord,
  storeCreateReviewRoomHistoryEvent,
  storeGetAssignmentTask,
  storeGetLatestPublishedVersion,
  storeGetReviewRoomDocumentByProofSlug,
  storeGetReviewRoomDocumentMemberForProofSlug,
  storeGetReviewRoomDocumentMemberForProofSlugAndToken,
  storeGetReviewRoomIdentity,
  storeListReviewRoomDocumentMembersForProofSlug,
  storeListAssignmentTasks,
  storeListPublishedVersions,
  storeListReviewRoomAgents,
  storeListReviewRoomDocuments,
  storeListReviewRoomHistoryEvents,
  storeListReviewRoomIdentities,
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

function getExplicitReviewRoomIdentityId(req: Request): string | null {
  const fromHeader = req.header('x-review-room-identity-id');
  if (fromHeader && fromHeader.trim()) return normalizeReviewRoomIdentityId(fromHeader);
  const fromQuery = typeof req.query.identityId === 'string' ? req.query.identityId.trim() : '';
  return fromQuery ? normalizeReviewRoomIdentityId(fromQuery) : null;
}

function getCurrentReviewRoomIdentityId(req: Request): string {
  return getExplicitReviewRoomIdentityId(req) ?? normalizeReviewRoomIdentityId(null);
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

function parseProofSlugInput(value: string): { slug: string; token: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { slug: '', token: null };
  try {
    const parsed = new URL(trimmed, 'http://review-room.local');
    const match = parsed.pathname.match(/^\/d\/([^/?#]+)\/?$/);
    if (match?.[1]) {
      return {
        slug: decodeURIComponent(match[1]).trim(),
        token: parsed.searchParams.get('token'),
      };
    }
  } catch {
    // Treat unparsable input as a raw slug below.
  }
  return { slug: trimmed.replace(/^\/d\//, '').split(/[?#]/)[0]?.trim() ?? '', token: null };
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
    error: `This document is not available for registration (${shareState}).`,
  };
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
    sourceLabel: row.source === 'registered' ? 'Registered document' : 'Created in Review Room',
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
    openPath: appendTokenToPath(buildReviewRoomOpenPath(member.proof_slug), includeAccessToken ? member.proof_access_token ?? null : null),
  };
  if (includeAccessToken) payload.accessToken = member.proof_access_token ?? null;
  return payload;
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
  const explicitIdentityId = getExplicitReviewRoomIdentityId(req);
  const token = getPresentedShareToken(req);
  const tokenMember = explicitIdentityId
    ? null
    : await storeGetReviewRoomDocumentMemberForProofSlugAndToken(proofSlug, token);
  const identityId = explicitIdentityId ?? tokenMember?.identity_id ?? getCurrentReviewRoomIdentityId(req);
  const member = tokenMember ?? await storeGetReviewRoomDocumentMemberForProofSlug(proofSlug, identityId);
  return {
    identityId: member?.identity_id ?? identityId,
    document,
    member,
    capabilities: member
      ? deriveReviewRoomCapabilities(member.role, document.share_state)
      : { canRead: false, canComment: false, canEdit: false, canShare: false, canManageAgents: false },
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
    .form-note { font-size: 13px; color: var(--rr-muted); }
    form { display: grid; gap: 12px; padding: 18px; }
    form + form { border-top: 1px solid var(--rr-border-soft); }
    .import-form { padding: 0; }
    .import-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .file-input {
      border: 1px dashed #b8c8b3;
      background: var(--rr-surface-soft);
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
            <label>
              Import Markdown or Text
              <input id="import-file" class="file-input" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain">
            </label>
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
    const newDocumentButton = document.getElementById('new-document-button');
    const importForm = document.getElementById('import-form');
    const importFileInput = document.getElementById('import-file');
    const importDocumentButton = document.getElementById('import-document-button');
    const registerForm = document.getElementById('register-form');
    const errorEl = document.getElementById('form-error');
    const registerErrorEl = document.getElementById('register-error');

    function formatDate(value) {
      try { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
      catch { return value || ''; }
    }

    function renderDocuments(docs) {
      if (!docs.length) {
        documentsEl.innerHTML = '<div class="empty">No Review Room documents yet.</div>';
        return;
      }
      documentsEl.innerHTML = docs.map((doc) => {
        const title = escapeHtml(doc.title || 'Untitled review');
        const source = escapeHtml(doc.sourceLabel || (doc.source === 'registered' ? 'Registered document' : 'Created in Review Room'));
        const meta = escapeHtml('Slug ' + doc.proofSlug + ' · Updated ' + formatDate(doc.proofUpdatedAt || doc.updatedAt));
        return '<article class="doc-row">'
          + '<div><div class="doc-title">' + title + '</div><div class="doc-meta"><span class="doc-source">' + source + '</span><span>' + meta + '</span></div></div>'
          + '<a class="button secondary" href="' + encodeURI(doc.openPath) + '">Open</a>'
          + '</article>';
      }).join('');
    }

    function renderIdentity(payload) {
      workspaceChip.textContent = payload.workspace && payload.workspace.name ? payload.workspace.name : 'Review Room';
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
        fetch('/review-room/api/documents'),
        fetch('/review-room/api/identity'),
      ]);
      const docsPayload = await docsResponse.json();
      const identityPayload = await identityResponse.json();
      renderDocuments(docsPayload.documents || []);
      renderIdentity(identityPayload);
    }

    newDocumentButton.addEventListener('click', async () => {
      errorEl.textContent = '';
      newDocumentButton.disabled = true;
      newDocumentButton.textContent = 'Creating...';
      const response = await fetch('/review-room/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

    importForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.textContent = '';
      const file = importFileInput.files && importFileInput.files[0];
      if (!file) {
        errorEl.textContent = 'Choose a Markdown or Text file to import.';
        return;
      }
      const lowerName = file.name.toLowerCase();
      const supported = lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || lowerName.endsWith('.txt')
        || file.type === 'text/markdown' || file.type === 'text/plain';
      if (!supported) {
        errorEl.textContent = 'Review Room can import .md, .markdown, and .txt files right now.';
        return;
      }
      importDocumentButton.disabled = true;
      importDocumentButton.textContent = 'Importing...';
      try {
        const markdown = await file.text();
        const title = file.name.replace(/\\.(markdown|md|txt)$/i, '').trim() || 'Imported document';
        const response = await fetch('/review-room/api/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, markdown }),
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
    });

    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      registerErrorEl.textContent = '';
      const proofSlug = document.getElementById('proof-slug').value.trim();
      const token = document.getElementById('proof-token').value.trim();
      const response = await fetch('/review-room/api/documents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proofSlug, token }),
      });
      const payload = await response.json();
      if (!response.ok) {
        registerErrorEl.textContent = payload.error || 'Could not register document.';
        return;
      }
      window.location.href = payload.openPath || payload.document.openPath;
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
  const identityId = getCurrentReviewRoomIdentityId(req);
  res.json({
    success: true,
    workspace: {
      id: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
      name: REVIEW_ROOM_LOCAL_WORKSPACE_NAME,
    },
    currentIdentity: await storeGetReviewRoomIdentity(identityId),
    identities: await storeListReviewRoomIdentities(REVIEW_ROOM_DEFAULT_WORKSPACE_ID),
  });
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
  const identityId = getCurrentReviewRoomIdentityId(req);
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
  const identityId = getCurrentReviewRoomIdentityId(req);
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
  const identityId = getCurrentReviewRoomIdentityId(req);
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
  if (!access.capabilities.canEdit) {
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
  const identityId = getCurrentReviewRoomIdentityId(req);
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
  if (!access.capabilities.canComment) {
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
  res.json({
    success: true,
    document: serializeDocument(access.document, access.member),
    currentMember: access.member ? serializeDocumentMember(access.member, identities.get(access.member.identity_id) ?? null) : null,
    members: members.map((member) => serializeDocumentMember(member, identities.get(member.identity_id) ?? null)),
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
  if (access.member?.role !== 'owner') {
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
    member: serializeDocumentMember(member, identity, true),
  });
});

reviewRoomRoutes.post('/review-room/api/documents', async (req: Request, res: Response) => {
  const identityId = getCurrentReviewRoomIdentityId(req);
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled document';
  const markdown = typeof body.markdown === 'string' ? body.markdown : '';

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
    });
    const openPath = appendTokenToPath(
      buildReviewRoomOpenPath(hosted.proofDoc.slug),
      hosted.member?.proof_access_token ?? hosted.editorAccess.secret,
    );
    res.status(201).json({
      success: true,
      document: serializeDocument(hosted.reviewRoomDocument, hosted.member),
      openPath,
      proof: {
        slug: hosted.proofDoc.slug,
        docId: hosted.proofDoc.doc_id,
        accessToken: hosted.editorAccess.secret,
        ownerSecret,
        statePath: `/documents/${encodeURIComponent(hosted.proofDoc.slug)}/state`,
      },
    });
    return;
  }
  const proofDoc = createDocument(slug, markdown, {}, title, ownerId, ownerSecret);
  const access = createDocumentAccessToken(slug, 'editor');
  refreshSnapshotForSlug(slug);
  addEvent(slug, 'review_room.document.created', {
    title,
    ownerId,
    reviewRoom: true,
  }, ownerId);

  const reviewRoomDocument = await storeCreateReviewRoomDocumentRecord({
    workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
    title,
    proofSlug: proofDoc.slug,
    proofDocId: proofDoc.doc_id,
    ownerIdentityId: identityId,
    createdByIdentityId: identityId,
  });
  await storeCreateReviewRoomHistoryEvent({
    workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
    documentId: reviewRoomDocument.id,
    actorId: identityId,
    actorType: 'human',
    eventType: 'document.created',
    targetType: 'document',
    targetId: reviewRoomDocument.id,
    after: { title, proofSlug: proofDoc.slug, proofDocId: proofDoc.doc_id },
    metadata: { source: 'created' },
  });
  const member = await storeGetReviewRoomDocumentMemberForProofSlug(proofDoc.slug, identityId);
  const openPath = appendTokenToPath(buildReviewRoomOpenPath(proofDoc.slug), member?.proof_access_token ?? access.secret);

  res.status(201).json({
    success: true,
    document: serializeDocument(reviewRoomDocument, member),
    openPath,
    proof: {
      slug: proofDoc.slug,
      docId: proofDoc.doc_id,
      accessToken: access.secret,
      ownerSecret,
      statePath: `/documents/${encodeURIComponent(proofDoc.slug)}/state`,
    },
  });
});

reviewRoomRoutes.post('/review-room/api/documents/register', async (req: Request, res: Response) => {
  const identityId = getCurrentReviewRoomIdentityId(req);
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const rawProofSlug = typeof body.proofSlug === 'string' ? body.proofSlug : '';
  const parsed = parseProofSlugInput(rawProofSlug);
  const proofSlug = parsed.slug;
  const token = typeof body.token === 'string' && body.token.trim()
    ? body.token.trim()
    : parsed.token;
  if (!proofSlug) {
    res.status(400).json({ success: false, code: 'DOCUMENT_SLUG_REQUIRED', error: 'Document slug is required.' });
    return;
  }
  const existing = await storeGetReviewRoomDocumentByProofSlug(proofSlug);
  if (existing) {
    const member = await storeGetReviewRoomDocumentMemberForProofSlug(proofSlug, identityId)
      ?? await storeUpsertReviewRoomDocumentMember({
        reviewRoomDocumentId: existing.id,
        identityId,
        role: 'owner',
        proofSlug,
      });
    res.json({
      success: true,
      alreadyRegistered: true,
      document: serializeDocument(existing, member),
      openPath: appendTokenToPath(buildReviewRoomOpenPath(proofSlug), member.proof_access_token ?? token),
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
    proof: {
      slug: proofDoc.slug,
      docId: proofDoc.doc_id,
      shareState: proofDoc.share_state,
      statePath: `/documents/${encodeURIComponent(proofDoc.slug)}/state`,
    },
  });
});
