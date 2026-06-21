import { createHash, randomBytes, randomUUID } from 'crypto';
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
import { safeCreateAssignmentTasksFromCommentMentions } from './mention-tasks.js';
import {
  storeClaimAgentReviewRun,
  storeCompleteAgentReviewRun,
  storeCountAgentReviewOutputs,
  storeCreateReviewRoomHistoryEvent,
  storeExpireAgentReviewRunLeases,
  storeFailAgentReviewRun,
  storeGetAgentReviewRun,
  storeGetReviewRoomDocumentByProofSlug,
  storeHeartbeatAgentReviewRun,
  storeListAgentReviewRuns,
  storeReleaseAgentReviewRun,
  storeReserveAgentReviewOutput,
  storeResolveReviewRoomAgentCredential,
  storeTouchReviewRoomAgentCredential,
  storeUpsertAgentReviewOutput,
  type ReviewRoomAgentReviewRun,
} from './review-room-store.js';

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

type ReviewRoomToolRole = ShareRole | 'agent';
type ReviewRoomToolAuth = {
  ok: true;
  role: ReviewRoomToolRole;
  agentId?: string;
  reviewRequestId?: string;
  credentialId?: string;
};

export const reviewRoomMcpRoutes = Router();

const MCP_PROTOCOL_VERSION = '2024-11-05';
const REVIEW_REQUEST_LEASE_MS = 60_000;
const MCP_SERVER_INSTRUCTIONS = [
  'Review Room is a human-controlled document review workspace.',
  'Read document state before writing.',
  'Use comments for questions, ambiguity, risks, and rationale.',
  'Use suggestions for proposed edits that humans should accept or reject.',
  'Do not accept, reject, or directly apply changes unless the user explicitly asks.',
  'Pass per-document share tokens in tool arguments or Authorization headers, and never echo tokens into document content.',
  'Review Room never runs a model or stores provider credentials. External agents claim queued review requests and use their own model environment.',
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
    description: 'Optional document share token or request-scoped agent token. You may also send Authorization: Bearer <token> or x-share-token.',
  },
};

const claimProperties = {
  ...baseAuthProperties,
  requestId: { type: 'string', description: 'Review request id.' },
  leaseToken: { type: 'string', description: 'Secret lease token returned by review_room_claim_review_request.' },
};

