import type { ReviewRoomHistoryEvent } from '../bridge/share-client';
import { getReviewRoomSuggestionGroups } from './suggestion-groups';

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

export function filterReviewComments(comments: ReviewComment[], filter: ReviewCommentFilter): ReviewComment[] {
  if (filter === 'open') return comments.filter((comment) => !comment.resolved);
  if (filter === 'resolved') return comments.filter((comment) => comment.resolved);
  return comments;
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
