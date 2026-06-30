import { strict as assert } from 'assert';

import {
  ReviewPanelSuggestionDecisionQueue,
  type ReviewPanelSuggestionDecisionAction,
} from '../review-room/review-panel.js';

type HostCall = `${ReviewPanelSuggestionDecisionAction}:${string}`;

type TestHost = {
  calls: HostCall[];
  persistCount: number;
  refreshCount: number;
  docMarks: Record<string, unknown>;
  acceptResults: boolean[];
  rejectResults: boolean[];
  persistReviewMarks(): Promise<boolean>;
  acceptSuggestion(markId: string): Promise<boolean>;
  rejectSuggestion(markId: string): Promise<boolean>;
  refreshDocumentFromServer(): Promise<void>;
  fetchDocument(): Promise<{ marks: Record<string, unknown> }>;
  getSuggestionFinalizeBlockReason(): string | null;
};

function createHost(overrides: Partial<TestHost> = {}): TestHost {
  const host: TestHost = {
    calls: [],
    persistCount: 0,
    refreshCount: 0,
    docMarks: {},
    acceptResults: [],
    rejectResults: [],
    async persistReviewMarks() {
      this.persistCount += 1;
      return true;
    },
    async acceptSuggestion(markId: string) {
      this.calls.push(`accept:${markId}`);
      return this.acceptResults.shift() ?? true;
    },
    async rejectSuggestion(markId: string) {
      this.calls.push(`reject:${markId}`);
      return this.rejectResults.shift() ?? true;
    },
    async refreshDocumentFromServer() {
      this.refreshCount += 1;
    },
    async fetchDocument() {
      return { marks: this.docMarks };
    },
    getSuggestionFinalizeBlockReason() {
      return null;
    },
    ...overrides,
  };
  return host;
}

async function testMixedRapidDecisionsDrainInOrder(): Promise<void> {
  const host = createHost();
  const queue = new ReviewPanelSuggestionDecisionQueue(host);

  assert.equal(queue.enqueue('accept', ['mark-a']), true);
  assert.equal(queue.enqueue('reject', ['mark-b']), true);
  await queue.waitForIdle();

  assert.deepEqual(host.calls, ['accept:mark-a', 'reject:mark-b']);
  assert.equal(host.persistCount, 1, 'accept decisions persist review marks before finalizing');
  assert.equal(host.refreshCount, 1, 'completed decision drains refresh once');
  assert.equal(queue.get('mark-a')?.state, 'applied');
  assert.equal(queue.get('mark-b')?.state, 'rejected');
}

async function testDuplicateActiveDecisionIsIgnored(): Promise<void> {
  const host = createHost();
  const queue = new ReviewPanelSuggestionDecisionQueue(host);

  assert.equal(queue.enqueue('accept', ['mark-a']), true);
  assert.equal(queue.enqueue('reject', ['mark-a']), false);
  await queue.waitForIdle();

  assert.deepEqual(host.calls, ['accept:mark-a']);
  assert.equal(queue.get('mark-a')?.state, 'applied');
}

async function testFailedDecisionCanRetry(): Promise<void> {
  const host = createHost({
    acceptResults: [false, true],
    docMarks: {
      'mark-a': { kind: 'replace', status: 'pending' },
    },
  });
  const queue = new ReviewPanelSuggestionDecisionQueue(host);

  assert.equal(queue.enqueue('accept', ['mark-a']), true);
  await queue.waitForIdle();
  assert.equal(queue.get('mark-a')?.state, 'failed');

  assert.equal(queue.enqueue('accept', ['mark-a']), true);
  await queue.waitForIdle();

  assert.deepEqual(host.calls, ['accept:mark-a', 'accept:mark-a']);
  assert.equal(queue.get('mark-a')?.state, 'applied');
}

async function testFailedMutationRecoversFinalizedServerState(): Promise<void> {
  const host = createHost({
    rejectResults: [false],
    docMarks: {
      'mark-a': { kind: 'replace', status: 'rejected' },
    },
  });
  const queue = new ReviewPanelSuggestionDecisionQueue(host);

  assert.equal(queue.enqueue('reject', ['mark-a']), true);
  await queue.waitForIdle();

  assert.deepEqual(host.calls, ['reject:mark-a']);
  assert.equal(queue.get('mark-a')?.state, 'rejected');
}

await testMixedRapidDecisionsDrainInOrder();
await testDuplicateActiveDecisionIsIgnored();
await testFailedDecisionCanRetry();
await testFailedMutationRecoversFinalizedServerState();

console.log('✓ Review Room suggestion decision queue handles rapid, duplicate, retry, and stale recovery flows');
