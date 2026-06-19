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
