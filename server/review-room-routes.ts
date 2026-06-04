import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { buildClaudePluginZip } from './claude-plugin-package.js';
import { generateSlug } from './slug.js';
import {
  addEvent,
  createDocument,
  createDocumentAccessToken,
  createReviewRoomDocumentRecord,
  deriveReviewRoomCapabilities,
  getDocumentBySlug,
  getReviewRoomDocumentMemberForProofSlug,
  getReviewRoomDocumentByProofSlug,
  getReviewRoomIdentity,
  listReviewRoomDocuments,
  listReviewRoomIdentities,
  resolveDocumentAccess,
  reviewRoomRoleToShareRole,
  upsertReviewRoomDocumentMember,
  type ReviewRoomDocumentMemberRow,
  type ReviewRoomDocumentRow,
} from './db.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import {
  addHostedDocumentEvent,
  createHostedReviewRoomDocument,
  createHostedReviewRoomDocumentRecord,
  getHostedDocumentBySlug,
  getHostedReviewRoomDocumentByProofSlug,
  getHostedReviewRoomDocumentMemberForProofSlug,
  getHostedReviewRoomIdentity,
  isHostedReviewRoomDbEnabled,
  listHostedReviewRoomDocuments,
  listHostedReviewRoomIdentities,
  resolveHostedDocumentAccess,
  upsertHostedReviewRoomDocumentMember,
} from './hosted-review-room-db.js';
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

function getCurrentReviewRoomIdentityId(req: Request): string {
  const fromHeader = req.header('x-review-room-identity-id');
  if (fromHeader && fromHeader.trim()) return normalizeReviewRoomIdentityId(fromHeader);
  const fromQuery = typeof req.query.identityId === 'string' ? req.query.identityId.trim() : '';
  return normalizeReviewRoomIdentityId(fromQuery);
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
  };
}

