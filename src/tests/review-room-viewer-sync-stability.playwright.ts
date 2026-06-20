import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';

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

async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-viewer-sync-${Date.now()}-${randomUUID()}.db`);
  const port = await getFreePort();
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);
  process.env.COLLAB_EMBEDDED_WS = '1';

  const { createReviewRoomHttpServer } = await import('../../server/index.js');
  const server = await createReviewRoomHttpServer(port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  let browser: Browser | null = null;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = await readJson<{
      success: boolean;
      proof: { slug: string; accessToken: string };
    }>(await fetch(`${baseUrl}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-review-room-identity-id': 'viewer-sync-owner' },
      body: JSON.stringify({
        title: 'Viewer sync stability',
        markdown: '# Viewer sync stability\n\nRead-only clients must settle without write probes.\n',
      }),
    }), 'create document');
    assert(created.success, 'Expected document creation success');

    const viewer = await readJson<{
      success: boolean;
      member: { openPath: string };
    }>(await fetch(`${baseUrl}/review-room/api/documents/${created.proof.slug}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': created.proof.accessToken },
      body: JSON.stringify({ identityId: 'viewer-sync-reader', displayName: 'Read-only Reviewer', role: 'viewer' }),
    }), 'create viewer member');
    assert(viewer.success, 'Expected viewer member creation success');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const consoleErrors: string[] = [];
    const forbiddenResponses: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('response', (response) => {
      if (response.status() === 403) forbiddenResponses.push(response.url());
    });

    await page.goto(`${baseUrl}${viewer.member.openPath}`);
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    const anonymousPrompt = page.getByRole('button', { name: 'Continue anonymously' });
    if (await anonymousPrompt.isVisible().catch(() => false)) await anonymousPrompt.click();

    const status = page.locator('#review-room-status-slot .status-label');
    await expect(status).toHaveText('Saved', { timeout: 12_000 });
    await page.waitForTimeout(6_000);
    await expect(status).toHaveText('Saved');
    await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');

    assert(forbiddenResponses.length === 0, `Viewer generated forbidden requests:\n${forbiddenResponses.join('\n')}`);
    assert(consoleErrors.length === 0, `Viewer generated console errors:\n${consoleErrors.join('\n')}`);
    console.log('✓ Review Room viewer settles as read-only without write-probe recovery loops');
  } finally {
    if (browser) await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
