import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';

function assert(condition: boolean, message: string): void {
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
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForNoHorizontalOverflow(page: Page): Promise<void> {
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!hasOverflow, 'Expected page not to have visible horizontal overflow');
}

async function dismissAnonymousPrompt(page: Page): Promise<void> {
  const anonymousPrompt = page.getByRole('button', { name: 'Continue anonymously' });
  if (await anonymousPrompt.isVisible().catch(() => false)) {
    await anonymousPrompt.click();
    await expect(anonymousPrompt).toBeHidden();
  }
}

async function dispatchFileDrop(page: Page, selector: string, file: { name: string; mimeType: string; body: string }): Promise<void> {
  const dataTransfer = await page.evaluateHandle((payload) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([payload.body], payload.name, { type: payload.mimeType }));
    return transfer;
  }, file);
  await page.dispatchEvent(selector, 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-create-flow-${Date.now()}-${randomUUID()}.db`);
  const port = await getFreePort();
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);
  process.env.COLLAB_EMBEDDED_WS = '1';

  const { createReviewRoomHttpServer } = await import('../../server/index.js');
  const server = await createReviewRoomHttpServer(port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  let browser: Browser | null = null;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const title = `Playwright flow ${Date.now()}`;

  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const baseUrl = `http://127.0.0.1:${port}`;
    await page.goto(`${baseUrl}/review-room`);
    await expect(page.getByRole('heading', { name: 'Create or import' })).toBeVisible();
    await expect(page.getByText('Import Markdown or Text')).toBeVisible();
    await expect(page.getByText('Open existing Review Room link')).toBeVisible();
    await expect(page.getByText('Open a document')).toBeVisible();
    await expect(page.locator('section[aria-labelledby="docs-heading"]')).toBeVisible();
    await expect(page.locator('details.secondary-details')).not.toHaveAttribute('open', '');
    await waitForNoHorizontalOverflow(page);

    await dispatchFileDrop(page, '#import-drop-zone', {
      name: 'unsupported.pdf',
      mimeType: 'application/pdf',
      body: '%PDF-unsupported',
    });
    await expect(page.locator('#form-error')).toHaveText('Review Room can import .md, .markdown, and .txt files right now.');

    await dispatchFileDrop(page, '#import-drop-zone', {
      name: 'Dropped sample.md',
      mimeType: 'text/markdown',
      body: '# Dropped sample\n\nImported from drag and drop.',
    });
    await expect(page.locator('#import-file-name')).toHaveText('Dropped sample.md');
    await expect(page.locator('#form-error')).toBeEmpty();
    const dropImportResponsePromise = page.waitForResponse((response) => (
      response.url() === `${baseUrl}/review-room/api/documents`
      && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: 'Import and open' }).click();
    const dropImportResponse = await dropImportResponsePromise;
    const dropImportHeaders = dropImportResponse.request().headers();
    assert(
      typeof dropImportHeaders['x-review-room-identity-id'] === 'string' && dropImportHeaders['x-review-room-identity-id'].startsWith('browser-'),
      'Expected dropped-file import to include a browser Review Room identity',
    );
    await page.waitForURL(/\/d\/[^?]+\?rr=1&token=/);
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    await dismissAnonymousPrompt(page);
    await expect(page.locator('.ProseMirror')).toContainText('Imported from drag and drop.');
    await page.getByRole('button', { name: 'Save and return to documents' }).click();
    await page.waitForURL(`${baseUrl}/review-room`);
    await expect(page.getByText('Dropped sample')).toBeVisible();

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5_000 }),
      page.locator('#choose-file-button').click(),
    ]);
    await fileChooser.setFiles({
      name: 'Picked sample.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Picked sample\n\nImported from the picker.'),
    });
    await expect(page.locator('#import-file-name')).toHaveText('Picked sample.md');
    const pickerImportResponsePromise = page.waitForResponse((response) => (
      response.url() === `${baseUrl}/review-room/api/documents`
      && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: 'Import and open' }).click();
    await pickerImportResponsePromise;
    await page.waitForURL(/\/d\/[^?]+\?rr=1&token=/);
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    await dismissAnonymousPrompt(page);
    await expect(page.locator('.ProseMirror')).toContainText('Imported from the picker.');
    await page.getByRole('button', { name: 'Save and return to documents' }).click();
    await page.waitForURL(`${baseUrl}/review-room`);
    await expect(page.getByText('Picked sample')).toBeVisible();
    await waitForNoHorizontalOverflow(page);

    const createResponsePromise = page.waitForResponse((response) => (
      response.url() === `${baseUrl}/review-room/api/documents`
      && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: 'Create new document' }).click();
    const createResponse = await createResponsePromise;
    const createRequestHeaders = createResponse.request().headers();
    const browserIdentityHeader = createRequestHeaders['x-review-room-identity-id'];
    assert(
      typeof browserIdentityHeader === 'string' && browserIdentityHeader.startsWith('browser-'),
      `Expected dashboard create request to include a browser Review Room identity, got ${browserIdentityHeader || '<missing>'}`,
    );
    await page.waitForURL(/\/d\/[^?]+\?rr=1&token=/);
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    const openContextResult = await page.evaluate(async ({ identityId }) => {
      const url = new URL(window.location.href);
      const slug = decodeURIComponent(url.pathname.replace(/^\/d\//, '').replace(/\/$/, ''));
      const documentsResponse = await fetch('/review-room/api/documents', {
        headers: { 'x-review-room-identity-id': identityId },
      });
      const documentsPayload = await documentsResponse.json() as {
        documents?: Array<{ proofSlug?: string; openPath?: string }>;
      };
      const document = (documentsPayload.documents || []).find((entry) => entry.proofSlug === slug);
      const token = document?.openPath
        ? new URL(document.openPath, window.location.origin).searchParams.get('token') || ''
        : '';
      const response = await fetch(`/api/documents/${encodeURIComponent(slug)}/open-context`, {
        headers: {
          'x-share-token': token,
          'X-Proof-Client-Version': '0.31.0',
          'X-Proof-Client-Build': 'tests',
          'X-Proof-Client-Protocol': '3',
        },
      });
      const openContext = await response.json() as { reviewRoom?: { identityId?: string; currentRole?: string } };
      return {
        slug,
        tokenPresent: Boolean(token),
        documents: documentsPayload.documents || [],
        openContext,
      };
    }, {
      identityId: browserIdentityHeader,
    });
    assert(
      openContextResult.openContext.reviewRoom?.identityId === browserIdentityHeader,
      `Expected dashboard-created document to resolve to the browser Review Room identity, got ${openContextResult.openContext.reviewRoom?.identityId || '<missing>'}. Debug: ${JSON.stringify(openContextResult)}`,
    );
    assert(openContextResult.openContext.reviewRoom?.currentRole === 'owner', 'Expected dashboard-created document token to resolve to owner role');
    await dismissAnonymousPrompt(page);

    await expect(page.getByRole('toolbar', { name: 'Document formatting' })).toBeVisible();
    for (const name of ['Paragraph', 'Heading 1', 'Heading 2', 'Bold', 'Italic', 'Block quote', 'Bulleted list', 'Numbered list']) {
      await expect(page.getByRole('button', { name })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Agent options' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share options' })).toBeVisible();

    const titleBox = page.locator('#review-room-title-slot [role="textbox"]');
    await titleBox.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(title);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('This document was created by the automated Review Room flow.');
    await page.getByRole('button', { name: 'Bold' }).click();
    await waitForNoHorizontalOverflow(page);

    await expect(page.locator('#review-room-status-slot .status-label')).toHaveText('Saved', { timeout: 12_000 });
    await page.getByRole('button', { name: 'Save and return to documents' }).click();
    await page.waitForURL(`${baseUrl}/review-room`);
    await expect(page.locator('section[aria-labelledby="docs-heading"]')).toBeVisible();
    await expect(page.getByText(title)).toBeVisible();
    await waitForNoHorizontalOverflow(page);

    assert(consoleErrors.length === 0, `Unexpected console errors:\n${consoleErrors.join('\n')}`);
    assert(pageErrors.length === 0, `Unexpected page errors:\n${pageErrors.join('\n')}`);
    console.log('✓ Review Room editor-first create flow passed in Playwright');
  } finally {
    if (browser) await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
