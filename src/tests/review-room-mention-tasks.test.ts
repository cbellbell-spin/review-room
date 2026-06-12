import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

type McpResponse = {
  result?: {
    content?: Array<{ type: string; text: string }>;
  };
  error?: { message?: string };
};

async function mcp(base: string, body: Record<string, unknown>, token?: string): Promise<McpResponse> {
  return json<McpResponse>(await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2024-11-05',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), ...body }),
  }));
}

function parseToolBody(response: McpResponse): Record<string, unknown> {
  assert(!response.error, response.error?.message || 'Unexpected MCP error');
  const text = response.result?.content?.[0]?.text;
  assert(typeof text === 'string', 'Expected MCP tool text content');
  return JSON.parse(text) as Record<string, unknown>;
}

async function addComment(base: string, slug: string, token: string, text: string, by = 'ai:codex-test'): Promise<Record<string, unknown>> {
  return parseToolBody(await mcp(base, {
    method: 'tools/call',
    params: {
      name: 'review_room_add_comment',
      arguments: {
        slug,
        quote: 'Original paragraph.',
        text,
        by,
      },
    },
  }, token));
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-mention-tasks-${Date.now()}-${randomUUID()}.db`);
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = '';
  process.env.PROOF_TRUST_PROXY_HEADERS = '1';

  const { createReviewRoomExpressApp } = await import('../../server/index.js');
  const app = createReviewRoomExpressApp();
  const port = await getFreePort();
  const server = app.listen(port, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  try {
    const created = await json<{
      success: boolean;
      document: { proofSlug: string; historyPath?: string };
      proof: { accessToken: string };
    }>(await fetch(`${base}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Mention task test',
        markdown: '# Mention task test\n\nOriginal paragraph.',
      }),
    }));
    assert(created.success === true, 'Expected document creation success');
    const slug = created.document.proofSlug;
    const token = created.proof.accessToken;

    const comment = await addComment(base, slug, token, 'Please @Review agent check this paragraph.');
    assert(comment.success === true && typeof comment.markId === 'string', 'Expected comment with mention to be created');

    const tasksAfterMention = await json<{
      success: boolean;
      tasks: Array<{
        id: string;
        status: string;
        sourceId?: string;
        assignedToActorId?: string;
        assignedToActorType?: string;
        assignedToLabel?: string;
        sourceText?: string;
      }>;
    }>(await fetch(`${base}/review-room/api/documents/${slug}/tasks?status=all`));
    assert(tasksAfterMention.success === true, 'Expected task list success');
    assert(tasksAfterMention.tasks.length === 1, `Expected one task after @Review agent mention, got ${tasksAfterMention.tasks.length}`);
    const task = tasksAfterMention.tasks[0];
    assert(task.status === 'open', 'Expected new assignment task to be open');
    assert(task.sourceId === comment.markId, 'Expected task to point at the comment mark');
    assert(task.assignedToActorId === 'agent-reviewer', 'Expected task to be assigned to the seeded review agent');
    assert(task.assignedToActorType === 'agent', 'Expected seeded review agent assignment type');
    assert(task.sourceText?.includes('@Review agent') === true, 'Expected task source excerpt to include the mention text');

    await addComment(base, slug, token, 'Please @UnknownReviewer check this too.');
    const tasksAfterUnknown = await json<{ tasks: unknown[] }>(await fetch(`${base}/review-room/api/documents/${slug}/tasks?status=all`));
    assert(tasksAfterUnknown.tasks.length === 1, 'Expected unknown mentions not to create assignment tasks');

    await addComment(base, slug, token, 'Self check for @Review agent.', 'ai:Review agent');
    const tasksAfterSelf = await json<{ tasks: unknown[] }>(await fetch(`${base}/review-room/api/documents/${slug}/tasks?status=all`));
    assert(tasksAfterSelf.tasks.length === 1, 'Expected self-mentions not to create assignment tasks');

    const completed = await json<{
      success: boolean;
      task: { id: string; status: string; completedAt?: string | null };
    }>(await fetch(`${base}/review-room/api/documents/${slug}/tasks/${task.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    }));
    assert(completed.success === true, 'Expected task completion success');
    assert(completed.task.status === 'completed', 'Expected task to be completed');
    assert(typeof completed.task.completedAt === 'string' && completed.task.completedAt.length > 0, 'Expected completed task to stamp completedAt');

    const secondComment = await addComment(base, slug, token, 'One more for @agent-reviewer.');
    const tasksAfterSecondMention = await json<{ tasks: Array<{ id: string; status: string; sourceId?: string }> }>(
      await fetch(`${base}/review-room/api/documents/${slug}/tasks?status=all`),
    );
    const secondTask = tasksAfterSecondMention.tasks.find((candidate) => candidate.sourceId === secondComment.markId);
    assert(secondTask?.status === 'open', 'Expected id alias mention to create a second open task');
    const secondTaskId = secondTask.id;

    const dismissed = await json<{ success: boolean; task: { status: string; completedAt?: string | null } }>(
      await fetch(`${base}/review-room/api/documents/${slug}/tasks/${secondTaskId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed' }),
      }),
    );
    assert(dismissed.success === true, 'Expected task dismissal success');
    assert(dismissed.task.status === 'dismissed', 'Expected second task to be dismissed');
    assert(dismissed.task.completedAt === null, 'Expected dismissed task not to stamp completedAt');

    const history = await json<{
      success: boolean;
      events: Array<{
        eventType?: string;
        targetType?: string;
        targetId?: string;
        before?: { status?: string };
        after?: { status?: string; assignedToActorId?: string };
      }>;
    }>(await fetch(`${base}${created.document.historyPath ?? `/review-room/api/documents/${slug}/history`}`));
    assert(history.success === true, 'Expected history list success');
    assert(
      history.events.some((event) => (
        event.eventType === 'task.created'
        && event.targetType === 'assignment_task'
        && event.after?.assignedToActorId === 'agent-reviewer'
      )),
      'Expected task.created history event',
    );
    assert(
      history.events.some((event) => (
        event.eventType === 'task.status_changed'
        && event.targetId === task.id
        && event.before?.status === 'open'
        && event.after?.status === 'completed'
      )),
      'Expected completed status change history event',
    );
    assert(
      history.events.some((event) => (
        event.eventType === 'task.status_changed'
        && event.targetId === secondTaskId
        && event.before?.status === 'open'
        && event.after?.status === 'dismissed'
      )),
      'Expected dismissed status change history event',
    );

    console.log('✓ Review Room mention-to-task wiring');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
