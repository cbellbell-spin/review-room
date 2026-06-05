import assert from 'node:assert/strict';

import { getReviewRoomSuggestionGroups } from '../editor/review-room-suggestions';

const adjacentRangeGroups = getReviewRoomSuggestionGroups({
  markdown: 'Before hello world after.',
  marks: {
    a: { kind: 'insert', by: 'human:Chris', content: 'hello', status: 'pending', range: { from: 8, to: 13 } },
    b: { kind: 'insert', by: 'human:Chris', content: ' ', status: 'pending', range: { from: 13, to: 14 } },
    c: { kind: 'insert', by: 'human:Chris', content: 'world', status: 'pending', range: { from: 14, to: 19 } },
  },
});

assert.equal(adjacentRangeGroups.length, 1, 'adjacent insert ranges should render as one Review pane group');
assert.deepEqual(adjacentRangeGroups[0]?.ids, ['a', 'b', 'c']);
assert.equal(adjacentRangeGroups[0]?.content, 'hello world');
assert.equal(adjacentRangeGroups[0]?.count, 3);

const spanFallbackGroups = getReviewRoomSuggestionGroups({
  markdown: [
    'Before ',
    '<span data-proof="suggestion" data-id="one" data-kind="insert">Proof</span>',
    '<span data-proof="suggestion" data-id="two" data-kind="insert"> </span>',
    '<span data-proof="suggestion" data-id="three" data-kind="insert">works</span>',
    ' after.',
  ].join(''),
  marks: {
    three: { kind: 'insert', by: 'human:Chris', content: 'works', status: 'pending' },
    one: { kind: 'insert', by: 'human:Chris', content: 'Proof', status: 'pending' },
    two: { kind: 'insert', by: 'human:Chris', content: ' ', status: 'pending' },
  },
});

assert.equal(spanFallbackGroups.length, 1, 'adjacent suggestion spans should render as one Review pane group');
assert.deepEqual(spanFallbackGroups[0]?.ids, ['one', 'two', 'three']);
assert.equal(spanFallbackGroups[0]?.content, 'Proof works');

const staleRangeGapGroups = getReviewRoomSuggestionGroups({
  markdown: 'This is the second paragraph(in suggesting mode) and it looks like it is also being treated as suggestions.',
  marks: {
    first: {
      kind: 'insert',
      by: 'human:Chris',
      content: 'This is the second paragraph',
      status: 'pending',
      range: { from: 0, to: 28 },
    },
    second: {
      kind: 'insert',
      by: 'human:Chris',
      content: '(in suggesting mode)',
      status: 'pending',
      range: { from: 28, to: 48 },
    },
    third: {
      kind: 'insert',
      by: 'human:Chris',
      content: 'treated as suggestions.',
      status: 'pending',
      range: { from: 84, to: 107 },
    },
  },
});

assert.equal(staleRangeGapGroups.length, 1, 'same-paragraph insert chunks with small stale gaps should render as one group');
assert.deepEqual(staleRangeGapGroups[0]?.ids, ['first', 'second', 'third']);
assert.equal(
  staleRangeGapGroups[0]?.content,
  'This is the second paragraph(in suggesting mode) and it looks like it is also being treated as suggestions.',
);

const separatedGroups = getReviewRoomSuggestionGroups({
  markdown: [
    '<span data-proof="suggestion" data-id="first" data-kind="insert">First</span>',
    ' existing text ',
    '<span data-proof="suggestion" data-id="second" data-kind="insert">Second</span>',
  ].join(''),
  marks: {
    first: { kind: 'insert', by: 'human:Chris', content: 'First', status: 'pending' },
    second: { kind: 'insert', by: 'human:Chris', content: 'Second', status: 'pending' },
  },
});

assert.equal(separatedGroups.length, 2, 'non-adjacent insert suggestions should stay separate');

const paragraphBreakGroups = getReviewRoomSuggestionGroups({
  markdown: 'First paragraph suggestion.\n\nSecond paragraph suggestion.',
  marks: {
    first: { kind: 'insert', by: 'human:Chris', content: 'First paragraph suggestion.', status: 'pending', range: { from: 0, to: 27 } },
    second: { kind: 'insert', by: 'human:Chris', content: 'Second paragraph suggestion.', status: 'pending', range: { from: 29, to: 57 } },
  },
});

assert.equal(paragraphBreakGroups.length, 2, 'insert suggestions across paragraph breaks should stay separate');

const mixedKindGroups = getReviewRoomSuggestionGroups({
  markdown: '',
  marks: {
    insert: { kind: 'insert', by: 'human:Chris', content: 'New', status: 'pending', range: { from: 1, to: 4 } },
    delete: { kind: 'delete', by: 'human:Chris', status: 'pending', range: { from: 4, to: 8 } },
  },
});

assert.equal(mixedKindGroups.length, 2, 'only adjacent insert suggestions should be grouped');

console.log('✓ Review Room groups contiguous insert suggestions for the Review pane');
