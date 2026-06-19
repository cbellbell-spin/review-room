import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
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

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function continueAnonymously(page: Page): Promise<void> {
  const anonymousPrompt = page.getByRole('button', { name: 'Continue anonymously' });
  if (await anonymousPrompt.isVisible().catch(() => false)) {
    await anonymousPrompt.click();
  }
}

async function installDelayedWebSocket(page: Page, delayMs: number): Promise<void> {
  await page.addInitScript({
    content: `
(() => {
    const NativeWebSocket = window.WebSocket;
    const delay = Math.max(0, Number(${JSON.stringify(delayMs)}) || 0);
    const deliver = (listener, event) => {
      if (delay > 0) setTimeout(() => listener(event), delay);
      else listener(event);
    };
    class DelayedWebSocket extends NativeWebSocket {
      addEventListener(type, listener, options) {
        if (type === 'message' && typeof listener === 'function') {
          super.addEventListener(type, (event) => deliver(listener, event), options);
          return;
        }
        super.addEventListener(type, listener, options);
      }
      set onmessage(fn) {
        const descriptor = Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, 'onmessage');
        if (typeof fn === 'function') {
          descriptor?.set?.call(this, (event) => deliver(fn, event));
        } else {
          descriptor?.set?.call(this, fn);
        }
      }
      get onmessage() {
        return Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, 'onmessage')?.get?.call(this) ?? null;
      }
    }
    window.WebSocket = DelayedWebSocket;
})();
`,
  });
}

async function placeCursorAtDocumentEnd(page: Page): Promise<void> {
  await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
  await page.evaluate(() => {
    const view = (window as unknown as { __editorView?: any }).__editorView;
    if (!view) throw new Error('Missing editor view');
    const selectionCtor = view.state.selection.constructor;
    const pos = Math.max(1, view.state.doc.content.size - 1);
    view.dispatch(view.state.tr.setSelection(selectionCtor.create(view.state.doc, pos)).scrollIntoView());
    view.focus();
  });
}

async function selectEditorText(page: Page, text: string): Promise<void> {
  await page.evaluate((targetText) => {
    const view = (window as unknown as { __editorView?: any }).__editorView;
    if (!view) throw new Error('Missing editor view');
    let from: number | null = null;
    view.state.doc.descendants((node: any, pos: number) => {
      if (from !== null || !node.isText) return true;
      const offset = String(node.text ?? '').indexOf(targetText);
      if (offset < 0) return true;
      from = pos + offset;
      return false;
    });
    if (from === null) throw new Error(`Could not select ${targetText}`);
    const selectionCtor = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(selectionCtor.create(view.state.doc, from, from + targetText.length)).scrollIntoView());
    view.focus();
  }, text);
}

type CreateDocumentResponse = {
  success: boolean;
  openPath: string;
  proof: { slug: string; ownerSecret?: string; accessToken?: string };
};

type StateResponse = {
  content?: string;
  markdown?: string;
};

const COMMENT_TARGET = 'Comment target sentence.';
const OWNER_COMMENT = 'Comment created by the owner in browser A.';
const SUGGESTED_INSERTION = ' RR comment interaction token';

