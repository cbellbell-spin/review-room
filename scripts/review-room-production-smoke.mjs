import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const base = (process.env.REVIEW_ROOM_PROD_BASE || 'https://review-room.chrisjbell.dev').replace(/\/+$/, '');
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const ownerIdentityId = `smoke-owner-${runId}`;
const reviewerIdentityId = `smoke-reviewer-${runId}`;

async function readJson(response, label) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return payload;
}

async function fetchJson(path, options = {}, label = path) {
  const response = await fetch(`${base}${path}`, options);
  return readJson(response, label);
}

function withToken(path, token) {
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function collabWebSocketUrl(session) {
  const url = new URL(session.collabWsUrl);
  url.searchParams.set('token', session.token);
  url.searchParams.set('role', session.role);
  return url.toString();
}

async function openWebSocket(url, label) {
  const ws = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${label} did not open within 10s`));
      }, 10_000);
      ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      ws.once('close', (code, reason) => {
        clearTimeout(timeout);
        reject(new Error(`${label} closed before open: ${code} ${reason.toString()}`));
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

const health = await fetchJson('/health', undefined, 'health');
assert.equal(health.ok, true, 'Expected /health ok');
assert.equal(health.collab?.enabled, true, 'Expected live collab to be enabled');
assert.match(String(health.collab?.wsUrlBase ?? ''), /^wss:\/\/review-room\.chrisjbell\.dev\/ws$/, 'Expected production wss base');

const created = await fetchJson('/review-room/api/documents', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-review-room-identity-id': ownerIdentityId,
  },
  body: JSON.stringify({
    title: `Fly production smoke ${runId}`,
    markdown: '# Fly production smoke\n\nAnchor paragraph for comment and suggestion.\n\nReload persistence target.',
  }),
}, 'create Review Room document');
assert.equal(created.success, true, 'Expected Review Room document creation success');
assert.equal(created.document?.currentRole, 'owner', 'Expected creator to be owner');

const slug = created.document.proofSlug;
const ownerToken = created.proof.accessToken;
assert.ok(slug && ownerToken, 'Expected created document slug and owner access token');
assert.ok(String(created.openPath || '').includes('rr=1'), 'Expected Review Room open path');

const ownerDoc = await fetchJson(withToken(`/d/${encodeURIComponent(slug)}`, ownerToken), {
  headers: { Accept: 'application/json' },
}, 'owner document open context');
assert.equal(ownerDoc.success, true, 'Expected owner open JSON success');
assert.match(String(ownerDoc.markdown ?? ownerDoc.doc?.markdown ?? ''), /Anchor paragraph/, 'Expected owner document markdown');

const ownerSession = await fetchJson(`/api/documents/${encodeURIComponent(slug)}/collab-session`, {
  headers: { 'x-share-token': ownerToken },
}, 'owner collab session');
assert.equal(ownerSession.success, true, 'Expected owner collab session success');
assert.equal(ownerSession.capabilities?.canEdit, true, 'Expected owner/editor token to edit');
assert.match(String(ownerSession.session?.collabWsUrl ?? ''), /^wss:\/\/review-room\.chrisjbell\.dev\/ws\?slug=/, 'Expected production collab URL');

await openWebSocket(collabWebSocketUrl(ownerSession.session), 'owner live-collab websocket');

const member = await fetchJson(`/review-room/api/documents/${encodeURIComponent(slug)}/members`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-review-room-identity-id': ownerIdentityId,
  },
  body: JSON.stringify({
    identityId: reviewerIdentityId,
    displayName: 'Fly Smoke Reviewer',
    role: 'commenter',
  }),
}, 'create commenter collaborator');
assert.equal(member.success, true, 'Expected member creation success');
assert.equal(member.member?.role, 'commenter', 'Expected commenter member role');
assert.ok(member.member?.accessToken, 'Expected commenter access token');
assert.ok(String(member.member?.openPath ?? '').includes('token='), 'Expected role-scoped reviewer open path');

const reviewerToken = member.member.accessToken;
const reviewerDoc = await fetchJson(withToken(`/d/${encodeURIComponent(slug)}`, reviewerToken), {
  headers: { Accept: 'application/json' },
}, 'reviewer document open context');
assert.equal(reviewerDoc.success, true, 'Expected reviewer open JSON success');

const reviewerSession = await fetchJson(`/api/documents/${encodeURIComponent(slug)}/collab-session`, {
  headers: { 'x-share-token': reviewerToken },
}, 'reviewer collab session');
assert.equal(reviewerSession.success, true, 'Expected reviewer collab session success');
assert.equal(reviewerSession.reviewRoom?.currentRole, 'commenter', 'Expected reviewer role in collab session context');
assert.equal(reviewerSession.capabilities?.canComment, true, 'Expected reviewer canComment');
assert.equal(reviewerSession.capabilities?.canEdit, false, 'Expected commenter cannot edit');
await openWebSocket(collabWebSocketUrl(reviewerSession.session), 'reviewer live-collab websocket');

const comment = await fetchJson(`/documents/${encodeURIComponent(slug)}/ops`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-share-token': reviewerToken,
    'X-Agent-Id': 'production-smoke',
  },
  body: JSON.stringify({
    type: 'comment.add',
    by: 'human:fly-smoke-reviewer',
    quote: 'Anchor paragraph',
    text: 'Production smoke comment.',
  }),
}, 'add reviewer comment');
assert.equal(comment.success, true, 'Expected reviewer comment to persist');
assert.ok(comment.markId, 'Expected comment mark id');

const suggestion = await fetchJson(`/documents/${encodeURIComponent(slug)}/ops`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-share-token': reviewerToken,
    'X-Agent-Id': 'production-smoke',
  },
  body: JSON.stringify({
    type: 'suggestion.add',
    by: 'human:fly-smoke-reviewer',
    kind: 'replace',
    quote: 'Reload persistence target.',
    content: 'Reload persistence target, suggested by production smoke.',
  }),
}, 'add reviewer suggestion');
assert.equal(suggestion.success, true, 'Expected reviewer suggestion to persist');
assert.ok(suggestion.markId, 'Expected suggestion mark id');

const reloaded = await fetchJson(`/documents/${encodeURIComponent(slug)}/state`, {
  headers: { 'x-share-token': ownerToken },
}, 'reload persisted state');
const marks = reloaded.marks && typeof reloaded.marks === 'object' ? reloaded.marks : {};
assert.ok(marks[comment.markId], 'Expected comment mark after reload');
assert.ok(marks[suggestion.markId], 'Expected suggestion mark after reload');

console.log(JSON.stringify({
  ok: true,
  base,
  slug,
  healthSha: health.buildInfo?.sha ?? null,
  collabWsBase: health.collab?.wsUrlBase ?? null,
  ownerRole: created.document.currentRole,
  reviewerRole: member.member.role,
  commentPersisted: true,
  suggestionPersisted: true,
}, null, 2));
