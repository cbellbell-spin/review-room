import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from '@playwright/test';

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

type CreateDocumentResponse = {
  success: boolean;
  openPath: string;
  proof: { slug: string; accessToken: string; ownerSecret: string };
};

type StateResponse = {
  content?: string;
  markdown?: string;
  marks?: Record<string, { kind?: string; status?: string }>;
};

const INTRO = 'Intro paragraph stays.';
const ORIGINAL = 'Original sentence to replace.';
const REPLACEMENT = 'Replacement sentence RR ACCEPT TOKEN.';
const TAIL = 'Tail paragraph stays.';

const INITIAL_MARKDOWN = [
  '# Accept race regression',
  '',
  INTRO,
  '',
  ORIGINAL,
  '',
  TAIL,
  '',
].join('\n');

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-accept-race-${Date.now()}-${randomUUID()}.db`);
  const port = await getFreePort();
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);
  process.env.COLLAB_EMBEDDED_WS = '1';

  const { createReviewRoomHttpServer } = await import('../../server/index.js');
  const { getActiveCollabClientCount } = await import('../../server/ws.js');
  const server = await createReviewRoomHttpServer(port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  let browser: Browser | null = null;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const createRes = await fetch(`${baseUrl}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Accept race regression', markdown: INITIAL_MARKDOWN }),
    });
    const created = await mustJson<CreateDocumentResponse>(createRes, 'create document');
    assert(created.success === true, 'Expected document creation to succeed');
    const slug = created.proof.slug;
    const ownerSecret = created.proof.ownerSecret;

    const suggestRes = await fetch(`${baseUrl}/api/agent/${slug}/marks/suggest-replace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': ownerSecret },
      body: JSON.stringify({ by: 'ai:race-test', quote: ORIGINAL, content: REPLACEMENT }),
    });
    const suggested = await mustJson<{ success: boolean }>(suggestRes, 'suggest-replace');
    assert(suggested.success === true, 'Expected suggest-replace to succeed');

    const fetchState = async (): Promise<{ content: string; marks: Record<string, { kind?: string; status?: string }> }> => {
      const res = await fetch(`${baseUrl}/api/agent/${slug}/state`, {
        headers: { 'x-share-token': ownerSecret },
      });
      const state = await mustJson<StateResponse>(res, 'state');
      const content = typeof state.content === 'string'
        ? state.content
        : (typeof state.markdown === 'string' ? state.markdown : '');
      return { content, marks: state.marks ?? {} };
    };

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

    // Make the race deterministic: once __rrWsDelayMs is set, every incoming
    // collab websocket message is delivered late, so the Review sidebar's
    // post-accept REST refresh always runs against a stale local Yjs replica —
    // exactly the timing window users hit nondeterministically in dev mode.
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      (window as unknown as { __rrWsDelayMs: number }).__rrWsDelayMs = 0;
      const delayMs = () => (window as unknown as { __rrWsDelayMs: number }).__rrWsDelayMs || 0;
      const deliver = (listener: (event: MessageEvent) => void, event: MessageEvent) => {
        const ms = delayMs();
        if (ms > 0) setTimeout(() => listener(event), ms);
        else listener(event);
      };
      class DelayedWebSocket extends NativeWebSocket {
        addEventListener(type: string, listener: any, options?: any): void {
          if (type === 'message' && typeof listener === 'function') {
            super.addEventListener(type, (event: MessageEvent) => deliver(listener, event), options);
            return;
          }
          super.addEventListener(type, listener, options);
        }
        set onmessage(fn: ((event: MessageEvent) => void) | null) {
          if (typeof fn === 'function') {
            NativeWebSocket.prototype && Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, 'onmessage')
              ?.set?.call(this, (event: MessageEvent) => deliver(fn, event));
          } else {
            Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, 'onmessage')?.set?.call(this, fn);
          }
        }
        get onmessage(): ((event: MessageEvent) => void) | null {
          return Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, 'onmessage')?.get?.call(this) ?? null;
        }
      }
      window.WebSocket = DelayedWebSocket as typeof WebSocket;
    });

    await page.goto(`${baseUrl}${created.openPath}`);
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    const anonymousPrompt = page.getByRole('button', { name: 'Continue anonymously' });
    if (await anonymousPrompt.isVisible().catch(() => false)) {
      await anonymousPrompt.click();
    }

    await waitForAsync(
      async () => getActiveCollabClientCount(slug) > 0,
      15_000,
      'live collab client connection',
    );
    await waitForAsync(
      async () => (await page.locator('.ProseMirror').textContent() ?? '').includes(ORIGINAL),
      15_000,
      'suggestion target text rendered in editor',
    );
    // Give initial hydration/marks sync a moment to settle before racing.
    await page.waitForTimeout(1_500);

    await page.evaluate(() => {
      (window as unknown as { __rrWsDelayMs: number }).__rrWsDelayMs = 2_000;
    });

    await page.getByRole('button', { name: 'Open review items' }).click();
    const acceptButton = page.getByRole('button', { name: 'Accept', exact: true }).first();
    await acceptButton.waitFor({ state: 'visible', timeout: 10_000 });
    await acceptButton.click();

    // Let the stale refresh race the delayed collab broadcast, then restore
    // normal delivery and let everything converge/persist.
    await page.waitForTimeout(4_000);
    await page.evaluate(() => {
      (window as unknown as { __rrWsDelayMs: number }).__rrWsDelayMs = 0;
    });

    let lastContent = '';
    await waitForAsync(async () => {
      const { content } = await fetchState();
      const stable = content === lastContent;
      lastContent = content;
      return stable && content.length > 0;
    }, 20_000, 'canonical document content to stabilize');

    const { content, marks } = await fetchState();
    const editorText = (await page.locator('.ProseMirror').textContent()) ?? '';

    const failures: string[] = [];
    if (countOccurrences(content, REPLACEMENT) !== 1) {
      failures.push(`expected accepted replacement exactly once in canonical content, found ${countOccurrences(content, REPLACEMENT)}`);
    }
    if (content.includes(ORIGINAL)) {
      failures.push('original suggestion target text still present in canonical content');
    }
    if (countOccurrences(content, INTRO) !== 1) {
      failures.push(`intro paragraph duplicated/lost in canonical content (found ${countOccurrences(content, INTRO)})`);
    }
    if (countOccurrences(content, TAIL) !== 1) {
      failures.push(`tail paragraph duplicated/lost in canonical content (found ${countOccurrences(content, TAIL)})`);
    }
    const pendingSuggestions = Object.entries(marks).filter(([, mark]) =>
      (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
      && (mark.status ?? 'pending') === 'pending');
    if (pendingSuggestions.length > 0) {
      failures.push(`suggestion still pending after accept: ${pendingSuggestions.map(([id]) => id).join(', ')}`);
    }
    if (countOccurrences(editorText, REPLACEMENT.replace(/\.$/, '')) !== 1) {
      failures.push(`expected accepted replacement exactly once in live editor, found ${countOccurrences(editorText, REPLACEMENT.replace(/\.$/, ''))}`);
    }
    if (countOccurrences(editorText, INTRO) !== 1 || countOccurrences(editorText, TAIL) !== 1) {
      failures.push('live editor shows duplicated/lost paragraphs after accept');
    }

    assert(
      failures.length === 0,
      `Accepting a suggestion with a live collab session corrupted the document:\n- ${failures.join('\n- ')}\nCanonical content:\n${content}`,
    );

    console.log('✓ Review sidebar accept stays consistent with a live collab session open');
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
