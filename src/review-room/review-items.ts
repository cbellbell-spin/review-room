import type { ReviewRoomAssignmentTask, ReviewRoomAssignmentTaskStatus, ReviewRoomHistoryEvent } from '../bridge/share-client';
import { getReviewRoomSuggestionGroups, type ReviewRoomSuggestionGroup, type ReviewRoomSuggestionKind } from './suggestion-groups';

// Pure Review Room review-item logic, extracted from the editor monolith so the
// cockpit UI, counts, and future tabs share one derivation path.

export type ReviewCommentReply = {
  by: string;
  at: string;
  text: string;
};

export type ReviewComment = {
  id: string;
  by: string;
  at: string;
  quote: string;
  text: string;
  replies: ReviewCommentReply[];
  resolved: boolean;
};

export type ReviewCommentFilter = 'open' | 'resolved' | 'all';
export type ReviewActorFilter = 'all' | string;
export type ReviewSuggestionKindFilter = 'all' | ReviewRoomSuggestionKind;
export type ReviewHistoryEventTypeFilter = 'all' | string;
export type ReviewTaskStatusFilter = 'all' | ReviewRoomAssignmentTaskStatus;

export type ReviewCommentCounts = {
  open: number;
  resolved: number;
  all: number;
};

type MarksRecord = Record<string, unknown>;

export function deriveReviewComments(marks: MarksRecord | null | undefined): ReviewComment[] {
  const comments: ReviewComment[] = [];
  for (const [id, raw] of Object.entries(marks ?? {})) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const mark = raw as Record<string, unknown>;
    if (mark.kind !== 'comment') continue;
    const rawReplies = Array.isArray(mark.replies)
      ? mark.replies
      : Array.isArray(mark.thread)
        ? mark.thread
        : [];
    const replies = rawReplies
      .filter((reply): reply is Record<string, unknown> => Boolean(reply) && typeof reply === 'object' && !Array.isArray(reply))
      .map((reply) => ({
        by: typeof reply.by === 'string' ? reply.by : 'unknown',
        at: typeof reply.at === 'string' ? reply.at : '',
        text: typeof reply.text === 'string' ? reply.text : '',
      }))
      .filter((reply) => reply.text.trim().length > 0);
    comments.push({
      id,
      by: typeof mark.by === 'string' ? mark.by : 'unknown',
      at: typeof mark.createdAt === 'string' ? mark.createdAt : '',
      quote: typeof mark.quote === 'string' ? mark.quote : '',
      text: typeof mark.text === 'string' ? mark.text : '',
      replies,
      resolved: mark.resolved === true,
    });
  }
  return comments;
}

export function countReviewComments(comments: ReviewComment[]): ReviewCommentCounts {
  const open = comments.filter((comment) => !comment.resolved).length;
  return { open, resolved: comments.length - open, all: comments.length };
}

export function normalizeReviewActorFilter(value: string | null | undefined): ReviewActorFilter {
  const actor = typeof value === 'string' ? value.trim() : '';
  return actor || 'all';
}

export function reviewActorMatches(actor: string | null | undefined, filter: ReviewActorFilter): boolean {
  if (filter === 'all') return true;
  return (actor ?? '').trim() === filter;
}

export function collectReviewActorOptions(actors: Array<string | null | undefined>): string[] {
  return Array.from(new Set(
    actors
      .map((actor) => (actor ?? '').trim())
      .filter((actor) => actor.length > 0),
  )).sort((a, b) => a.localeCompare(b));
}

export function reviewCommentMatchesActor(comment: ReviewComment, filter: ReviewActorFilter): boolean {
  if (reviewActorMatches(comment.by, filter)) return true;
  return comment.replies.some((reply) => reviewActorMatches(reply.by, filter));
}

export function filterReviewComments(
  comments: ReviewComment[],
  filter: ReviewCommentFilter,
  actorFilter: ReviewActorFilter = 'all',
): ReviewComment[] {
  return comments.filter((comment) => {
    if (filter === 'open' && comment.resolved) return false;
    if (filter === 'resolved' && !comment.resolved) return false;
    return reviewCommentMatchesActor(comment, actorFilter);
  });
}

export function collectReviewCommentActors(comments: ReviewComment[]): string[] {
  return collectReviewActorOptions(comments.flatMap((comment) => [
    comment.by,
    ...comment.replies.map((reply) => reply.by),
  ]));
}

