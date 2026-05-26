import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { generateSlug } from './slug.js';
import {
  addEvent,
  createDocument,
  createDocumentAccessToken,
  createReviewRoomDocumentRecord,
  getReviewRoomDocumentByProofSlug,
  getReviewRoomIdentity,
  listReviewRoomDocuments,
  listReviewRoomIdentities,
  type ReviewRoomDocumentRow,
} from './db.js';
import { refreshSnapshotForSlug } from './snapshot.js';

export const reviewRoomRoutes = Router();

const DEFAULT_WORKSPACE_ID = 'local';
const DEFAULT_HUMAN_ID = 'local-human';

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

function serializeDocument(row: ReviewRoomDocumentRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    proofSlug: row.proof_slug,
    proofDocId: row.proof_doc_id,
    shareState: row.share_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    proofCreatedAt: row.proof_created_at,
    proofUpdatedAt: row.proof_updated_at,
    openPath: buildReviewRoomOpenPath(row.proof_slug),
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
      width: min(1120px, 100%);
      margin: 0 auto;
      padding: 28px 24px 48px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 28px;
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
    .doc-meta { font-size: 13px; color: #718073; }
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
    form { display: grid; gap: 12px; padding: 18px; }
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
    @media (max-width: 840px) {
      main { grid-template-columns: 1fr; padding: 20px 16px 40px; }
      .topbar { padding: 0 16px; }
      .doc-row { grid-template-columns: 1fr; }
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
      <section class="panel" aria-labelledby="docs-heading">
        <div class="panel-header">
          <h1 id="docs-heading">Documents</h1>
          <p>Drafts backed by Proof documents, with Review Room metadata layered around them.</p>
        </div>
        <div id="documents" class="doc-list" aria-live="polite">
          <div class="empty">Loading documents...</div>
        </div>
      </section>
      <aside class="panel" aria-labelledby="create-heading">
        <div class="panel-header">
          <h1 id="create-heading">New Review</h1>
          <p>Create a Markdown draft and open it in the existing Proof editor.</p>
        </div>
        <form id="create-form">
          <label>
            Title
            <input id="title" name="title" value="Untitled review" autocomplete="off">
          </label>
          <label>
            Markdown
            <textarea id="markdown" name="markdown"># Untitled review

What should reviewers focus on?</textarea>
          </label>
          <button class="button" type="submit">Create and open</button>
          <div id="form-error" class="error" role="alert"></div>
        </form>
        <div class="identity" id="identity"></div>
      </aside>
    </main>
  </div>
  <script>
    const documentsEl = document.getElementById('documents');
    const identityEl = document.getElementById('identity');
    const form = document.getElementById('create-form');
    const errorEl = document.getElementById('form-error');

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
        const meta = escapeHtml('Proof slug ' + doc.proofSlug + ' · Updated ' + formatDate(doc.proofUpdatedAt || doc.updatedAt));
        return '<article class="doc-row">'
          + '<div><div class="doc-title">' + title + '</div><div class="doc-meta">' + meta + '</div></div>'
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

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.textContent = '';
      const title = document.getElementById('title').value.trim() || 'Untitled review';
      const markdown = document.getElementById('markdown').value;
      const response = await fetch('/review-room/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, markdown }),
      });
      const payload = await response.json();
      if (!response.ok) {
        errorEl.textContent = payload.error || 'Could not create document.';
        return;
      }
      window.location.href = payload.openPath;
    });

    load().catch((error) => {
      documentsEl.innerHTML = '<div class="empty">Could not load Review Room documents.</div>';
      errorEl.textContent = error.message || String(error);
    });
  </script>
</body>
</html>`;
}

reviewRoomRoutes.get('/review-room', (_req: Request, res: Response) => {
  res.type('html').send(renderReviewRoomHome());
});

reviewRoomRoutes.get('/review-room/api/identity', (_req: Request, res: Response) => {
  res.json({
    success: true,
    workspace: {
      id: DEFAULT_WORKSPACE_ID,
      name: 'Local Review Room',
    },
    currentIdentity: getReviewRoomIdentity(DEFAULT_HUMAN_ID),
    identities: listReviewRoomIdentities(DEFAULT_WORKSPACE_ID),
  });
});

reviewRoomRoutes.get('/review-room/api/documents', (req: Request, res: Response) => {
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
  res.json({
    success: true,
    documents: listReviewRoomDocuments(DEFAULT_WORKSPACE_ID, Number.isFinite(limit) ? limit : 50).map(serializeDocument),
  });
});

reviewRoomRoutes.post('/review-room/api/documents', (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled review';
  const markdown = typeof body.markdown === 'string' ? body.markdown : '';
  if (!markdown.trim()) {
    res.status(400).json({ success: false, error: 'markdown must not be empty' });
    return;
  }

  const slug = generateSlug();
  const ownerSecret = randomUUID();
  const ownerId = `review-room:${DEFAULT_HUMAN_ID}`;
  const proofDoc = createDocument(slug, markdown, {}, title, ownerId, ownerSecret);
  const access = createDocumentAccessToken(slug, 'editor');
  refreshSnapshotForSlug(slug);
  addEvent(slug, 'review_room.document.created', {
    title,
    ownerId,
    reviewRoom: true,
  }, ownerId);

  const reviewRoomDocument = createReviewRoomDocumentRecord({
    workspaceId: DEFAULT_WORKSPACE_ID,
    title,
    proofSlug: proofDoc.slug,
    proofDocId: proofDoc.doc_id,
    ownerIdentityId: DEFAULT_HUMAN_ID,
    createdByIdentityId: DEFAULT_HUMAN_ID,
  });
  const openPath = `${buildReviewRoomOpenPath(proofDoc.slug)}&token=${encodeURIComponent(access.secret)}`;

  res.status(201).json({
    success: true,
    document: serializeDocument(reviewRoomDocument),
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

reviewRoomRoutes.post('/review-room/api/documents/register', (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const proofSlug = typeof body.proofSlug === 'string' ? body.proofSlug.trim() : '';
  if (!proofSlug) {
    res.status(400).json({ success: false, error: 'proofSlug is required' });
    return;
  }
  const existing = getReviewRoomDocumentByProofSlug(proofSlug);
  if (existing) {
    res.json({ success: true, document: serializeDocument(existing) });
    return;
  }
  res.status(404).json({ success: false, error: 'Registration for existing Proof documents is not wired yet.' });
});
