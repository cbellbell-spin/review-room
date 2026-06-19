import assert from 'node:assert/strict';
import { formatActorLabel, getActorColor } from '../review-room/actor-presentation';

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

const actor = 'human:browser-fd3417fe-0000';
assert.deepEqual(getActorColor(actor), getActorColor(actor), 'same actor must retain the same color');
assert.notDeepEqual(getActorColor('human:owner-empty-flow'), getActorColor('human:test-editor'), 'the two-browser contract collaborators should be visually distinct');

for (const id of [actor, 'human:second', 'human:third', 'human:fourth', 'human:fifth', 'human:sixth']) {
  const contrastAgainstWhite = 1.05 / (relativeLuminance(getActorColor(id).accent) + 0.05);
  assert(contrastAgainstWhite >= 4.5, `${getActorColor(id).accent} must meet WCAG AA contrast against white`);
}

assert.equal(
  formatActorLabel(actor, { 'browser-fd3417fe-0000': 'Document owner' }),
  'Document owner',
  'human actor IDs should resolve through stable identity labels',
);
assert.equal(formatActorLabel('ai:reviewer', {}), 'ai:reviewer', 'unknown actors should remain attributable');

console.log('✓ Review Room actor labels and deterministic accessible colors');