const tools: ReviewRoomTool[] = [
  {
    name: 'review_room_get_state',
    description: 'Read a Review Room document, including markdown, marks, revision, and agent links.',
    inputSchema: objectSchema(baseAuthProperties, ['slug']),
  },
  {
    name: 'review_room_list_review_requests',
    description: 'List review requests for a document. Queued requests are available for an external BYO agent to claim.',
    inputSchema: objectSchema(baseAuthProperties, ['slug']),
  },
  {
    name: 'review_room_claim_review_request',
    description: 'Atomically claim one queued review request and receive a short-lived lease token. Review Room does not invoke a model.',
    inputSchema: objectSchema({
      ...baseAuthProperties,
      requestId: { type: 'string', description: 'Queued review request id.' },
    }, ['slug', 'requestId']),
  },
  {
    name: 'review_room_heartbeat_review_request',
    description: 'Mark a claimed request running and renew its short-lived lease.',
    inputSchema: objectSchema(claimProperties, ['slug', 'requestId', 'leaseToken']),
  },
  {
    name: 'review_room_complete_review_request',
    description: 'Complete a claimed review request after submitting its comments and suggestions.',
    inputSchema: objectSchema(claimProperties, ['slug', 'requestId', 'leaseToken']),
  },
  {
    name: 'review_room_fail_review_request',
    description: 'Fail a claimed review request with a concise error message.',
    inputSchema: objectSchema({
      ...claimProperties,
      error: { type: 'string', description: 'Safe failure detail for the document owner.' },
    }, ['slug', 'requestId', 'leaseToken', 'error']),
  },
  {
    name: 'review_room_release_review_request',
    description: 'Release a claimed request back to the queue so another external agent can claim it.',
    inputSchema: objectSchema(claimProperties, ['slug', 'requestId', 'leaseToken']),
  },
  {
    name: 'review_room_add_comment',
    description: 'Add an anchored human-review comment to a Review Room document.',
    inputSchema: objectSchema({
      ...baseAuthProperties,
      quote: { type: 'string', description: 'Exact visible text to anchor the comment to.' },
      text: { type: 'string', description: 'Comment body.' },
      by: { type: 'string', description: 'Actor id, usually ai:<agent-id>.' },
      requestId: { type: 'string', description: 'Optional claimed review request id for attribution and deduplication.' },
      leaseToken: { type: 'string', description: 'Required with requestId.' },
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
      requestId: { type: 'string', description: 'Optional claimed review request id for attribution and deduplication.' },
      leaseToken: { type: 'string', description: 'Required with requestId.' },
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
  allowedRoles: ReviewRoomToolRole[],
): Promise<ReviewRoomToolAuth | { ok: false; status: number; body: JsonRecord }> {
  if (!slug) {
    return { ok: false, status: 400, body: { success: false, code: 'INVALID_REQUEST', error: 'Missing slug' } };
  }
  if (token) {
    const credential = await storeResolveReviewRoomAgentCredential(slug, token);
    if (credential) {
      if (!allowedRoles.includes('agent')) {
        return { ok: false, status: 403, body: { success: false, code: 'AGENT_CAPABILITY_FORBIDDEN', error: 'This agent credential cannot perform that action.' } };
      }
      await storeTouchReviewRoomAgentCredential(credential.id);
      return {
        ok: true,
        role: 'agent',
        agentId: credential.agent_id,
        reviewRequestId: credential.review_request_id,
        credentialId: credential.id,
      };
    }
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

function hashLeaseToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function nextLeaseExpiry(): string {
  return new Date(Date.now() + REVIEW_REQUEST_LEASE_MS).toISOString();
}

function serializeReviewRequest(run: ReviewRoomAgentReviewRun): JsonRecord {
  return {
    id: run.id,
    status: run.status,
    scope: run.scope,
    instructions: run.instructions,
    requestedByIdentityId: run.requested_by_identity_id,
    claimedByAgentId: run.agent_id || null,
    attemptCount: run.attempt_count,
    resultCount: run.result_count,
    failedOutputCount: run.failed_output_count,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    leaseExpiresAt: run.lease_expires_at,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    claimedAt: run.claimed_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
  };
}

async function resolveReviewRequestDocument(slug: string): Promise<{ id: string } | null> {
  const document = await storeGetReviewRoomDocumentByProofSlug(slug);
  return document ? { id: document.id } : null;
}

async function validateClaimedReviewRequest(input: {
  slug: string;
  requestId: string;
  leaseToken: string;
}): Promise<{ ok: true; run: ReviewRoomAgentReviewRun; documentId: string } | { ok: false; status: number; body: JsonRecord }> {
  const document = await resolveReviewRequestDocument(input.slug);
  if (!document) return { ok: false, status: 404, body: { success: false, code: 'REVIEW_REQUEST_DOCUMENT_MISSING', error: 'Review Room document not found.' } };
  await storeExpireAgentReviewRunLeases(document.id);
  const run = await storeGetAgentReviewRun(input.requestId);
  if (!run || run.document_id !== document.id) {
    return { ok: false, status: 404, body: { success: false, code: 'REVIEW_REQUEST_MISSING', error: 'Review request not found.' } };
  }
  if (!input.leaseToken || !run.claim_token_hash || hashLeaseToken(input.leaseToken) !== run.claim_token_hash) {
    return { ok: false, status: 409, body: { success: false, code: 'REVIEW_REQUEST_LEASE_INVALID', error: 'The review request lease is missing, invalid, or expired.' } };
  }
  if (run.status !== 'claimed' && run.status !== 'running') {
    return { ok: false, status: 409, body: { success: false, code: 'REVIEW_REQUEST_NOT_CLAIMED', error: `Review request is ${run.status}.` } };
  }
  return { ok: true, run, documentId: document.id };
}

function reviewOutputFingerprint(type: string, payload: JsonRecord): string {
  return createHash('sha256').update(JSON.stringify({ type, payload })).digest('hex');
}

async function executeReviewRoomTool(req: Request, name: string, args: JsonRecord): Promise<{ status: number; body: JsonRecord }> {
  const slug = readString(args.slug);
  const token = readString(args.token) || readBearerToken(req);
  const by = readString(args.by) || 'ai:review-room-mcp';

  if (name === 'review_room_list_review_requests') {
    const auth = await resolveToolAuth(slug, token, ['viewer', 'commenter', 'editor', 'owner_bot', 'agent']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const document = await resolveReviewRequestDocument(slug);
    if (!document) return { status: 404, body: { success: false, code: 'REVIEW_REQUEST_DOCUMENT_MISSING', error: 'Review Room document not found.' } };
    await storeExpireAgentReviewRunLeases(document.id);
    const requests = (await storeListAgentReviewRuns(document.id, 50))
      .filter((request) => auth.role !== 'agent' || request.id === auth.reviewRequestId);
    return { status: 200, body: { success: true, requests: requests.map(serializeReviewRequest) } };
  }

  if (name === 'review_room_claim_review_request') {
    const auth = await resolveToolAuth(slug, token, ['agent']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const requestId = readString(args.requestId);
    if (requestId !== auth.reviewRequestId || !auth.agentId) {
      return { status: 403, body: { success: false, code: 'AGENT_REQUEST_SCOPE_MISMATCH', error: 'This credential is not assigned to that review request.' } };
    }
    const agentId = auth.agentId;
    const document = await resolveReviewRequestDocument(slug);
    if (!document) return { status: 404, body: { success: false, code: 'REVIEW_REQUEST_DOCUMENT_MISSING', error: 'Review Room document not found.' } };
    await storeExpireAgentReviewRunLeases(document.id);
    const existing = await storeGetAgentReviewRun(requestId);
    if (!existing || existing.document_id !== document.id) {
      return { status: 404, body: { success: false, code: 'REVIEW_REQUEST_MISSING', error: 'Review request not found.' } };
    }
    const leaseToken = randomBytes(32).toString('base64url');
    const claimed = await storeClaimAgentReviewRun({
      id: requestId,
      agentId,
      claimTokenHash: hashLeaseToken(leaseToken),
      leaseExpiresAt: nextLeaseExpiry(),
    });
    if (!claimed) {
      return { status: 409, body: { success: false, code: 'REVIEW_REQUEST_ALREADY_CLAIMED', error: 'Review request is no longer available.' } };
    }
    await storeCreateReviewRoomHistoryEvent({
      documentId: document.id,
      actorId: agentId,
      actorType: 'agent',
      eventType: 'agent_review.claimed',
      targetType: 'agent_review_run',
      targetId: requestId,
      before: { status: 'queued' },
      after: { status: 'claimed', agentId, leaseExpiresAt: claimed.lease_expires_at },
    });
    return { status: 200, body: { success: true, request: serializeReviewRequest(claimed), leaseToken } };
  }

  if (
    name === 'review_room_heartbeat_review_request'
    || name === 'review_room_complete_review_request'
    || name === 'review_room_fail_review_request'
    || name === 'review_room_release_review_request'
  ) {
    const auth = await resolveToolAuth(slug, token, ['agent']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const requestId = readString(args.requestId);
    if (requestId !== auth.reviewRequestId) {
      return { status: 403, body: { success: false, code: 'AGENT_REQUEST_SCOPE_MISMATCH', error: 'This credential is not assigned to that review request.' } };
    }
    const leaseToken = readString(args.leaseToken);
    const claim = await validateClaimedReviewRequest({ slug, requestId, leaseToken });
    if (!claim.ok) return { status: claim.status, body: claim.body };
    const leaseHash = hashLeaseToken(leaseToken);
    if (name === 'review_room_heartbeat_review_request') {
      const updated = await storeHeartbeatAgentReviewRun({ id: requestId, claimTokenHash: leaseHash, leaseExpiresAt: nextLeaseExpiry() });
      if (!updated) return { status: 409, body: { success: false, code: 'REVIEW_REQUEST_LEASE_INVALID', error: 'The review request lease could not be renewed.' } };
      if (claim.run.status === 'claimed') {
        await storeCreateReviewRoomHistoryEvent({
          documentId: claim.documentId,
          actorId: claim.run.agent_id,
          actorType: 'agent',
          eventType: 'agent_review.started',
          targetType: 'agent_review_run',
          targetId: requestId,
          before: { status: 'claimed' },
          after: { status: 'running' },
        });
      }
      return { status: 200, body: { success: true, request: serializeReviewRequest(updated) } };
    }
    if (name === 'review_room_complete_review_request') {
      const resultCount = await storeCountAgentReviewOutputs(requestId);
      const completed = await storeCompleteAgentReviewRun({ id: requestId, claimTokenHash: leaseHash, resultCount, failedOutputCount: 0 });
      if (!completed) return { status: 409, body: { success: false, code: 'REVIEW_REQUEST_LEASE_INVALID', error: 'The review request could not be completed.' } };
      await storeCreateReviewRoomHistoryEvent({
        documentId: claim.documentId,
        actorId: claim.run.agent_id,
        actorType: 'agent',
        eventType: 'agent_review.completed',
        targetType: 'agent_review_run',
        targetId: requestId,
        before: { status: claim.run.status },
        after: { status: 'completed', resultCount },
      });
      return { status: 200, body: { success: true, request: serializeReviewRequest(completed) } };
    }
    if (name === 'review_room_fail_review_request') {
      const message = readString(args.error).slice(0, 1000);
      if (!message) return { status: 400, body: { success: false, code: 'REVIEW_REQUEST_ERROR_REQUIRED', error: 'A failure message is required.' } };
      const failed = await storeFailAgentReviewRun({ id: requestId, claimTokenHash: leaseHash, code: 'EXTERNAL_AGENT_FAILED', message });
      if (!failed) return { status: 409, body: { success: false, code: 'REVIEW_REQUEST_LEASE_INVALID', error: 'The review request could not be failed.' } };
      await storeCreateReviewRoomHistoryEvent({
        documentId: claim.documentId,
        actorId: claim.run.agent_id,
        actorType: 'agent',
        eventType: 'agent_review.failed',
        targetType: 'agent_review_run',
        targetId: requestId,
        before: { status: claim.run.status },
        after: { status: 'failed', message },
      });
      return { status: 200, body: { success: true, request: serializeReviewRequest(failed) } };
    }
    const released = await storeReleaseAgentReviewRun(requestId, leaseHash);
    if (!released) return { status: 409, body: { success: false, code: 'REVIEW_REQUEST_LEASE_INVALID', error: 'The review request could not be released.' } };
    await storeCreateReviewRoomHistoryEvent({
      documentId: claim.documentId,
      actorId: claim.run.agent_id,
      actorType: 'agent',
      eventType: 'agent_review.released',
      targetType: 'agent_review_run',
      targetId: requestId,
      before: { status: claim.run.status },
      after: { status: 'queued' },
    });
    return { status: 200, body: { success: true, request: serializeReviewRequest(released) } };
  }

  if (name === 'review_room_get_state') {
    const auth = await resolveToolAuth(slug, token, ['viewer', 'commenter', 'editor', 'owner_bot', 'agent']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    return executeDocumentOperationAsync(slug, 'GET', '/state');
  }

  if (name === 'review_room_add_comment') {
    const auth = await resolveToolAuth(slug, token, ['commenter', 'editor', 'owner_bot', 'agent']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const requestId = readString(args.requestId);
    if (auth.role === 'agent' && !requestId) {
      return { status: 400, body: { success: false, code: 'AGENT_REQUEST_ID_REQUIRED', error: 'Agent comments require requestId and leaseToken.' } };
    }
    if (auth.role === 'agent' && requestId !== auth.reviewRequestId) {
      return { status: 403, body: { success: false, code: 'AGENT_REQUEST_SCOPE_MISMATCH', error: 'Agent comments must belong to the assigned review request.' } };
    }
    const payload: JsonRecord = {
      by,
      quote: readString(args.quote),
      text: readString(args.text),
    };
    let outputKey = '';
    if (requestId) {
      const claim = await validateClaimedReviewRequest({ slug, requestId, leaseToken: readString(args.leaseToken) });
      if (!claim.ok) return { status: claim.status, body: claim.body };
      payload.by = claim.run.agent_id;
      outputKey = reviewOutputFingerprint('comment', { quote: payload.quote, text: payload.text });
      const reservation = await storeReserveAgentReviewOutput({ runId: requestId, itemKey: outputKey, itemType: 'comment' });
      if (!reservation.reserved) {
        if (reservation.output.status === 'applied') {
          return { status: 200, body: { success: true, reused: true, markId: reservation.output.mark_id, requestId } };
        }
        return { status: 409, body: { success: false, code: 'REVIEW_OUTPUT_IN_PROGRESS', error: 'This review output is already being submitted.' } };
      }
    }
    const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/comment', payload);
    if (requestId && outputKey) {
      await storeUpsertAgentReviewOutput({
        runId: requestId,
        itemKey: outputKey,
        itemType: 'comment',
        status: result.status >= 200 && result.status < 300 ? 'applied' : 'failed',
        markId: typeof result.body.markId === 'string' ? result.body.markId : null,
        errorMessage: result.status >= 200 && result.status < 300 ? null : readString(result.body.error),
      });
    }
    if (result.status >= 200 && result.status < 300) {
      await safeCreateAssignmentTasksFromCommentMentions({
        proofSlug: slug,
        sourceId: typeof result.body.markId === 'string' ? result.body.markId : null,
        text: readString(payload.text),
        actorId: readString(payload.by),
        proofEventId: typeof result.body.eventId === 'number' ? result.body.eventId : null,
      });
    }
    return result;
  }

  if (name === 'review_room_reply_comment') {
    const auth = await resolveToolAuth(slug, token, ['commenter', 'editor', 'owner_bot']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const payload = {
      markId: readString(args.markId),
      text: readString(args.text),
      by,
    };
    const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/reply', payload);
    if (result.status >= 200 && result.status < 300) {
      await safeCreateAssignmentTasksFromCommentMentions({
        proofSlug: slug,
        sourceId: payload.markId || null,
        text: payload.text,
        actorId: by,
        proofEventId: typeof result.body.eventId === 'number' ? result.body.eventId : null,
      });
    }
    return result;
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
    const auth = await resolveToolAuth(slug, token, ['editor', 'owner_bot', 'agent']);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const kind = readString(args.kind);
    const route = routeForSuggestionKind(kind);
    if (!route) {
      return { status: 400, body: { success: false, code: 'INVALID_KIND', error: 'kind must be replace, insert, or delete' } };
    }
    const requestId = readString(args.requestId);
    if (auth.role === 'agent' && !requestId) {
      return { status: 400, body: { success: false, code: 'AGENT_REQUEST_ID_REQUIRED', error: 'Agent suggestions require requestId and leaseToken.' } };
    }
    if (auth.role === 'agent' && requestId !== auth.reviewRequestId) {
      return { status: 403, body: { success: false, code: 'AGENT_REQUEST_SCOPE_MISMATCH', error: 'Agent suggestions must belong to the assigned review request.' } };
    }
    const payload: JsonRecord = {
      by,
      quote: readString(args.quote),
      ...(kind !== 'delete' ? { content: typeof args.content === 'string' ? args.content : '' } : {}),
    };
    let outputKey = '';
    if (requestId) {
      const claim = await validateClaimedReviewRequest({ slug, requestId, leaseToken: readString(args.leaseToken) });
      if (!claim.ok) return { status: claim.status, body: claim.body };
      payload.by = claim.run.agent_id;
      outputKey = reviewOutputFingerprint(`suggestion:${kind}`, {
        quote: payload.quote,
        ...(kind !== 'delete' ? { content: payload.content } : {}),
      });
      const itemType = `suggestion:${kind}`;
      const reservation = await storeReserveAgentReviewOutput({ runId: requestId, itemKey: outputKey, itemType });
      if (!reservation.reserved) {
        if (reservation.output.status === 'applied') {
          return { status: 200, body: { success: true, reused: true, markId: reservation.output.mark_id, requestId } };
        }
        return { status: 409, body: { success: false, code: 'REVIEW_OUTPUT_IN_PROGRESS', error: 'This review output is already being submitted.' } };
      }
    }
    const result = isHostedReviewRoomDbEnabled()
      ? await executeHostedAgentOps(slug, { type: 'suggestion.add', kind, ...payload })
      : await executeDocumentOperationAsync(slug, 'POST', route, payload);
    if (requestId && outputKey) {
      await storeUpsertAgentReviewOutput({
        runId: requestId,
        itemKey: outputKey,
        itemType: `suggestion:${kind}`,
        status: result.status >= 200 && result.status < 300 ? 'applied' : 'failed',
        markId: typeof result.body.markId === 'string' ? result.body.markId : null,
        errorMessage: result.status >= 200 && result.status < 300 ? null : readString(result.body.error),
      });
    }
    return result;
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
