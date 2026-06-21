import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';

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
      server.close(() => resolve(address.port));
    });
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  assert(response.ok, payload.error || `Request failed with ${response.status}`);
  return payload;
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-identity-ui-${Date.now()}-${randomUUID()}.db`);
  const port = await getFreePort();
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);
  process.env.COLLAB_EMBEDDED_WS = '1';

  const { createReviewRoomHttpServer } = await import('../../server/index.js');
  const server = await createReviewRoomHttpServer(port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  let browser: Browser | null = null;
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const ownerHeaders = {
      'Content-Type': 'application/json',
      'x-review-room-identity-id': 'identity-ui-owner',
    };
    const created = await readJson<{
      document: { proofSlug: string };
    }>(await fetch(`${baseUrl}/review-room/api/documents`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ title: 'Identity continuity', markdown: '# Identity continuity\n' }),
    }));
    const invite = await readJson<{
      identityInvitePath: string;
    }>(await fetch(`${baseUrl}/review-room/api/documents/${created.document.proofSlug}/members`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        identityId: 'identity-ui-collaborator',
        displayName: 'Casey Collaborator',
        role: 'commenter',
      }),
    }));

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(`${baseUrl}${invite.identityInvitePath}`);
    await page.waitForURL(/\/d\/[^?]+\?rr=1&token=/);
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });

    await page.getByRole('button', { name: 'Open profile' }).click();
    await expect(page.getByRole('dialog', { name: 'Review Room profile' })).toBeVisible();
    await expect(page.getByText('Linked on this browser')).toBeVisible();
    await expect(page.getByText('shared document links can still grant document access')).toBeVisible();
    const displayName = page.getByLabel('Display name');
    await displayName.fill('Casey Renamed');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved.');
    await expect(page.getByRole('button', { name: 'Open profile' })).toHaveAttribute('title', 'Profile: Casey Renamed');
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      'Expected the Review Room document header not to overflow at 390px',
    );

    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('link', { name: 'Documents' }).click();
    await page.waitForURL(`${baseUrl}/review-room`);
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      'Expected the Review Room dashboard not to overflow at 390px',
    );
    await expect(page.locator('#profile-button-label')).toHaveText('Casey Renamed');
    await page.locator('#profile-button').click();
    await expect(page.locator('#profile-session')).toHaveText('Linked on this browser');
    await page.locator('#profile-signout').click();
    await page.waitForURL(`${baseUrl}/review-room`);
    await page.locator('#profile-button').click();
    await expect(page.locator('#profile-session')).toHaveText('Local browser identity');
    await expect(page.locator('#profile-signout')).toBeHidden();

    console.log('✓ Review Room identity continuity UI passed in Playwright');
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