export function filterReviewSuggestions(
  suggestions: ReviewRoomSuggestionGroup[],
  filters: { actorFilter?: ReviewActorFilter; kindFilter?: ReviewSuggestionKindFilter } = {},
): ReviewRoomSuggestionGroup[] {
  const actorFilter = filters.actorFilter ?? 'all';
  const kindFilter = filters.kindFilter ?? 'all';
  return suggestions.filter((suggestion) => (
    reviewActorMatches(suggestion.by, actorFilter)
    && (kindFilter === 'all' || suggestion.kind === kindFilter)
  ));
}

export function collectReviewSuggestionActors(suggestions: ReviewRoomSuggestionGroup[]): string[] {
  return collectReviewActorOptions(suggestions.map((suggestion) => suggestion.by));
}

export function collectReviewSuggestionKinds(suggestions: ReviewRoomSuggestionGroup[]): ReviewRoomSuggestionKind[] {
  return Array.from(new Set(suggestions.map((suggestion) => suggestion.kind))).sort();
}

export function filterReviewHistoryEvents(
  events: ReviewRoomHistoryEvent[],
  filters: { actorFilter?: ReviewActorFilter; eventTypeFilter?: ReviewHistoryEventTypeFilter } = {},
): ReviewRoomHistoryEvent[] {
  const actorFilter = filters.actorFilter ?? 'all';
  const eventTypeFilter = filters.eventTypeFilter ?? 'all';
  return events.filter((event) => (
    reviewActorMatches(event.actorId, actorFilter)
    && (eventTypeFilter === 'all' || event.eventType === eventTypeFilter)
  ));
}

export function collectReviewHistoryActors(events: ReviewRoomHistoryEvent[]): string[] {
  return collectReviewActorOptions(events.map((event) => event.actorId));
}

export function collectReviewHistoryEventTypes(events: ReviewRoomHistoryEvent[]): string[] {
  return Array.from(new Set(
    events
      .map((event) => event.eventType.trim())
      .filter((eventType) => eventType.length > 0),
  )).sort((a, b) => a.localeCompare(b));
}

export function filterReviewTasks(
  tasks: ReviewRoomAssignmentTask[],
  filters: { actorFilter?: ReviewActorFilter; statusFilter?: ReviewTaskStatusFilter } = {},
): ReviewRoomAssignmentTask[] {
  const actorFilter = filters.actorFilter ?? 'all';
  const statusFilter = filters.statusFilter ?? 'all';
  return tasks.filter((task) => (
    (reviewActorMatches(task.assignedToActorId, actorFilter) || reviewActorMatches(task.createdByActorId, actorFilter))
    && (statusFilter === 'all' || task.status === statusFilter)
  ));
}

export function collectReviewTaskActors(tasks: ReviewRoomAssignmentTask[]): string[] {
  return collectReviewActorOptions(tasks.flatMap((task) => [task.assignedToActorId, task.createdByActorId]));
}

export function collectReviewTaskStatuses(tasks: ReviewRoomAssignmentTask[]): ReviewRoomAssignmentTaskStatus[] {
  return Array.from(new Set(tasks.map((task) => task.status))).sort();
}

export function countOpenReviewItems(doc: { marks?: MarksRecord }): number {
  const suggestions = getReviewRoomSuggestionGroups(doc).length;
  const openComments = countReviewComments(deriveReviewComments(doc.marks)).open;
  return suggestions + openComments;
}

export type ReviewHistoryRow = {
  id: string;
  title: string;
  actorId: string;
  timestamp: string;
  beforeText: string;
  afterText: string;
  targetLabel: string;
};

function readHistoryText(payload: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!payload) return '';
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function formatReviewTimestamp(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString();
}

export function historyEventTitle(event: ReviewRoomHistoryEvent): string {
  if (event.eventType === 'suggestion.accepted') return 'Accepted suggestion';
  if (event.eventType === 'suggestion.rejected') return 'Rejected suggestion';
  if (event.eventType === 'document.created') return 'Created document';
  if (event.eventType === 'document.registered') return 'Registered document';
  if (event.eventType === 'task.created') return 'Created task';
  if (event.eventType === 'task.status_changed') return 'Updated task status';
  if (event.eventType === 'baseline.created') return 'Created baseline';
  return event.eventType.replace(/\./g, ' ');
}

export function shapeHistoryRow(event: ReviewRoomHistoryEvent): ReviewHistoryRow {
  return {
    id: event.id,
    title: historyEventTitle(event),
    actorId: event.actorId,
    timestamp: formatReviewTimestamp(event.createdAt),
    beforeText: readHistoryText(event.before, ['beforeContent', 'quote', 'content', 'title']),
    afterText: readHistoryText(event.after, ['afterContent', 'content', 'title', 'quote']),
    targetLabel: event.targetId ? `${event.targetType || 'item'} ${event.targetId}` : '',
  };
}
