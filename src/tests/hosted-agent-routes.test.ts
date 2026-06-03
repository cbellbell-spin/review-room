import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `hosted-agent-routes-${Date.now()}-${randomUUID()}.db`);
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = '';
  process.env.PROOF_TRUST_PROXY_HEADERS = '1';

  const { createReviewRoomExpressApp } = await import('../../server/index.js');
  const app = createReviewRoomExpressApp();
  const port = await getFreePort();
  const server = app.listen(port, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  try {
    const neutralCreated = await json<{
      success: boolean;
      slug: string;
      accessToken: string;
      agent?: { editingGuidance?: { proposedEdits?: string; directApply?: string } };
      _links?: {
        bridge?: {
          suggestion?: { href?: string; useFor?: string };
          rewrite?: { href?: string; directApply?: boolean; warning?: string };
        };
      };
    }>(await fetch(`${base}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Hosted neutral create test',
        markdown: '# Hosted neutral doc\n\nOriginal paragraph.',
      }),
    }));
    assert(neutralCreated.success === true, 'Expected hosted neutral create success');
    assert(typeof neutralCreated.slug === 'string' && neutralCreated.slug.length > 0, 'Expected hosted neutral create slug');
    assert(typeof neutralCreated.accessToken === 'string' && neutralCreated.accessToken.length > 0, 'Expected hosted neutral create access token');
    assert(
      neutralCreated._links?.bridge?.suggestion?.useFor?.includes('reviewable')
        && neutralCreated._links?.bridge?.rewrite?.directApply === true,
      'Expected hosted neutral create links to distinguish suggestions from direct rewrites',
    );
    assert(
      typeof neutralCreated.agent?.editingGuidance?.proposedEdits === 'string'
        && neutralCreated.agent.editingGuidance.proposedEdits.includes('suggestion.add'),
      'Expected hosted neutral create agent descriptor to guide proposed edits toward suggestions',
    );
    const neutralState = await json<{ markdown: string; agent?: { getActionApi?: string }; _links?: { getAction?: { requiresConfirm?: boolean } } }>(
      await fetch(`${base}/api/agent/${neutralCreated.slug}/state`, {
        headers: { 'x-share-token': neutralCreated.accessToken },
      }),
    );
    assert(neutralState.markdown.includes('Hosted neutral doc'), 'Expected hosted neutral create state to use hosted persistence');
    assert(
      neutralState.agent?.getActionApi === `/api/agent/${neutralCreated.slug}/action`
        && neutralState._links?.getAction?.requiresConfirm === true,
      'Expected hosted state to advertise GET-only action fallback',
    );
    const getActionParams = new URLSearchParams({
      token: neutralCreated.accessToken,
      type: 'suggestion.add',
      kind: 'replace',
      quote: 'Original paragraph.',
      content: 'Original paragraph, revised by GET-only fallback.',
      by: 'ai:get-only-test',
    });
    const getActionPreview = await json<{
      success: boolean;
      code?: string;
      execute?: { method?: string; href?: string };
    }>(
      await fetch(`${base}/api/agent/${neutralCreated.slug}/action?${getActionParams.toString()}`),
    );
    assert(
      getActionPreview.success === false
        && getActionPreview.code === 'CONFIRM_REQUIRED'
        && getActionPreview.execute?.method === 'GET'
        && typeof getActionPreview.execute.href === 'string'
        && getActionPreview.execute.href.includes('confirm=1'),
      'Expected GET-only action preview to require confirmation and return execute URL',
    );
    const getActionExecuted = await json<{ success: boolean; markId?: string; getOnlyAction?: boolean }>(
      await fetch(`${base}${getActionPreview.execute!.href}`),
    );
    assert(
      getActionExecuted.success === true
        && typeof getActionExecuted.markId === 'string'
        && getActionExecuted.getOnlyAction === true,
      'Expected confirmed GET-only action to create a pending suggestion',
    );
    const afterGetActionState = await json<{ marks?: Record<string, { kind?: string; status?: string; content?: string }> }>(
      await fetch(`${base}/api/agent/${neutralCreated.slug}/state`, {
        headers: { 'x-share-token': neutralCreated.accessToken },
      }),
    );
    const getActionMark = getActionExecuted.markId ? afterGetActionState.marks?.[getActionExecuted.markId] : null;
    assert(
      getActionMark?.kind === 'suggestion'
        && getActionMark.status === 'pending'
        && getActionMark.content === 'Original paragraph, revised by GET-only fallback.',
      'Expected GET-only action suggestion mark to be visible in hosted state',
    );
    const neutralDeleted = await json<{ success: boolean; shareState: string }>(
      await fetch(`${base}/documents/${neutralCreated.slug}`, {
        method: 'DELETE',
        headers: { 'x-share-token': neutralCreated.accessToken },
      }),
    );
    assert(neutralDeleted.success === true && neutralDeleted.shareState === 'DELETED', 'Expected hosted neutral create cleanup');

    const created = await json<{
      proof: { slug: string; accessToken: string };
    }>(await fetch(`${base}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Hosted agent route test',
        markdown: '# Hosted doc\n\nOriginal paragraph.',
      }),
    }));
    const { slug, accessToken } = created.proof;
    const authHeaders = {
      'Content-Type': 'application/json',
      'x-share-token': accessToken,
      'X-Agent-Id': 'hosted-route-test',
    };

    const state = await json<{ success: boolean; revision: number; markdown: string }>(
      await fetch(`${base}/api/agent/${slug}/state`, { headers: authHeaders }),
    );
    assert(state.success === true, 'Expected hosted state success');
    assert(state.markdown.includes('Original paragraph.'), 'Expected state markdown');

    const snapshot = await json<{ success: boolean; revision: number; blocks: Array<{ ref: string; markdown: string }> }>(
      await fetch(`${base}/api/agent/${slug}/snapshot`, { headers: authHeaders }),
    );
    assert(snapshot.success === true, 'Expected hosted snapshot success');
    assert(snapshot.blocks.length >= 2, 'Expected hosted snapshot blocks');

    const edited = await json<{ success: boolean; snapshot: { blocks: Array<{ markdown: string }> } }>(
      await fetch(`${base}/api/agent/${slug}/edit/v2`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          by: 'ai:hosted-route-test',
          baseRevision: snapshot.revision,
          operations: [
            { op: 'insert_after', ref: 'b1', blocks: [{ markdown: 'Inserted by hosted edit/v2.' }] },
          ],
        }),
      }),
    );
    assert(edited.success === true, 'Expected hosted edit/v2 success');
    assert(
      edited.snapshot.blocks.some((block) => block.markdown.includes('Inserted by hosted edit/v2.')),
      'Expected hosted edit/v2 content in snapshot',
    );

    const comment = await json<{ success: boolean; markId?: string }>(
      await fetch(`${base}/api/agent/${slug}/ops`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          type: 'comment.add',
          by: 'ai:hosted-route-test',
          quote: 'Original paragraph.',
          text: 'Hosted comment works.',
        }),
      }),
    );
    assert(comment.success === true && typeof comment.markId === 'string', 'Expected hosted comment mark');

    const bridgeHeaders = {
      'Content-Type': 'application/json',
      'x-share-token': accessToken,
      'X-Agent-Id': 'hosted-bridge-test',
    };
    const bridgeCommentResponse = await fetch(`${base}/documents/${slug}/bridge/comments`, {
      method: 'POST',
      headers: bridgeHeaders,
      body: JSON.stringify({
        by: 'ai:hosted-bridge-test',
        quote: 'Original paragraph.',
        text: 'Hosted bridge comment works without Proof client headers.',
      }),
    });
    const bridgeComment = await json<{ success: boolean; markId?: string }>(bridgeCommentResponse);
    assert(bridgeComment.success === true && typeof bridgeComment.markId === 'string', 'Expected hosted bridge comment mark');

    const bridgeRewriteResponse = await fetch(`${base}/documents/${slug}/bridge/rewrite`, {
      method: 'POST',
      headers: bridgeHeaders,
      body: JSON.stringify({
        by: 'ai:hosted-bridge-test',
        content: '# Hosted doc\n\nRewritten through hosted bridge.',
      }),
    });
    const bridgeRewrite = await json<{
      success: boolean;
      revision: number;
      directApply?: boolean;
      proposedEdits?: boolean;
      reviewableAlternative?: { type?: string; bridgeEndpoint?: string };
    }>(bridgeRewriteResponse);
    assert(bridgeRewrite.success === true, 'Expected hosted bridge rewrite success');
    assert(bridgeRewrite.directApply === true, 'Expected hosted bridge rewrite to identify direct apply semantics');
    assert(bridgeRewrite.proposedEdits === false, 'Expected hosted bridge rewrite to distinguish itself from proposed edits');
    assert(
      bridgeRewrite.reviewableAlternative?.type === 'suggestion.add'
        && typeof bridgeRewrite.reviewableAlternative.bridgeEndpoint === 'string'
        && bridgeRewrite.reviewableAlternative.bridgeEndpoint.includes('/bridge/suggestions'),
      'Expected hosted bridge rewrite to point agents at reviewable suggestions',
    );

    const bridgeState = await json<{ markdown: string }>(
      await fetch(`${base}/api/agent/${slug}/state`, { headers: authHeaders }),
    );
    assert(bridgeState.markdown.includes('Rewritten through hosted bridge.'), 'Expected hosted bridge rewrite content');

    const events = await json<{ success: boolean; events: Array<{ type: string; data?: Record<string, unknown> }> }>(
      await fetch(`${base}/api/agent/${slug}/events/pending?after=0&limit=100`, { headers: authHeaders }),
    );
    assert(events.success === true, 'Expected hosted pending events success');
    assert(events.events.some((event) => event.type === 'document.updated'), 'Expected hosted document.updated event');
    assert(
      events.events.some((event) => event.type === 'document.updated' && event.data?.directApply === true),
      'Expected hosted document.updated event to identify agent direct apply semantics',
    );
    assert(events.events.some((event) => event.type === 'comment.added'), 'Expected hosted comment.added event');

    const rewritten = await json<{ success: boolean; revision: number }>(
      await fetch(`${base}/documents/${slug}/ops`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          type: 'rewrite.apply',
          by: 'ai:hosted-route-test',
          content: '# Hosted doc\n\nRewritten through canonical alias.',
        }),
      }),
    );
    assert(rewritten.success === true, 'Expected hosted canonical rewrite success');

    const finalState = await json<{ markdown: string }>(
      await fetch(`${base}/api/agent/${slug}/state`, { headers: authHeaders }),
    );
    assert(finalState.markdown.includes('Rewritten through canonical alias.'), 'Expected final hosted rewrite content');
    const deleted = await json<{ success: boolean; shareState: string }>(
      await fetch(`${base}/documents/${slug}`, {
        method: 'DELETE',
        headers: authHeaders,
      }),
    );
    assert(deleted.success === true && deleted.shareState === 'DELETED', 'Expected hosted delete success');

    const deletedState = await fetch(`${base}/api/agent/${slug}/state`, { headers: authHeaders });
    assert(deletedState.status === 404 || deletedState.status === 410, `Expected deleted hosted doc to be unavailable, got ${deletedState.status}`);
    console.log('✓ hosted agent routes support state, snapshot, edit/v2, ops, canonical ops, and delete');
  } finally {
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
