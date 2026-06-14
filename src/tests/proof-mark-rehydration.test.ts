import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalizeStoredMarks, type StoredMark } from '../formats/marks.js';
import { stripAllProofSpanTags, stripProofSpanTags } from '../../server/proof-span-strip.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function parseStoredMarks(raw: unknown): Record<string, StoredMark> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return canonicalizeStoredMarks(parsed as Record<string, StoredMark>);
  } catch {
    return {};
  }
}

function buildRelativeAnchors(baseMarkdown: string, quote: string): { startRel: string; endRel: string; range: { from: number; to: number } } {
  const start = baseMarkdown.indexOf(quote);
  if (start < 0) {
    throw new Error(`Quote not found in base markdown: ${quote}`);
  }
  return {
    startRel: `char:${start}`,
    endRel: `char:${start + quote.length}`,
    range: {
      from: start + 1,
      to: start + 1 + Math.min(100, quote.length),
    },
  };
}

async function run(): Promise<void> {
  const dbName = `proof-mark-rehydration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const db = await import('../../server/db.ts');
  const { executeDocumentOperationAsync } = await import('../../server/document-engine.ts');
  const { MUTATION_BASE_SCHEMA_VERSION } = await import('../../server/collab.ts');
  const { rehydrateProofMarksMarkdown } = await import('../../server/proof-mark-rehydration.ts');
  const { repairProofMarksForSlug } = await import('../../server/proof-mark-repair.ts');

  try {
    const createdAt = new Date('2026-03-10T18:00:00.000Z').toISOString();

    const acceptSlug = `rehydrate-accept-${Math.random().toString(36).slice(2, 10)}`;
    const fullQuote = 'You can try it yourself right now. A copy of this post is available on Proof. Use the share link there to have Claude, ChatGPT, your claw, or any other agent add their comments.';
    const truncatedQuote = fullQuote.slice(0, 100);
    const replacement = 'Proof lets you share a doc with an agent and review its edits inline.';
    const acceptBase = `# Launch\n\n${fullQuote}\n\n## Next`;
    const acceptAnchors = buildRelativeAnchors(acceptBase, fullQuote);
    const acceptMarkId = 'legacy-replace-accept';
    db.createDocument(
      acceptSlug,
      `# Launch\n\n<span data-proof="suggestion" data-id="${acceptMarkId}" data-by="ai:test" data-kind="replace">${truncatedQuote}</span>\n\n## Next`,
      canonicalizeStoredMarks({
        [acceptMarkId]: {
          kind: 'replace',
          by: 'ai:test',
          createdAt,
          quote: fullQuote,
          content: replacement,
          status: 'pending',
          startRel: acceptAnchors.startRel,
          endRel: acceptAnchors.endRel,
          range: acceptAnchors.range,
        } satisfies StoredMark,
      }),
      'Legacy accept repair',
    );

    const acceptResult = await executeDocumentOperationAsync(acceptSlug, 'POST', '/marks/accept', {
      markId: acceptMarkId,
      by: 'human:test',
    });
    assertEqual(acceptResult.status, 200, `Expected legacy accept to succeed, got ${acceptResult.status}`);
    const acceptedDoc = db.getDocumentBySlug(acceptSlug);
    assert(acceptedDoc?.markdown.includes(replacement), 'Expected accept to write replacement content into canonical markdown');
    assert(!acceptedDoc?.markdown.includes(truncatedQuote), 'Expected accept to remove the stale truncated wrapper text');
    assert(!acceptedDoc?.markdown.includes('data-proof="suggestion"'), 'Expected accepted suggestion wrapper to be removed');
    assert(!(acceptMarkId in parseStoredMarks(acceptedDoc?.marks)), 'Expected accepted suggestion metadata to be removed');

    const acceptThenRejectSlug = `rehydrate-accept-then-reject-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(
      acceptThenRejectSlug,
      '# Sequence\n\nThis sentence needs clarity.\n\nThis sentence needs precision.',
      {},
      'Accept then reject sequence',
    );
    const firstSuggestion = await executeDocumentOperationAsync(acceptThenRejectSlug, 'POST', '/marks/suggest-replace', {
      by: 'ai:test',
      quote: 'This sentence needs clarity.',
      content: 'This sentence is clear.',
    });
    assertEqual(firstSuggestion.status, 200, `Expected first suggestion to succeed, got ${firstSuggestion.status}`);
    const firstMarkId = (firstSuggestion.body as { markId?: string }).markId;
    assert(typeof firstMarkId === 'string' && firstMarkId.length > 0, 'Expected first suggestion mark id');
    const sequenceAccept = await executeDocumentOperationAsync(acceptThenRejectSlug, 'POST', '/marks/accept', {
      markId: firstMarkId,
      by: 'human:test',
    });
    assertEqual(sequenceAccept.status, 200, `Expected sequence accept to succeed, got ${sequenceAccept.status}`);
    const secondSuggestion = await executeDocumentOperationAsync(acceptThenRejectSlug, 'POST', '/marks/suggest-replace', {
      by: 'ai:test',
      quote: 'This sentence needs precision.',
      content: 'This sentence is precise.',
    });
    assertEqual(secondSuggestion.status, 200, `Expected second suggestion to succeed, got ${secondSuggestion.status}`);
    const secondMarkId = (secondSuggestion.body as { markId?: string }).markId;
    assert(typeof secondMarkId === 'string' && secondMarkId.length > 0, 'Expected second suggestion mark id');
    const sequenceReject = await executeDocumentOperationAsync(acceptThenRejectSlug, 'POST', '/marks/reject', {
      markId: secondMarkId,
      by: 'human:test',
    });
    assertEqual(sequenceReject.status, 200, `Expected reject after prior accept to succeed, got ${sequenceReject.status}`);

    const rejectSlug = `rehydrate-reject-${Math.random().toString(36).slice(2, 10)}`;
    const rejectMarkId = 'legacy-replace-reject';
    db.createDocument(
      rejectSlug,
      `# Launch\n\n<span data-proof="suggestion" data-id="${rejectMarkId}" data-by="ai:test" data-kind="replace">${truncatedQuote}</span>\n\n## Next`,
      canonicalizeStoredMarks({
        [rejectMarkId]: {
          kind: 'replace',
          by: 'ai:test',
          createdAt,
          quote: fullQuote,
          content: replacement,
          status: 'pending',
          startRel: acceptAnchors.startRel,
          endRel: acceptAnchors.endRel,
          range: acceptAnchors.range,
        } satisfies StoredMark,
      }),
      'Legacy reject repair',
    );

    const rejectResult = await executeDocumentOperationAsync(rejectSlug, 'POST', '/marks/reject', {
      markId: rejectMarkId,
      by: 'human:test',
    });
    assertEqual(rejectResult.status, 200, `Expected legacy reject to succeed, got ${rejectResult.status}`);
    const rejectedDoc = db.getDocumentBySlug(rejectSlug);
    const rejectedVisibleText = stripAllProofSpanTags(rejectedDoc?.markdown ?? '');
    assert(rejectedVisibleText.includes(fullQuote), 'Expected reject to restore the full original quote text');
    assert(!rejectedDoc?.markdown.includes('data-proof="suggestion"'), 'Expected rejected suggestion wrapper to be removed');

    const escapedQuoteSlug = `rehydrate-escaped-quote-${Math.random().toString(36).slice(2, 10)}`;
    const escapedQuoteMarkId = 'legacy-escaped-quote-reject';
    const escapedQuoteVisible = 'REJECT_REPRO_QUOTE_ESCAPED';
    const escapedQuoteMarkdown = `# Launch\n\nParagraph with escaped quote: REJECT\\_REPRO\\_QUOTE\\_ESCAPED.\n`;
    const escapedQuoteVisibleBase = `# Launch\n\nParagraph with escaped quote: ${escapedQuoteVisible}.\n`;
    const escapedQuoteAnchors = buildRelativeAnchors(escapedQuoteVisibleBase, escapedQuoteVisible);
    db.createDocument(
      escapedQuoteSlug,
      escapedQuoteMarkdown,
      canonicalizeStoredMarks({
        [escapedQuoteMarkId]: {
          kind: 'replace',
          by: 'ai:test',
          createdAt,
          quote: escapedQuoteVisible,
          content: 'escaped replacement',
          status: 'pending',
          startRel: escapedQuoteAnchors.startRel,
          endRel: escapedQuoteAnchors.endRel,
          range: escapedQuoteAnchors.range,
        } satisfies StoredMark,
      }),
      'Escaped quote reject repair',
    );

    const escapedRejectResult = await executeDocumentOperationAsync(escapedQuoteSlug, 'POST', '/marks/reject', {
      markId: escapedQuoteMarkId,
      by: 'human:test',
    });
    assertEqual(escapedRejectResult.status, 200, `Expected escaped-quote reject to succeed, got ${escapedRejectResult.status}`);
    const escapedRejectedDoc = db.getDocumentBySlug(escapedQuoteSlug);
    assert(
      (escapedRejectedDoc?.markdown ?? '').includes('REJECT\\_REPRO\\_QUOTE\\_ESCAPED'),
      'Expected reject to preserve escaped markdown text for quotes with underscores',
    );
    assert(!escapedRejectedDoc?.markdown.includes('data-proof="suggestion"'), 'Expected escaped-quote reject to remove suggestion wrappers');

    const longSlug = `rehydrate-add-accepted-${Math.random().toString(36).slice(2, 10)}`;
    const longQuote = `Start ${'a'.repeat(140)} end`;
    db.createDocument(longSlug, `Before ${longQuote} after.`, {}, 'Accepted long quote');

    const addAccepted = await executeDocumentOperationAsync(longSlug, 'POST', '/marks/suggest-replace', {
      quote: longQuote,
      content: 'REPLACED',
      by: 'ai:test',
      status: 'accepted',
    });
    assertEqual(addAccepted.status, 200, `Expected accepted long quote suggestion.add to succeed, got ${addAccepted.status}`);
    const longDoc = db.getDocumentBySlug(longSlug);
    assertEqual(
      stripProofSpanTags(longDoc?.markdown ?? ''),
      'Before REPLACED after.\n',
      'Expected accepted long quote suggestion.add to use structured finalization',
    );

    const inertCommentSlug = `rehydrate-inert-comment-${Math.random().toString(36).slice(2, 10)}`;
    const inertCommentBase = '# Hello there';
    const inertCommentAnchors = buildRelativeAnchors(inertCommentBase, 'Hello');
    const inertCommentSuggestionId = 'rehydrate-inert-suggestion';
    db.createDocument(
      inertCommentSlug,
      inertCommentBase,
      canonicalizeStoredMarks({
        staleComment: {
          kind: 'comment',
          by: 'human:test',
          createdAt,
          quote: 'Hello',
          resolved: false,
          startRel: inertCommentAnchors.startRel,
          endRel: inertCommentAnchors.endRel,
          range: inertCommentAnchors.range,
        } satisfies StoredMark,
        [inertCommentSuggestionId]: {
          kind: 'replace',
          by: 'ai:test',
          createdAt,
          quote: 'Hello',
          content: 'Hi',
          status: 'pending',
          startRel: inertCommentAnchors.startRel,
          endRel: inertCommentAnchors.endRel,
          range: inertCommentAnchors.range,
        } satisfies StoredMark,
      }),
      'Ignore inert comment metadata during accept',
    );

    const inertCommentAccept = await executeDocumentOperationAsync(inertCommentSlug, 'POST', '/marks/accept', {
      markId: inertCommentSuggestionId,
      by: 'human:test',
    });
    assertEqual(inertCommentAccept.status, 200, `Expected accept with inert comment metadata to succeed, got ${inertCommentAccept.status}`);
    const inertCommentDoc = db.getDocumentBySlug(inertCommentSlug);
    assert(
      stripProofSpanTags(inertCommentDoc?.markdown ?? '').includes('Hi there'),
      'Expected accept to succeed even when unrelated incomplete comment metadata exists',
    );

    const nestedSlug = `rehydrate-nested-${Math.random().toString(36).slice(2, 10)}`;
    const nestedMarkId = 'legacy-nested-suggestion';
    const nestedCommentId = 'legacy-nested-comment';
    const nestedQuote = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau';
    const nestedCommentQuote = 'Gamma Delta Epsilon';
    const nestedBase = `Before ${nestedQuote} After`;
    const nestedAnchors = buildRelativeAnchors(nestedBase, nestedQuote);
    const nestedCommentAnchors = buildRelativeAnchors(nestedBase, nestedCommentQuote);
    const nestedMarkdown = `Before <span data-proof="suggestion" data-id="${nestedMarkId}" data-by="ai:test" data-kind="replace">${nestedQuote.slice(0, 48)}</span> After`;
    const nestedMarks = canonicalizeStoredMarks({
      [nestedMarkId]: {
        kind: 'replace',
        by: 'ai:test',
        createdAt,
        quote: nestedQuote,
        content: 'Alpha Beta Rewritten',
        status: 'pending',
        startRel: nestedAnchors.startRel,
        endRel: nestedAnchors.endRel,
        range: nestedAnchors.range,
      } satisfies StoredMark,
      [nestedCommentId]: {
        kind: 'comment',
        by: 'human:test',
        createdAt,
        quote: nestedCommentQuote,
        text: 'Need to revisit this clause',
        threadId: nestedCommentId,
        thread: [],
        replies: [],
        resolved: false,
        startRel: nestedCommentAnchors.startRel,
        endRel: nestedCommentAnchors.endRel,
        range: nestedCommentAnchors.range,
      } satisfies StoredMark,
    });

    const nestedRepair = await rehydrateProofMarksMarkdown(nestedMarkdown, nestedMarks);
    assert(nestedRepair.ok, `Expected nested repair to succeed, got ${nestedRepair.ok ? 'ok' : nestedRepair.error}`);
    const nestedVisibleText = stripAllProofSpanTags(nestedRepair.markdown);
    assert(nestedVisibleText.startsWith('Before'), 'Expected nested repair to preserve surrounding text');
    assert(nestedVisibleText.includes(nestedQuote), 'Expected nested repair to rebuild the full quoted text');
    assert(nestedVisibleText.trim().endsWith('After'), 'Expected nested repair to preserve trailing text');
    assert(nestedRepair.markdown.includes(`data-id="${nestedMarkId}"`), 'Expected nested repair to keep the suggestion wrapper');
    assert(nestedRepair.markdown.includes(`data-id="${nestedCommentId}"`), 'Expected nested repair to restore the nested comment wrapper');
    assertEqual(
      Object.keys(nestedRepair.marks).sort().join(','),
      Object.keys(nestedMarks).sort().join(','),
      'Expected nested repair to preserve mark ids',
    );

    db.createDocument(nestedSlug, nestedMarkdown, nestedMarks, 'Nested repair write');
    const repairReport = await repairProofMarksForSlug(nestedSlug, { write: true });
    assert(repairReport.textStable, 'Expected nested repair to preserve replacement-aware visible text');
    assert(repairReport.safeToWrite, 'Expected nested repair to be safe to write');
    assert(repairReport.wrote, 'Expected nested repair write to persist');
    const repairedNestedDoc = db.getDocumentBySlug(nestedSlug);
    assert(repairedNestedDoc?.markdown.includes(`data-id="${nestedCommentId}"`), 'Expected persisted repair to keep nested comment wrappers');

    const splitQuote = 'Alpha Beta Gamma Delta Epsilon Zeta Eta';
    const splitCommentQuote = 'Gamma Delta Epsilon';
    const splitBase = `Before ${splitQuote} After`;
    const splitAnchors = buildRelativeAnchors(splitBase, splitQuote);
    const splitCommentAnchors = buildRelativeAnchors(splitBase, splitCommentQuote);
    const buildSplitFixture = (suffix: string): {
      suggestionId: string;
      commentId: string;
      markdown: string;
      marks: Record<string, StoredMark>;
    } => {
      const suggestionId = `legacy-split-suggestion-${suffix}`;
      const commentId = `legacy-split-comment-${suffix}`;
      return {
        suggestionId,
        commentId,
        markdown: [
          'Before ',
          `<span data-proof="suggestion" data-id="${suggestionId}" data-by="ai:test" data-kind="replace">Alpha Beta </span>`,
          `<span data-proof="comment" data-id="${commentId}" data-by="human:test">${splitCommentQuote}</span>`,
          `<span data-proof="suggestion" data-id="${suggestionId}" data-by="ai:test" data-kind="replace"> Zeta Eta</span>`,
          ' After',
        ].join(''),
        marks: canonicalizeStoredMarks({
          [suggestionId]: {
            kind: 'replace',
            by: 'ai:test',
            createdAt,
            quote: splitQuote,
            content: splitQuote,
            status: 'pending',
            startRel: splitAnchors.startRel,
            endRel: splitAnchors.endRel,
            range: splitAnchors.range,
          } satisfies StoredMark,
          [commentId]: {
            kind: 'comment',
            by: 'human:test',
            createdAt,
            quote: splitCommentQuote,
            text: 'Nested comment should survive suggestion finalization',
            threadId: commentId,
            thread: [],
            replies: [],
            resolved: false,
            startRel: splitCommentAnchors.startRel,
            endRel: splitCommentAnchors.endRel,
            range: splitCommentAnchors.range,
          } satisfies StoredMark,
        }),
      };
    };

    const splitAcceptFixture = buildSplitFixture('accept');
    const splitSuggestionSlug = `rehydrate-split-accept-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(splitSuggestionSlug, splitAcceptFixture.markdown, splitAcceptFixture.marks, 'Split suggestion accept');
    const splitAcceptResult = await executeDocumentOperationAsync(splitSuggestionSlug, 'POST', '/marks/accept', {
      markId: splitAcceptFixture.suggestionId,
      by: 'human:test',
    });
    assertEqual(splitAcceptResult.status, 200, `Expected split suggestion accept to succeed, got ${splitAcceptResult.status}`);
    const splitAcceptBody = splitAcceptResult.body as { marks?: Record<string, { status?: string }> };
    assertEqual(
      splitAcceptBody.marks?.[splitAcceptFixture.suggestionId]?.status,
      'accepted',
      'Expected split suggestion accept response to finalize the suggestion status',
    );
    const splitAcceptedDoc = db.getDocumentBySlug(splitSuggestionSlug);
    assertEqual(
      stripAllProofSpanTags(splitAcceptedDoc?.markdown ?? '').trim(),
      splitBase,
      'Expected split suggestion accept to preserve plain text without duplication',
    );
    assert(
      !splitAcceptedDoc?.markdown.includes(`data-id="${splitAcceptFixture.suggestionId}"`),
      'Expected split suggestion accept to remove all legacy suggestion wrappers',
    );
    assert(
      splitAcceptedDoc?.markdown.includes(`data-id="${splitAcceptFixture.commentId}"`),
      'Expected split suggestion accept to preserve nested comment markup',
    );
    const splitAcceptedMarks = parseStoredMarks(splitAcceptedDoc?.marks);
    assert(splitAcceptFixture.commentId in splitAcceptedMarks, 'Expected split suggestion accept to preserve nested comment metadata');

    const splitAuthoritativeFallbackFixture = buildSplitFixture('accept-authoritative');
    const splitAuthoritativeFallbackSlug = `rehydrate-split-accept-authoritative-${Math.random().toString(36).slice(2, 10)}`;
    const staleSplitMarks = {
      [splitAuthoritativeFallbackFixture.suggestionId]: splitAuthoritativeFallbackFixture.marks[splitAuthoritativeFallbackFixture.suggestionId],
    };
    db.createDocument(
      splitAuthoritativeFallbackSlug,
      splitAuthoritativeFallbackFixture.markdown,
      JSON.stringify(staleSplitMarks),
      'Split suggestion accept authoritative fallback',
    );
    const splitAuthoritativeFallbackRow = db.getDocumentBySlug(splitAuthoritativeFallbackSlug);
    assert(splitAuthoritativeFallbackRow, 'Expected authoritative fallback fixture row');
    const authoritativeSplitContext = {
      doc: {
        ...splitAuthoritativeFallbackRow,
        markdown: splitBase,
        marks: JSON.stringify(splitAuthoritativeFallbackFixture.marks),
        plain_text: splitBase,
      },
      mutationBase: {
        token: 'split-authoritative-token',
        source: 'persisted_yjs',
        schemaVersion: MUTATION_BASE_SCHEMA_VERSION,
        markdown: splitBase,
        marks: splitAuthoritativeFallbackFixture.marks,
        accessEpoch: splitAuthoritativeFallbackRow?.access_epoch ?? 0,
      },
      precondition: {
        mode: 'revision',
        baseRevision: splitAuthoritativeFallbackRow?.revision ?? 1,
      },
    } as const;
    const splitAuthoritativeFallbackResult = await executeDocumentOperationAsync(
      splitAuthoritativeFallbackSlug,
      'POST',
      '/marks/accept',
      {
        markId: splitAuthoritativeFallbackFixture.suggestionId,
        by: 'human:test',
      },
      authoritativeSplitContext,
    );
    assertEqual(
      splitAuthoritativeFallbackResult.status,
      200,
      `Expected authoritative fallback accept to succeed, got ${splitAuthoritativeFallbackResult.status}: ${JSON.stringify(splitAuthoritativeFallbackResult.body)}`,
    );
    const splitAuthoritativeFallbackDoc = db.getDocumentBySlug(splitAuthoritativeFallbackSlug);
    const splitAuthoritativeFallbackMarks = parseStoredMarks(splitAuthoritativeFallbackDoc?.marks);
    assert(
      splitAuthoritativeFallbackFixture.commentId in splitAuthoritativeFallbackMarks,
      'Expected authoritative fallback accept to preserve unrelated comment metadata even when row marks were stale',
    );

    const splitRejectFixture = buildSplitFixture('reject');
    const splitRejectSlug = `rehydrate-split-reject-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(splitRejectSlug, splitRejectFixture.markdown, splitRejectFixture.marks, 'Split suggestion reject');
    const splitRejectBefore = db.getDocumentBySlug(splitRejectSlug);
    const splitRejectResult = await executeDocumentOperationAsync(splitRejectSlug, 'POST', '/marks/reject', {
      markId: splitRejectFixture.suggestionId,
      by: 'human:test',
    });
    assertEqual(splitRejectResult.status, 200, `Expected split suggestion reject to succeed, got ${splitRejectResult.status}`);
    const splitRejectBody = splitRejectResult.body as { marks?: Record<string, { status?: string }> };
    assertEqual(
      splitRejectBody.marks?.[splitRejectFixture.suggestionId]?.status,
      'rejected',
      'Expected split suggestion reject response to finalize the suggestion status',
    );
    const splitRejectedDoc = db.getDocumentBySlug(splitRejectSlug);
    assertEqual(
      stripAllProofSpanTags(splitRejectedDoc?.markdown ?? '').trim(),
      splitBase,
      'Expected split suggestion reject to preserve plain text without duplication',
    );
    assert(
      !splitRejectedDoc?.markdown.includes(`data-id="${splitRejectFixture.suggestionId}"`),
      'Expected split suggestion reject to remove all legacy suggestion wrappers',
    );
    assert(
      splitRejectedDoc?.markdown.includes(`data-id="${splitRejectFixture.commentId}"`),
      'Expected split suggestion reject to preserve nested comment markup',
    );
    assert(
      (splitRejectedDoc?.access_epoch ?? 0) > (splitRejectBefore?.access_epoch ?? 0),
      'Expected split suggestion reject to bump access_epoch so stale collab rooms must reload',
    );
    const splitRejectedMarks = parseStoredMarks(splitRejectedDoc?.marks);
    assert(splitRejectFixture.commentId in splitRejectedMarks, 'Expected split suggestion reject to preserve nested comment metadata');

    const splitRepairFixture = buildSplitFixture('repair');
    const splitRepair = await rehydrateProofMarksMarkdown(splitRepairFixture.markdown, splitRepairFixture.marks);
    assert(splitRepair.ok, `Expected split repair to succeed, got ${splitRepair.ok ? 'ok' : splitRepair.error}`);
    assertEqual(
      stripAllProofSpanTags(splitRepair.markdown).trim(),
      splitBase,
      'Expected split repair to preserve plain text without duplication',
    );
    assert(
      splitRepair.markdown.includes(`data-id="${splitRepairFixture.suggestionId}"`),
      'Expected split repair to restore the split suggestion wrapper',
    );
    assert(
      splitRepair.markdown.includes(`data-id="${splitRepairFixture.commentId}"`),
      'Expected split repair to restore the nested comment wrapper',
    );
    assertEqual(
      Object.keys(splitRepair.marks).sort().join(','),
      Object.keys(splitRepairFixture.marks).sort().join(','),
      'Expected split repair to preserve mark ids',
    );

    const splitRepairSlug = `rehydrate-split-repair-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(splitRepairSlug, splitRepairFixture.markdown, splitRepairFixture.marks, 'Split suggestion repair write');
    const splitRepairReport = await repairProofMarksForSlug(splitRepairSlug, { write: true });
    assert(splitRepairReport.textStable, 'Expected split repair write to preserve visible text');
    assert(splitRepairReport.safeToWrite, 'Expected split repair write to be safe');
    assert(splitRepairReport.wrote, 'Expected split repair write to persist');
    const repairedSplitDoc = db.getDocumentBySlug(splitRepairSlug);
    assertEqual(
      stripAllProofSpanTags(repairedSplitDoc?.markdown ?? '').trim(),
      splitBase,
      'Expected persisted split repair to preserve plain text without duplication',
    );
    assert(
      repairedSplitDoc?.markdown.includes(`data-id="${splitRepairFixture.commentId}"`),
      'Expected persisted split repair to keep the nested comment wrapper',
    );

    const staleAuthoredSlug = `rehydrate-stale-authored-${Math.random().toString(36).slice(2, 10)}`;
    const staleAuthoredSuggestionId = 'stale-authored-suggestion';
    const staleAuthoredBase = 'Before Hello After';
    const staleAuthoredAnchors = buildRelativeAnchors(staleAuthoredBase, 'Hello');
    db.createDocument(
      staleAuthoredSlug,
      'Before <span data-proof="suggestion" data-id="stale-authored-suggestion" data-by="ai:test" data-kind="replace">Hell</span> After',
      canonicalizeStoredMarks({
        [staleAuthoredSuggestionId]: {
          kind: 'replace',
          by: 'ai:test',
          createdAt,
          quote: 'Hello',
          content: 'Hi',
          status: 'pending',
          startRel: staleAuthoredAnchors.startRel,
          endRel: staleAuthoredAnchors.endRel,
          range: staleAuthoredAnchors.range,
        } satisfies StoredMark,
        'authored:human:R2C2 Repro:90-92': {
          kind: 'authored',
          by: 'human:R2C2 Repro',
          createdAt: '1970-01-01T00:00:00.000Z',
          quote: 'XY',
          startRel: 'char:87',
          endRel: 'char:89',
          range: { from: 90, to: 92 },
        } satisfies StoredMark,
        'authored:human:R2C2 Repro:92-94': {
          kind: 'authored',
          by: 'human:R2C2 Repro',
          createdAt: '1970-01-01T00:00:00.000Z',
          quote: 'XY',
          startRel: 'char:89',
          endRel: 'char:91',
          range: { from: 92, to: 94 },
        } satisfies StoredMark,
      }),
      'Ignore stale orphaned authored metadata during accept',
    );

    const staleAuthoredAccept = await executeDocumentOperationAsync(staleAuthoredSlug, 'POST', '/marks/accept', {
      markId: staleAuthoredSuggestionId,
      by: 'human:test',
    });
    assertEqual(staleAuthoredAccept.status, 200, `Expected accept with stale orphaned authored metadata to succeed, got ${staleAuthoredAccept.status}`);
    const staleAuthoredDoc = db.getDocumentBySlug(staleAuthoredSlug);
    assert(
      stripAllProofSpanTags(staleAuthoredDoc?.markdown ?? '').includes('Before Hi After'),
      'Expected stale orphaned authored metadata to be ignored when it is not serialized in markdown',
    );

    const missingAuthoredSlug = `rehydrate-missing-authored-${Math.random().toString(36).slice(2, 10)}`;
    const missingAuthoredSuggestionId = 'missing-authored-suggestion';
    const missingAuthoredVisibleText = 'Visible authored provenance';
    const missingAuthoredQuote = 'Editable legacy quote';
    const missingAuthoredReplacement = 'Accepted replacement text';
    const missingAuthoredBase = `${missingAuthoredVisibleText} ${missingAuthoredQuote}`;
    const missingAuthoredAnchors = buildRelativeAnchors(missingAuthoredBase, missingAuthoredQuote);
    db.createDocument(
      missingAuthoredSlug,
      [
        `<span data-proof="authored" data-by="human:dan">${missingAuthoredVisibleText}</span> `,
        `<span data-proof="suggestion" data-id="${missingAuthoredSuggestionId}" data-by="ai:test" data-kind="replace">${missingAuthoredQuote.slice(0, 10)}</span>`,
      ].join(''),
      canonicalizeStoredMarks({
        [missingAuthoredSuggestionId]: {
          kind: 'replace',
          by: 'ai:test',
          createdAt,
          quote: missingAuthoredQuote,
          content: missingAuthoredReplacement,
          status: 'pending',
          startRel: missingAuthoredAnchors.startRel,
          endRel: missingAuthoredAnchors.endRel,
          range: missingAuthoredAnchors.range,
        } satisfies StoredMark,
      }),
      'Fail when visible authored spans are missing stored metadata',
    );

    const missingAuthoredAccept = await executeDocumentOperationAsync(missingAuthoredSlug, 'POST', '/marks/accept', {
      markId: missingAuthoredSuggestionId,
      by: 'human:test',
    });
    assertEqual(
      missingAuthoredAccept.status,
      200,
      `Expected accept with missing visible authored metadata to recover authored spans, got ${missingAuthoredAccept.status}`,
    );
    const missingAuthoredDoc = db.getDocumentBySlug(missingAuthoredSlug);
    assert(
      (missingAuthoredDoc?.markdown ?? '').includes('data-proof="authored"'),
      'Expected accept to preserve visible authored spans even when stored authored metadata was missing',
    );
    const missingAuthoredMarks = parseStoredMarks(missingAuthoredDoc?.marks ?? '');
    assert(
      Object.values(missingAuthoredMarks).some((mark) => mark.kind === 'authored'),
      'Expected accept to backfill authored metadata from serialized markdown during structured rehydration',
    );

    const authoredBeforeText = 'Lead authored text.';
    const authoredAfterText = 'Tail authored text.';
    const authoredQuote = 'Middle legacy quote that should stay anchored.';
    const authoredReplacement = 'Middle accepted text that still preserves provenance.';
    const authoredBase = `${authoredBeforeText} ${authoredQuote} ${authoredAfterText}`;
    const authoredSuggestionAnchors = buildRelativeAnchors(authoredBase, authoredQuote);
    const authoredBeforeAnchors = buildRelativeAnchors(authoredBase, authoredBeforeText);
    const authoredAfterAnchors = buildRelativeAnchors(authoredBase, authoredAfterText);
    const buildAuthoredFixture = (suffix: string): {
      beforeId: string;
      afterId: string;
      suggestionId: string;
      markdown: string;
      marks: Record<string, StoredMark>;
    } => {
      const beforeId = `authored-before-${suffix}`;
      const afterId = `authored-after-${suffix}`;
      const suggestionId = `authored-suggestion-${suffix}`;
      return {
        beforeId,
        afterId,
        suggestionId,
        markdown: [
          `<span data-proof="authored" data-by="human:dan">${authoredBeforeText}</span> `,
          `<span data-proof="suggestion" data-id="${suggestionId}" data-by="ai:test" data-kind="replace">${authoredQuote.slice(0, 30)}</span> `,
          `<span data-proof="authored" data-by="human:dan">${authoredAfterText}</span>`,
        ].join(''),
        marks: canonicalizeStoredMarks({
          [beforeId]: {
            kind: 'authored',
            by: 'human:dan',
            createdAt,
            quote: authoredBeforeText,
            startRel: authoredBeforeAnchors.startRel,
            endRel: authoredBeforeAnchors.endRel,
            range: authoredBeforeAnchors.range,
          } satisfies StoredMark,
          [afterId]: {
            kind: 'authored',
            by: 'human:dan',
            createdAt,
            quote: authoredAfterText,
            startRel: authoredAfterAnchors.startRel,
            endRel: authoredAfterAnchors.endRel,
            range: authoredAfterAnchors.range,
          } satisfies StoredMark,
          [suggestionId]: {
            kind: 'replace',
            by: 'ai:test',
            createdAt,
            quote: authoredQuote,
            content: authoredReplacement,
            status: 'pending',
            startRel: authoredSuggestionAnchors.startRel,
            endRel: authoredSuggestionAnchors.endRel,
            range: authoredSuggestionAnchors.range,
          } satisfies StoredMark,
        }),
      };
    };

    const authoredAcceptFixture = buildAuthoredFixture('accept');
    const authoredAcceptSlug = `rehydrate-authored-accept-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(authoredAcceptSlug, authoredAcceptFixture.markdown, authoredAcceptFixture.marks, 'Authored preservation accept');
    const authoredAcceptResult = await executeDocumentOperationAsync(authoredAcceptSlug, 'POST', '/marks/accept', {
      markId: authoredAcceptFixture.suggestionId,
      by: 'human:test',
    });
    assertEqual(authoredAcceptResult.status, 200, `Expected authored preservation accept to succeed, got ${authoredAcceptResult.status}`);
    const authoredAcceptBody = authoredAcceptResult.body as { marks?: Record<string, { status?: string }> };
    assertEqual(
      authoredAcceptBody.marks?.[authoredAcceptFixture.suggestionId]?.status,
      'accepted',
      'Expected authored preservation accept response to finalize the suggestion status',
    );
    const authoredAcceptedDoc = db.getDocumentBySlug(authoredAcceptSlug);
    assertEqual(
      stripAllProofSpanTags(authoredAcceptedDoc?.markdown ?? '').trim(),
      `${authoredBeforeText} ${authoredReplacement} ${authoredAfterText}`,
      'Expected authored preservation accept to apply the replacement without dropping authored spans',
    );
    assertEqual(
      (authoredAcceptedDoc?.markdown.match(/data-proof="authored"[^>]*data-by="human:dan"/g) ?? []).length,
      2,
      'Expected authored preservation accept to keep both original human authored wrappers',
    );
    const authoredAcceptedMarks = parseStoredMarks(authoredAcceptedDoc?.marks);
    assert(authoredAcceptFixture.beforeId in authoredAcceptedMarks, 'Expected authored preservation accept to keep the leading authored mark id');
    assert(authoredAcceptFixture.afterId in authoredAcceptedMarks, 'Expected authored preservation accept to keep the trailing authored mark id');

    const authoredRejectFixture = buildAuthoredFixture('reject');
    const authoredRejectSlug = `rehydrate-authored-reject-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(authoredRejectSlug, authoredRejectFixture.markdown, authoredRejectFixture.marks, 'Authored preservation reject');
    const authoredRejectResult = await executeDocumentOperationAsync(authoredRejectSlug, 'POST', '/marks/reject', {
      markId: authoredRejectFixture.suggestionId,
      by: 'human:test',
    });
    assertEqual(authoredRejectResult.status, 200, `Expected authored preservation reject to succeed, got ${authoredRejectResult.status}`);
    const authoredRejectBody = authoredRejectResult.body as { marks?: Record<string, { status?: string }> };
    assertEqual(
      authoredRejectBody.marks?.[authoredRejectFixture.suggestionId]?.status,
      'rejected',
      'Expected authored preservation reject response to finalize the suggestion status',
    );
    const authoredRejectedDoc = db.getDocumentBySlug(authoredRejectSlug);
    assertEqual(
      stripAllProofSpanTags(authoredRejectedDoc?.markdown ?? '').trim(),
      authoredBase,
      'Expected authored preservation reject to keep the original text without dropping authored spans',
    );
    assertEqual(
      (authoredRejectedDoc?.markdown.match(/data-proof="authored"[^>]*data-by="human:dan"/g) ?? []).length,
      2,
      'Expected authored preservation reject to keep both original human authored wrappers',
    );
    const authoredRejectedMarks = parseStoredMarks(authoredRejectedDoc?.marks);
    assert(authoredRejectFixture.beforeId in authoredRejectedMarks, 'Expected authored preservation reject to keep the leading authored mark id');
    assert(authoredRejectFixture.afterId in authoredRejectedMarks, 'Expected authored preservation reject to keep the trailing authored mark id');

    console.log('✓ proof mark rehydration repairs legacy accept/reject/add-accepted and nested repair flows');

    // Regression: authored spans with inline backtick code caused serialized-authored fingerprint
    // mismatch (raw markdown preserves backticks; ProseMirror quotes strip them), blocking accepts.
    {
      const backtickPmBase = 'use foo to call it Replace this old text.';
      const backtickAuthoredQuote = 'use foo to call it';
      const backtickSuggestionQuote = 'Replace this old text.';
      const backtickAuthoredAnchors = buildRelativeAnchors(backtickPmBase, backtickAuthoredQuote);
      const backtickSuggestionAnchors = buildRelativeAnchors(backtickPmBase, backtickSuggestionQuote);
      const backtickAuthoredId = 'authored-backtick-regression';
      const backtickSuggestionId = 'suggestion-backtick-regression';
      // Markdown has backtick code span in authored content; authored mark quote has no backticks
      // (as ProseMirror would store it after parsing the markdown).
      const backtickMarkdown = [
        `<span data-proof="authored" data-proof-id="authored:ai:claude:bt-1" data-by="ai:claude">use \`foo\` to call it</span> `,
        `<span data-proof="suggestion" data-id="${backtickSuggestionId}" data-by="ai:test" data-kind="replace">${backtickSuggestionQuote}</span>`,
      ].join('');
      const backtickSlug = `rehydrate-backtick-regression-${Math.random().toString(36).slice(2, 10)}`;
      db.createDocument(backtickSlug, backtickMarkdown, canonicalizeStoredMarks({
        [backtickAuthoredId]: {
          kind: 'authored',
          by: 'ai:claude',
          createdAt,
          quote: backtickAuthoredQuote,
          startRel: backtickAuthoredAnchors.startRel,
          endRel: backtickAuthoredAnchors.endRel,
          range: backtickAuthoredAnchors.range,
        } satisfies StoredMark,
        [backtickSuggestionId]: {
          kind: 'replace',
          by: 'ai:test',
          createdAt,
          quote: backtickSuggestionQuote,
          content: 'new accepted text.',
          status: 'pending',
          startRel: backtickSuggestionAnchors.startRel,
          endRel: backtickSuggestionAnchors.endRel,
          range: backtickSuggestionAnchors.range,
        } satisfies StoredMark,
      }), 'Backtick regression');
      const backtickResult = await executeDocumentOperationAsync(backtickSlug, 'POST', '/marks/accept', {
        markId: backtickSuggestionId,
        by: 'human:test',
      });
      assertEqual(backtickResult.status, 200, `Authored span with inline backtick code should not block accept (got ${backtickResult.status})`);
    }

    // Regression: bold formatting (**text**) splits a single authored span into two adjacent sibling
    // spans sharing the same data-proof-id; each span was counted separately, causing fingerprint
    // mismatch with the authored mark's combined ProseMirror quote and excess serialized-authored IDs.
    {
      const boldPmBase = 'Open the door: enter freely. Replace this now.';
      const boldAuthoredQuote = 'Open the door: enter freely.';
      const boldSuggestionQuote = 'Replace this now.';
      const boldAuthoredAnchors = buildRelativeAnchors(boldPmBase, boldAuthoredQuote);
      const boldSuggestionAnchors = buildRelativeAnchors(boldPmBase, boldSuggestionQuote);
      const boldAuthoredId = 'authored-bold-split-regression';
      const boldSuggestionId = 'suggestion-bold-split-regression';
      // Two sibling spans share the same proof-id; the bold marker (**) sits between them.
      const boldMarkdown = [
        `**<span data-proof="authored" data-proof-id="authored:ai:claude:bs-1" data-by="ai:claude">Open the door</span>**`,
        `<span data-proof="authored" data-proof-id="authored:ai:claude:bs-1" data-by="ai:claude">: enter freely.</span> `,
        `<span data-proof="suggestion" data-id="${boldSuggestionId}" data-by="ai:test" data-kind="replace">${boldSuggestionQuote}</span>`,
      ].join('');
      const boldSlug = `rehydrate-bold-split-regression-${Math.random().toString(36).slice(2, 10)}`;
      db.createDocument(boldSlug, boldMarkdown, canonicalizeStoredMarks({
        [boldAuthoredId]: {
          kind: 'authored',
          by: 'ai:claude',
          createdAt,
          quote: boldAuthoredQuote,
          startRel: boldAuthoredAnchors.startRel,
          endRel: boldAuthoredAnchors.endRel,
          range: boldAuthoredAnchors.range,
        } satisfies StoredMark,
        [boldSuggestionId]: {
          kind: 'replace',
          by: 'ai:test',
          createdAt,
          quote: boldSuggestionQuote,
          content: 'new accepted text.',
          status: 'pending',
          startRel: boldSuggestionAnchors.startRel,
          endRel: boldSuggestionAnchors.endRel,
          range: boldSuggestionAnchors.range,
        } satisfies StoredMark,
      }), 'Bold split regression');
      const boldResult = await executeDocumentOperationAsync(boldSlug, 'POST', '/marks/accept', {
        markId: boldSuggestionId,
        by: 'human:test',
      });
      assertEqual(boldResult.status, 200, `Bold-split authored span with same proof-id should not block accept (got ${boldResult.status})`);
    }

    // Regression: a live implementation-plan suggestion had legacy malformed numeric
    // mark keys, authored spans around an already-updated copy, and repeated old anchor
    // text. Accept should still resolve through rehydration instead of raw quote matching.
    {
      const liveMarkId = 'suggestion-live-github-main-regression';
      const liveOldQuote = 'GitHub main deploys through the Fly workflow, and /health reports build 3bd223b with live collaboration enabled.';
      const liveAccepted = 'GitHub `main` deploys through the Fly workflow, and `/health` reports build `d82aed0` with live collaboration enabled.';
      const liveMarkdown = [
        '- ',
        '<span data-proof="authored" data-proof-id="authored:ai:claude:gh-1" data-by="ai:claude">GitHub</span> ',
        '<span data-proof="authored" data-proof-id="authored:ai:claude:gh-2" data-by="ai:claude">`main`</span> ',
        '<span data-proof="authored" data-proof-id="authored:ai:claude:gh-3" data-by="ai:claude">deploys through the Fly workflow, and</span> ',
        '<span data-proof="authored" data-proof-id="authored:ai:claude:gh-4" data-by="ai:claude">`/health`</span> ',
        '<span data-proof="authored" data-proof-id="authored:ai:claude:gh-5" data-by="ai:claude">reports build</span> ',
        '<span data-proof="authored" data-proof-id="authored:ai:claude:gh-6" data-by="ai:claude">`d82aed0`</span> ',
        '<span data-proof="authored" data-proof-id="authored:ai:claude:gh-7" data-by="ai:claude">with live collaboration enabled.</span>\n',
        `- ${liveAccepted}\n`,
        `- ${liveOldQuote}\n`,
        `- ${liveOldQuote}\n`,
      ].join('');
      const livePlain = stripAllProofSpanTags(liveMarkdown);
      const liveAnchors = buildRelativeAnchors(livePlain, liveOldQuote);
      const malformedLegacyPayload = JSON.stringify({
        kind: 'replace',
        quote: liveOldQuote,
        content: liveAccepted,
      });
      const liveSlug = `rehydrate-live-github-main-${Math.random().toString(36).slice(2, 10)}`;
      db.createDocument(liveSlug, liveMarkdown, canonicalizeStoredMarks({
        [liveMarkId]: Object.assign({}, malformedLegacyPayload, {
          kind: 'replace',
          by: 'ai:claude',
          createdAt,
          quote: liveOldQuote,
          content: liveAccepted,
          status: 'pending',
          startRel: liveAnchors.startRel,
          endRel: liveAnchors.endRel,
          range: liveAnchors.range,
        }) as StoredMark,
      }), 'Live GitHub main regression');
      const liveResult = await executeDocumentOperationAsync(liveSlug, 'POST', '/marks/accept', {
        markId: liveMarkId,
        by: 'human:test',
      });
      assertEqual(liveResult.status, 200, `Live GitHub main suggestion should accept despite malformed legacy metadata (got ${liveResult.status})`);
      const liveDoc = db.getDocumentBySlug(liveSlug);
      const liveClean = stripAllProofSpanTags(liveDoc?.markdown ?? '');
      assert(
        liveClean.includes(liveAccepted),
        'Expected live GitHub main accept to keep the accepted markdown-formatted sentence',
      );
      const liveStoredMarks = parseStoredMarks(liveDoc?.marks);
      assert(!(liveMarkId in liveStoredMarks), 'Expected finalized live GitHub main suggestion metadata to be removed');
    }

    console.log('✓ authored span fingerprint regressions: inline backtick code, bold-split proof-id, and live GitHub main accept');
  } finally {
    try {
      unlinkSync(dbPath);
    } catch {
      // Ignore cleanup failures for temp DBs.
    }

    process.env.DATABASE_PATH = prevDatabasePath;
    process.env.PROOF_ENV = prevProofEnv;
    process.env.NODE_ENV = prevNodeEnv;
    if (prevDbEnvInit === undefined) {
      delete process.env.PROOF_DB_ENV_INIT;
    } else {
      process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
