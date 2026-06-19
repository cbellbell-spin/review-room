import assert from 'node:assert/strict';

import { getReviewRoomSuggestionGroups } from '../review-room/suggestion-groups';

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

const sameParagraphSpanGroups = getReviewRoomSuggestionGroups({
  markdown: [
    '<span data-proof="suggestion" data-id="first" data-kind="insert">This is the second paragraph</span>',
    '<span data-proof="suggestion" data-id="second" data-kind="insert">(in suggesting mode)</span>',
    '<span data-proof="suggestion" data-id="third" data-kind="insert"> and it looks like it is also being treated as suggestions.</span>',
  ].join(''),
  marks: {
    first: {
      kind: 'insert',
      by: 'human:Chris',
      content: 'This is the second paragraph',
      status: 'pending',
    },
    second: {
      kind: 'insert',
      by: 'human:Chris',
      content: '(in suggesting mode)',
      status: 'pending',
    },
    third: {
      kind: 'insert',
      by: 'human:Chris',
      content: ' and it looks like it is also being treated as suggestions.',
      status: 'pending',
    },
  },
});

assert.equal(sameParagraphSpanGroups.length, 1, 'same-paragraph insert chunks should render as one group');
assert.deepEqual(sameParagraphSpanGroups[0]?.ids, ['first', 'second', 'third']);
assert.equal(
  sameParagraphSpanGroups[0]?.content,
  'This is the second paragraph(in suggesting mode) and it looks like it is also being treated as suggestions.',
);

const hardReturnGroups = getReviewRoomSuggestionGroups({
  markdown: [
    '<span data-proof="suggestion" data-id="hello" data-kind="insert">Hello World</span>',
    '\n',
    '<span data-proof="suggestion" data-id="paragraph" data-kind="insert">This is the second paragraph</span>',
  ].join(''),
  marks: {
    hello: { kind: 'insert', by: 'human:Chris', content: 'Hello World', status: 'pending' },
    paragraph: { kind: 'insert', by: 'human:Chris', content: 'This is the second paragraph', status: 'pending' },
  },
});

assert.equal(hardReturnGroups.length, 2, 'insert suggestions separated by a hard return should stay separate');
assert.deepEqual(hardReturnGroups.map((group) => group.content), ['Hello World', 'This is the second paragraph']);

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

const temporallySeparatedGroups = getReviewRoomSuggestionGroups({
  markdown: [
    '<span data-proof="suggestion" data-id="old" data-kind="insert">now suggestion with a comment</span>',
    '<span data-proof="suggestion" data-id="new" data-kind="insert"> 2nd editor suggestion.</span>',
  ].join(''),
  marks: {
    old: {
      kind: 'insert',
      by: 'human:CJ-1',
      content: 'now suggestion with a comment',
      status: 'pending',
      createdAt: '2026-06-16T20:00:00.000Z',
    },
    new: {
      kind: 'insert',
      by: 'human:CJ-1',
      content: ' 2nd editor suggestion.',
      status: 'pending',
      createdAt: '2026-06-16T20:01:00.000Z',
    },
  },
});

assert.equal(temporallySeparatedGroups.length, 2, 'separate insert bursts from the same human should not merge just because they are adjacent');
assert.deepEqual(
  temporallySeparatedGroups.map((group) => group.content),
  ['now suggestion with a comment', ' 2nd editor suggestion.'],
);

const paragraphBreakGroups = getReviewRoomSuggestionGroups({
  markdown: 'First paragraph suggestion.\n\nSecond paragraph suggestion.',
  marks: {
    first: { kind: 'insert', by: 'human:Chris', content: 'First paragraph suggestion.', status: 'pending', range: { from: 0, to: 27 } },
    second: { kind: 'insert', by: 'human:Chris', content: 'Second paragraph suggestion.', status: 'pending', range: { from: 29, to: 57 } },
  },
});

assert.equal(paragraphBreakGroups.length, 2, 'insert suggestions across paragraph breaks should stay separate');

const screenshotMarkdown = 'I am really worried how deep the bug is you and me both\n\nso far this looks ok.';
const screenshotVisibleText = screenshotMarkdown.replace(/\n{2,}/g, '\n');
function anchoredInsert(content: string, text: string, occurrence = 0) {
  let from = -1;
  let searchFrom = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    from = screenshotVisibleText.indexOf(text, searchFrom);
    searchFrom = from + text.length;
  }
  assert(from >= 0, `Expected test text to exist: ${text}`);
  return {
    kind: 'insert' as const,
    by: 'human:CJ-1',
    content,
    status: 'pending' as const,
    startRel: `char:${from}`,
    endRel: `char:${from + text.length}`,
  };
}
const screenshotGroups = getReviewRoomSuggestionGroups({
  markdown: screenshotMarkdown,
  marks: {
    a: anchoredInsert('you', 'you'),
    b: anchoredInsert('and', 'and'),
    c: anchoredInsert('me', 'me'),
    d: anchoredInsert('both', 'both'),
    e: anchoredInsert('so far this looks ok.', 'so far this looks ok.'),
  },
});

assert.equal(screenshotGroups.length, 2, 'paragraph-breaking insert chunks should not render as one mashed suggestion');
assert.equal(screenshotGroups[0]?.content, 'you and me both');
assert.equal(screenshotGroups[1]?.content, 'so far this looks ok.');

const mixedKindGroups = getReviewRoomSuggestionGroups({
  markdown: '',
  marks: {
    insert: { kind: 'insert', by: 'human:Chris', content: 'New', status: 'pending', range: { from: 1, to: 4 } },
    delete: { kind: 'delete', by: 'human:Chris', status: 'pending', range: { from: 4, to: 8 } },
  },
});

assert.equal(mixedKindGroups.length, 2, 'only adjacent insert suggestions should be grouped');

console.log('✓ Review Room groups contiguous insert suggestions for the Review pane');
