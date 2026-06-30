import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

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

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function postJson(base: string, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `review-room-permissions-${Date.now()}-${randomUUID()}.db`);
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = '';
  process.env.PROOF_TRUST_PROXY_HEADERS = '1';

  const { createReviewRoomExpressApp } = await import('../../server/index.js');
  const app = createReviewRoomExpressApp();
  const port = await getFreePort();
  const server = app.listen(port, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  try {
    const created = await readJson<{
      success: boolean;
      document: { id: string; proofSlug: string; currentRole: string };
      proof: { accessToken: string };
    }>(await postJson(base, '/review-room/api/documents', {
      title: 'Permissions runway',
      markdown: '# Permissions runway\n\nFirst Phase 2 slice.',
    }));
    assert(created.success === true, 'Expected document creation success');
    assert(created.document.currentRole === 'owner', 'Expected creator to be owner');
    const slug = created.document.proofSlug;
    const ownerOpenContext = await readJson<{
      success: boolean;
      reviewRoom?: { identityId?: string; currentRole?: string };
    }>(await fetch(`${base}/api/documents/${slug}/open-context`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.proof.accessToken },
    }));
    assert(ownerOpenContext.reviewRoom?.identityId === 'local-human', 'Expected create response token to resolve to the owner Review Room identity');
    assert(ownerOpenContext.reviewRoom?.currentRole === 'owner', 'Expected create response token to resolve to owner role');

    const explicitOwnerId = `smoke-owner-${randomUUID()}`;
    const explicitOwnerCreated = await readJson<{
      success: boolean;
      document: { proofSlug: string; currentRole: string };
    }>(await postJson(base, '/review-room/api/documents', {
      title: 'Explicit owner identity',
      markdown: '# Explicit owner identity\n\nThis should not require a pre-seeded identity.',
    }, {
      'x-review-room-identity-id': explicitOwnerId,
    }));
    assert(explicitOwnerCreated.success === true, 'Expected document creation for a new explicit identity');
    assert(explicitOwnerCreated.document.currentRole === 'owner', 'Expected explicit identity creator to be owner');
    const explicitOwnerList = await readJson<{ documents: Array<{ proofSlug?: string; currentRole?: string }> }>(
      await fetch(`${base}/review-room/api/documents?identityId=${encodeURIComponent(explicitOwnerId)}`, { headers: CLIENT_HEADERS }),
    );
    assert(
      explicitOwnerList.documents.some((document) => (
        document.proofSlug === explicitOwnerCreated.document.proofSlug && document.currentRole === 'owner'
      )),
      'Expected new explicit owner identity to see its created document',
    );

    const outsiderList = await readJson<{ documents: Array<{ proofSlug?: string }> }>(
      await fetch(`${base}/review-room/api/documents?identityId=outside-reviewer`, { headers: CLIENT_HEADERS }),
    );
    assert(
      !outsiderList.documents.some((document) => document.proofSlug === slug),
      'Expected non-members not to see Review Room documents in the dashboard list',
    );

    const outsiderHistory = await fetch(`${base}/review-room/api/documents/${slug}/history?identityId=outside-reviewer`, { headers: CLIENT_HEADERS });
    assert(outsiderHistory.status === 403, `Expected non-member history status 403, got ${outsiderHistory.status}`);

    const editorMember = await readJson<{
      success: boolean;
      member: { identityId: string; role: string; shareRole: string; accessToken: string; openPath: string };
    }>(await postJson(base, `/review-room/api/documents/${slug}/members`, {
      identityId: 'editor-alice',
      displayName: 'Editor Alice',
      role: 'editor',
    }));
    assert(editorMember.success === true, 'Expected owner to add an editor');
    assert(editorMember.member.identityId === 'editor-alice', 'Expected member identity id');
    assert(editorMember.member.role === 'editor', 'Expected editor member role');
    assert(editorMember.member.shareRole === 'editor', 'Expected editor share role');
    assert(editorMember.member.openPath.includes(`token=${encodeURIComponent(editorMember.member.accessToken)}`), 'Expected member open path to include role token');
    const editorToken = editorMember.member.accessToken;
    const editorOpenContext = await readJson<{
      success: boolean;
      reviewRoom?: { identityId?: string; currentRole?: string };
    }>(await fetch(`${base}/api/documents/${slug}/open-context`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': editorToken },
    }));
    assert(editorOpenContext.reviewRoom?.identityId === 'editor-alice', 'Expected editor token to resolve to the editor Review Room identity');
    assert(editorOpenContext.reviewRoom?.currentRole === 'editor', 'Expected editor token to resolve to editor role');

    const firstSessionInvite = await readJson<{
      success: boolean;
      identityInvitePath: string;
    }>(await postJson(base, `/review-room/api/documents/${slug}/members`, {
      identityId: 'session-sam',
      displayName: 'Session Sam',
      role: 'commenter',
    }));
    const replacementSessionInvite = await readJson<{
      success: boolean;
      identityInvitePath: string;
    }>(await postJson(base, `/review-room/api/documents/${slug}/members`, {
      identityId: 'session-sam',
      displayName: 'Session Sam',
      role: 'commenter',
    }));
    assert(firstSessionInvite.identityInvitePath.includes('invite='), 'Expected a one-time identity invitation path');
    assert(
      replacementSessionInvite.identityInvitePath !== firstSessionInvite.identityInvitePath,
      'Expected a replacement identity invitation to mint a new secret',
    );
    const revokedInvite = await fetch(`${base}${firstSessionInvite.identityInvitePath}`, {
      headers: { ...CLIENT_HEADERS, Accept: 'application/json' },
    });
    assert(revokedInvite.status === 410, `Expected replaced invitation status 410, got ${revokedInvite.status}`);

    const acceptedInvite = await fetch(`${base}${replacementSessionInvite.identityInvitePath}`, {
      headers: { ...CLIENT_HEADERS, Accept: 'application/json' },
    });
    const acceptedPayload = await readJson<{
      success: boolean;
      identity: { id: string; displayName: string };
      session: { active: boolean };
      openPath: string;
    }>(acceptedInvite);
    assert(acceptedPayload.identity.id === 'session-sam', 'Expected invitation to bind the intended stable identity');
    assert(acceptedPayload.identity.displayName === 'Session Sam', 'Expected invitation to preserve the collaborator display name');
    assert(acceptedPayload.session.active === true, 'Expected invitation acceptance to create an active session');
    assert(acceptedPayload.openPath.includes('token='), 'Expected invitation acceptance to return the authorized document path');
    const setCookie = acceptedInvite.headers.get('set-cookie') ?? '';
    assert(setCookie.includes('proof_review_room_session='), 'Expected Review Room session cookie');
    assert(setCookie.includes('HttpOnly'), 'Expected Review Room session cookie to be HttpOnly');
    assert(setCookie.includes('SameSite=Lax'), 'Expected Review Room session cookie to use SameSite=Lax');
    const sessionCookie = setCookie.split(';', 1)[0] ?? '';
    assert(sessionCookie.startsWith('proof_review_room_session='), 'Expected extractable Review Room session cookie');

    const replayedInvite = await fetch(`${base}${replacementSessionInvite.identityInvitePath}`, {
      headers: { ...CLIENT_HEADERS, Accept: 'application/json' },
    });
    assert(replayedInvite.status === 410, `Expected consumed invitation replay status 410, got ${replayedInvite.status}`);

    const sessionIdentity = await readJson<{
      currentIdentity: { id: string; display_name: string };
      session: { active: boolean };
      recovery: {
        state: string;
        canCreateEnrollment: boolean;
        canSelfRecover: boolean;
        activeDeviceCount: number | null;
        emailDelivery: { enabled: boolean; reason: string };
        guidance: { summary: string; owner: string; editor: string; commenter: string; viewer: string };
      };
      sessions: Array<{ id: string; current: boolean; createdAt: string; lastSeenAt: string; expiresAt: string }>;
    }>(await fetch(`${base}/review-room/api/identity`, {
      headers: {
        ...CLIENT_HEADERS,
        Cookie: sessionCookie,
        'x-review-room-identity-id': 'spoofed-identity',
      },
    }));
    assert(sessionIdentity.currentIdentity.id === 'session-sam', 'Expected session identity to override a legacy identity header');
    assert(sessionIdentity.session.active === true, 'Expected identity endpoint to report the active session');
    assert(sessionIdentity.recovery.state === 'session_active', 'Expected active sessions to report the active recovery state');
    assert(sessionIdentity.recovery.canCreateEnrollment === true, 'Expected active sessions to allow device enrollment');
    assert(sessionIdentity.recovery.canSelfRecover === false, 'Expected self-service account recovery to stay disabled');
    assert(sessionIdentity.recovery.activeDeviceCount === 1, 'Expected active-device count for the stable identity');
    assert(sessionIdentity.recovery.emailDelivery.enabled === false, 'Expected invitation email delivery to remain disabled');
    assert(
      sessionIdentity.recovery.guidance.owner.includes('owner-capable document link'),
      'Expected owner recovery guidance to preserve document authority',
    );
    assert(sessionIdentity.sessions.length === 1, 'Expected identity endpoint to list the active browser session');
    assert(sessionIdentity.sessions[0]?.current === true, 'Expected session list to mark the current browser session');
    assert(typeof sessionIdentity.sessions[0]?.createdAt === 'string', 'Expected session creation metadata');
    assert(typeof sessionIdentity.sessions[0]?.lastSeenAt === 'string', 'Expected session last-used metadata');

    const firstEnrollment = await readJson<{
      enrollmentPath: string;
      enrollmentExpiresAt: string;
    }>(await postJson(base, '/review-room/api/session/enrollments', {}, { Cookie: sessionCookie }));
    assert(firstEnrollment.enrollmentPath.includes('/review-room/session/enroll?enroll='), 'Expected manual device enrollment link');
    assert(typeof firstEnrollment.enrollmentExpiresAt === 'string', 'Expected enrollment expiry metadata');

    const replacementEnrollment = await readJson<{ enrollmentPath: string }>(
      await postJson(base, '/review-room/api/session/enrollments', {}, { Cookie: sessionCookie }),
    );
    assert(
      replacementEnrollment.enrollmentPath !== firstEnrollment.enrollmentPath,
      'Expected a replacement enrollment to mint a new single-use secret',
    );
    const revokedEnrollment = await fetch(`${base}${firstEnrollment.enrollmentPath}`, {
      headers: { ...CLIENT_HEADERS, Accept: 'application/json' },
    });
    assert(revokedEnrollment.status === 410, `Expected revoked enrollment link status 410, got ${revokedEnrollment.status}`);
    assert(
      (await revokedEnrollment.text()).includes('was revoked'),
      'Expected revoked enrollment link to explain the terminal state',
    );

    const alreadyEnrolled = await fetch(`${base}${replacementEnrollment.enrollmentPath}`, {
      headers: { ...CLIENT_HEADERS, Accept: 'application/json', Cookie: sessionCookie },
    });
    assert(alreadyEnrolled.status === 409, `Expected already-enrolled status 409, got ${alreadyEnrolled.status}`);
    const alreadyEnrolledPayload = await alreadyEnrolled.json() as { code?: string };
    assert(alreadyEnrolledPayload.code === 'ALREADY_ENROLLED', 'Expected already-enrolled code');

    const enrolledSecondBrowser = await fetch(`${base}${replacementEnrollment.enrollmentPath}`, {
      headers: { ...CLIENT_HEADERS, Accept: 'application/json' },
    });
    const enrolledPayload = await readJson<{
      identity: { id: string; displayName: string };
      session: { active: boolean; id: string };
    }>(enrolledSecondBrowser);
    assert(enrolledPayload.identity.id === 'session-sam', 'Expected enrollment to carry the same stable identity');
    assert(enrolledPayload.session.active === true, 'Expected enrollment to create a normal session');
    const secondSessionCookie = enrolledSecondBrowser.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    assert(
      secondSessionCookie.startsWith('proof_review_room_session=') && secondSessionCookie !== sessionCookie,
      'Expected independent browser to receive its own session cookie',
    );

    const replayedEnrollment = await fetch(`${base}${replacementEnrollment.enrollmentPath}`, {
      headers: { ...CLIENT_HEADERS, Accept: 'application/json' },
    });
    assert(replayedEnrollment.status === 410, `Expected enrollment replay status 410, got ${replayedEnrollment.status}`);
    assert(
      (await replayedEnrollment.text()).includes('already used'),
      'Expected replayed enrollment link to explain the terminal state',
    );

    const { storeCreateReviewRoomDeviceEnrollment } = await import('../../server/review-room-store.js');
    const expired = await storeCreateReviewRoomDeviceEnrollment({
      identityId: 'session-sam',
      createdBySessionId: sessionIdentity.sessions[0]!.id,
      ttlMs: -1000,
    });
    const expiredResponse = await fetch(`${base}/review-room/session/enroll?enroll=${encodeURIComponent(expired.secret)}`, {
      headers: { ...CLIENT_HEADERS, Accept: 'application/json' },
    });
    assert(expiredResponse.status === 410, `Expected expired enrollment status 410, got ${expiredResponse.status}`);
    assert((await expiredResponse.text()).includes('has expired'), 'Expected expired enrollment message');

    const sessionsAfterEnrollment = await readJson<{
      sessions: Array<{ id: string; current: boolean }>;
    }>(await fetch(`${base}/review-room/api/identity`, {
      headers: { ...CLIENT_HEADERS, Cookie: sessionCookie },
    }));
    assert(sessionsAfterEnrollment.sessions.length === 2, 'Expected both browser sessions to be listed for the identity');
    assert(
      sessionsAfterEnrollment.sessions.some((listed) => listed.id === enrolledPayload.session.id && listed.current === false),
      'Expected session list to include the independently enrolled browser',
    );

    const revokedSecondSession = await fetch(`${base}/review-room/api/sessions/${encodeURIComponent(enrolledPayload.session.id)}`, {
      method: 'DELETE',
      headers: { ...CLIENT_HEADERS, Cookie: sessionCookie },
    });
    assert(revokedSecondSession.ok, `Expected individual session revocation success, got ${revokedSecondSession.status}`);
    const secondBrowserAfterRevoke = await readJson<{
      currentIdentity: { id: string };
      session: { active: boolean };
      recovery: { state: string; activeDeviceCount: number | null; canSelfRecover: boolean };
    }>(await fetch(`${base}/review-room/api/identity`, {
      headers: { ...CLIENT_HEADERS, Cookie: secondSessionCookie },
    }));
    assert(secondBrowserAfterRevoke.currentIdentity.id === 'local-human', 'Expected revoked second browser to lose the enrolled identity');
    assert(secondBrowserAfterRevoke.session.active === false, 'Expected revoked second browser session to be inactive');
    assert(secondBrowserAfterRevoke.recovery.state === 'session_revoked', 'Expected revoked browser to report a revoked-session recovery state');
    assert(secondBrowserAfterRevoke.recovery.activeDeviceCount === 1, 'Expected revoked browser to see that another device remains');
    assert(secondBrowserAfterRevoke.recovery.canSelfRecover === false, 'Expected revoked browser not to self-recover');

    const renamedIdentity = await readJson<{
      currentIdentity: { id: string; display_name: string };
    }>(await fetch(`${base}/review-room/api/identity`, {
      method: 'PATCH',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ displayName: 'Samuel Session' }),
    }));
    assert(renamedIdentity.currentIdentity.id === 'session-sam', 'Expected rename to preserve the stable actor identity');
    assert(renamedIdentity.currentIdentity.display_name === 'Samuel Session', 'Expected session-backed profile rename');

    const logoutResponse = await fetch(`${base}/review-room/api/session/logout`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, Cookie: sessionCookie },
    });
    assert(logoutResponse.ok, `Expected logout success, got ${logoutResponse.status}`);
    const clearedCookie = logoutResponse.headers.get('set-cookie') ?? '';
    assert(clearedCookie.includes('proof_review_room_session='), 'Expected logout to clear the Review Room session cookie');
    assert(clearedCookie.includes('Max-Age=0'), 'Expected logout cookie to expire immediately');

    const revokedSessionIdentity = await readJson<{
      currentIdentity: { id: string };
      session: { active: boolean };
      recovery: { state: string; activeDeviceCount: number | null; canCreateEnrollment: boolean; emailDelivery: { enabled: boolean } };
    }>(await fetch(`${base}/review-room/api/identity`, {
      headers: { ...CLIENT_HEADERS, Cookie: sessionCookie },
    }));
    assert(revokedSessionIdentity.currentIdentity.id === 'local-human', 'Expected revoked session to stop asserting the collaborator identity');
    assert(revokedSessionIdentity.session.active === false, 'Expected revoked session to report inactive');
    assert(revokedSessionIdentity.recovery.state === 'no_authenticated_devices', 'Expected loss of the last session to report no authenticated devices');
    assert(revokedSessionIdentity.recovery.activeDeviceCount === 0, 'Expected no remaining active devices for the previous identity');
    assert(revokedSessionIdentity.recovery.canCreateEnrollment === false, 'Expected no-device recovery state to block enrollment creation');
    assert(revokedSessionIdentity.recovery.emailDelivery.enabled === false, 'Expected email delivery to stay disabled without a recovery factor');

    const enrollmentWithoutDevice = await fetch(`${base}/review-room/api/session/enrollments`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({}),
    });
    assert(enrollmentWithoutDevice.status === 401, `Expected no-device enrollment status 401, got ${enrollmentWithoutDevice.status}`);
    const noDevicePayload = await enrollmentWithoutDevice.json() as { code?: string; recovery?: { state?: string; canSelfRecover?: boolean } };
    assert(noDevicePayload.code === 'NO_AUTHENTICATED_DEVICE', 'Expected enrollment failure to use explicit no-device code');
    assert(noDevicePayload.recovery?.state === 'no_authenticated_devices', 'Expected enrollment failure to include no-device recovery state');
    assert(noDevicePayload.recovery?.canSelfRecover === false, 'Expected enrollment failure to keep self-recovery disabled');

    const editorList = await readJson<{ documents: Array<{ proofSlug?: string; currentRole?: string; capabilities?: { canEdit?: boolean } }> }>(
      await fetch(`${base}/review-room/api/documents?identityId=editor-alice`, { headers: CLIENT_HEADERS }),
    );
    const listedForEditor = editorList.documents.find((document) => document.proofSlug === slug);
    assert(listedForEditor?.currentRole === 'editor', 'Expected invited editor to see the document as editor');
    assert(listedForEditor.capabilities?.canEdit === true, 'Expected invited editor to receive edit capability');

    const editorBaseline = await readJson<{ success: boolean; baseline: { versionNumber: number } }>(
      await postJson(base, `/review-room/api/documents/${slug}/baselines`, { note: 'Editor checkpoint' }, {
        'x-share-token': editorToken,
      }),
    );
    assert(editorBaseline.success === true, 'Expected editor token to create baseline');
    assert(editorBaseline.baseline.versionNumber === 1, 'Expected editor baseline version 1');

    const editorCannotInvite = await postJson(base, `/review-room/api/documents/${slug}/members`, {
      identityId: 'viewer-vic',
      displayName: 'Viewer Vic',
      role: 'viewer',
    }, {
      'x-share-token': editorToken,
    });
    assert(editorCannotInvite.status === 403, `Expected editor member invite status 403, got ${editorCannotInvite.status}`);

    const viewerMember = await readJson<{
      success: boolean;
      member: { role: string; shareRole: string; accessToken: string };
    }>(await postJson(base, `/review-room/api/documents/${slug}/members`, {
      identityId: 'editor-alice',
      displayName: 'Editor Alice',
      role: 'viewer',
    }));
    assert(viewerMember.success === true, 'Expected owner to downgrade member');
    assert(viewerMember.member.role === 'viewer', 'Expected downgraded member role');
    assert(viewerMember.member.shareRole === 'viewer', 'Expected downgraded share role');
    assert(viewerMember.member.accessToken !== editorToken, 'Expected role change to mint a new token');

    const oldEditorTitle = await fetch(`${base}/api/documents/${slug}/title`, {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-share-token': editorToken },
      body: JSON.stringify({ title: 'Old editor token should fail' }),
    });
    assert(oldEditorTitle.status === 403, `Expected old editor token to be revoked, got ${oldEditorTitle.status}`);

    const viewerBaselineList = await readJson<{ success: boolean; baselines: unknown[] }>(
      await fetch(`${base}/review-room/api/documents/${slug}/baselines`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': viewerMember.member.accessToken },
      }),
    );
    assert(viewerBaselineList.success === true, 'Expected viewer token to read baselines');
    assert(viewerBaselineList.baselines.length === 1, 'Expected viewer to see existing baseline');

    const viewerBaselineCreate = await postJson(base, `/review-room/api/documents/${slug}/baselines`, { note: 'Viewer should fail' }, {
      'x-share-token': viewerMember.member.accessToken,
    });
    assert(viewerBaselineCreate.status === 403, `Expected viewer baseline create status 403, got ${viewerBaselineCreate.status}`);

    const members = await readJson<{ success: boolean; members: Array<{ identityId: string; role: string; accessToken?: string; openPath?: string }> }>(
      await fetch(`${base}/review-room/api/documents/${slug}/members`, { headers: CLIENT_HEADERS }),
    );
    assert(members.success === true, 'Expected owner to list members');
    assert(
      members.members.some((member) => member.identityId === 'editor-alice' && member.role === 'viewer'),
      'Expected member list to include downgraded collaborator',
    );
    assert(members.members.every((member) => member.accessToken === undefined), 'Expected member list not to expose access tokens');
    const listedEditor = members.members.find((member) => member.identityId === 'editor-alice');
    assert(listedEditor?.openPath?.includes('token='), 'Expected owner member list to expose tokenized collaborator open paths');

    const viewerCannotRevoke = await fetch(`${base}/review-room/api/documents/${slug}/members/local-human`, {
      method: 'DELETE',
      headers: { ...CLIENT_HEADERS, 'x-share-token': viewerMember.member.accessToken },
    });
    assert(viewerCannotRevoke.status === 403, `Expected viewer member revoke status 403, got ${viewerCannotRevoke.status}`);

    const ownerCannotRevokeSelf = await fetch(`${base}/review-room/api/documents/${slug}/members/local-human`, {
      method: 'DELETE',
      headers: CLIENT_HEADERS,
    });
    assert(ownerCannotRevokeSelf.status === 409, `Expected owner self-revoke status 409, got ${ownerCannotRevokeSelf.status}`);

    const revokedViewer = await readJson<{ success: boolean; identityId: string; status: string }>(
      await fetch(`${base}/review-room/api/documents/${slug}/members/editor-alice`, {
        method: 'DELETE',
        headers: CLIENT_HEADERS,
      }),
    );
    assert(revokedViewer.success === true, 'Expected owner to revoke collaborator access');
    assert(revokedViewer.status === 'revoked', 'Expected explicit revoked member status');

    const revokedViewerState = await fetch(`${base}/api/documents/${slug}/open-context`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': viewerMember.member.accessToken },
    });
    assert(revokedViewerState.status === 401, `Expected revoked member token status 401, got ${revokedViewerState.status}`);

    const membersAfterRevoke = await readJson<{ members: Array<{ identityId: string }> }>(
      await fetch(`${base}/review-room/api/documents/${slug}/members`, { headers: CLIENT_HEADERS }),
    );
    assert(
      !membersAfterRevoke.members.some((member) => member.identityId === 'editor-alice'),
      'Expected revoked collaborator to be removed from the active member list',
    );

    console.log('✓ Review Room Phase 2 permissions runway');
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
