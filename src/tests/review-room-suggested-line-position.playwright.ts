import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';

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

async function paragraphTexts(page: Page): Promise<string[]> {
  return page.locator('.ProseMirror p').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? '').trim()).filter(Boolean),
  );
}

async function placeCursorAtEndOfText(page: Page, text: string): Promise<void> {
  await page.evaluate((targetText) => {
    const view = (window as unknown as { __editorView?: any }).__editorView;
    if (!view) throw new Error('Missing editor view');
    let targetPos: number | null = null;
    view.state.doc.descendants((node: any, pos: number) => {
      if (targetPos !== null || !node.isText) return true;
      const value = String(node.text ?? '');
      const offset = value.indexOf(targetText);
      if (offset < 0) return true;
      targetPos = pos + offset + targetText.length;
      return false;
    });
    if (targetPos === null) throw new Error(`Could not find text ${targetText}`);
    const selectionCtor = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(selectionCtor.create(view.state.doc, targetPos)).scrollIntoView());
    view.focus();
  }, text);
}

type CreateDocumentResponse = {
  success: boolean;
  openPath: string;
  proof: { slug: string; ownerSecret: string };
};

const FIRST_PARAGRAPH = 'THIS WILL be a big test of coding agents';
const SECOND_PARAGRAPH = 'Tail paragraph should stay after the suggestion.';
const SUGGESTED_LINE = 'So far we found 1 bug';

const INITIAL_MARKDOWN = [
  '# Suggested line position regression',
  '',
  FIRST_PARAGRAPH,
  '',
  SECOND_PARAGRAPH,
  '',
].join('\n');

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-suggested-line-position-${Date.now()}-${randomUUID()}.db`);
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
    const createRes = await fetch(`${baseUrl}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Suggested line position regression', markdown: INITIAL_MARKDOWN }),
    });
    const created = await mustJson<CreateDocumentResponse>(createRes, 'create document');
    assert(created.success === true, 'Expected document creation to succeed');

    browser = await chromium.launch();
    const pageA = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const pageB = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await Promise.all([
      installDelayedWebSocket(pageA, 150),
      installDelayedWebSocket(pageB, 150),
    ]);
    await Promise.all([
      pageA.goto(`${baseUrl}${created.openPath}`),
      pageB.goto(`${baseUrl}${created.openPath}`),
    ]);
    await Promise.all([
      pageA.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 }),
      pageB.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 }),
    ]);
    await Promise.all([continueAnonymously(pageA), continueAnonymously(pageB)]);
    await waitForAsync(async () => {
      const [a, b] = await Promise.all([paragraphTexts(pageA), paragraphTexts(pageB)]);
      return a.includes(FIRST_PARAGRAPH) && a.includes(SECOND_PARAGRAPH)
        && b.includes(FIRST_PARAGRAPH) && b.includes(SECOND_PARAGRAPH);
    }, 20_000, 'both editors to hydrate paragraphs');

    await pageB.getByRole('switch', { name: 'Suggesting mode' }).click();
    await placeCursorAtEndOfText(pageB, FIRST_PARAGRAPH);
    await pageB.keyboard.press('Enter');
    await pageB.keyboard.type(SUGGESTED_LINE);

    await waitForAsync(async () => (await paragraphTexts(pageA)).some((text) => text.includes(SUGGESTED_LINE)), 20_000, 'browser A to receive suggested line');
    await waitForAsync(async () => (await paragraphTexts(pageB)).some((text) => text.includes(SUGGESTED_LINE)), 20_000, 'browser B to keep suggested line');

    const [paragraphsA, paragraphsB] = await Promise.all([paragraphTexts(pageA), paragraphTexts(pageB)]);
    const failures: string[] = [];
    for (const [label, paragraphs] of [['browser A', paragraphsA], ['browser B', paragraphsB]] as const) {
      const firstIndex = paragraphs.findIndex((text) => text.includes(FIRST_PARAGRAPH));
      const suggestedIndex = paragraphs.findIndex((text) => text.includes(SUGGESTED_LINE));
      const secondIndex = paragraphs.findIndex((text) => text.includes(SECOND_PARAGRAPH));
      if (!(firstIndex >= 0 && suggestedIndex > firstIndex && secondIndex > suggestedIndex)) {
        failures.push(`${label} paragraph order wrong: ${JSON.stringify(paragraphs)}`);
      }
      if (paragraphs.some((text) => text.includes(FIRST_PARAGRAPH) && text.includes(SUGGESTED_LINE))) {
        failures.push(`${label} merged suggested line into the first paragraph: ${JSON.stringify(paragraphs)}`);
      }
    }
    assert(failures.length === 0, `Suggested line position diverged:\n- ${failures.join('\n- ')}`);

    console.log('✓ Suggested line keeps the same paragraph position across two editors');
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

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
