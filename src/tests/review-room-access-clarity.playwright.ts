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
      server.close(() => resolve(address.port));
    });
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  assert(response.ok, payload.error || `Request failed with ${response.status}`);
  return payload;
}

async function expectAccess(
  page: Page,
  url: string,
  role: 'owner' | 'editor' | 'commenter' | 'viewer',
  label: string,
  editable: boolean,
): Promise<void> {
  await page.goto(url);
  await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
  const access = page.locator(`[data-review-room-access="${role}"]`);
  await expect(access).toContainText(label);
  const capabilityStrip = page.locator('[data-review-room-capability-strip="1"]');
  await expect(capabilityStrip).toBeVisible();
  await expect(capabilityStrip.locator('[data-kind="role"]')).toContainText(label);
  await expect(capabilityStrip.locator('[data-kind="edit"]')).toContainText(
    editable ? 'Editing available' : role === 'commenter' ? 'Comment only' : 'Read only',
  );
  await expect(capabilityStrip.locator('[data-kind="share"]')).toContainText(
    role === 'owner' ? 'Can manage access' : role === 'editor' ? 'Can share document' : 'Owner manages access',
  );
  await expect(capabilityStrip.locator('[data-kind="agent"]')).toContainText(
    role === 'owner' ? 'Agent request ready' : 'Agent request owner-only',
  );
  await expect(capabilityStrip.locator('[data-kind="state"]')).toContainText('Active document');
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', editable ? 'true' : 'false');
  const title = page.locator('.share-pill-title');
  if (editable) {
    await expect(title).toHaveAttribute('role', 'textbox');
  } else {
    await expect(title).not.toHaveAttribute('role', 'textbox');
  }
  await access.click();
  await expect(page.locator('[data-review-room-access-menu="1"]')).toBeVisible();
  if (role === 'owner') {
    await expect(page.getByRole('menuitem', { name: /Manage human access/ })).toBeVisible();
  } else {
    await expect(page.getByRole('menuitem', { name: /View collaborators/ })).toBeVisible();
  }
  await page.keyboard.press('Escape');

  const agentOptions = page.getByRole('button', { name: 'Agent options' });
  await expect(agentOptions).toBeVisible();
  await agentOptions.click();
  if (role === 'owner') {
    await expect(page.getByRole('menuitem', { name: /Request document review/ })).toBeEnabled();
  } else {
    const unavailable = page.getByRole('menuitem', { name: /Only the owner can request a review/ });
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toBeDisabled();
  }
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Open review items' }).click();
  await page.getByRole('tab', { name: 'Publish' }).click();
  const baseline = page.getByRole('button', { name: /Create(?: new)? baseline/ });
  await expect(baseline).toBeVisible();
  if (editable) {
    await expect(baseline).toBeEnabled();
  } else {
    await expect(baseline).toBeDisabled();
    await expect(baseline).toHaveAttribute('title', 'Only editors and owners can create baselines.');
  }
  await page.getByRole('button', { name: 'Open review items' }).click();
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-access-ui-${Date.now()}-${randomUUID()}.db`);
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
      'x-review-room-identity-id': 'access-ui-owner',
    };
    const created = await readJson<{
      document: { proofSlug: string };
      openPath: string;
    }>(await fetch(`${baseUrl}/review-room/api/documents`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ title: 'Access clarity', markdown: '# Access clarity\n' }),
    }));

    const members: Record<'editor' | 'commenter' | 'viewer', { openPath: string; identityInvitePath: string }> = {} as never;
    for (const role of ['editor', 'commenter', 'viewer'] as const) {
      const response = await readJson<{
        member: { openPath: string };
        identityInvitePath: string;
      }>(await fetch(`${baseUrl}/review-room/api/documents/${created.document.proofSlug}/members`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ identityId: `access-ui-${role}`, displayName: `${role} browser`, role }),
      }));
      members[role] = { openPath: response.member.openPath, identityInvitePath: response.identityInvitePath };
    }

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await expectAccess(page, `${baseUrl}${created.openPath}`, 'owner', 'Full access', true);
    await expectAccess(page, `${baseUrl}${members.editor.openPath}`, 'editor', 'Can edit', true);
    await expectAccess(page, `${baseUrl}${members.commenter.openPath}`, 'commenter', 'Comment only', false);
    await expectAccess(page, `${baseUrl}${members.viewer.openPath}`, 'viewer', 'View only', false);

    const oldViewerInvite = members.viewer.identityInvitePath;
    const rotatedViewer = await readJson<{ identityInvitePath: string }>(
      await fetch(`${baseUrl}/review-room/api/documents/${created.document.proofSlug}/members`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ identityId: 'access-ui-viewer', displayName: 'viewer browser', role: 'viewer' }),
      }),
    );
    assert(rotatedViewer.identityInvitePath !== oldViewerInvite, 'Expected rotation to create a new invitation');
    await page.goto(`${baseUrl}${oldViewerInvite}`);
    await expect(page.getByText('This identity invitation has expired or was already used.')).toBeVisible();

    const revokedLink = members.commenter.openPath;
    const revoked = await fetch(`${baseUrl}/review-room/api/documents/${created.document.proofSlug}/members/access-ui-commenter`, {
      method: 'DELETE',
      headers: ownerHeaders,
    });
    assert(revoked.ok, `Expected revoke success, got ${revoked.status}`);
    await page.goto(`${baseUrl}${revokedLink}`);
    await expect(page.locator('[data-review-room-unavailable]')).toContainText(/This document link no longer works|This link is invalid, expired, or revoked/);

    const signedOutPage = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await signedOutPage.goto(`${baseUrl}${members.editor.openPath}`);
    await signedOutPage.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    await signedOutPage.getByRole('button', { name: 'Open profile' }).click();
    await expect(signedOutPage.getByText('Document-link identity on this browser')).toBeVisible();
    await expect(signedOutPage.getByText(/identifies you through its collaborator link/)).toBeVisible();

    console.log('✓ Review Room shared-document access clarity passed in Playwright');
  } finally {
    if (browser) await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore cleanup errors */ }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
