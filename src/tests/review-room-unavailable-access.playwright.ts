import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function createReviewRoomDocument(baseUrl: string, title: string): Promise<{
  slug: string;
  openPath: string;
  accessToken: string;
  ownerSecret: string;
  ownerIdentityId: string;
}> {
  const ownerIdentityId = `owner-${randomUUID()}`;
  const created = await readJson<{
    success: boolean;
    document: { proofSlug: string };
    openPath: string;
    proof: { accessToken: string; ownerSecret: string };
  }>(await fetch(`${baseUrl}/review-room/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-review-room-identity-id': ownerIdentityId },
    body: JSON.stringify({ title, markdown: `# ${title}\n\nPrivate body.` }),
  }));
  assert(created.success === true, 'Expected Review Room create success');
  return {
    slug: created.document.proofSlug,
    openPath: created.openPath,
    accessToken: created.proof.accessToken,
    ownerSecret: created.proof.ownerSecret,
    ownerIdentityId,
  };
}

async function pauseDocument(baseUrl: string, slug: string, ownerSecret: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(slug)}/pause`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerSecret }),
  });
  assert(response.ok, `Expected pause success, got ${response.status}: ${await response.text()}`);
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-unavailable-${Date.now()}-${randomUUID()}.db`);
  const port = await getFreePort();
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);
  process.env.COLLAB_EMBEDDED_WS = '1';
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  const { createReviewRoomHttpServer } = await import('../../server/index.js');
  const server = await createReviewRoomHttpServer(port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  let browser: Browser | null = null;
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    browser = await chromium.launch();

    const ownerDoc = await createReviewRoomDocument(baseUrl, 'Paused owner clarity');
    await pauseDocument(baseUrl, ownerDoc.slug, ownerDoc.ownerSecret);

    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(`${baseUrl}${ownerDoc.openPath}`);
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    await expect(page.locator('[data-review-room-paused-owner="1"]')).toContainText('Document paused');
    await expect(page.locator('[data-review-room-capability-strip="1"] [data-kind="state"]')).toContainText('Sharing paused');
    await expect(page.locator('[data-review-room-capability-strip="1"] [data-kind="edit"]')).toContainText('Editing available');
    await page.getByRole('button', { name: 'Resume sharing' }).click();
    await expect(page.locator('[data-review-room-paused-owner="1"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-review-room-capability-strip="1"] [data-kind="state"]')).toContainText('Active document');

    const resumedContext = await readJson<{ doc: { shareState: string }; capabilities: { canEdit: boolean } }>(
      await fetch(`${baseUrl}/api/documents/${encodeURIComponent(ownerDoc.slug)}/open-context`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': ownerDoc.accessToken },
      }),
    );
    assert(resumedContext.doc.shareState === 'ACTIVE', 'Expected owner resume to reactivate the document');
    assert(resumedContext.capabilities.canEdit === true, 'Expected owner capabilities to remain editable');

    const viewerDoc = await createReviewRoomDocument(baseUrl, 'Paused viewer clarity');
    const viewerIdentity = `viewer-${randomUUID()}`;
    const viewerMember = await readJson<{ member: { openPath: string; accessToken: string } }>(
      await fetch(`${baseUrl}/review-room/api/documents/${encodeURIComponent(viewerDoc.slug)}/members`, {
        method: 'POST',
        headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-review-room-identity-id': viewerDoc.ownerIdentityId },
        body: JSON.stringify({ identityId: viewerIdentity, displayName: 'Viewer', role: 'viewer' }),
      }),
    );
    await pauseDocument(baseUrl, viewerDoc.slug, viewerDoc.ownerSecret);
    const pausedViewer = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(viewerDoc.slug)}/open-context`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': viewerMember.member.accessToken },
    });
    assert(pausedViewer.status === 403, `Expected paused viewer 403, got ${pausedViewer.status}`);
    const pausedViewerPayload = await pausedViewer.json() as Record<string, unknown>;
    assert(pausedViewerPayload.code === 'DOCUMENT_PAUSED', 'Expected paused viewer code');
    assert(pausedViewerPayload.shareState === 'PAUSED', 'Expected paused viewer shareState');
    assert(pausedViewerPayload.title === null, 'Expected paused viewer response not to leak title');

    const pausedViewerHtml = await fetch(`${baseUrl}${viewerMember.member.openPath}`, {
      headers: { Accept: 'text/html' },
    });
    assert(pausedViewerHtml.status === 200 || pausedViewerHtml.status === 404, `Expected paused viewer HTML fallback, got ${pausedViewerHtml.status}`);
    const pausedViewerBody = await pausedViewerHtml.text();
    assert(!pausedViewerBody.includes('Paused viewer clarity'), 'Expected paused viewer HTML not to leak the document title');
    assert(!pausedViewerBody.includes('Private body.'), 'Expected paused viewer HTML not to leak document content');

    const missing = await fetch(`${baseUrl}/api/documents/missing-review-room-doc/open-context`, {
      headers: CLIENT_HEADERS,
    });
    assert(missing.status === 404, `Expected missing open-context 404, got ${missing.status}`);
    const missingPayload = await missing.json() as Record<string, unknown>;
    assert(missingPayload.code === 'DOCUMENT_NOT_FOUND', 'Expected missing code');
    assert(missingPayload.shareState === 'MISSING', 'Expected missing shareState');

    const deletedDoc = await createReviewRoomDocument(baseUrl, 'Deleted clarity');
    const deleted = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(deletedDoc.slug)}`, {
      method: 'DELETE',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerSecret: deletedDoc.ownerSecret }),
    });
    assert(deleted.ok, `Expected delete success, got ${deleted.status}: ${await deleted.text()}`);
    const deletedContext = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(deletedDoc.slug)}/open-context`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': deletedDoc.accessToken },
    });
    assert(deletedContext.status === 410, `Expected deleted open-context 410, got ${deletedContext.status}`);
    const deletedPayload = await deletedContext.json() as Record<string, unknown>;
    assert(deletedPayload.code === 'DOCUMENT_DELETED', 'Expected deleted code');
    assert(deletedPayload.shareState === 'DELETED', 'Expected deleted shareState');

    console.log('✓ Review Room unavailable access clarity passed in Playwright');
  } finally {
    if (browser) await browser.close();
    const collab = await import('../../server/collab.js');
    await collab.stopCollabRuntime();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore cleanup errors */ }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
