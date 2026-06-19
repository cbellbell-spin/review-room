import {
  buildStrippedIndexMap,
  stripAllProofSpanTags,
  stripAllProofSpanTagsWithReplacements,
  stripProofSpanTags,
  unwrapProofSpanById,
} from '../../server/proof-span-strip.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function run(): void {
  const markdown = [
    'Hello ',
    '<span data-proof="authored" data-by="ai:test">draft</span>',
    ' and ',
    '<span data-proof="comment" data-id="c1" data-by="human:test">commented</span>',
    ' text.',
  ].join('');

  const stripped = stripProofSpanTags(markdown);
  assertEqual(
    stripped,
    'Hello draft and <span data-proof="comment" data-id="c1" data-by="human:test">commented</span> text.',
    'Expected authored spans to be stripped while comment spans remain intact',
  );

  const { stripped: mapped, map } = buildStrippedIndexMap(markdown);
  assertEqual(mapped, stripped, 'Expected stripped index map to preserve the same output as stripProofSpanTags');

  const commentSpanStart = mapped.indexOf('<span data-proof="comment"');
  assert(commentSpanStart >= 0, 'Expected comment span markup to remain in mapped output');
  assertEqual(
    markdown[map[commentSpanStart] ?? -1],
    '<',
    'Expected mapped comment span start to point back to the original comment markup',
  );

  const authoredTextStart = mapped.indexOf('draft');
  assert(authoredTextStart >= 0, 'Expected authored span text to remain after stripping wrapper');
  assertEqual(
    markdown[map[authoredTextStart] ?? -1],
    'd',
    'Expected authored text to map back to the original authored content',
  );

  const allStripped = stripAllProofSpanTags(markdown);
  assertEqual(allStripped, 'Hello draft and commented text.', 'Expected all Proof spans to be stripped');

  const staleSuggestionMarkdown = [
    'Before ',
    '<span data-proof="suggestion" data-id="s1" data-by="ai:test" data-kind="replace">truncated</span>',
    ' after.',
  ].join('');
  const repairedBase = stripAllProofSpanTagsWithReplacements(staleSuggestionMarkdown, {
    s1: 'restored quote text',
  });
  assertEqual(
    repairedBase,
    'Before restored quote text after.',
    'Expected replacement-aware stripping to rebuild the proof-span-free base text',
  );

  const splitSuggestionMarkdown = [
    'Before ',
    '<span data-proof="suggestion" data-id="s2" data-by="ai:test" data-kind="replace">Alpha Beta </span>',
    '<span data-proof="comment" data-id="c2" data-by="human:test">Gamma Delta Epsilon</span>',
    '<span data-proof="suggestion" data-id="s2" data-by="ai:test" data-kind="replace"> Zeta Eta</span>',
    ' After',
  ].join('');
  const splitBase = stripAllProofSpanTagsWithReplacements(splitSuggestionMarkdown, {
    s2: 'Alpha Beta Gamma Delta Epsilon Zeta Eta',
    c2: 'Gamma Delta Epsilon',
  });
  assertEqual(
    splitBase,
    'Before Alpha Beta Gamma Delta Epsilon Zeta Eta After',
    'Expected replacement-aware stripping to rebuild split suggestion spans once per logical mark',
  );

  const nestedSuggestion = [
    '<span data-proof="suggestion" data-id="s-nested" data-kind="insert">',
    '<span data-proof="authored" data-proof-id="a1" data-by="human:test">nested text</span>',
    '</span>',
  ].join('');
  assertEqual(
    unwrapProofSpanById(nestedSuggestion, 's-nested'),
    '<span data-proof="authored" data-proof-id="a1" data-by="human:test">nested text</span>',
    'Expected targeted unwrap to preserve nested authored markup exactly',
  );
  assertEqual(
    unwrapProofSpanById(nestedSuggestion, 'missing'),
    null,
    'Expected targeted unwrap to leave unrelated spans untouched',
  );

  console.log('✓ proof span stripping preserves non-authored marks');
}

run();
