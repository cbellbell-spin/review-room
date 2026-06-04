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
  };
  error?: { message?: string };
};

async function mcp(base: string, body: Record<string, unknown>, token?: string): Promise<McpResponse> {
  return json<McpResponse>(await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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

    const created = await json<{
      success: boolean;
      document: { proofSlug: string };
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

    const initialized = await mcp(base, {
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    assert(!initialized.error, initialized.error?.message || 'Expected MCP initialize success');

    const listed = await mcp(base, { method: 'tools/list' });
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
