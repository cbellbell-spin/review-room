import {
  assignDistinctAgentFamilies,
  createAgentFaceSvgMarkup,
  getAgentFaceAssetUrl,
  getAgentFaceVariant,
  isAgentIdentity,
  resetAgentFaceAssignmentsForTests,
  resolveAgentFamily,
  AGENT_FACE_VARIANTS,
} from '../ui/agent-identity-icon';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  assert(haystack.includes(needle), `${message}\nMissing: ${needle}\nIn: ${haystack}`);
}

function run(): void {
  resetAgentFaceAssignmentsForTests();
  const claudeVariant = resolveAgentFamily({ name: 'Claude Code' });
  const chatgptVariant = resolveAgentFamily({ actor: 'ai:chatgpt' });
  const reviewerFromActor = resolveAgentFamily({ actor: 'ai:kieran-typescript-reviewer' });
  const reviewerFromSession = resolveAgentFamily({
    id: 'session-1741143180000-abc123',
    skill: 'kieran-typescript-reviewer',
    name: 'Kieran Typescript Reviewer',
  });
  const codexVariant = resolveAgentFamily({ actor: 'ai:codex' });
  assert(AGENT_FACE_VARIANTS.includes(claudeVariant), 'Expected provider names to receive a valid random icon');
  assert(AGENT_FACE_VARIANTS.includes(chatgptVariant), 'Expected actor hints to receive a valid random icon');
  assert(AGENT_FACE_VARIANTS.includes(reviewerFromActor), 'Expected arbitrary agent actors to receive a valid icon');
  assert(resolveAgentFamily({ name: 'Claude Code' }) === claudeVariant, 'Expected repeated lookups for the same key to stay stable');
  assert(reviewerFromActor === reviewerFromSession, 'Expected session and actor identities for the same agent to converge on one face');
  assert(resolveAgentFamily({ avatar: '/assets/agent-icons/mint.svg' }) === 'mint', 'Expected avatar URL to resolve the mint icon');
  assert(resolveAgentFamily({ avatar: '/assets/agent-icons/mint.png' }) === 'mint', 'Expected PNG avatar URL to resolve the mint icon');
  assert(resolveAgentFamily({ avatar: 'https://cdn.example.com/proof-agent-yellow.svg' }) === 'yellow', 'Expected avatar URL to resolve the yellow icon');

  assert(isAgentIdentity({ name: 'Review Room Agent' }) === true, 'Expected Review Room Agent to be treated as an agent');
  assert(isAgentIdentity({ name: 'Dan Shipper' }) === false, 'Expected a human name not to be treated as an agent');
  assert(isAgentIdentity({ avatar: '/assets/agent-icons/red.svg' }) === true, 'Expected assigned icon avatars to be treated as agents');

  assert(getAgentFaceVariant('blue') === 'blue', 'Expected blue icon variant passthrough');
  assertIncludes(getAgentFaceAssetUrl('pink'), 'pink', 'Expected the pink asset URL to include the icon color name');

  const distinctAssignments = assignDistinctAgentFamilies(['ai:claude', 'ai:gemini', 'ai:codex']);
  const distinctValues = Array.from(distinctAssignments.values());
  assert(new Set(distinctValues).size === distinctValues.length, 'Expected active agent families to avoid duplicates when faces are available');
  resetAgentFaceAssignmentsForTests();
  const afterResetCodexVariant = resolveAgentFamily({ actor: 'ai:codex' });
  assert(afterResetCodexVariant === codexVariant, 'Expected agent families to remain stable across reload-like resets');
  const afterResetAssignments = assignDistinctAgentFamilies(['ai:claude', 'ai:gemini', 'ai:codex']);
  assert(
    JSON.stringify(Array.from(afterResetAssignments.entries())) === JSON.stringify(Array.from(distinctAssignments.entries())),
    'Expected distinct share-pill assignments to stay stable across reload-like resets',
  );

  const blueMarkup = createAgentFaceSvgMarkup({
    family: 'blue',
    size: 24,
    className: 'test-face',
    title: 'Agent icon',
  });
  assertIncludes(blueMarkup, '<img', 'Expected image markup');
  assertIncludes(blueMarkup, 'width="24"', 'Expected requested width');
  assertIncludes(blueMarkup, 'height="24"', 'Expected requested height');
  assertIncludes(blueMarkup, 'class="test-face"', 'Expected custom class name');
  assertIncludes(blueMarkup, 'data-agent-family="blue"', 'Expected family metadata');
  assertIncludes(blueMarkup, 'data-agent-variant="blue"', 'Expected variant metadata');
  assertIncludes(blueMarkup, 'aria-label="Agent icon"', 'Expected accessible label');

  const mintMarkup = createAgentFaceSvgMarkup({ input: { avatar: '/assets/agent-icons/mint.svg' }, size: 14 });
  assertIncludes(mintMarkup, 'data-agent-family="mint"', 'Expected icon resolution from avatar input');
  assertIncludes(mintMarkup, 'data-agent-variant="mint"', 'Expected mint variant metadata');

  console.log('✓ agent identity icon helpers');
}

run();
