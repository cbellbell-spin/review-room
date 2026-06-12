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
  shapeHistoryRow,
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

const acceptedReplacement = shapeHistoryRow({
  id: 'replace-history',
  actorId: 'ai:codex',
  actorType: 'agent',
  eventType: 'suggestion.accepted',
  targetType: 'suggestion',
  targetId: 'mark-replace',
  before: { kind: 'replace', beforeContent: 'Old paragraph.' },
  after: { kind: 'replace', afterContent: 'New paragraph.' },
  createdAt: '2026-06-11T10:06:00.000Z',
});
assert.equal(acceptedReplacement.title, 'Accepted replacement');
assert.equal(acceptedReplacement.changeKind, 'replacement');
assert(acceptedReplacement.summary.includes('Replaced'), 'replacement summary should explain the change');
assert.deepEqual(
  acceptedReplacement.details.map((detail) => [detail.label, detail.tone]),
  [['Before', 'removed'], ['After', 'added']],
  'replacement rows should expose before/after detail blocks',
);

const acceptedInsert = shapeHistoryRow({
  id: 'insert-history',
  actorId: 'ai:codex',
  actorType: 'agent',
  eventType: 'suggestion.accepted',
  before: { kind: 'insert', beforeContent: '' },
  after: { kind: 'insert', afterContent: 'New section.' },
  createdAt: '2026-06-11T10:07:00.000Z',
});
assert.equal(acceptedInsert.title, 'Accepted insertion');
assert.equal(acceptedInsert.changeKind, 'addition');
assert.deepEqual(acceptedInsert.details.map((detail) => detail.label), ['Added']);

const acceptedDelete = shapeHistoryRow({
  id: 'delete-history',
  actorId: 'ai:codex',
  actorType: 'agent',
  eventType: 'suggestion.accepted',
  before: { kind: 'delete', beforeContent: 'Remove this.' },
  after: { kind: 'delete', afterContent: '' },
  createdAt: '2026-06-11T10:08:00.000Z',
});
assert.equal(acceptedDelete.title, 'Accepted deletion');
assert.equal(acceptedDelete.changeKind, 'deletion');
assert.deepEqual(acceptedDelete.details.map((detail) => [detail.label, detail.tone]), [['Deleted', 'removed']]);

const rejectedSuggestion = shapeHistoryRow({
  id: 'reject-history',
  actorId: 'human:chris',
  actorType: 'human',
  eventType: 'suggestion.rejected',
  before: { kind: 'replace', beforeContent: 'Keep this.' },
  after: { kind: 'replace', afterContent: 'Keep this.' },
  createdAt: '2026-06-11T10:09:00.000Z',
});
assert.equal(rejectedSuggestion.title, 'Rejected replacement');
assert.equal(rejectedSuggestion.changeKind, 'unchanged');
assert(rejectedSuggestion.summary.includes('unchanged'), 'rejected suggestion summary should say the document did not change');

const baselineRow = shapeHistoryRow({
  id: 'baseline-history',
  actorId: 'human:chris',
  actorType: 'human',
  eventType: 'baseline.created',
  targetType: 'published_version',
  targetId: 'baseline1',
  before: { versionNumber: 1 },
  after: { versionNumber: 2, proofRevision: 9, contentLength: 123, note: 'Ready for review' },
  createdAt: '2026-06-11T10:10:00.000Z',
});
assert.equal(baselineRow.changeKind, 'baseline');
assert(baselineRow.summary.includes('v2'), 'baseline summary should include the version number');
assert.deepEqual(
  baselineRow.details.map((detail) => detail.label),
  ['Previous baseline', 'New baseline', 'Proof revision', 'Snapshot size', 'Note'],
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
