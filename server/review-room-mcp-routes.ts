import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { getDocumentBySlug, resolveDocumentAccessRole } from './db.js';
import { executeDocumentOperationAsync } from './document-engine.js';
import {
  executeHostedAgentOps,
  isHostedReviewRoomDbEnabled,
  resolveHostedDocumentAccessRole,
} from './hosted-review-room-db.js';
import { getEffectiveShareStateForRole } from './share-access.js';
import type { ShareRole } from './share-types.js';

type JsonRecord = Record<string, unknown>;
type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type ReviewRoomTool = {
  name: string;
  description: string;
  inputSchema: JsonRecord;
};

export const reviewRoomMcpRoutes = Router();

const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_SERVER_INSTRUCTIONS = [
  'Review Room is a human-controlled document review workspace.',
  'Read document state before writing.',
  'Use comments for questions, ambiguity, risks, and rationale.',
  'Use suggestions for proposed edits that humans should accept or reject.',
  'Do not accept, reject, or directly apply changes unless the user explicitly asks.',
  'Pass per-document share tokens in tool arguments or Authorization headers, and never echo tokens into document content.',
].join(' ');

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBearerToken(req: Request): string {
  const shareToken = req.header('x-share-token');
  if (shareToken && shareToken.trim()) return shareToken.trim();
  const authHeader = req.header('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function setMcpResponseHeaders(res: Response, sessionId?: string): void {
  res.setHeader('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
  res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, Mcp-Session-Id');
  if (sessionId) res.setHeader('Mcp-Session-Id', sessionId);
}

function jsonRpcResult(id: unknown, result: JsonRecord): JsonRecord {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string, data?: JsonRecord): JsonRecord {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

function toolContent(body: JsonRecord, isError = false): JsonRecord {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(body, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function objectSchema(properties: JsonRecord, required: string[]): JsonRecord {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

const baseAuthProperties = {
  slug: {
    type: 'string',
    description: 'Review Room document slug from /d/:slug.',
  },
  token: {
    type: 'string',
    description: 'Optional share token. You may also send Authorization: Bearer <token> or x-share-token.',
  },
};

const tools: ReviewRoomTool[] = [
  {
    name: 'review_room_get_state',
    description: 'Read a Review Room document, including markdown, marks, revision, and agent links.',
    inputSchema: objectSchema(baseAuthProperties, ['slug']),
  },
  {
    name: 'review_room_add_comment',
    description: 'Add an anchored human-review comment to a Review Room document.',
    inputSchema: objectSchema({
      ...baseAuthProperties,
      quote: { type: 'string', description: 'Exact visible text to anchor the comment to.' },
      text: { type: 'string', description: 'Comment body.' },
      by: { type: 'string', description: 'Actor id, usually ai:<agent-id>.' },
    }, ['slug', 'quote', 'text']),
  },
  {
    name: 'review_room_reply_comment',
    description: 'Reply to an existing Review Room comment thread.',
    inputSchema: objectSchema({
      ...baseAuthProperties,
      markId: { type: 'string', description: 'Comment mark id.' },
      text: { type: 'string', description: 'Reply body.' },
      by: { type: 'string', description: 'Actor id, usually ai:<agent-id>.' },
    }, ['slug', 'markId', 'text']),
  },
  {
    name: 'review_room_resolve_comment',
    description: 'Resolve an existing Review Room comment thread.',
    inputSchema: objectSchema({
      ...baseAuthProperties,
      markId: { type: 'string', description: 'Comment mark id.' },
      by: { type: 'string', description: 'Actor id resolving the comment.' },
    }, ['slug', 'markId']),
  },
  {
    name: 'review_room_add_suggestion',
    description: 'Add a pending suggestion that a human can accept or reject.',
    inputSchema: objectSchema({
      ...baseAuthProperties,
      kind: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      quote: { type: 'string', description: 'Exact visible text to anchor the suggestion to.' },
      content: { type: 'string', description: 'Replacement content, or inserted content for insert suggestions. Insert suggestions apply immediately after quote; include blank lines for Markdown block inserts. Omit for delete suggestions.' },
      by: { type: 'string', description: 'Actor id, usually ai:<agent-id>.' },
    }, ['slug', 'kind', 'quote']),
  },
  {
    name: 'review_room_accept_suggestion',
    description: 'Accept and apply a pending Review Room suggestion.',
    inputSchema: objectSchema({
      ...baseAuthProperties,
      markId: { type: 'string', description: 'Suggestion mark id.' },
      by: { type: 'string', description: 'Actor id accepting the suggestion.' },
    }, ['slug', 'markId']),
  },
  {
    name: 'review_room_reject_suggestion',
    description: 'Reject a pending Review Room suggestion without applying it.',
    inputSchema: objectSchema({
      ...baseAuthProperties,
      markId: { type: 'string', description: 'Suggestion mark id.' },
      by: { type: 'string', description: 'Actor id rejecting the suggestion.' },
    }, ['slug', 'markId']),
  },
];

async function resolveToolAuth(
  slug: string,
  token: string,
  allowedRoles: ShareRole[],
): Promise<{ ok: true; role: ShareRole } | { ok: false; status: number; body: JsonRecord }> {
  if (!slug) {
    return { ok: false, status: 400, body: { success: false, code: 'INVALID_REQUEST', error: 'Missing slug' } };
  }
  if (isHostedReviewRoomDbEnabled()) {
    const role = token ? await resolveHostedDocumentAccessRole(slug, token) : null;
    if (!role || !allowedRoles.includes(role)) {
      return { ok: false, status: 401, body: { success: false, code: 'UNAUTHORIZED', error: 'Missing or invalid share token' } };
    }
    return { ok: true, role };
  }

  const doc = getDocumentBySlug(slug);
  if (!doc) return { ok: false, status: 404, body: { success: false, error: 'Document not found' } };
  if (doc.share_state === 'DELETED') return { ok: false, status: 410, body: { success: false, error: 'Document deleted' } };

  const role = token ? resolveDocumentAccessRole(slug, token) : null;
  const effectiveShareState = getEffectiveShareStateForRole(doc, role, Boolean(token && role));
  if (effectiveShareState === 'REVOKED' && role !== 'owner_bot') {
    return { ok: false, status: 403, body: { success: false, error: 'Document access revoked' } };
  }
  if (effectiveShareState === 'PAUSED' && role !== 'owner_bot') {
    return { ok: false, status: 403, body: { success: false, error: 'Document is not currently accessible' } };
  }
  if (!role || !allowedRoles.includes(role)) {
    return { ok: false, status: 401, body: { success: false, code: 'UNAUTHORIZED', error: 'Missing or invalid share token' } };
  }
  return { ok: true, role };
}

function routeForSuggestionKind(kind: string): string | null {
  if (kind === 'replace') return '/marks/suggest-replace';
  if (kind === 'insert') return '/marks/suggest-insert';
  if (kind === 'delete') return '/marks/suggest-delete';
  return null;
}

async function executeReviewRoomTool(req: Request, name: string, args: JsonRecord): Promise<{ status: number; body: JsonRecord }> {
  const slug = readString(args.slug);
  const token = readString(args.token) || readBearerToken(req);
  const by = readString(args.by) || 'ai:review-room-mcp';

  if (name === 'review_room_get_state') {
    const auth = await resolveToolAuth(slug, token, ['viewer', 'commenter', 'editor', 'owner_bot']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    return executeDocumentOperationAsync(slug, 'GET', '/state');
  }

  if (name === 'review_room_add_comment') {
    const auth = await resolveToolAuth(slug, token, ['commenter', 'editor', 'owner_bot']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    return executeDocumentOperationAsync(slug, 'POST', '/marks/comment', {
      by,
      quote: readString(args.quote),
      text: readString(args.text),
    });
  }

  if (name === 'review_room_reply_comment') {
    const auth = await resolveToolAuth(slug, token, ['commenter', 'editor', 'owner_bot']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    return executeDocumentOperationAsync(slug, 'POST', '/marks/reply', {
      markId: readString(args.markId),
      text: readString(args.text),
      by,
    });
  }

  if (name === 'review_room_resolve_comment') {
    const auth = await resolveToolAuth(slug, token, ['commenter', 'editor', 'owner_bot']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    return executeDocumentOperationAsync(slug, 'POST', '/marks/resolve', {
      markId: readString(args.markId),
      by,
    });
  }

  if (name === 'review_room_add_suggestion') {
    const auth = await resolveToolAuth(slug, token, ['editor', 'owner_bot']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const kind = readString(args.kind);
    const route = routeForSuggestionKind(kind);
    if (!route) {
      return { status: 400, body: { success: false, code: 'INVALID_KIND', error: 'kind must be replace, insert, or delete' } };
    }
    const payload = {
      by,
      quote: readString(args.quote),
      ...(kind !== 'delete' ? { content: typeof args.content === 'string' ? args.content : '' } : {}),
    };
    if (isHostedReviewRoomDbEnabled()) {
      return executeHostedAgentOps(slug, { type: 'suggestion.add', kind, ...payload });
    }
    return executeDocumentOperationAsync(slug, 'POST', route, payload);
  }

  if (name === 'review_room_accept_suggestion' || name === 'review_room_reject_suggestion') {
    const auth = await resolveToolAuth(slug, token, ['editor', 'owner_bot']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const route = name === 'review_room_accept_suggestion' ? '/marks/accept' : '/marks/reject';
    return executeDocumentOperationAsync(slug, 'POST', route, {
      markId: readString(args.markId),
      by,
    });
  }

  return { status: 404, body: { success: false, code: 'UNKNOWN_TOOL', error: `Unknown Review Room MCP tool: ${name}` } };
}

reviewRoomMcpRoutes.get('/mcp', (_req: Request, res: Response) => {
  setMcpResponseHeaders(res);
  res.json({
    name: 'review-room-mcp',
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: 'streamable-http',
    tools: tools.map(({ name, description }) => ({ name, description })),
  });
});

reviewRoomMcpRoutes.post('/mcp', async (req: Request, res: Response) => {
  setMcpResponseHeaders(res);
  const request = isRecord(req.body) ? req.body as JsonRpcRequest : {};
  const id = hasOwn(request, 'id') ? request.id : null;
  const method = readString(request.method);

  if (!method) {
    res.status(400).json(jsonRpcError(id, -32600, 'Invalid JSON-RPC request'));
    return;
  }

  if (!hasOwn(request, 'id')) {
    res.status(204).end();
    return;
  }

  if (method === 'initialize') {
    setMcpResponseHeaders(res, randomUUID());
    res.json(jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'review-room-mcp', version: '0.1.0' },
      instructions: MCP_SERVER_INSTRUCTIONS,
    }));
    return;
  }

  if (method === 'tools/list') {
    res.json(jsonRpcResult(id, { tools }));
    return;
  }

  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : {};
    const name = readString(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (!name) {
      res.json(jsonRpcError(id, -32602, 'tools/call requires params.name'));
      return;
    }
    const result = await executeReviewRoomTool(req, name, args);
    res.status(result.status >= 500 ? 500 : 200).json(jsonRpcResult(id, toolContent(result.body, result.status >= 400)));
    return;
  }

  res.json(jsonRpcError(id, -32601, `Unsupported MCP method: ${method}`));
});
