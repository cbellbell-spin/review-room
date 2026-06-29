import { createHash } from 'crypto';
import {
  storeCreateReviewRoomHistoryEvent,
  storeGetReviewRoomDocumentByProofSlug,
} from './review-room-store.js';

function reviewRoomActorType(actor: string): 'human' | 'agent' {
  return actor.trim().startsWith('ai:') ? 'agent' : 'human';
}

function hashAuditValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashAuditJson(value: unknown): string {
  return hashAuditValue(JSON.stringify(value ?? null));
}

function previewText(value: string, maxLength = 260): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function changedTextPreview(before: string, after: string): {
  beforeChangedPreview: string;
  afterChangedPreview: string;
} {
  if (before === after) return { beforeChangedPreview: '', afterChangedPreview: '' };
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeChanged = before.slice(prefix, before.length - suffix);
  const afterChanged = after.slice(prefix, after.length - suffix);
  return {
    beforeChangedPreview: previewText(beforeChanged || before),
    afterChangedPreview: previewText(afterChanged || after),
  };
}

export function auditMutationFields(input: {
  markdown: boolean;
  marks: boolean;
  title: boolean;
}): string[] {
  return [
    ...(input.markdown ? ['markdown'] : []),
    ...(input.marks ? ['marks'] : []),
    ...(input.title ? ['title'] : []),
  ];
}

export async function recordReviewRoomDirectMutationAudit(input: {
  slug: string;
  actor: string;
  route: string;
  source: string;
  changedFields: string[];
  before: {
    title?: string | null;
    markdown?: string | null;
    marks?: Record<string, unknown> | null;
    revision?: number | null;
    updatedAt?: string | null;
  };
  after: {
    title?: string | null;
    markdown?: string | null;
    marks?: Record<string, unknown> | null;
    revision?: number | null;
    updatedAt?: string | null;
  };
}): Promise<void> {
  if (input.changedFields.length === 0) return;
  try {
    const reviewRoomDocument = await storeGetReviewRoomDocumentByProofSlug(input.slug);
    if (!reviewRoomDocument) return;
    const before: Record<string, unknown> = {
      revision: input.before.revision ?? null,
      updatedAt: input.before.updatedAt ?? null,
    };
    const after: Record<string, unknown> = {
      revision: input.after.revision ?? null,
      updatedAt: input.after.updatedAt ?? null,
      changedFields: input.changedFields,
    };
    if (input.changedFields.includes('title')) {
      before.title = input.before.title ?? null;
      after.title = input.after.title ?? null;
    }
    if (input.changedFields.includes('markdown')) {
      const beforeMarkdown = input.before.markdown ?? '';
      const afterMarkdown = input.after.markdown ?? '';
      const changedPreview = changedTextPreview(beforeMarkdown, afterMarkdown);
      before.markdownHash = hashAuditValue(beforeMarkdown);
      before.markdownLength = beforeMarkdown.length;
      before.markdownPreview = previewText(beforeMarkdown);
      before.markdownChangedPreview = changedPreview.beforeChangedPreview;
      after.markdownHash = hashAuditValue(afterMarkdown);
      after.markdownLength = afterMarkdown.length;
      after.markdownPreview = previewText(afterMarkdown);
      after.markdownChangedPreview = changedPreview.afterChangedPreview;
    }
    if (input.changedFields.includes('marks')) {
      before.marksHash = hashAuditJson(input.before.marks ?? {});
      after.marksHash = hashAuditJson(input.after.marks ?? {});
    }
    await storeCreateReviewRoomHistoryEvent({
      workspaceId: reviewRoomDocument.workspace_id,
      documentId: reviewRoomDocument.id,
      actorId: input.actor,
      actorType: reviewRoomActorType(input.actor),
      eventType: 'document.direct_mutation',
      targetType: 'document',
      targetId: reviewRoomDocument.id,
      before,
      after,
      metadata: {
        proofSlug: input.slug,
        route: input.route,
        source: input.source,
        reviewStatus: 'open',
        reviewable: true,
      },
    });
  } catch (error) {
    console.error('[review-room] failed to record direct mutation audit event', {
      slug: input.slug,
      route: input.route,
      error,
    });
  }
}
