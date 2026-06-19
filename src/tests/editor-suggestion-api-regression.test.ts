import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert(start !== -1, `Missing block start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert(end !== -1, `Missing block end after: ${startNeedle}`);
  return source.slice(start, end);
}

function run(): void {
  const editorSource = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
  const shareClientSource = readFileSync(path.resolve(process.cwd(), 'src/bridge/share-client.ts'), 'utf8');
  const agentRoutesSource = readFileSync(path.resolve(process.cwd(), 'server/agent-routes.ts'), 'utf8');

  const acceptSuggestionBlock = sliceBetween(editorSource, '  acceptSuggestion(id: string): boolean {', '\n  /**');
  assert(acceptSuggestionBlock.includes('return this.markAccept(String(id));'), 'Expected acceptSuggestion to delegate to markAccept');

  const rejectSuggestionBlock = sliceBetween(editorSource, '  rejectSuggestion(id: string): boolean {', '\n  /**');
  assert(rejectSuggestionBlock.includes('return this.markReject(String(id));'), 'Expected rejectSuggestion to delegate to markReject');

  const acceptAllBlock = sliceBetween(editorSource, '  acceptAllSuggestions(): number {', '\n  /**');
  assert(acceptAllBlock.includes('return this.markAcceptAll();'), 'Expected acceptAllSuggestions to delegate to markAcceptAll');

  const rejectAllBlock = sliceBetween(editorSource, '  rejectAllSuggestions(): number {', '\n  /**');
  assert(rejectAllBlock.includes('return this.markRejectAll();'), 'Expected rejectAllSuggestions to delegate to markRejectAll');

  const markAcceptBlock = sliceBetween(editorSource, '  markAccept(markId: string): boolean {', '\n  /**\n   * Reject a suggestion without changing the document\n   */');
  assert(
    markAcceptBlock.includes('void shareClient.acceptSuggestion(markId, actor).then((result) => {')
      && markAcceptBlock.includes("console.error('[markAccept] Failed to persist suggestion acceptance via share mutation:', error);"),
    'Expected markAccept to persist accepted suggestions through the share mutation route',
  );

  const markAcceptAllBlock = sliceBetween(editorSource, '  markAcceptAll(): number {', '\n  /**\n   * Reject all pending suggestions\n   */');
  assert(
    markAcceptAllBlock.includes('acceptedIds = getPendingSuggestions(getMarks(view.state)).map((mark) => mark.id);')
      && markAcceptAllBlock.includes('const result = await shareClient.acceptSuggestion(suggestionId, actor);'),
    'Expected markAcceptAll to persist each accepted suggestion through share mutations',
  );

  const shareAcceptBlock = sliceBetween(shareClientSource, 'async acceptSuggestion(', '\n  async ');
  assert(
    shareAcceptBlock.includes('return this.performMarkMutationWithRetry({')
      && shareAcceptBlock.includes("path: 'accept',"),
    'Expected ShareClient acceptSuggestion to submit an accept mark mutation',
  );
  const markMutationBlock = sliceBetween(shareClientSource, 'private async performMarkMutationWithRetry(', '\n  private ');
  assert(
    markMutationBlock.includes('/agent/${encodeURIComponent(this.slug as string)}/marks/${args.path}'),
    'Expected ShareClient mark mutations to POST to the /marks/accept|reject share routes',
  );

  const acceptRouteBlock = sliceBetween(
    agentRoutesSource,
    'async function handleAcceptSuggestionRoute(req: Request, res: Response): Promise<void> {',
    "\nagentRoutes.post('/:slug/marks/accept'",
  );
  assert(
    acceptRouteBlock.includes('const collabStatus = await notifyCollabMutation(')
      && acceptRouteBlock.includes('verify: true')
      && acceptRouteBlock.includes("source: 'marks.accept'")
      && acceptRouteBlock.includes("status: collabStatus.confirmed ? 'confirmed' : 'pending'")
      && !acceptRouteBlock.includes("code: 'COLLAB_SYNC_FAILED'"),
    'Expected /marks/accept to return canonical success while surfacing pending collab convergence',
  );
  assert(
    agentRoutesSource.includes("agentRoutes.post('/:slug/marks/accept', handleAcceptSuggestionRoute);")
      && agentRoutesSource.includes("agentRoutes.post('/marks/accept', handleAcceptSuggestionRoute);"),
    'Expected /marks/accept to support both direct and mounted slug route shapes',
  );

  console.log('✓ suggestion API actions route through share-aware accept/reject persistence');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
