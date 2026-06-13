import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type JsonRow = Record<string, unknown>;

type ExportBundle = {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    kind: 'vercel-api';
    baseUrl: string;
    tokenPolicy: 'used-for-export-only';
  };
  filters: {
    slugs: string[];
    includeDeleted: boolean;
  };
  tables: Record<string, JsonRow[]>;
  counts: Record<string, number>;
  warnings: string[];
};

const REVIEW_ROOM_TABLES = [
  'review_room_workspaces',
  'review_room_identities',
  'review_room_documents',
  'review_room_document_members',
  'review_room_agents',
  'review_room_document_agent_settings',
  'review_room_assignment_tasks',
  'review_room_published_versions',
  'review_room_history_events',
] as const;

function parseArgs(argv: string[]): {
  baseUrl: string;
  out: string;
  slugs: string[];
  includeDeleted: boolean;
} {
  const args = [...argv];
  const result = {
    baseUrl: 'https://proof-sdk-psi.vercel.app',
    out: '',
    slugs: [] as string[],
    includeDeleted: false,
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--base-url') {
      result.baseUrl = requireValue(args, '--base-url').replace(/\/+$/, '');
      continue;
    }
    if (arg === '--out') {
      result.out = requireValue(args, '--out');
      continue;
    }
    if (arg === '--slug') {
      result.slugs.push(requireValue(args, '--slug'));
      continue;
    }
    if (arg === '--include-deleted') {
      result.includeDeleted = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.out) throw new Error('Missing --out <path>');
  return result;
}

function requireValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Export legacy Vercel Review Room documents through the public API.

Usage:
  npm run migrate:review-room:export-api -- --out /tmp/review-room-vercel-api-export.json

Options:
  --base-url <url>      Legacy Vercel base URL. Defaults to https://proof-sdk-psi.vercel.app.
  --out <path>          Required JSON bundle path.
  --slug <slug>         Export one slug. Repeat to export a subset.
  --include-deleted     Include documents whose list response reports shareState='DELETED'.

Secrets:
  The old API share tokens are used to read state, but they are not written to the export bundle.
