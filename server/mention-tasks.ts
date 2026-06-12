import type { ReviewRoomAssignmentTaskRow } from './db.js';
import {
  storeCreateAssignmentTask,
  storeCreateReviewRoomHistoryEvent,
  storeGetReviewRoomDocumentByProofSlug,
  storeListAssignmentTasks,
  storeListReviewRoomAgents,
  storeListReviewRoomIdentities,
} from './review-room-store.js';

type MentionTarget = {
  id: string;
  type: 'agent' | 'human';
  label: string;
  aliases: string[];
  managerIdentityId: string | null;
};

type MentionTaskInput = {
  proofSlug: string;
  sourceId: string | null;
  text: string;
  actorId: string;
  proofEventId?: number | null;
};

function normalizeAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function compactAlias(value: string): string {
  return normalizeAlias(value).replace(/\s+/g, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actorTypeFor(actorId: string): ReviewRoomAssignmentTaskRow['created_by_actor_type'] {
  const normalized = actorId.trim().toLowerCase();
  if (normalized.startsWith('ai:') || normalized.startsWith('agent:')) return 'agent';
  if (normalized.startsWith('human:') || normalized.startsWith('review-room:')) return 'human';
  return 'system';
}

function targetAliases(...values: Array<string | null | undefined>): string[] {
  const aliases = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const normalized = normalizeAlias(value);
    if (!normalized) continue;
    aliases.add(normalized);
    const compact = compactAlias(normalized);
    if (compact && compact !== normalized) aliases.add(compact);
  }
  return [...aliases];
}

function textMentionsAlias(text: string, alias: string): boolean {
  const normalizedAlias = normalizeAlias(alias);
  if (!normalizedAlias) return false;
  const pattern = normalizedAlias
    .split(' ')
    .map(escapeRegex)
    .join('(?:\\s+|[_-]+)');
  const mention = new RegExp(`(^|[^\\p{L}\\p{N}_-])@${pattern}(?=$|[^\\p{L}\\p{N}_-])`, 'iu');
  if (mention.test(text)) return true;

  const compact = compactAlias(normalizedAlias);
  if (!compact || compact === normalizedAlias) return false;
  const compactMention = new RegExp(`(^|[^\\p{L}\\p{N}_-])@${escapeRegex(compact)}(?=$|[^\\p{L}\\p{N}_-])`, 'iu');
  return compactMention.test(text);
}

function isSelfMention(actorId: string, target: MentionTarget): boolean {
  const actorAlias = normalizeAlias(actorId.replace(/^(ai|agent|human|review-room):/i, ''));
  if (actorId === target.id || normalizeAlias(actorId) === normalizeAlias(target.id)) return true;
  return target.aliases.some((alias) => alias === actorAlias || compactAlias(alias) === compactAlias(actorAlias));
}

async function findMentionTargets(workspaceId: string): Promise<MentionTarget[]> {
  const [agents, identities] = await Promise.all([
    storeListReviewRoomAgents(workspaceId),
    storeListReviewRoomIdentities(workspaceId),
  ]);
  const targets = new Map<string, MentionTarget>();
  for (const agent of agents) {
    targets.set(`agent:${agent.id}`, {
      id: agent.id,
      type: 'agent',
      label: agent.name,
      aliases: targetAliases(agent.name, agent.id),
      managerIdentityId: agent.manager_identity_id,
    });
  }
  for (const identity of identities) {
    const type = identity.kind === 'agent' ? 'agent' : 'human';
    const key = `${type}:${identity.id}`;
    if (targets.has(key)) continue;
    targets.set(key, {
      id: identity.id,
      type,
      label: identity.display_name,
      aliases: targetAliases(identity.display_name, identity.id),
      managerIdentityId: identity.manager_identity_id,
    });
  }
  return [...targets.values()];
}

export async function createAssignmentTasksFromCommentMentions(input: MentionTaskInput): Promise<ReviewRoomAssignmentTaskRow[]> {
  const text = input.text.trim();
  if (!text.includes('@')) return [];
  const document = await storeGetReviewRoomDocumentByProofSlug(input.proofSlug);
  if (!document) return [];

  const targets = await findMentionTargets(document.workspace_id);
  const openTasks = await storeListAssignmentTasks(document.id, 'open');
  const created: ReviewRoomAssignmentTaskRow[] = [];
  for (const target of targets) {
    if (isSelfMention(input.actorId, target)) continue;
    if (!target.aliases.some((alias) => textMentionsAlias(text, alias))) continue;
    if (openTasks.some((task) => (
      task.source_type === 'comment'
      && task.source_id === input.sourceId
      && task.assigned_to_actor_id === target.id
      && task.assigned_to_actor_type === target.type
    ))) {
      continue;
    }
    const task = await storeCreateAssignmentTask({
      documentId: document.id,
      proofEventId: input.proofEventId ?? null,
      sourceType: 'comment',
      sourceId: input.sourceId,
      createdByActorId: input.actorId,
      createdByActorType: actorTypeFor(input.actorId),
      assignedToActorId: target.id,
      assignedToActorType: target.type,
      managerIdentityId: target.managerIdentityId,
    });
    await storeCreateReviewRoomHistoryEvent({
      workspaceId: document.workspace_id,
      documentId: document.id,
      actorId: input.actorId,
      actorType: actorTypeFor(input.actorId),
      eventType: 'task.created',
      targetType: 'assignment_task',
      targetId: task.id,
      after: {
        status: task.status,
        assignedToActorId: target.id,
        assignedToActorType: target.type,
        assignedToLabel: target.label,
        sourceType: task.source_type,
        sourceId: task.source_id,
        sourceText: text,
      },
      metadata: {
        proofSlug: input.proofSlug,
        proofEventId: input.proofEventId ?? null,
      },
    });
    created.push(task);
    openTasks.push(task);
  }
  return created;
}

export async function safeCreateAssignmentTasksFromCommentMentions(input: MentionTaskInput): Promise<ReviewRoomAssignmentTaskRow[]> {
  try {
    return await createAssignmentTasksFromCommentMentions(input);
  } catch (error) {
    console.error('[review-room] mention-to-task wiring failed', {
      proofSlug: input.proofSlug,
      sourceId: input.sourceId,
      actorId: input.actorId,
      error,
    });
    return [];
  }
}
