import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const editorSource = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
  const engineSource = readFileSync(path.resolve(process.cwd(), 'server/document-engine.ts'), 'utf8');

  const markRejectStart = editorSource.indexOf('markReject(markId: string): boolean {');
  assert(markRejectStart !== -1, 'Expected editor markReject implementation');

  const markRejectEnd = editorSource.indexOf('\n  /**\n   * Accept all pending suggestions', markRejectStart);
  assert(markRejectEnd !== -1, 'Expected to isolate markReject body');

  const markRejectBlock = editorSource.slice(markRejectStart, markRejectEnd);

  assert(
    markRejectBlock.includes('success = rejectMark(view, markId);')
      && markRejectBlock.includes('if (success && this.isShareMode) {')
      && markRejectBlock.includes('const metadata = getMarkMetadataWithQuotes(view.state);')
      && markRejectBlock.includes('this.lastReceivedServerMarks = { ...metadata };')
      && markRejectBlock.includes('const actor = getCurrentActor();')
      && markRejectBlock.includes('void shareClient.rejectSuggestion(markId, actor).then((result) => {')
      && markRejectBlock.includes('const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), serverMarks);')
      && markRejectBlock.includes('setMarkMetadata(innerView, mergedMetadata);'),
    'Expected markReject share mode to use the dedicated reject mutation and merge authoritative server marks',
  );
  assert(
    !markRejectBlock.includes('shareClient.pushUpdate(')
      && !markRejectBlock.includes('shareClient.pushMarks('),
    'Expected markReject share mode not to fall back to broad content or marks writes for suggestion rejection',
  );
  assert(
    markRejectBlock.includes("console.error('[markReject] Failed to persist suggestion rejection via share mutation:', error);"),
    'Expected markReject to log share mutation persistence failures for reject actions',
  );
  assert(!markRejectBlock.includes('shareClient.pushUpdate('), 'markReject must not require a content write to persist suggestion rejection');
  assert(!markRejectBlock.includes('shareClient.pushMarks('), 'markReject should not depend on a broad marks PUT when a dedicated reject mutation exists');
  assert(
    engineSource.includes("if (status === 'rejected') {")
      && engineSource.includes('bumpDocumentAccessEpoch(slug);')
      && engineSource.includes('invalidateCollabDocument(slug);')
      && engineSource.includes('return persistMarksAsync(')
      && engineSource.includes("code: 'COLLAB_SYNC_REQUIRED'")
      && engineSource.includes("code: 'COLLAB_SYNC_FAILED'"),
    'Expected server-side suggestion status persistence to stale out collab sessions for rejects and route non-rejected finalizations through the collab-aware persistence path',
  );

  const markRejectAllStart = editorSource.indexOf('markRejectAll(): number {');
  assert(markRejectAllStart !== -1, 'Expected editor markRejectAll implementation');

  const markRejectAllEnd = editorSource.indexOf('\n  /**\n   * Delete a mark by ID', markRejectAllStart);
  assert(markRejectAllEnd !== -1, 'Expected to isolate markRejectAll body');

  const markRejectAllBlock = editorSource.slice(markRejectAllStart, markRejectAllEnd);
  assert(
    markRejectAllBlock.includes('rejectedIds = getPendingSuggestions(getMarks(view.state)).map((mark) => mark.id);')
      && markRejectAllBlock.includes('count = rejectAll(view);')
      && markRejectAllBlock.includes('if (count > 0 && this.isShareMode && rejectedIds.length > 0) {')
      && markRejectAllBlock.includes('const metadata = getMarkMetadataWithQuotes(view.state);')
      && markRejectAllBlock.includes('this.lastReceivedServerMarks = { ...metadata };')
      && markRejectAllBlock.includes('const actor = getCurrentActor();')
      && markRejectAllBlock.includes('const result = await shareClient.rejectSuggestion(suggestionId, actor);')
      && markRejectAllBlock.includes('const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), latestServerMarks!);')
      && markRejectAllBlock.includes('setMarkMetadata(innerView, mergedMetadata);'),
    'Expected markRejectAll share mode to use dedicated reject mutations and merge authoritative server marks',
  );
  assert(
    !markRejectAllBlock.includes('shareClient.pushUpdate(')
      && !markRejectAllBlock.includes('shareClient.pushMarks('),
    'Expected markRejectAll share mode not to depend on broad content or marks writes for suggestion rejection',
  );

  console.log('✓ rejecting a suggestion persists share marks without content writes');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