`);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : [];
}

function nowIso(): string {
  return new Date().toISOString();
}

function plainText(markdown: string): string {
  return markdown
    .replace(/<\/?(?:p|br|div|li|ul|ol|blockquote|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTokenFromOpenPath(baseUrl: string, openPath: unknown): string | null {
  if (typeof openPath !== 'string' || !openPath.trim()) return null;
  try {
    return new URL(openPath, baseUrl).searchParams.get('token');
  } catch {
    return null;
  }
}

async function fetchJson(baseUrl: string, apiPath: string, token?: string | null): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (token) headers['x-share-token'] = token;
  const response = await fetch(`${baseUrl}${apiPath}`, { headers });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${apiPath} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const error = jsonObject(parsed).error ?? text.slice(0, 200);
    throw new Error(`${apiPath} failed HTTP ${response.status}: ${String(error)}`);
  }
  return jsonObject(parsed);
}

function addIdentity(rows: Map<string, JsonRow>, input: {
  id: unknown;
  workspaceId?: unknown;
  kind?: unknown;
  displayName?: unknown;
  managerIdentityId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}): void {
  const id = stringValue(input.id).trim();
  if (!id) return;
  const now = nowIso();
  rows.set(id, {
    id,
    workspace_id: stringValue(input.workspaceId, 'local'),
    kind: stringValue(input.kind, 'human') === 'agent' ? 'agent' : 'human',
    display_name: stringValue(input.displayName, id),
    manager_identity_id: stringValue(input.managerIdentityId) || null,
    created_at: stringValue(input.createdAt, now),
    updated_at: stringValue(input.updatedAt, now),
  });
}

function serializeJson(value: unknown, fallback: unknown): string {
  return JSON.stringify(value === undefined ? fallback : value);
}

function normalizeReviewRoomRole(value: unknown): 'owner' | 'editor' | 'commenter' | 'viewer' {
  return value === 'owner' || value === 'editor' || value === 'commenter' || value === 'viewer'
    ? value
    : 'viewer';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const list = await fetchJson(args.baseUrl, '/review-room/api/documents');
  const requestedSlugs = new Set(args.slugs.map((slug) => slug.trim()).filter(Boolean));
  const documents = jsonArray(list.documents)
    .filter((doc) => requestedSlugs.size === 0 || requestedSlugs.has(stringValue(doc.proofSlug)))
    .filter((doc) => args.includeDeleted || stringValue(doc.shareState, 'ACTIVE') !== 'DELETED');

  const tables: Record<string, JsonRow[]> = {
    documents: [],
    document_projections: [],
    events: [],
    document_events: [],
    review_room_workspaces: [],
    review_room_identities: [],
    review_room_documents: [],
    review_room_document_members: [],
    review_room_agents: [],
    review_room_document_agent_settings: [],
    review_room_assignment_tasks: [],
    review_room_published_versions: [],
    review_room_history_events: [],
  };
  const identityRows = new Map<string, JsonRow>();
  const workspaceRows = new Map<string, JsonRow>();
  const warnings: string[] = [];
  const currentIdentity = jsonObject(list.currentIdentity);
  if (currentIdentity.id) {
    addIdentity(identityRows, {
      id: currentIdentity.id,
      workspaceId: currentIdentity.workspace_id,
      kind: currentIdentity.kind,
      displayName: currentIdentity.display_name,
      managerIdentityId: currentIdentity.manager_identity_id,
      createdAt: currentIdentity.created_at,
      updatedAt: currentIdentity.updated_at,
    });
  }

  for (const listed of documents) {
    const slug = stringValue(listed.proofSlug);
    if (!slug) continue;
    const token = extractTokenFromOpenPath(args.baseUrl, listed.openPath);
    if (!token) {
      warnings.push(`${slug}: skipped because list response did not include an export token`);
      continue;
    }
    const state = await fetchJson(args.baseUrl, `/documents/${encodeURIComponent(slug)}/state`, token);
    const markdown = stringValue(state.markdown ?? jsonObject(state.doc).markdown);
    const marksObject = jsonObject(state.marks ?? jsonObject(state.doc).marks);
    const marks = JSON.stringify(marksObject);
    const revision = numberValue(state.revision ?? jsonObject(state.doc).revision, 1);
    const title = stringValue(listed.title ?? jsonObject(state.doc).title, 'Untitled');
    const createdAt = stringValue(listed.proofCreatedAt ?? listed.createdAt, nowIso());
    const updatedAt = stringValue(listed.proofUpdatedAt ?? listed.updatedAt, createdAt);
    const workspaceId = stringValue(listed.workspaceId, 'local');
    const reviewRoomDocumentId = stringValue(listed.id);
    const currentIdentityId = stringValue(currentIdentity.id, 'local-human');

    workspaceRows.set(workspaceId, {
      id: workspaceId,
      name: workspaceId === 'local' ? 'Local Review Room' : workspaceId,
      created_at: stringValue(currentIdentity.created_at, createdAt),
      updated_at: updatedAt,
    });

    tables.documents.push({
      slug,
      doc_id: stringValue(listed.proofDocId) || null,
      title,
      markdown,
      marks,
      revision,
      y_state_version: 0,
      share_state: stringValue(listed.shareState, 'ACTIVE'),
      access_epoch: 0,
      collab_bootstrap_epoch: 0,
      live_collab_seen_at: null,
      live_collab_access_epoch: null,
      active: stringValue(listed.shareState, 'ACTIVE') === 'DELETED' ? 0 : 1,
      owner_id: currentIdentityId ? `human:${currentIdentityId}` : null,
      owner_secret: null,
      owner_secret_hash: null,
      created_at: createdAt,
      updated_at: updatedAt,
      deleted_at: null,
    });
    tables.document_projections.push({
      document_slug: slug,
      revision,
      y_state_version: 0,
      markdown,
      marks_json: marks,
      plain_text: plainText(markdown),
      updated_at: updatedAt,
      health: 'healthy',
      health_reason: null,
    });

    tables.review_room_documents.push({
      id: reviewRoomDocumentId,
      workspace_id: workspaceId,
      title,
      proof_slug: slug,
      proof_doc_id: stringValue(listed.proofDocId) || null,
      source: stringValue(listed.source, 'created'),
      owner_identity_id: currentIdentityId,
      created_by_identity_id: currentIdentityId,
      created_at: stringValue(listed.createdAt, createdAt),
      updated_at: stringValue(listed.updatedAt, updatedAt),
    });

    const members = await fetchJson(args.baseUrl, `/review-room/api/documents/${encodeURIComponent(slug)}/members`, token)
      .catch((error) => {
        warnings.push(`${slug}: members export skipped (${error instanceof Error ? error.message : String(error)})`);
        return {};
      });
    const memberRows = jsonArray(members.members);
    if (memberRows.length === 0) {
      tables.review_room_document_members.push({
        review_room_document_id: reviewRoomDocumentId,
        identity_id: currentIdentityId,
        role: normalizeReviewRoomRole(listed.currentRole),
        proof_access_token_id: null,
        proof_access_token: null,
        created_at: stringValue(listed.createdAt, createdAt),
        updated_at: stringValue(listed.updatedAt, updatedAt),
      });
    } else {
      for (const member of memberRows) {
        const identityId = stringValue(member.identityId);
        addIdentity(identityRows, {
          id: identityId,
          workspaceId,
          kind: member.identityKind,
          displayName: member.displayName,
          createdAt: member.createdAt,
          updatedAt: member.updatedAt,
        });
        tables.review_room_document_members.push({
          review_room_document_id: reviewRoomDocumentId,
          identity_id: identityId,
          role: normalizeReviewRoomRole(member.role),
          proof_access_token_id: null,
          proof_access_token: null,
          created_at: stringValue(member.createdAt, createdAt),
          updated_at: stringValue(member.updatedAt, updatedAt),
        });
      }
    }

    const history = await fetchJson(args.baseUrl, `/review-room/api/documents/${encodeURIComponent(slug)}/history?limit=500`, token)
      .catch((error) => {
        warnings.push(`${slug}: history export skipped (${error instanceof Error ? error.message : String(error)})`);
        return {};
      });
    for (const event of jsonArray(history.events)) {
      tables.review_room_history_events.push({
        id: stringValue(event.id),
        workspace_id: stringValue(event.workspaceId, workspaceId),
        document_id: stringValue(event.documentId, reviewRoomDocumentId) || reviewRoomDocumentId,
        actor_id: stringValue(event.actorId, currentIdentityId),
        actor_type: stringValue(event.actorType, 'human'),
        event_type: stringValue(event.eventType, 'migration.imported'),
        target_type: stringValue(event.targetType) || null,
        target_id: stringValue(event.targetId) || null,
        before_json: event.before == null ? null : serializeJson(event.before, null),
        after_json: event.after == null ? null : serializeJson(event.after, null),
        rationale: stringValue(event.rationale) || null,
        metadata_json: serializeJson(event.metadata, {}),
        created_at: stringValue(event.createdAt, updatedAt),
      });
    }

    const tasks = await fetchJson(args.baseUrl, `/review-room/api/documents/${encodeURIComponent(slug)}/tasks?status=all`, token)
      .catch((error) => {
        warnings.push(`${slug}: tasks export skipped (${error instanceof Error ? error.message : String(error)})`);
        return {};
      });
    for (const task of jsonArray(tasks.tasks)) {
      tables.review_room_assignment_tasks.push({
        id: stringValue(task.id),
        document_id: stringValue(task.documentId, reviewRoomDocumentId) || reviewRoomDocumentId,
        proof_event_id: null,
        source_type: stringValue(task.sourceType, 'migration'),
        source_id: stringValue(task.sourceId) || null,
        created_by_actor_id: stringValue(task.createdByActorId, currentIdentityId),
        created_by_actor_type: stringValue(task.createdByActorType, 'human'),
        assigned_to_actor_id: stringValue(task.assignedToActorId, currentIdentityId),
        assigned_to_actor_type: stringValue(task.assignedToActorType, 'human'),
        manager_identity_id: stringValue(task.managerIdentityId) || null,
        status: stringValue(task.status, 'open'),
        created_at: stringValue(task.createdAt, createdAt),
        updated_at: stringValue(task.updatedAt, updatedAt),
        completed_at: stringValue(task.completedAt) || null,
      });
    }

    const baselines = await fetchJson(args.baseUrl, `/review-room/api/documents/${encodeURIComponent(slug)}/baselines`, token)
      .catch((error) => {
        warnings.push(`${slug}: baselines export skipped (${error instanceof Error ? error.message : String(error)})`);
        return {};
      });
    for (const baseline of jsonArray(baselines.baselines)) {
      if (typeof baseline.contentSnapshot !== 'string') {
        warnings.push(`${slug}: baseline ${stringValue(baseline.id)} metadata found, but content snapshot is not exposed by the API`);
        continue;
      }
      tables.review_room_published_versions.push({
        id: stringValue(baseline.id),
        document_id: stringValue(baseline.documentId, reviewRoomDocumentId) || reviewRoomDocumentId,
        version_number: numberValue(baseline.versionNumber, 1),
        proof_revision: baseline.proofRevision ?? null,
        content_snapshot: baseline.contentSnapshot,
        created_by_identity_id: stringValue(baseline.createdByIdentityId, currentIdentityId),
        created_at: stringValue(baseline.createdAt, createdAt),
        note: stringValue(baseline.note) || null,
      });
    }
  }

  tables.review_room_workspaces = Array.from(workspaceRows.values());
  tables.review_room_identities = Array.from(identityRows.values());
  for (const table of REVIEW_ROOM_TABLES) tables[table] ??= [];

  const counts = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length]));
  const bundle: ExportBundle = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    source: {
      kind: 'vercel-api',
      baseUrl: args.baseUrl,
      tokenPolicy: 'used-for-export-only',
    },
    filters: {
      slugs: Array.from(requestedSlugs),
      includeDeleted: args.includeDeleted,
    },
    tables,
    counts,
    warnings,
  };

  mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  console.log(`[export-api] Wrote ${counts.documents ?? 0} document(s) to ${args.out}`);
  if (warnings.length > 0) {
    console.log(`[export-api] Completed with ${warnings.length} warning(s). See bundle.warnings for details.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