function renderReviewRoomHome(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Review Room</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: #1f2933;
      background: #f7f8f3;
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
      border-bottom: 1px solid #dfe5d7;
      background: rgba(247, 248, 243, 0.94);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    .brand { font-weight: 700; letter-spacing: 0; }
    .nav { display: flex; align-items: center; gap: 8px; color: #607064; font-size: 14px; }
    .nav a { color: inherit; text-decoration: none; padding: 8px 10px; border-radius: 6px; }
    .nav a[aria-current="page"] { color: #1f2933; background: #e8eee2; }
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
    p { margin: 0; color: #607064; line-height: 1.5; }
    .panel { background: #ffffff; border: 1px solid #dfe5d7; border-radius: 8px; }
    .panel-header { padding: 18px 18px 0; }
    .doc-list { display: grid; gap: 0; margin-top: 14px; }
    .doc-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      padding: 16px 18px;
      border-top: 1px solid #edf1e9;
    }
    .doc-title { font-weight: 650; margin-bottom: 5px; overflow-wrap: anywhere; }
    .doc-meta { font-size: 13px; color: #718073; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .doc-source { padding: 2px 7px; border-radius: 999px; background: #eef4e9; color: #4c5f4f; font-size: 12px; font-weight: 650; }
    .primary-action {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 18px;
      border-top: 1px solid #edf1e9;
    }
    .button {
      border: 1px solid #266854;
      background: #266854;
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
    .button.secondary { background: #fff; color: #266854; }
    .form-note { font-size: 13px; color: #607064; }
    form { display: grid; gap: 12px; padding: 18px; }
    form + form { border-top: 1px solid #edf1e9; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 650; color: #374539; }
    input, textarea {
      width: 100%;
      border: 1px solid #cbd7c6;
      border-radius: 6px;
      padding: 10px 11px;
      background: #fff;
      color: #1f2933;
    }
    textarea { min-height: 190px; resize: vertical; line-height: 1.45; }
    .identity { padding: 14px 18px 18px; display: grid; gap: 10px; }
    .identity-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 14px; }
    .pill { padding: 4px 8px; border-radius: 999px; background: #eef4e9; color: #4c5f4f; font-size: 12px; }
    .empty { padding: 24px 18px; color: #607064; border-top: 1px solid #edf1e9; }
    .error { color: #b42318; font-size: 13px; min-height: 18px; }
    .section-title { font-size: 16px; font-weight: 700; margin: 0; }
    .download-list { display: grid; gap: 10px; padding: 18px; border-top: 1px solid #edf1e9; }
    .download-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }
    .download-copy { display: grid; gap: 3px; min-width: 0; }
    .download-title { font-weight: 700; }
    .download-note { color: #607064; font-size: 13px; line-height: 1.45; }
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
      border: 1px solid #cbd7c6;
      border-radius: 6px;
      padding: 7px 10px;
      color: #266854;
      font-size: 13px;
      font-weight: 650;
      background: #fff;
      flex-shrink: 0;
    }
    details[open] summary.panel-header::after { content: "Close"; }
    @media (max-width: 840px) {
      main { grid-template-columns: 1fr; padding: 20px 16px 40px; }
      .topbar { padding: 0 16px; }
      .doc-row { grid-template-columns: 1fr; }
      .download-row { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">Review Room</div>
      <nav class="nav" aria-label="Review Room navigation">
        <a href="/review-room" aria-current="page">Documents</a>
        <a href="/agent-docs">Agent API</a>
      </nav>
    </header>
    <main>
      <aside class="panel" aria-labelledby="create-heading">
        <div class="panel-header">
          <h1 id="create-heading">Create new document</h1>
          <p>Start with an empty editor, write the document, then save it back to this workspace.</p>
        </div>
        <div class="primary-action">
          <button id="new-document-button" class="button" type="button">Create new document</button>
          <div id="form-error" class="error" role="alert"></div>
        </div>
        <form id="register-form">
          <h2 class="section-title">Add existing document</h2>
          <p class="form-note">Accepts Review Room document slugs or /d/... links. Direct Google Docs and SharePoint imports are not supported yet; paste a Review Room share URL or create a fresh document here.</p>
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
        <div class="identity" id="identity"></div>
      </aside>
      <details class="panel" aria-labelledby="docs-heading">
        <summary class="panel-header">
          <div>
            <h1 id="docs-heading">Open a document</h1>
            <p>Browse documents already in this Review Room workspace.</p>
          </div>
        </summary>
        <div id="documents" class="doc-list" aria-live="polite">
          <div class="empty">Loading documents...</div>
        </div>
      </details>
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
    const identityEl = document.getElementById('identity');
    const newDocumentButton = document.getElementById('new-document-button');
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
      const people = payload.identities || [];
      identityEl.innerHTML = '<div class="identity-item"><strong>Workspace</strong><span class="pill">' + escapeHtml(payload.workspace.name) + '</span></div>'
        + people.map((identity) => '<div class="identity-item"><span>' + escapeHtml(identity.display_name) + '</span><span class="pill">' + escapeHtml(identity.kind) + '</span></div>').join('');
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
  if (isHostedReviewRoomDbEnabled()) {
    res.json({
      success: true,
      workspace: {
        id: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
        name: REVIEW_ROOM_LOCAL_WORKSPACE_NAME,
      },
      currentIdentity: await getHostedReviewRoomIdentity(identityId),
      identities: await listHostedReviewRoomIdentities(REVIEW_ROOM_DEFAULT_WORKSPACE_ID),
    });
    return;
  }
  res.json({
    success: true,
    workspace: {
      id: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
      name: REVIEW_ROOM_LOCAL_WORKSPACE_NAME,
    },
    currentIdentity: getReviewRoomIdentity(identityId),
    identities: listReviewRoomIdentities(REVIEW_ROOM_DEFAULT_WORKSPACE_ID),
  });
});

reviewRoomRoutes.get('/review-room/api/documents', async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
  const identityId = getCurrentReviewRoomIdentityId(req);
  if (isHostedReviewRoomDbEnabled()) {
    const rows = await listHostedReviewRoomDocuments(REVIEW_ROOM_DEFAULT_WORKSPACE_ID, Number.isFinite(limit) ? limit : 50);
    const documents = await Promise.all(
      rows.map(async (row) => serializeDocument(row, await getHostedReviewRoomDocumentMemberForProofSlug(row.proof_slug, identityId))),
    );
    res.json({
      success: true,
      currentIdentity: await getHostedReviewRoomIdentity(identityId),
      documents,
    });
    return;
  }
  res.json({
    success: true,
    currentIdentity: getReviewRoomIdentity(identityId),
    documents: listReviewRoomDocuments(REVIEW_ROOM_DEFAULT_WORKSPACE_ID, Number.isFinite(limit) ? limit : 50)
      .map((row) => serializeDocument(row, getReviewRoomDocumentMemberForProofSlug(row.proof_slug, identityId))),
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

  const reviewRoomDocument = createReviewRoomDocumentRecord({
    workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
    title,
    proofSlug: proofDoc.slug,
    proofDocId: proofDoc.doc_id,
    ownerIdentityId: identityId,
    createdByIdentityId: identityId,
  });
  const member = getReviewRoomDocumentMemberForProofSlug(proofDoc.slug, identityId);
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
  if (isHostedReviewRoomDbEnabled()) {
    const existing = await getHostedReviewRoomDocumentByProofSlug(proofSlug);
    if (existing) {
      const member = await getHostedReviewRoomDocumentMemberForProofSlug(proofSlug, identityId)
        ?? await upsertHostedReviewRoomDocumentMember({
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
    const proofDoc = await getHostedDocumentBySlug(proofSlug);
    if (!proofDoc) {
      res.status(404).json({
        success: false,
        code: 'DOCUMENT_MISSING',
        error: 'No document exists for that slug.',
      });
      return;
    }
    if (token && !(await resolveHostedDocumentAccess(proofSlug, token))) {
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
    const reviewRoomDocument = await createHostedReviewRoomDocumentRecord({
      workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
      title: proofDoc.title?.trim() || 'Untitled review',
      proofSlug: proofDoc.slug,
      proofDocId: proofDoc.doc_id,
      source: 'registered',
      ownerIdentityId: identityId,
      createdByIdentityId: identityId,
    });
    const member = await getHostedReviewRoomDocumentMemberForProofSlug(proofDoc.slug, identityId);
    await addHostedDocumentEvent(proofDoc.slug, 'review_room.document.registered', {
      title: reviewRoomDocument.title,
      reviewRoom: true,
    }, `review-room:${identityId}`);
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
    return;
  }
  const existing = getReviewRoomDocumentByProofSlug(proofSlug);
  if (existing) {
    const member = getReviewRoomDocumentMemberForProofSlug(proofSlug, identityId)
      ?? upsertReviewRoomDocumentMember({
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
  const proofDoc = getDocumentBySlug(proofSlug);
  if (!proofDoc) {
    res.status(404).json({
      success: false,
      code: 'DOCUMENT_MISSING',
      error: 'No document exists for that slug.',
    });
    return;
  }

  if (token && !resolveDocumentAccess(proofSlug, token)) {
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

  const reviewRoomDocument = createReviewRoomDocumentRecord({
    workspaceId: REVIEW_ROOM_DEFAULT_WORKSPACE_ID,
    title: proofDoc.title?.trim() || 'Untitled review',
    proofSlug: proofDoc.slug,
    proofDocId: proofDoc.doc_id,
    source: 'registered',
    ownerIdentityId: identityId,
    createdByIdentityId: identityId,
  });
  const member = getReviewRoomDocumentMemberForProofSlug(proofDoc.slug, identityId);
  addEvent(proofDoc.slug, 'review_room.document.registered', {
    title: reviewRoomDocument.title,
    reviewRoom: true,
  }, `review-room:${identityId}`);

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