const INITIAL_MARKDOWN = [
  '# Comment interaction regression',
  '',
  'Stable opening paragraph.',
  '',
  COMMENT_TARGET,
  '',
].join('\n');

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-comment-duplication-${Date.now()}-${randomUUID()}.db`);
  const port = await getFreePort();
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);
  process.env.COLLAB_EMBEDDED_WS = '1';

  const { createReviewRoomHttpServer } = await import('../../server/index.js');
  const server = await createReviewRoomHttpServer(port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  let browserA: Browser | null = null;
  let browserB: Browser | null = null;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const createRes = await fetch(`${baseUrl}/review-room/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-review-room-identity-id': 'comment-owner',
      },
      body: JSON.stringify({ title: 'Comment interaction regression', markdown: INITIAL_MARKDOWN }),
    });
    const created = await mustJson<CreateDocumentResponse>(createRes, 'create document');
    assert(created.success === true, 'Expected document creation to succeed');
    const slug = created.proof.slug;
    const ownerSecret = created.proof.accessToken ?? created.proof.ownerSecret;
    assert(Boolean(ownerSecret), 'Expected owner access token');

    const memberRes = await fetch(`${baseUrl}/review-room/api/documents/${encodeURIComponent(slug)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': ownerSecret as string },
      body: JSON.stringify({ identityId: 'comment-editor', displayName: 'Comment Editor', role: 'editor' }),
    });
    const member = await mustJson<{ success: boolean; member: { openPath: string } }>(memberRes, 'create editor member');
    assert(member.success === true, 'Expected member creation to succeed');

    [browserA, browserB] = await Promise.all([chromium.launch(), chromium.launch()]);
    const pageA = await browserA.newPage({ viewport: { width: 1280, height: 860 } });
    const pageB = await browserB.newPage({ viewport: { width: 1280, height: 860 } });
    await Promise.all([
      installDelayedWebSocket(pageA, 150),
      installDelayedWebSocket(pageB, 150),
    ]);
    const errors: string[] = [];
    for (const page of [pageA, pageB]) {
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (text.includes('Failed to load resource: the server responded with a status of 404')) return;
        errors.push(text);
      });
      page.on('pageerror', (error) => errors.push(error.message));
    }

    await Promise.all([
      pageA.goto(`${baseUrl}${created.openPath}`),
      pageB.goto(`${baseUrl}${member.member.openPath}`),
    ]);
    await Promise.all([
      pageA.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 }),
      pageB.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 }),
    ]);
    await Promise.all([continueAnonymously(pageA), continueAnonymously(pageB)]);
    await waitForAsync(
      async () => {
        const [aText, bText] = await Promise.all([
          pageA.locator('.ProseMirror').textContent(),
          pageB.locator('.ProseMirror').textContent(),
        ]);
        return (aText ?? '').includes(COMMENT_TARGET) && (bText ?? '').includes(COMMENT_TARGET);
      },
      20_000,
      'both editors to hydrate seeded document text',
    );

    // Browser A creates a comment through the human UI; browser B must receive
    // it and reply through its own independently launched browser process.
    await selectEditorText(pageA, COMMENT_TARGET);
    await pageA.getByRole('button', { name: 'Open review items' }).click();
    const sidebarA = pageA.locator('#review-room-review-sidebar');
    await sidebarA.getByPlaceholder('Add a comment...').fill(OWNER_COMMENT);
    await sidebarA.getByRole('button', { name: 'Comment', exact: true }).click();
    await sidebarA.getByText(OWNER_COMMENT).waitFor({ state: 'visible', timeout: 15_000 });
    await sidebarA.getByText(/human:comment-owner ·/).first().waitFor({ state: 'visible', timeout: 10_000 });
    await sidebarA.getByRole('button', { name: 'Close', exact: true }).click();

    await pageA.getByRole('switch', { name: 'Suggesting mode' }).click();
    await placeCursorAtDocumentEnd(pageA);
    await pageA.keyboard.type(SUGGESTED_INSERTION);

    const insertedTrimmed = SUGGESTED_INSERTION.trim();
    await waitForAsync(
      async () => ((await pageA.locator('.ProseMirror').textContent()) ?? '').includes(insertedTrimmed),
      10_000,
      'first editor to show local suggested insertion',
    );
    await waitForAsync(
      async () => ((await pageB.locator('.ProseMirror').textContent()) ?? '').includes(insertedTrimmed),
      30_000,
      'second editor to receive suggested insertion',
    );

    await pageB.getByRole('button', { name: 'Open review items' }).click();
    const commentsTab = pageB.locator('#review-room-review-sidebar button').filter({ hasText: /^Comments/ }).first();
    try {
      await commentsTab.waitFor({ state: 'visible', timeout: 10_000 });
    } catch (error) {
      const buttons = await pageB.locator('#review-room-review-sidebar button').evaluateAll((items) =>
        items.map((item) => item.textContent ?? '').filter(Boolean),
      ).catch(() => []);
      throw new Error(`Could not find Comments tab. Sidebar buttons: ${buttons.join(' | ')}`);
    }
    await commentsTab.click();
    await pageB.getByText(OWNER_COMMENT).waitFor({ state: 'visible', timeout: 15_000 });
    await pageB.getByText(/human:comment-owner ·/).first().waitFor({ state: 'visible', timeout: 10_000 });
    await pageB.getByPlaceholder('Reply...').fill('Reply from the second editor.');
    await pageB.getByRole('button', { name: 'Reply', exact: true }).click();
    await pageB.getByText('Reply from the second editor.').waitFor({ state: 'visible', timeout: 10_000 });
    await pageB.getByText(/human:comment-editor ·/).first().waitFor({ state: 'visible', timeout: 10_000 });

    await waitForAsync(async () => {
      const [aText, bText] = await Promise.all([
        pageA.locator('.ProseMirror').textContent(),
        pageB.locator('.ProseMirror').textContent(),
      ]);
      return countOccurrences(aText ?? '', insertedTrimmed) === 1
        && countOccurrences(bText ?? '', insertedTrimmed) === 1;
    }, 20_000, 'both live editors to keep the insertion once after comment interaction');

    const [editorAText, editorBText, stateRes] = await Promise.all([
      pageA.locator('.ProseMirror').textContent(),
      pageB.locator('.ProseMirror').textContent(),
      fetch(`${baseUrl}/api/agent/${slug}/state`, { headers: { 'x-share-token': ownerSecret as string } }),
    ]);
    const state = await mustJson<StateResponse>(stateRes, 'final state');
    const canonical = typeof state.content === 'string'
      ? state.content
      : (typeof state.markdown === 'string' ? state.markdown : '');

    const failures: string[] = [];
    if (countOccurrences(canonical, insertedTrimmed) > 1) {
      failures.push(`canonical insertion count=${countOccurrences(canonical, insertedTrimmed)}\n${canonical}`);
    }
    if (countOccurrences(editorAText ?? '', insertedTrimmed) !== 1) {
      failures.push(`editor A insertion count=${countOccurrences(editorAText ?? '', insertedTrimmed)}\n${editorAText ?? ''}`);
    }
    if (countOccurrences(editorBText ?? '', insertedTrimmed) !== 1) {
      failures.push(`editor B insertion count=${countOccurrences(editorBText ?? '', insertedTrimmed)}\n${editorBText ?? ''}`);
    }
    if (errors.length > 0) failures.push(`browser errors:\n${errors.join('\n')}`);
    assert(
      failures.length === 0,
      `Comment interaction duplicated suggested body text:\n- ${failures.join('\n- ')}`,
    );

    console.log('✓ Comment interaction does not duplicate live suggested body text');
  } finally {
    await Promise.all([browserA?.close(), browserB?.close()]);
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

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
