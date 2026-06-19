import assert from 'node:assert/strict';

import type { Mark } from '../formats/marks';
import { getCoalescableInsertCandidateFromMarks } from '../editor/plugins/suggestions';

const actor = 'human:Chris';
const now = new Date().toISOString();

function insertMark(id: string, from: number, to: number, by = actor, status: 'pending' | 'accepted' | 'rejected' = 'pending'): Mark {
  return {
    id,
    kind: 'insert',
    by,
    at: now,
    quote: '',
    range: { from, to },
    data: { content: id, status },
  };
}

const exactCached = getCoalescableInsertCandidateFromMarks(
  [insertMark('cached', 4, 9)],
  { id: 'cached' },
  9,
  actor,
);
assert.deepEqual(
  exactCached,
  { id: 'cached', range: { from: 4, to: 9 }, direction: 'append' },
  'cached adjacent pending insert should coalesce',
);

const fallback = getCoalescableInsertCandidateFromMarks(
  [insertMark('roundtrip-rebuilt', 4, 9)],
  { id: 'stale-cached-id' },
  9,
  actor,
);
assert.deepEqual(
  fallback,
  { id: 'roundtrip-rebuilt', range: { from: 4, to: 9 }, direction: 'append' },
  'same-actor adjacent pending insert should coalesce when the cached id is stale',
);

const prependFallback = getCoalescableInsertCandidateFromMarks(
  [insertMark('prepend', 4, 9)],
  { id: 'stale-cached-id' },
  4,
  actor,
);
assert.deepEqual(
  prependFallback,
  { id: 'prepend', range: { from: 4, to: 9 }, direction: 'prepend' },
  'same-actor adjacent pending insert should coalesce at the front edge',
);

assert.equal(
  getCoalescableInsertCandidateFromMarks(
    [insertMark('other-actor', 4, 9, 'human:Other')],
    { id: 'stale-cached-id' },
    9,
    actor,
  ),
  null,
  "fallback must not coalesce another actor's insert",
);

assert.equal(
  getCoalescableInsertCandidateFromMarks(
    [insertMark('accepted', 4, 9, actor, 'accepted')],
    { id: 'stale-cached-id' },
    9,
    actor,
  ),
  null,
  'fallback must not coalesce finalized insert suggestions',
);

assert.equal(
  getCoalescableInsertCandidateFromMarks(
    [insertMark('not-adjacent', 4, 9)],
    { id: 'stale-cached-id' },
    11,
    actor,
  ),
  null,
  'fallback must not coalesce non-adjacent insert suggestions',
);

console.log('✓ Review Room suggestion insert coalescing survives stale cached mark ids');
