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

type McpResponse = {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    instructions?: string;
  };
  error?: { message?: string };
};

async function mcpResponse(base: string, body: Record<string, unknown>, token?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2024-11-05',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), ...body }),
  });
}

async function mcp(base: string, body: Record<string, unknown>, token?: string): Promise<McpResponse> {
  return json<McpResponse>(await mcpResponse(base, body, token));
}

function parseToolBody(response: McpResponse): Record<string, unknown> {
  assert(!response.error, response.error?.message || 'Unexpected MCP error');
  const text = response.result?.content?.[0]?.text;
  assert(typeof text === 'string', 'Expected MCP tool text content');
  return JSON.parse(text) as Record<string, unknown>;
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-mcp-${Date.now()}-${randomUUID()}.db`);
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = '';
  process.env.PROOF_TRUST_PROXY_HEADERS = '1';

  const { createReviewRoomExpressApp } = await import('../../server/index.js');
  const app = createReviewRoomExpressApp();
  const port = await getFreePort();
  const server = app.listen(port, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  try {
    const discovery = await json<{
      mcp_url?: string;
      capabilities?: string[];
      mcp?: { tools?: string[] };
    }>(await fetch(`${base}/.well-known/agent.json`));
    assert(discovery.mcp_url === `${base}/mcp`, 'Expected discovery to advertise absolute MCP URL');
    assert(discovery.capabilities?.includes('mcp') === true, 'Expected discovery capabilities to include mcp');
    assert(discovery.mcp?.tools?.includes('review_room_add_suggestion') === true, 'Expected discovery to list Review Room MCP tools');
    assert(discovery.mcp?.tools?.includes('review_room_reply_comment') === true, 'Expected discovery to list MCP comment reply tool');

    const forwardedDiscovery = await json<{ mcp_url?: string; docs_url?: string }>(await fetch(`${base}/.well-known/agent.json`, {
      headers: {
        'x-forwarded-proto': 'http',
        'x-forwarded-host': 'review-room.chrisjbell.dev',
      },
    }));
    assert(
      forwardedDiscovery.mcp_url === 'https://review-room.chrisjbell.dev/mcp',
      `Expected production discovery MCP URL to use https, got ${String(forwardedDiscovery.mcp_url)}`,
    );
    assert(
      forwardedDiscovery.docs_url === 'https://review-room.chrisjbell.dev/agent-docs',
      `Expected production docs URL to use https, got ${String(forwardedDiscovery.docs_url)}`,
    );

    const htmlDocs = await fetch(`${base}/agent-docs`, {
      headers: {
        Accept: 'text/html',
        'x-forwarded-proto': 'http',
        'x-forwarded-host': 'review-room.chrisjbell.dev',
      },
    });
    const htmlDocsText = await htmlDocs.text();
    assert(htmlDocs.status === 200 && htmlDocs.headers.get('content-type')?.includes('text/html'), 'Expected HTML agent docs for browser Accept');
    assert(htmlDocsText.includes('Copy MCP URL'), 'Expected HTML docs to include Copy MCP URL button');
    assert(htmlDocsText.includes('https://review-room.chrisjbell.dev/mcp'), 'Expected HTML docs to show HTTPS MCP URL');
    assert(htmlDocsText.includes('/review-room/claude-plugin.zip'), 'Expected HTML docs to link the Claude plugin download');

    const markdownDocs = await fetch(`${base}/agent-docs`, { headers: { Accept: 'text/markdown' } });
    const markdownDocsText = await markdownDocs.text();
    assert(markdownDocs.status === 200 && markdownDocs.headers.get('content-type')?.includes('text/markdown'), 'Expected Markdown agent docs for Markdown Accept');
    assert(markdownDocsText.includes('ChatGPT, Codex, And Claude MCP Setup'), 'Expected Markdown docs to include ChatGPT/Codex/Claude setup');

    const markdownFormatDocs = await fetch(`${base}/agent-docs?format=markdown`, { headers: { Accept: 'text/html' } });
    assert(
      markdownFormatDocs.status === 200 && markdownFormatDocs.headers.get('content-type')?.includes('text/markdown'),
      'Expected ?format=markdown to force Markdown agent docs',
    );

    const created = await json<{
      success: boolean;
      document: { proofSlug: string; historyPath?: string };
      proof: { accessToken: string };
    }>(await fetch(`${base}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'MCP Review Room test',
        markdown: '# MCP Review Room test\n\nOriginal paragraph.',
      }),
    }));
    assert(created.success === true, 'Expected Review Room document creation success');
    const slug = created.document.proofSlug;
    const token = created.proof.accessToken;

    const initializedResponse = await mcpResponse(base, {
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    assert(initializedResponse.status === 200, `Expected streamable HTTP initialize status 200, got ${initializedResponse.status}`);
    assert(
      initializedResponse.headers.get('content-type')?.includes('application/json') === true,
      `Expected initialize JSON response, got ${initializedResponse.headers.get('content-type')}`,
    );
    assert(
      initializedResponse.headers.get('mcp-protocol-version') === '2024-11-05',
      `Expected MCP protocol response header, got ${String(initializedResponse.headers.get('mcp-protocol-version'))}`,
    );
    const sessionId = initializedResponse.headers.get('mcp-session-id');
    assert(typeof sessionId === 'string' && sessionId.length > 0, 'Expected initialize to return Mcp-Session-Id');
    const initialized = await json<McpResponse>(initializedResponse);
    assert(!initialized.error, initialized.error?.message || 'Expected MCP initialize success');
    assert(
      String(initialized.result?.instructions || '').includes('human-controlled document review workspace'),
      'Expected MCP initialize to include Review Room server instructions',
    );

    const initializedNotification = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId,
        'MCP-Protocol-Version': '2024-11-05',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert(initializedNotification.status === 204, `Expected initialized notification 204, got ${initializedNotification.status}`);

    const listed = await json<McpResponse>(await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId,
        'MCP-Protocol-Version': '2024-11-05',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' }),
    }));
    assert(
      listed.result?.tools?.some((tool) => tool.name === 'review_room_get_state') === true,
      'Expected MCP tools/list to include review_room_get_state',
    );

    const state = parseToolBody(await mcp(base, {
      method: 'tools/call',
      params: {
        name: 'review_room_get_state',
        arguments: { slug },
      },
    }, token));
    assert(String(state.markdown).includes('Original paragraph.'), 'Expected MCP state tool to read markdown');

    const argTokenState = parseToolBody(await mcp(base, {
      method: 'tools/call',
      params: {
        name: 'review_room_get_state',
        arguments: { slug, token },
      },
    }));
    assert(String(argTokenState.markdown).includes('Original paragraph.'), 'Expected MCP state tool to accept token argument auth');

    const suggestion = parseToolBody(await mcp(base, {
      method: 'tools/call',
      params: {
        name: 'review_room_add_suggestion',
        arguments: {
          slug,
          kind: 'replace',
          quote: 'Original paragraph.',
          content: 'Original paragraph revised through MCP.',
          by: 'ai:mcp-test',
        },
      },
    }, token));
    assert(suggestion.success === true && typeof suggestion.markId === 'string', 'Expected MCP suggestion tool to create a mark');

    const siblingSuggestion = parseToolBody(await mcp(base, {
      method: 'tools/call',
      params: {
        name: 'review_room_add_suggestion',
        arguments: {
          slug,
          kind: 'insert',
          quote: 'MCP Review Room test',
          content: ' accepted-one-keeps-siblings',
          by: 'ai:mcp-test',
        },
      },
    }, token));
    assert(
      siblingSuggestion.success === true && typeof siblingSuggestion.markId === 'string',
      'Expected MCP to create a second pending suggestion',
    );

    const accepted = parseToolBody(await mcp(base, {
      method: 'tools/call',
      params: {
        name: 'review_room_accept_suggestion',
        arguments: {
          slug,
          markId: suggestion.markId,
          by: 'human:mcp-reviewer',
        },
      },
    }, token));
    assert(
      accepted.success === true && String(accepted.markdown).includes('Original paragraph revised through MCP.'),
      'Expected MCP accept tool to apply the suggestion',
    );
    const stateAfterSingleAccept = parseToolBody(await mcp(base, {
      method: 'tools/call',
      params: {
        name: 'review_room_get_state',
        arguments: { slug },
      },
    }, token));
    const marksAfterSingleAccept = stateAfterSingleAccept.marks && typeof stateAfterSingleAccept.marks === 'object' && !Array.isArray(stateAfterSingleAccept.marks)
      ? stateAfterSingleAccept.marks as Record<string, { kind?: string; status?: string }>
      : {};
    assert(
      marksAfterSingleAccept[String(siblingSuggestion.markId)]?.status === 'pending',
      'Accepting one suggestion must leave sibling suggestions pending',
    );
    const historyAfterMcpAccept = await json<{
      success: boolean;
      events: Array<{
        eventType?: string;
        targetType?: string;
        targetId?: string;
        actorId?: string;
        before?: { status?: string; beforeContent?: string };
        after?: { status?: string; afterContent?: string };
      }>;
    }>(await fetch(`${base}${created.document.historyPath ?? `/review-room/api/documents/${slug}/history`}`));
    assert(
      historyAfterMcpAccept.events.some((event) => (
        event.eventType === 'suggestion.accepted'
        && event.targetType === 'suggestion'
        && event.targetId === suggestion.markId
        && event.actorId === 'human:mcp-reviewer'
        && event.before?.status === 'pending'
        && event.before.beforeContent === 'Original paragraph.'
        && event.after?.status === 'accepted'
        && event.after.afterContent === 'Original paragraph revised through MCP.'
      )),
      'Expected MCP suggestion acceptance to appear in Review Room history',
    );

    const comment = parseToolBody(await mcp(base, {
      method: 'tools/call',
      params: {
        name: 'review_room_add_comment',
        arguments: {
          slug,
          quote: 'Original paragraph revised through MCP.',
          text: 'Comment added through MCP.',
          by: 'ai:mcp-test',
        },
      },
    }, token));
    assert(comment.success === true && typeof comment.markId === 'string', 'Expected MCP comment tool to create a mark');

    const reply = parseToolBody(await mcp(base, {
      method: 'tools/call',
      params: {
        name: 'review_room_reply_comment',
        arguments: {
          slug,
          token,
          markId: comment.markId,
          text: 'Reply added through MCP token argument.',
          by: 'ai:mcp-test',
        },
      },
    }));
    assert(reply.success === true, 'Expected MCP reply tool to append a comment reply');
    const replyMarks = reply.marks as Record<string, { replies?: Array<{ text?: string }> }>;
    assert(
      replyMarks?.[String(comment.markId)]?.replies?.some((item) => item.text === 'Reply added through MCP token argument.') === true,
      'Expected MCP reply to be visible on the comment mark',
    );

    const resolved = parseToolBody(await mcp(base, {
      method: 'tools/call',
      params: {
        name: 'review_room_resolve_comment',
        arguments: {
          slug,
          markId: comment.markId,
          by: 'human:mcp-reviewer',
        },
      },
    }, token));
    assert(resolved.success === true, 'Expected MCP resolve tool to resolve the comment');
    const resolvedMarks = resolved.marks as Record<string, { resolved?: boolean }>;
    assert(resolvedMarks?.[String(comment.markId)]?.resolved === true, 'Expected MCP-resolved comment mark');

    console.log('✓ Review Room MCP route');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { unlinkSync(dbPath); } catch { /* ignore */ }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
