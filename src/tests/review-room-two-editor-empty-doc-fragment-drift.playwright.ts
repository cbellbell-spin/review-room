import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { chromium, type Browser, type Page } from 'playwright';

async function getFreePort(): Promise<number> {
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not allocate port'));
      });
    });
  });
}

async function json<T>(response: Response, label: string): Promise<T> {
  const body = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }));
  assert(response.ok, `${label} failed: ${response.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForEditable(page: Page): Promise<void> {
  await waitFor(async () => page.evaluate(() => {
    const view = (window as unknown as { __editorView?: any }).__editorView;
    const editorEl = document.querySelector('.ProseMirror');
    return Boolean(
      view
      && view.editable === true
      && editorEl?.getAttribute('contenteditable') === 'true'
    );
  }), 30_000, 'editor to become editable');
}

async function typeAtEnd(page: Page, text: string, delay = 0): Promise<void> {
  await waitForEditable(page);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.evaluate(() => {
    const view = (window as unknown as { __editorView?: any }).__editorView;
    if (!view) throw new Error('Missing editor view');
    const selectionCtor = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(selectionCtor.atEnd(view.state.doc)).scrollIntoView());
    view.focus();
  });
  await page.keyboard.type(text, { delay });
}

async function setSuggesting(page: Page, enabled: boolean): Promise<void> {
  const toggle = page.getByRole('switch', { name: 'Suggesting mode' });
  await toggle.waitFor({ state: 'visible', timeout: 15_000 });
  const checked = (await toggle.getAttribute('aria-checked')) === 'true';
  if (checked !== enabled) await toggle.click();
  await waitFor(
    async () => ((await toggle.getAttribute('aria-checked')) === 'true') === enabled,
    5_000,
    `suggesting mode to become ${enabled ? 'enabled' : 'disabled'}`,
  );
}

async function decideSuggestion(
  page: Page,
  text: string,
  action: 'Accept' | 'Reject',
): Promise<void> {
  const existing = page.locator('#review-room-review-sidebar');
  if (await existing.isVisible().catch(() => false)) {
    await existing.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Open review items' }).click();
  const sidebar = page.locator('#review-room-review-sidebar');
  await sidebar.waitFor({ state: 'visible', timeout: 10_000 });
  const item = sidebar.locator('article').filter({ hasText: text }).first();
  const button = item.getByRole('button', { name: action, exact: true });
  await button.waitFor({ state: 'visible', timeout: 15_000 });
  await waitFor(async () => button.isEnabled().catch(() => false), 20_000, `${action} for ${text} to become enabled`);
  await button.click();
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

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-empty-two-editor-${Date.now()}-${randomUUID()}.db`);
  const port = await getFreePort();
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);
  process.env.COLLAB_EMBEDDED_WS = '1';

  const { createReviewRoomHttpServer } = await import('../../server/index.js');
  const collab = await import('../../server/collab.js');
  const server = await createReviewRoomHttpServer(port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  let browserA: Browser | null = null;
  let browserB: Browser | null = null;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const created = await json<{
      success: boolean;
      openPath: string;
      proof: { slug: string; accessToken: string };
    }>(await fetch(`${baseUrl}/review-room/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-review-room-identity-id': 'owner-empty-flow',
      },
      body: JSON.stringify({ title: 'Empty two editor drift', markdown: '' }),
    }), 'create empty document');
    assert(created.success === true, 'Expected create success');
    const slug = created.proof.slug;

    const member = await json<{
      success: boolean;
      member: { openPath: string; accessToken: string; identityId: string };
    }>(await fetch(`${baseUrl}/review-room/api/documents/${encodeURIComponent(slug)}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': created.proof.accessToken,
      },
      body: JSON.stringify({ identityId: 'test-editor', displayName: 'Test Editor', role: 'editor' }),
    }), 'create editor member');
    assert(member.success === true, 'Expected member create success');

    // Separate browser processes are intentional: two contexts in one process
    // do not exercise the same storage, socket, and lifecycle boundaries as two
    // humans opening collaborator links in different browsers.
    [browserA, browserB] = await Promise.all([chromium.launch(), chromium.launch()]);
    const pageA = await browserA.newPage({ viewport: { width: 1280, height: 860 } });
    const pageB = await browserB.newPage({ viewport: { width: 1280, height: 860 } });
    const fullDocumentWrites: string[] = [];
    for (const page of [pageA, pageB]) {
      page.on('request', (request) => {
        if (request.method() !== 'PUT') return;
        if (!request.url().includes(`/api/documents/${slug}`)) return;
        fullDocumentWrites.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`);
      });
    }
    await Promise.all([
      pageA.goto(`${baseUrl}${created.openPath}`),
      pageB.goto(`${baseUrl}${member.member.openPath}`),
    ]);
    await Promise.all([
      pageA.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 }),
      pageB.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 }),
    ]);

    await typeAtEnd(pageA, 'We are jumping the shark on all of this manual testing.');
    await setSuggesting(pageA, true);
    await typeAtEnd(pageA, ' editor 1 suggesting with two people in the doc.');

    try {
      await waitFor(async () => {
        const text = await pageB.locator('.ProseMirror').textContent();
        return (text ?? '').includes('editor 1 suggesting');
      }, 20_000, 'editor B to see editor A suggestion');
    } catch (error) {
      const [textA, textB, fragmentAfterA] = await Promise.all([
        pageA.locator('.ProseMirror').textContent().catch(() => ''),
        pageB.locator('.ProseMirror').textContent().catch(() => ''),
        collab.getLoadedCollabMarkdownFromFragment(slug).catch(() => null),
      ]);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nEditor A:\n${textA}\nEditor B:\n${textB}\nFragment:\n${fragmentAfterA ?? '(missing)'}`);
    }

    await typeAtEnd(pageB, '\nEditor 2 direct text.');
    await waitFor(async () => {
      const text = await pageA.locator('.ProseMirror').textContent();
      return (text ?? '').includes('Editor 2 direct text.');
    }, 20_000, 'editor A to see editor B direct edit');

    await setSuggesting(pageB, true);
    await typeAtEnd(pageB, '\nsecond editor invited as an editor. now we suggest text where this goes weird', 125);

    try {
      await waitFor(async () => {
        const text = await pageA.locator('.ProseMirror').textContent();
        return (text ?? '').includes('second editor invited as an editor');
      }, 20_000, 'editor A to see editor B suggestion');
    } catch (error) {
      const [textA, textB, fragmentAfterB] = await Promise.all([
        pageA.locator('.ProseMirror').textContent().catch(() => ''),
        pageB.locator('.ProseMirror').textContent().catch(() => ''),
        collab.getLoadedCollabMarkdownFromFragment(slug).catch(() => null),
      ]);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nEditor A:\n${textA}\nEditor B:\n${textB}\nFragment:\n${fragmentAfterB ?? '(missing)'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const fragmentMarkdown = await collab.getLoadedCollabMarkdownFromFragment(slug);
    assert(fragmentMarkdown, 'Expected live fragment markdown');
    const plain = fragmentMarkdown.replace(/<[^>]+>/g, '');
    const compactPlain = plain.replace(/\s+/g, '');
    const secondCount = (compactPlain.match(/secondeditorinvited/g) ?? []).length;
    const firstCount = (compactPlain.match(/editor1suggesting/g) ?? []).length;
    const ownerSuggestionTailCount = countOccurrences(plain, 'sting with two people in the doc.');
    assert(firstCount === 1, `Expected first editor suggestion once, saw ${firstCount}: ${plain}`);
    assert(secondCount === 1, `Expected second editor suggestion once, saw ${secondCount}: ${plain}`);
    assert(
      ownerSuggestionTailCount === 1,
      `Expected no duplicated tail from editor A inside editor B's suggestion, saw ${ownerSuggestionTailCount}: ${plain}`,
    );
    assert(plain.length < 280, `Expected live fragment not to drift, got ${plain.length} chars: ${plain}`);

    const beforeAcceptState = await json<{ marks?: Record<string, { kind?: string; status?: string; by?: string; quote?: string }> }>(
      await fetch(`${baseUrl}/api/agent/${encodeURIComponent(slug)}/state`, {
        headers: { 'x-share-token': created.proof.accessToken },
      }),
      'state before accepting second-editor suggestion',
    );
    const pendingSecondEditorBeforeAccept = Object.values(beforeAcceptState.marks ?? {}).filter((mark) =>
      mark.by === 'human:test-editor'
      && mark.kind === 'insert'
      && (mark.status ?? 'pending') === 'pending'
    );
    assert.equal(
      pendingSecondEditorBeforeAccept.length,
      1,
      `Expected slowly typed sentence to remain one suggestion: ${JSON.stringify(beforeAcceptState.marks, null, 2)}`,
    );
    const authoredSecondEditorBeforeAccept = Object.values(beforeAcceptState.marks ?? {}).filter((mark) =>
      mark.by === 'human:test-editor' && mark.kind === 'authored'
    );
    assert(
      authoredSecondEditorBeforeAccept.some((mark) => mark.quote?.includes('Editor 2 direct text.')),
      `Expected editor B's direct edit to retain distinct authorship: ${JSON.stringify(beforeAcceptState.marks, null, 2)}`,
    );
    assert(
      !authoredSecondEditorBeforeAccept.some((mark) => mark.quote?.includes('second editor invited as an editor')),
      `Expected pending suggestion text not to also carry authored marks: ${JSON.stringify(beforeAcceptState.marks, null, 2)}`,
    );

    await pageA.getByRole('button', { name: 'Open review items' }).click();
    const sidebar = pageA.locator('#review-room-review-sidebar');
    await sidebar.waitFor({ state: 'visible', timeout: 10_000 });
    await waitFor(async () => {
      const text = (await sidebar.textContent()) ?? '';
      return text.includes('Document owner') && text.includes('Test Editor');
    }, 15_000, 'review pane to show distinct suggestion actors');
    const [ownerBorder, editorBorder] = await Promise.all([
      sidebar.locator('article').filter({ hasText: 'editor 1 suggesting with two people in the doc.' }).first().evaluate((item) => getComputedStyle(item).borderLeftColor),
      sidebar.locator('article').filter({ hasText: 'second editor invited as an editor' }).first().evaluate((item) => getComputedStyle(item).borderLeftColor),
    ]);
    assert(ownerBorder !== editorBorder, `Expected collaborators to retain distinct suggestion colors, got ${ownerBorder}`);

    const editorSuggestion = sidebar.locator('article').filter({ hasText: 'second editor invited as an editor' }).first();
    if (!(await editorSuggestion.getByRole('button', { name: 'Accept', exact: true }).isVisible({ timeout: 10_000 }).catch(() => false))) {
      const [sidebarText, rows, currentState] = await Promise.all([
        sidebar.textContent().catch(() => ''),
        sidebar.locator('article').evaluateAll((items) => items.map((item) => item.textContent ?? '')).catch(() => []),
        json<{ content?: string; markdown?: string; marks?: Record<string, unknown> }>(
          await fetch(`${baseUrl}/api/agent/${encodeURIComponent(slug)}/state`, {
            headers: { 'x-share-token': created.proof.accessToken },
          }),
          'state before accepting second-editor suggestion',
        ).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
      ]);
      throw new Error(`Could not find second-editor suggestion accept button.\nSidebar:\n${sidebarText}\nRows:\n${JSON.stringify(rows, null, 2)}\nState:\n${JSON.stringify(currentState, null, 2)}\nFragment:\n${fragmentMarkdown}`);
    }
    await editorSuggestion.getByRole('button', { name: 'Accept', exact: true }).click();
    await waitFor(async () => {
      const text = (await pageA.locator('.ProseMirror').textContent()) ?? '';
      return countOccurrences(text, 'second editor invited as an editor') === 1;
    }, 20_000, 'accepted second-editor suggestion to remain once');

    type CanonicalState = { content?: string; markdown?: string; marks?: Record<string, { kind?: string; status?: string; by?: string }> };
    let state: CanonicalState | null = null;
    await waitFor(async () => {
      state = await json<CanonicalState>(
        await fetch(`${baseUrl}/api/agent/${encodeURIComponent(slug)}/state`, {
          headers: { 'x-share-token': created.proof.accessToken },
        }),
        'state after accepting second-editor suggestion',
      );
      return !Object.values(state.marks ?? {}).some((mark) =>
        mark.by === 'human:test-editor'
        && (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
        && (mark.status ?? 'pending') === 'pending'
      );
    }, 20_000, 'accepted second-editor suggestion to leave canonical pending marks');
    assert(state, 'Expected canonical state after accepting second-editor suggestion');
    const canonical = typeof state.content === 'string' ? state.content : (state.markdown ?? '');
    assert(
      countOccurrences(canonical, 'second editor invited as an editor') === 1,
      `Expected accepted second-editor suggestion once in canonical content: ${canonical}`,
    );
    assert.deepEqual(fullDocumentWrites, [], `Expected no full-document PUT during live collab review: ${fullDocumentWrites.join('\n')}`);
    const pendingSecondEditorSuggestions = Object.values(state.marks ?? {}).filter((mark) =>
      mark.by === 'human:test-editor'
      && (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
      && (mark.status ?? 'pending') === 'pending'
    );
    assert(
      pendingSecondEditorSuggestions.length === 0,
      `Expected no pending suggestions from test-editor after accept: ${JSON.stringify(state.marks, null, 2)}`,
    );

    try {
      await waitFor(async () => pageB.evaluate(() => {
        const view = (window as unknown as { __editorView?: any }).__editorView;
        if (!view) return false;
        let pending = false;
        view.state.doc.descendants((node: any) => {
          for (const mark of node.marks ?? []) {
            if (
              mark.type?.name === 'proofSuggestion'
              && mark.attrs?.by === 'human:test-editor'
            ) {
              pending = true;
            }
          }
          return !pending;
        });
        return !pending;
      }), 20_000, 'browser B to remove the accepted suggestion mark');
    } catch (error) {
      const db = await import('../../server/db.ts');
      const durableRow = db.getDocumentBySlug(slug);
      const [browserBMarks, latestState, latestFragment] = await Promise.all([
        pageB.evaluate(() => {
          const view = (window as unknown as { __editorView?: any }).__editorView;
          if (!view) return [];
          const marks: Array<Record<string, unknown>> = [];
          view.state.doc.descendants((node: any, pos: number) => {
            for (const mark of node.marks ?? []) {
              if (mark.type?.name !== 'proofSuggestion') continue;
              marks.push({ pos, text: node.text, attrs: mark.attrs });
            }
            return true;
          });
          return marks;
        }),
        json<CanonicalState>(
          await fetch(`${baseUrl}/api/agent/${encodeURIComponent(slug)}/state`, {
            headers: { 'x-share-token': created.proof.accessToken },
          }),
          'diagnostic state after browser B convergence timeout',
        ),
        collab.getLoadedCollabMarkdownFromFragment(slug).catch(() => null),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}`
        + `\nBrowser B suggestion marks:\n${JSON.stringify(browserBMarks, null, 2)}`
        + `\nCanonical state:\n${JSON.stringify(latestState, null, 2)}`
        + `\nDurable row:\n${JSON.stringify({ markdown: durableRow?.markdown, marks: durableRow?.marks, revision: durableRow?.revision, yStateVersion: durableRow?.y_state_version }, null, 2)}`
        + `\nLive fragment:\n${latestFragment ?? '(missing)'}`,
      );
    }

    const [finalTextA, finalTextB] = await Promise.all([
      pageA.locator('.ProseMirror').textContent(),
      pageB.locator('.ProseMirror').textContent(),
    ]);
    assert.equal(finalTextA, finalTextB, `Expected both browser processes to converge\nA: ${finalTextA}\nB: ${finalTextB}`);

    // Complete the human decision matrix: owner rejects their own suggestion,
    // editor accepts their own new suggestion, then editor rejects a new owner
    // suggestion. Together with the cross-user accept above this proves both
    // self and cross-user accept/reject paths across independent browsers.
    await decideSuggestion(pageA, 'editor 1 suggesting with two people in the doc.', 'Reject');
    await waitFor(async () => {
      const [a, b] = await Promise.all([
        pageA.locator('.ProseMirror').textContent(),
        pageB.locator('.ProseMirror').textContent(),
      ]);
      return !(a ?? '').includes('editor 1 suggesting with two people in the doc.')
        && !(b ?? '').includes('editor 1 suggesting with two people in the doc.');
    }, 25_000, 'owner self-reject to converge in both browsers');

    const editorSelfAcceptedText = 'editor 2 self acceptance works.';
    await setSuggesting(pageB, true);
    await typeAtEnd(pageB, `\n${editorSelfAcceptedText}`);
    try {
      await waitFor(
        async () => ((await pageA.locator('.ProseMirror').textContent()) ?? '').includes(editorSelfAcceptedText),
        20_000,
        'owner browser to receive editor self-accept candidate',
      );
    } catch (error) {
      const inspectBrowser = (page: Page) => page.evaluate(() => {
        const view = (window as unknown as { __editorView?: any }).__editorView;
        const yPlugin = view?.state?.plugins?.find((plugin: any) => String(plugin?.key ?? '').startsWith('y-sync$'));
        const ystate = yPlugin?.getState?.(view.state);
        return {
          text: document.querySelector('.ProseMirror')?.textContent ?? '',
          editable: view?.editable ?? null,
          contenteditable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
          yDocClientId: ystate?.doc?.clientID ?? null,
          bindingDocClientId: ystate?.binding?.doc?.clientID ?? null,
          bindingHasView: ystate?.binding?.prosemirrorView === view,
          fragment: ystate?.type?.toString?.() ?? null,
        };
      });
      const [browserAState, browserBState, fragment, diagnosticState] = await Promise.all([
        inspectBrowser(pageA),
        inspectBrowser(pageB),
        collab.getLoadedCollabMarkdownFromFragment(slug).catch(() => null),
        json<CanonicalState>(
          await fetch(`${baseUrl}/api/agent/${encodeURIComponent(slug)}/state`, {
            headers: { 'x-share-token': created.proof.accessToken },
          }),
          'diagnostic state after editor self-accept candidate timeout',
        ),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}`
        + `\nBrowser A:\n${JSON.stringify(browserAState, null, 2)}`
        + `\nBrowser B:\n${JSON.stringify(browserBState, null, 2)}`
        + `\nLive fragment:\n${fragment ?? '(missing)'}`
        + `\nCanonical state:\n${JSON.stringify(diagnosticState, null, 2)}`,
      );
    }
    await decideSuggestion(pageB, editorSelfAcceptedText, 'Accept');
    await waitFor(async () => {
      const [a, b] = await Promise.all([
        pageA.locator('.ProseMirror').textContent(),
        pageB.locator('.ProseMirror').textContent(),
      ]);
      return countOccurrences(a ?? '', editorSelfAcceptedText) === 1
        && countOccurrences(b ?? '', editorSelfAcceptedText) === 1;
    }, 25_000, 'editor self-accept to converge exactly once');
    await waitFor(async () => {
      const acceptedState = await json<CanonicalState>(
        await fetch(`${baseUrl}/api/agent/${encodeURIComponent(slug)}/state`, {
          headers: { 'x-share-token': created.proof.accessToken },
        }),
        'editor self-accept readiness state',
      );
      return !Object.values(acceptedState.marks ?? {}).some((mark) =>
        (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
        && (mark.status ?? 'pending') === 'pending'
        && JSON.stringify(mark).includes(editorSelfAcceptedText)
      );
    }, 25_000, 'editor self-accept to finalize canonically');
    await waitFor(async () => {
      const checks = await Promise.all([pageA, pageB].map((page) => page.evaluate((acceptedText) => {
        const view = (window as unknown as { __editorView?: any }).__editorView;
        if (!view) return false;
        let found = false;
        view.state.doc.descendants((node: any) => {
          for (const mark of node.marks ?? []) {
            if (mark.type?.name !== 'proofSuggestion') continue;
            if (String(mark.attrs?.content ?? '').includes(acceptedText)) found = true;
          }
          return !found;
        });
        return !found;
      }, editorSelfAcceptedText)));
      return checks.every(Boolean);
    }, 25_000, 'editor self-accept mark removal in both browsers');

    const ownerCrossRejectedText = 'owner cross rejection candidate.';
    await setSuggesting(pageA, true);
    await typeAtEnd(pageA, `\n${ownerCrossRejectedText}`);
    try {
      await waitFor(
        async () => ((await pageB.locator('.ProseMirror').textContent()) ?? '').includes(ownerCrossRejectedText),
        25_000,
        'editor browser to receive owner cross-reject candidate',
      );
    } catch (error) {
      const inspectBrowser = (page: Page) => page.evaluate(() => {
        const view = (window as unknown as { __editorView?: any }).__editorView;
        const yPlugin = view?.state?.plugins?.find((plugin: any) => String(plugin?.key ?? '').startsWith('y-sync$'));
        const ystate = yPlugin?.getState?.(view.state);
        return {
          text: document.querySelector('.ProseMirror')?.textContent ?? '',
          editable: view?.editable ?? null,
          yDocClientId: ystate?.doc?.clientID ?? null,
          bindingDocClientId: ystate?.binding?.doc?.clientID ?? null,
          bindingHasView: ystate?.binding?.prosemirrorView === view,
          localYFragment: ystate?.type?.toString?.() ?? null,
        };
      });
      const [browserAState, browserBState, fragment, diagnosticState] = await Promise.all([
        inspectBrowser(pageA),
        inspectBrowser(pageB),
        collab.getLoadedCollabMarkdownFromFragment(slug).catch(() => null),
        json<CanonicalState>(
          await fetch(`${baseUrl}/api/agent/${encodeURIComponent(slug)}/state`, {
            headers: { 'x-share-token': created.proof.accessToken },
          }),
          'cross-reject propagation diagnostic state',
        ).catch((stateError) => ({ error: stateError instanceof Error ? stateError.message : String(stateError) } as CanonicalState)),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}`
        + `\nBrowser A:\n${JSON.stringify(browserAState, null, 2)}`
        + `\nBrowser B:\n${JSON.stringify(browserBState, null, 2)}`
        + `\nLive fragment:\n${fragment ?? '(missing)'}`
        + `\nState:\n${JSON.stringify(diagnosticState, null, 2)}`,
      );
    }
    await decideSuggestion(pageB, ownerCrossRejectedText, 'Reject');
    await waitFor(async () => {
      const [a, b] = await Promise.all([
        pageA.locator('.ProseMirror').textContent(),
        pageB.locator('.ProseMirror').textContent(),
      ]);
      return !(a ?? '').includes(ownerCrossRejectedText) && !(b ?? '').includes(ownerCrossRejectedText);
    }, 25_000, 'editor cross-reject to converge in both browsers');

    const finalState = await json<CanonicalState>(
      await fetch(`${baseUrl}/api/agent/${encodeURIComponent(slug)}/state`, {
        headers: { 'x-share-token': created.proof.accessToken },
      }),
      'final decision-matrix state',
    );
    const remainingPendingSuggestions = Object.entries(finalState.marks ?? {}).filter(([, mark]) =>
      (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
      && (mark.status ?? 'pending') === 'pending'
    );
    assert.equal(
      remainingPendingSuggestions.length,
      0,
      `Expected the accept/reject decision matrix to leave no pending suggestions: ${JSON.stringify(finalState.marks, null, 2)}`,
    );
    const [matrixTextA, matrixTextB] = await Promise.all([
      pageA.locator('.ProseMirror').textContent(),
      pageB.locator('.ProseMirror').textContent(),
    ]);
    assert.equal(matrixTextA, matrixTextB, `Expected final decision matrix to converge\nA: ${matrixTextA}\nB: ${matrixTextB}`);
    assert(countOccurrences(matrixTextA ?? '', editorSelfAcceptedText) === 1, 'Expected self-accepted editor text exactly once');
    assert((matrixTextA ?? '').includes('Editor 2 direct text.'), 'Expected editor B direct text to remain after decisions');
    assert((matrixTextA ?? '').includes('second editor invited as an editor'), 'Expected cross-accepted editor text to remain');

    console.log('✓ Two independent browsers converge across direct edits and the full self/cross suggestion decision matrix');
  } finally {
    await Promise.all([browserA?.close(), browserB?.close()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('review-room-two-editor-empty-doc-fragment-drift failed');
    console.error(error);
    process.exit(1);
  });
