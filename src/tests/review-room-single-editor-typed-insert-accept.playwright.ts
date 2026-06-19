import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { stripAllProofSpanTags } from '../../server/proof-span-strip.ts';

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

async function waitForEditorEditable(page: Page): Promise<void> {
  await waitForAsync(async () => page.evaluate(() => {
    const editorEl = document.querySelector('.ProseMirror');
    const view = (window as unknown as { __editorView?: { editable?: boolean } }).__editorView;
    return editorEl?.getAttribute('contenteditable') === 'true' && view?.editable === true;
  }), 15_000, 'editor to become editable');
}

type CreateDocumentResponse = {
  success: boolean;
  openPath: string;
  proof: { slug: string; ownerSecret: string };
};

type StateResponse = {
  content?: string;
  markdown?: string;
  marks?: Record<string, { kind?: string; status?: string }>;
};

const BASE_TEXT = 'I am really worried how deep the bug is';
const INLINE_INSERT = ' you and me both';
const LINE_INSERT = 'so far this looks ok.';

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-single-typed-accept-${Date.now()}-${randomUUID()}.db`);
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
      body: JSON.stringify({
        title: 'Single editor typed insert accept',
        markdown: `${BASE_TEXT}\n\n`,
      }),
    });
    const created = await mustJson<CreateDocumentResponse>(createRes, 'create document');
    assert(created.success === true, 'Expected document creation to succeed');
    const slug = created.proof.slug;
    const ownerSecret = created.proof.ownerSecret;

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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const consoleErrors: string[] = [];
    const acceptRequests: string[] = [];
    const mutationDiagnostics: string[] = [];
    page.on('request', (request) => {
      if (!request.url().includes('/marks/accept')) return;
      acceptRequests.push(request.postData() ?? '');
    });
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes(`/api/agent/${slug}/state`) && !url.includes(`/api/agent/${slug}/marks/accept`)) return;
      if (response.status() < 400 && !url.includes('/marks/accept')) {
        const requestMethod = response.request().method();
        const body = await response.text().catch(() => '');
        mutationDiagnostics.push(`${response.status()} ${requestMethod} ${url.replace(baseUrl, '')}: ${body.slice(0, 500)}`);
        return;
      }
      const body = await response.text().catch(() => '');
      mutationDiagnostics.push(`${response.status()} ${url.replace(baseUrl, '')}: ${body.slice(0, 500)}`);
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (text.includes('Failed to load resource: the server responded with a status of 404')) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    await page.goto(`${baseUrl}${created.openPath}`);
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    await continueAnonymously(page);
    await waitForAsync(
      async () => ((await page.locator('.ProseMirror').textContent()) ?? '').includes(BASE_TEXT),
      15_000,
      'initial document text',
    );

    await waitForEditorEditable(page);
    await page.getByRole('switch', { name: 'Suggesting mode' }).click();
    await waitForAsync(async () => {
      const checked = await page.getByRole('switch', { name: 'Suggesting mode' }).getAttribute('aria-checked');
      return checked === 'true';
    }, 5_000, 'suggesting mode to enable');
    await placeCursorAtEndOfText(page, BASE_TEXT);
    await page.keyboard.type(INLINE_INSERT);
    await page.keyboard.press('Enter');
    await page.keyboard.type(LINE_INSERT);

    await waitForAsync(
      async () => {
        const text = (await page.locator('.ProseMirror').textContent()) ?? '';
        return text.includes(INLINE_INSERT.trim()) && text.includes(LINE_INSERT);
      },
      10_000,
      'typed suggested insertions in editor',
    );

    await page.getByRole('button', { name: 'Open review items' }).click();
    const sidebar = page.locator('#review-room-review-sidebar');
    await sidebar.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForAsync(async () => {
      const sidebarText = (await sidebar.textContent()) ?? '';
      return sidebarText.includes('you and me both') && sidebarText.includes(LINE_INSERT);
    }, 10_000, 'Review pane to render typed suggestions');
    const sidebarText = (await sidebar.textContent()) ?? '';
    if (sidebarText.includes('bothso far')) {
      const debug = await page.evaluate(() => {
        const view = (window as unknown as { __editorView?: any }).__editorView;
        if (!view) return { error: 'Missing editor view' };
        const marks: Array<Record<string, unknown>> = [];
        view.state.doc.descendants((node: any, pos: number) => {
          for (const mark of node.marks ?? []) {
            if (mark.type?.name !== 'proofSuggestion') continue;
            marks.push({
              id: mark.attrs?.id,
              kind: mark.attrs?.kind,
              by: mark.attrs?.by,
              text: node.text,
              pos,
              attrs: mark.attrs,
            });
          }
          return true;
        });
        return {
          text: view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'),
          marks,
        };
      });
      throw new Error(`Review pane rendered mashed insert text: ${sidebarText}\nDebug: ${JSON.stringify(debug, null, 2)}`);
    }

    for (let i = 0; i < 5; i += 1) {
      const acceptButtons = page.locator('#review-room-review-sidebar').getByRole('button', { name: 'Accept', exact: true });
      let enabledIndex = -1;
      await waitForAsync(async () => {
        const count = await acceptButtons.count();
        if (count === 0) {
          enabledIndex = -2;
          return true;
        }
        for (let index = 0; index < count; index += 1) {
          if (await acceptButtons.nth(index).isEnabled().catch(() => false)) {
            enabledIndex = index;
            return true;
          }
        }
        return false;
      }, 20_000, 'Review pane accept action to become ready');
      if (enabledIndex === -2) break;

      const requestCountBeforeClick = acceptRequests.length;
      await acceptButtons.nth(enabledIndex).click();
      await waitForAsync(
        async () => acceptRequests.length > requestCountBeforeClick,
        15_000,
        'accept mutation request',
      );
      const errorVisible = await page.getByText(/Could not accept this suggestion|Could not save before accepting/).isVisible().catch(() => false);
      assert(!errorVisible, 'Review pane showed an accept failure');
    }

    try {
      await waitForAsync(async () => {
        const { marks } = await fetchState();
        return Object.values(marks).every((mark) =>
          !(mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
          || (mark.status ?? 'pending') !== 'pending');
      }, 20_000, 'pending suggestions to clear after accept');
    } catch (error) {
      const { marks, content } = await fetchState();
      const sidebarAfter = (await sidebar.textContent().catch(() => '')) ?? '';
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nAccept requests:\n${acceptRequests.join('\n')}\nMutation diagnostics:\n${mutationDiagnostics.join('\n')}\nSidebar:\n${sidebarAfter}\nMarks:\n${JSON.stringify(marks, null, 2)}\nCanonical:\n${content}`);
    }

    try {
      await waitForAsync(async () => {
        const { content } = await fetchState();
        const visibleContent = stripAllProofSpanTags(content);
        const editorText = (await page.locator('.ProseMirror').textContent()) ?? '';
        return visibleContent.includes(`${BASE_TEXT}${INLINE_INSERT}`)
          && visibleContent.includes(LINE_INSERT)
          && editorText.includes(`${BASE_TEXT}${INLINE_INSERT}`)
          && editorText.includes(LINE_INSERT);
      }, 20_000, 'accepted suggestions to converge in canonical state and editor');
    } catch (error) {
      const { content, marks } = await fetchState();
      const editorText = (await page.locator('.ProseMirror').textContent()) ?? '';
      const db = await import('../../server/db.ts');
      const durable = db.getDocumentBySlug(slug);
      const tombstones = db.listMarkTombstonesForDocument(slug);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}`
        + `\nDurable revision: ${durable?.revision ?? '(missing)'}`
        + `\nTombstones: ${JSON.stringify(tombstones)}`
        + `\nDurable:\n${durable?.markdown ?? '(missing)'}`
        + `\nState:\n${content}`
        + `\nEditor:\n${editorText}`
        + `\nMarks:\n${JSON.stringify(marks, null, 2)}`,
      );
    }

    const { content, marks } = await fetchState();
    const visibleContent = stripAllProofSpanTags(content);
    const editorText = (await page.locator('.ProseMirror').textContent()) ?? '';
    const failures: string[] = [];
    if (!visibleContent.includes(`${BASE_TEXT}${INLINE_INSERT}`)) failures.push('canonical content is missing accepted inline insert');
    if (!visibleContent.includes(LINE_INSERT)) failures.push('canonical content is missing accepted line insert');
    if (!editorText.includes(`${BASE_TEXT}${INLINE_INSERT}`)) failures.push('editor text is missing accepted inline insert');
    if (!editorText.includes(LINE_INSERT)) failures.push('editor text is missing accepted line insert');
    const pending = Object.entries(marks).filter(([, mark]) =>
      (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
      && (mark.status ?? 'pending') === 'pending');
    if (pending.length > 0) failures.push(`pending suggestions remain: ${pending.map(([id]) => id).join(', ')}`);
    if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(' | ')}`);
    assert(failures.length === 0, `Single-editor typed insert accept failed:\n- ${failures.join('\n- ')}\nAccept requests:\n${acceptRequests.join('\n')}\nMutation diagnostics:\n${mutationDiagnostics.join('\n')}\nCanonical:\n${content}`);

    console.log('✓ Single-editor typed insert suggestions render and accept from the Review pane');
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
