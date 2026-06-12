import assert from 'node:assert/strict';

import type { ReviewRoomAssignmentTask, ReviewRoomHistoryEvent } from '../bridge/share-client';
import {
  collectReviewCommentActors,
  collectReviewHistoryActors,
  collectReviewHistoryEventTypes,
  collectReviewSuggestionActors,
  collectReviewSuggestionKinds,
  collectReviewTaskActors,
  collectReviewTaskStatuses,
  deriveReviewComments,
  filterReviewComments,
  filterReviewHistoryEvents,
  filterReviewSuggestions,
  filterReviewTasks,
} from '../review-room/review-items';

const comments = deriveReviewComments({
  openFromHuman: {
    kind: 'comment',
    by: 'human:chris',
    createdAt: '2026-06-11T10:00:00.000Z',
    quote: 'Open quote',
    text: 'Please review this.',
    replies: [
      { by: 'ai:codex', at: '2026-06-11T10:01:00.000Z', text: 'On it.' },
    ],
  },
  resolvedFromAgent: {
    kind: 'comment',
    by: 'ai:claude',
    createdAt: '2026-06-11T10:02:00.000Z',
    quote: 'Resolved quote',
    text: 'Done.',
    resolved: true,
  },
});

assert.deepEqual(collectReviewCommentActors(comments), ['ai:claude', 'ai:codex', 'human:chris']);
assert.deepEqual(
  filterReviewComments(comments, 'open', 'ai:codex').map((comment) => comment.id),
  ['openFromHuman'],
  'actor filtering should include comment replies',
);
assert.deepEqual(
  filterReviewComments(comments, 'resolved', 'human:chris'),
  [],
  'status and actor filters should compose for comments',
);

const suggestions = [
  { id: 'replace1', ids: ['replace1'], kind: 'replace' as const, by: 'ai:codex', quote: 'A', content: 'B', count: 1 },
  { id: 'insert1', ids: ['insert1'], kind: 'insert' as const, by: 'human:chris', quote: 'B', content: 'C', count: 1 },
  { id: 'delete1', ids: ['delete1'], kind: 'delete' as const, by: 'ai:codex', quote: 'C', content: '', count: 1 },
];

assert.deepEqual(collectReviewSuggestionActors(suggestions), ['ai:codex', 'human:chris']);
assert.deepEqual(collectReviewSuggestionKinds(suggestions), ['delete', 'insert', 'replace']);
assert.deepEqual(
  filterReviewSuggestions(suggestions, { actorFilter: 'ai:codex', kindFilter: 'delete' }).map((suggestion) => suggestion.id),
  ['delete1'],
);

const historyEvents: ReviewRoomHistoryEvent[] = [
  {
    id: 'history1',
    actorId: 'human:chris',
    actorType: 'human',
    eventType: 'suggestion.accepted',
    createdAt: '2026-06-11T10:03:00.000Z',
  },
  {
    id: 'history2',
    actorId: 'ai:codex',
    actorType: 'agent',
    eventType: 'task.created',
    createdAt: '2026-06-11T10:04:00.000Z',
  },
];

assert.deepEqual(collectReviewHistoryActors(historyEvents), ['ai:codex', 'human:chris']);
assert.deepEqual(collectReviewHistoryEventTypes(historyEvents), ['suggestion.accepted', 'task.created']);
assert.deepEqual(
  filterReviewHistoryEvents(historyEvents, { actorFilter: 'ai:codex', eventTypeFilter: 'task.created' }).map((event) => event.id),
  ['history2'],
);

const taskBase = {
  documentId: 'doc1',
  sourceType: 'comment',
  sourceId: 'comment1',
  sourceText: 'Please review this.',
  createdByActorType: 'human',
  assignedToActorType: 'agent' as const,
  assignedToLabel: 'Codex',
  createdAt: '2026-06-11T10:05:00.000Z',
  updatedAt: '2026-06-11T10:05:00.000Z',
};
const tasks: ReviewRoomAssignmentTask[] = [
  {
    ...taskBase,
    id: 'task1',
    createdByActorId: 'human:chris',
    assignedToActorId: 'ai:codex',
    status: 'open',
  },
  {
    ...taskBase,
    id: 'task2',
    createdByActorId: 'ai:claude',
    assignedToActorId: 'human:chris',
    assignedToActorType: 'human',
    assignedToLabel: 'Chris',
    status: 'completed',
  },
];

assert.deepEqual(collectReviewTaskActors(tasks), ['ai:claude', 'ai:codex', 'human:chris']);
assert.deepEqual(collectReviewTaskStatuses(tasks), ['completed', 'open']);
assert.deepEqual(
  filterReviewTasks(tasks, { actorFilter: 'human:chris', statusFilter: 'completed' }).map((task) => task.id),
  ['task2'],
  'task actor filtering should match creators or assignees',
);

console.log('✓ Review Room cockpit filters review items by actor and type');
