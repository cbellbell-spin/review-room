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

async function callTool<T>(base: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const rpc = await response.json() as { result: { content: Array<{ type: string; text: string }> } };
  return JSON.parse(rpc.result.content[0].text) as T;
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-agent-review-ui-${Date.now()}-${randomUUID()}.db`);
  const port = await getFreePort();
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);
  process.env.COLLAB_EMBEDDED_WS = '1';
  const alpha = 'Alpha is uniquely worded for the browser review comment.';
  const beta = 'Beta is uniquely worded for the browser review suggestion.';
  const { createReviewRoomHttpServer } = await import('../../server/index.js');
  const server = await createReviewRoomHttpServer(port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  let browser: Browser | null = null;
  try {
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-review-room-identity-id': 'browser-review-owner' },
      body: JSON.stringify({ title: 'Browser agent review', markdown: `# Browser review\n\n${alpha}\n\n${beta}` }),
    });
    const created = await response.json() as { openPath: string; document: { proofSlug: string }; proof: { accessToken: string }; error?: string };
    assert(response.ok, created.error || 'Could not create browser review fixture');

    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(`${base}${created.openPath}`);
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    const agentButton = page.getByRole('button', { name: 'Agent options' });
    await expect(agentButton).toBeVisible();
    await expect(agentButton).toContainText('Add agent');
    await agentButton.click();
    const runReview = page.getByRole('menuitem', { name: 'Queue external review' });
    await expect(runReview).toBeVisible({ timeout: 10_000 });
    await runReview.click();
    await expect(agentButton).toContainText('Waiting for an agent', { timeout: 10_000 });
    await expect(page.locator('[data-review-room-capability-strip="1"] [data-kind="agent"]')).toContainText('Agent request waiting');

    const listed = await callTool<{ requests: Array<{ id: string; status: string }> }>(base, 'review_room_list_review_requests', {
      slug: created.document.proofSlug,
      token: created.proof.accessToken,
    });
    const request = listed.requests.find((item) => item.status === 'queued');
    assert(Boolean(request), 'Expected browser-created review request to be queued');
    await agentButton.click();
    const copyRequest = page.getByRole('menuitem', { name: 'Copy scoped request prompt' });
    await expect(copyRequest).toBeVisible();
    const credentialResponsePromise = page.waitForResponse((candidate) => (
      candidate.request().method() === 'POST'
      && candidate.url().includes(`/review-runs/${request!.id}/agent-credential`)
    ));
    await copyRequest.click();
    const credentialResponse = await credentialResponsePromise;
    const credentialPayload = await credentialResponse.json() as { credential?: { token?: string } };
    assert(credentialResponse.ok && Boolean(credentialPayload.credential?.token), 'Expected owner to mint request-scoped agent access');
    const agentToken = credentialPayload.credential!.token!;
    const claim = await callTool<{ leaseToken: string }>(base, 'review_room_claim_review_request', {
      slug: created.document.proofSlug,
      token: agentToken,
      requestId: request!.id,
    });
    const leaseArgs = {
      slug: created.document.proofSlug,
      token: agentToken,
      requestId: request!.id,
      leaseToken: claim.leaseToken,
    };
    await callTool(base, 'review_room_heartbeat_review_request', leaseArgs);
    await callTool(base, 'review_room_add_comment', {
      ...leaseArgs,
      quote: alpha,
      text: 'Name the accountable owner for this statement.',
    });
    await callTool(base, 'review_room_add_suggestion', {
      ...leaseArgs,
      kind: 'replace',
      quote: beta,
      content: 'Beta names a concrete outcome for the browser review suggestion.',
    });
    await callTool(base, 'review_room_complete_review_request', leaseArgs);
    await expect(agentButton).toContainText('2 review items need review', { timeout: 15_000 });
    await expect(page.locator('[data-review-room-capability-strip="1"] [data-kind="agent"]')).toContainText('Review work ready');

    await agentButton.click();
    await page.getByRole('menuitem', { name: 'Open remaining review work' }).click();
    await expect(page.locator('#review-room-review-sidebar')).toBeVisible();
    await expect(page.getByText('Beta names a concrete outcome for the browser review suggestion.')).toBeVisible();
    await page.getByRole('tab', { name: /Comments/ }).click();
    await expect(page.getByText('Name the accountable owner for this statement.')).toBeVisible();
    await page.screenshot({ path: '/private/tmp/review-room-agent-review-results.png', fullPage: true });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      'Expected agent review UI not to introduce horizontal overflow',
    );
    assert(browserErrors.length === 0, `Unexpected browser errors:\n${browserErrors.join('\n')}`);
    console.log('✓ Review Room BYO agent review-request UI passed in Playwright');
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
