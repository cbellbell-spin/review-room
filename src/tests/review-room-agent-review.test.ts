import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

function assert(condition: boolean, message: string): asserts condition {
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
  const payload = await response.json() as T & { error?: string };
  assert(response.ok, payload.error || `Request failed with ${response.status}`);
  return payload;
}

async function callTool<T extends Record<string, unknown>>(
  base: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T & { success: boolean; code?: string }> {
  const response = await json<{
    result: { content: Array<{ type: string; text: string }>; isError?: boolean };
  }>(await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  }));
  const text = response.result.content.find((item) => item.type === 'text')?.text || '{}';
  return JSON.parse(text) as T & { success: boolean; code?: string };
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-byo-review-${Date.now()}-${randomUUID()}.db`);
  const port = await getFreePort();
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);
  process.env.COLLAB_EMBEDDED_WS = '0';
  const { createReviewRoomHttpServer } = await import('../../server/index.js');
  const {
    storeClaimAgentReviewRun,
    storeGetReviewRoomDocumentByProofSlug,
    storeReserveAgentReviewOutput,
  } = await import('../../server/review-room-store.js');
  const server = await createReviewRoomHttpServer(port);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  const alpha = 'Alpha is a unique sentence for a focused comment.';
  const beta = 'Beta is a unique sentence that should be clearer.';
  const base = `http://127.0.0.1:${port}`;
  try {
    const created = await json<{
      document: { proofSlug: string };
      proof: { accessToken: string };
    }>(await fetch(`${base}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-review-room-identity-id': 'review-owner' },
      body: JSON.stringify({ title: 'BYO review fixture', markdown: `# Review fixture\n\n${alpha}\n\n${beta}` }),
    }));
    const slug = created.document.proofSlug;
    const ownerToken = created.proof.accessToken;

    const editor = await json<{ member: { accessToken: string } }>(await fetch(`${base}/review-room/api/documents/${slug}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-review-room-identity-id': 'review-owner' },
      body: JSON.stringify({ identityId: 'review-editor', displayName: 'Review Editor', role: 'editor' }),
    }));
    const editorToken = editor.member.accessToken;
    const mintAgentCredential = async (runId: string, agentName: string = 'Contract agent') => json<{
      credential: { token: string; agentId: string; reviewRequestId: string; expiresAt: string };
    }>(await fetch(`${base}/review-room/api/documents/${slug}/review-runs/${runId}/agent-credential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': ownerToken },
      body: JSON.stringify({ agentName }),
    }));

    const forbidden = await fetch(`${base}/review-room/api/documents/${slug}/review-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': editorToken },
      body: JSON.stringify({ idempotencyKey: 'editor-forbidden' }),
    });
    assert(forbidden.status === 403, `Expected editor request creation to be forbidden, got ${forbidden.status}`);

    const first = await json<{ run: { id: string; status: string; instructions: string }; reused: boolean }>(
      await fetch(`${base}/review-room/api/documents/${slug}/review-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-share-token': ownerToken },
        body: JSON.stringify({
          idempotencyKey: 'first-review',
          scope: 'document',
          instructions: 'Focus on ambiguous ownership and unclear claims.',
        }),
      }),
    );
    assert(first.run.status === 'queued', 'Creating a review request must only queue work');
    assert(first.run.instructions.includes('ambiguous ownership'), 'Expected owner instructions to persist');

    const duplicate = await json<{ run: { id: string }; reused: boolean }>(
      await fetch(`${base}/review-room/api/documents/${slug}/review-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-share-token': ownerToken },
        body: JSON.stringify({ idempotencyKey: 'first-review' }),
      }),
    );
    assert(duplicate.reused && duplicate.run.id === first.run.id, 'Expected idempotent request creation');

    const humanClaim = await callTool(base, 'review_room_claim_review_request', {
      slug,
      token: editorToken,
      requestId: first.run.id,
    });
    assert(!humanClaim.success && humanClaim.code === 'UNAUTHORIZED', 'A human editor token must not claim agent work');

    const forbiddenCredential = await fetch(`${base}/review-room/api/documents/${slug}/review-runs/${first.run.id}/agent-credential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': editorToken },
      body: '{}',
    });
    assert(forbiddenCredential.status === 403, 'Only the owner may mint agent-scoped access');

    const firstCredential = await mintAgentCredential(first.run.id);
    const agentToken = firstCredential.credential.token;
    assert(agentToken !== ownerToken && agentToken !== editorToken, 'Agent access must use a distinct scoped credential');

    const listed = await callTool<{ requests: Array<{ id: string; status: string }> }>(base, 'review_room_list_review_requests', {
      slug,
      token: agentToken,
    });
    assert(listed.requests.some((request) => request.id === first.run.id && request.status === 'queued'), 'External agent should see queued work');

    const claim = await callTool<{ request: { status: string; claimedByAgentId: string }; leaseToken: string }>(base, 'review_room_claim_review_request', {
      slug,
      token: agentToken,
      requestId: first.run.id,
    });
    assert(claim.success && claim.request.status === 'claimed', 'Expected atomic claim');
    assert(claim.request.claimedByAgentId === firstCredential.credential.agentId, 'Expected credential-bound BYO agent attribution');
    assert(Boolean(claim.leaseToken), 'Claim must return a lease token');

    const raced = await callTool(base, 'review_room_claim_review_request', {
      slug,
      token: agentToken,
      requestId: first.run.id,
    });
    assert(!raced.success && raced.code === 'REVIEW_REQUEST_ALREADY_CLAIMED', 'A second agent must not steal an active claim');

    const heartbeat = await callTool<{ request: { status: string; leaseExpiresAt: string } }>(base, 'review_room_heartbeat_review_request', {
      slug,
      token: agentToken,
      requestId: first.run.id,
      leaseToken: claim.leaseToken,
    });
    assert(heartbeat.request.status === 'running' && Boolean(heartbeat.request.leaseExpiresAt), 'Heartbeat should start work and renew the lease');

    const reservations = await Promise.all([
      storeReserveAgentReviewOutput({ runId: first.run.id, itemKey: 'atomic-reservation-fixture', itemType: 'comment' }),
      storeReserveAgentReviewOutput({ runId: first.run.id, itemKey: 'atomic-reservation-fixture', itemType: 'comment' }),
    ]);
    assert(reservations.filter((reservation) => reservation.reserved).length === 1, 'Output fingerprints must reserve atomically under concurrency');

    const commentArgs = {
      slug,
      token: agentToken,
      requestId: first.run.id,
      leaseToken: claim.leaseToken,
      quote: alpha,
      text: 'Clarify who owns this assertion.',
    };
    const comment = await callTool<{ markId: string; reused?: boolean }>(base, 'review_room_add_comment', commentArgs);
    assert(comment.success && Boolean(comment.markId), 'Claimed agent should add an attributable comment');
    const repeated = await callTool<{ markId: string; reused?: boolean }>(base, 'review_room_add_comment', commentArgs);
    assert(repeated.reused === true && repeated.markId === comment.markId, 'Repeated output must be idempotent');

    const suggestion = await callTool<{ markId: string }>(base, 'review_room_add_suggestion', {
      slug,
      token: agentToken,
      requestId: first.run.id,
      leaseToken: claim.leaseToken,
      kind: 'replace',
      quote: beta,
      content: 'Beta is a unique sentence with a specific claim.',
    });
    assert(suggestion.success && Boolean(suggestion.markId), 'Claimed agent should add an attributable suggestion');

    const forbiddenDecision = await callTool(base, 'review_room_accept_suggestion', {
      slug,
      token: agentToken,
      markId: suggestion.markId,
    });
    assert(!forbiddenDecision.success && forbiddenDecision.code === 'AGENT_CAPABILITY_FORBIDDEN', 'Agent credentials must not accept human-controlled suggestions');
    const forbiddenRewrite = await fetch(`${base}/documents/${slug}/ops`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-share-token': agentToken },
      body: JSON.stringify({ type: 'rewrite.apply', by: firstCredential.credential.agentId, content: '# forbidden' }),
    });
    assert(forbiddenRewrite.status === 401 || forbiddenRewrite.status === 403, 'Agent credentials must be useless on direct document mutation routes');
    const probeState = await json<{ revision: number }>(
      await fetch(`${base}/documents/${slug}/state`, { headers: { ...CLIENT_HEADERS, 'x-share-token': ownerToken } }),
    );
    const directMutationProbes: Array<{ label: string; path: string; method: string; body: Record<string, unknown> }> = [
      {
        label: 'document content PUT',
        path: `/api/documents/${slug}`,
        method: 'PUT',
        body: { markdown: '# forbidden direct put', actor: firstCredential.credential.agentId },
      },
      {
        label: 'document title PUT',
        path: `/api/documents/${slug}/title`,
        method: 'PUT',
        body: { title: 'Forbidden title', actor: firstCredential.credential.agentId },
      },
      {
        label: 'agent edit v2',
        path: `/api/agent/${slug}/edit/v2`,
        method: 'POST',
        body: { operations: [{ op: 'insert', after: alpha, content: ' forbidden' }], by: firstCredential.credential.agentId },
      },
      {
        label: 'legacy agent edit',
        path: `/api/agent/${slug}/edit`,
        method: 'POST',
        body: { operations: [{ op: 'insert', after: alpha, content: ' forbidden' }], by: firstCredential.credential.agentId },
      },
      {
        label: 'agent rewrite',
        path: `/api/agent/${slug}/rewrite`,
        method: 'POST',
        body: { content: '# forbidden agent rewrite', baseRevision: probeState.revision, by: firstCredential.credential.agentId },
      },
      {
        label: 'bridge rewrite',
        path: `/d/${slug}/bridge/rewrite`,
        method: 'POST',
        body: { content: '# forbidden bridge rewrite', baseRevision: probeState.revision, by: firstCredential.credential.agentId },
      },
    ];
    for (const probe of directMutationProbes) {
      const response = await fetch(`${base}${probe.path}`, {
        method: probe.method,
        headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-share-token': agentToken },
        body: JSON.stringify(probe.body),
      });
      assert(
        response.status === 401 || response.status === 403,
        `Request-scoped agent credential must not access ${probe.label}; got ${response.status}`,
      );
    }
    const otherDocument = await json<{ document: { proofSlug: string } }>(await fetch(`${base}/review-room/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-review-room-identity-id': 'review-owner' },
      body: JSON.stringify({ title: 'Other document', markdown: '# Other document' }),
    }));
    const crossDocument = await callTool(base, 'review_room_get_state', {
      slug: otherDocument.document.proofSlug,
      token: agentToken,
    });
    assert(!crossDocument.success && crossDocument.code === 'UNAUTHORIZED', 'Agent credentials must not cross document boundaries');

    const completed = await callTool<{ request: { status: string; resultCount: number } }>(base, 'review_room_complete_review_request', {
      slug,
      token: agentToken,
      requestId: first.run.id,
      leaseToken: claim.leaseToken,
    });
    assert(completed.request.status === 'completed' && completed.request.resultCount === 2, 'Completion should count deduplicated outputs');

    const staleHeartbeat = await callTool(base, 'review_room_heartbeat_review_request', {
      slug,
      token: agentToken,
      requestId: first.run.id,
      leaseToken: claim.leaseToken,
    });
    assert(!staleHeartbeat.success, 'Completing a request must invalidate its lease');

    const state = await json<{ marks: Record<string, { by?: string; text?: string }> }>(
      await fetch(`${base}/documents/${slug}/state`, { headers: { 'x-share-token': ownerToken } }),
    );
    const marks = Object.values(state.marks);
    assert(marks.filter((mark) => mark.text === 'Clarify who owns this assertion.').length === 1, 'Expected one deduplicated comment');
    assert(marks.filter((mark) => mark.by === firstCredential.credential.agentId).length === 2, 'Outputs must be bound to the credential identity');

    const second = await json<{ run: { id: string } }>(await fetch(`${base}/review-room/api/documents/${slug}/review-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': ownerToken },
      body: JSON.stringify({ idempotencyKey: 'release-and-fail' }),
    }));
    const secondCredential = await mintAgentCredential(second.run.id, 'Release agent');
    const secondClaim = await callTool<{ leaseToken: string }>(base, 'review_room_claim_review_request', {
      slug,
      token: secondCredential.credential.token,
      requestId: second.run.id,
    });
    const released = await callTool<{ request: { status: string } }>(base, 'review_room_release_review_request', {
      slug,
      token: secondCredential.credential.token,
      requestId: second.run.id,
      leaseToken: secondClaim.leaseToken,
    });
    assert(released.request.status === 'queued', 'Released work should return to the queue');

    const releasedTokenProbe = await callTool(base, 'review_room_get_state', {
      slug,
      token: secondCredential.credential.token,
    });
    assert(!releasedTokenProbe.success, 'Releasing work must revoke its agent credential');
    const finalCredential = await mintAgentCredential(second.run.id, 'Failure agent');
    const finalClaim = await callTool<{ leaseToken: string }>(base, 'review_room_claim_review_request', {
      slug,
      token: finalCredential.credential.token,
      requestId: second.run.id,
    });
    const failed = await callTool<{ request: { status: string; errorMessage: string } }>(base, 'review_room_fail_review_request', {
      slug,
      token: finalCredential.credential.token,
      requestId: second.run.id,
      leaseToken: finalClaim.leaseToken,
      error: 'The external agent could not finish this review.',
    });
    assert(failed.request.status === 'failed', 'External agent should be able to fail its request');

    const requeued = await json<{ run: { status: string; attemptCount: number } }>(
      await fetch(`${base}/review-room/api/documents/${slug}/review-runs/${second.run.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-share-token': ownerToken },
        body: '{}',
      }),
    );
    assert(requeued.run.status === 'queued' && requeued.run.attemptCount === 2, 'Owner should safely requeue failed work');

    const cancelled = await json<{ run: { status: string } }>(
      await fetch(`${base}/review-room/api/documents/${slug}/review-runs/${second.run.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-share-token': ownerToken },
        body: '{}',
      }),
    );
    assert(cancelled.run.status === 'cancelled', 'Owner should cancel active review work');

    const expiring = await json<{ run: { id: string } }>(await fetch(`${base}/review-room/api/documents/${slug}/review-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': ownerToken },
      body: JSON.stringify({ idempotencyKey: 'expired-lease' }),
    }));
    const productDocument = await storeGetReviewRoomDocumentByProofSlug(slug);
    assert(Boolean(productDocument), 'Expected Review Room document record');
    const expiringCredential = await mintAgentCredential(expiring.run.id, 'Expiring agent');
    const expiredSecret = 'deterministic-expired-lease';
    const expiredClaim = await storeClaimAgentReviewRun({
      id: expiring.run.id,
      agentId: expiringCredential.credential.agentId,
      claimTokenHash: createHash('sha256').update(expiredSecret).digest('hex'),
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert(Boolean(expiredClaim), 'Expected deterministic expired claim fixture');
    const afterExpiry = await callTool<{ requests: Array<{ id: string; status: string }> }>(base, 'review_room_list_review_requests', {
      slug,
      token: ownerToken,
    });
    assert(afterExpiry.requests.find((item) => item.id === expiring.run.id)?.status === 'lease_expired', 'Listing should expire stale leases deterministically');
    const expiredCredentialProbe = await callTool(base, 'review_room_get_state', {
      slug,
      token: expiringCredential.credential.token,
    });
    assert(!expiredCredentialProbe.success, 'Lease expiry must revoke the associated agent credential');

    console.log('✓ Review Room BYO agent review-request protocol');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
