# Review Room — Suggestion / Collab Convergence: Diagnosis & Plan

_Last updated: 2026-06-16. Owner: follow-up focused effort._

This documents the state after a long debugging session that fixed the catastrophic
collab loop/crash but left the **suggestion → review → accept** workflow with deeper,
interacting issues. Read this before resuming.

## ⚠️ Repo / deploy state
- All session changes are currently **uncommitted on `main`** but **deployed to prod**
  (`fly deploy` builds from the working tree, not from a commit). Prod does not match
  any git commit. **First action for the next session: commit this work to a branch**
  so it's reproducible and not lost. Files touched:
  `server/agent-routes.ts`, `server/canonical-document.ts`, `server/collab.ts`,
  `server/document-engine.ts`, `src/bridge/collab-client.ts`, `src/editor/index.ts`,
  `src/review-room/review-panel.ts`, `fly.toml`, `package.json`, plus `patches/` (new
  `patch-package` patch for y-prosemirror) and `.doc-backups/` (backups of the two
  quarantined docs).

## What is FIXED & deployed (verified)
1. **Server marks write-amplification** — `applyMarksMapDiff` (canonical-document.ts:465,
   collab.ts:8984) only writes changed keys now (idempotent via `stableStringify`).
2. **Client re-entrant stack overflow** — re-entrancy guard in
   `applyLatestCollabMarksToEditor` (src/editor/index.ts).
3. **Force-rerender reverting edits** — `updateShareEditGate` only force-rerenders before
   `hasCompletedInitialCollabHydration`.
4. **Anchor-field ping-pong** — `markValueEqualIgnoringAnchors` in collab-client.ts.
5. **Per-keystroke syncStatus cascade** — `onSyncStatus` heavy block gated to the rising
   edge (`collabWasConnectedSynced`). ⚠️ SUSPECTED CAUSE of the body-duplication regression
   below — re-examine first.
6. **y-prosemirror cursor-jump band-aid → null-return** — `relativePositionToAbsolutePosition`
   returns null on incomplete mapping instead of guessing nodeSize 0
   (`patches/y-prosemirror+1.3.7.patch`).
7. **Accept `enforceProjectionReadiness`** — only enforce when no live mark-fallback exists
   (agent-routes.ts ~1185).
8. **Accept never reached server** — `/state` now always exposes `revision`/`updatedAt`
   (document-engine.ts readState/readStateAsync) so the client can derive a mutation base.
9. **Review pane garbled text ("hpf")** — `fetchReviewDocumentWithLiveContent()` overlays
   live mark `quote`/`range`/`startRel`/`endRel` onto server marks (src/editor/index.ts).
10. **Review tab won't switch after adding a comment** — tab click clears `focusedMarkId`
    (review-panel.ts).
11. **Review pane split one insertion into N chunks** — partly addressed by overlaying live
    `range` so grouping adjacency works; root (coalescing) still open, see below.

## STILL BROKEN — all symptoms of ONE root cause
**Root cause: a collaborative doc with pending suggestions does not reach a stable,
converged canonical state under realistic conditions (two users + network latency +
comments).** Everything below follows from that. It does NOT reproduce on localhost
(zero latency), which is why earlier local tests looked clean — **realistic-latency
testing is required** (e.g. throttle the WS, or run server on Fly and drive two real
browsers).

### A. Accept/reject silently fails (mark stays pending)
- The POST now reaches the server and the mutation applies (`engine:accepted:<actor>`),
  but `mutateCanonicalDocument({ strictLiveDoc: true })` then runs post-mutation
  verification (`verifyAuthoritativeMutationBaseStable` / `verifyLoadedCollabMarkdownStable`
  with `stabilityMs` sampling, agent-routes.ts ~1490-1584). With pending suggestions the
  live doc never matches the expected canonical hash, so verification returns
  not-confirmed (or stalls) → client treats it as failure → mark stays pending.
- Server logs at failure: `markdownConfirmed: false, markdownSource: 'none'`.
- Direction: mark-status mutations (accept/reject) shouldn't require full live-convergence
  verification the way content rewrites do. Consider a relaxed/optimistic confirmation for
  `/marks/accept|reject`, OR fix the underlying convergence (B/C) so verification can pass.

### B. Suggestion coalescing fragments under latency
- `getCoalescableInsertCandidate` (src/editor/plugins/suggestions.ts) relies on
  `lastInsertByActor` + the previous mark's range matching the next insert position. The
  marks round-trip (`applyExternalMarks` from the peer/server) re-derives marks mid-typing
  with latency, so the candidate lookup misses and each keystroke makes a new 1-char mark.
- Result: review pane shows fragmented chunks (mitigated cosmetically by #9/#11) and accept
  becomes per-fragment.
- Direction: make coalescing resilient to the round-trip (e.g. coalesce by actor+adjacency
  in the live doc regardless of the cache), or debounce remote mark re-application while the
  local user is actively typing.

### C. Body text duplicates on comment interaction (most serious — data integrity)
- Two editors; when the 2nd editor interacts with comments, previously-inserted body text
  appears twice (e.g. "One more testOne more test") with no review-pane change.
- Strongly suspected regression from change #5 (rising-edge hydration gate) or an
  interaction with `kickCollabHydration`/`_forceRerender` no longer running when a
  re-hydration was previously deduplicating. **Investigate first** — possibly revert/narrow
  #5 and re-verify the concurrent-edit case it originally fixed.

## Suggested staging for the focused effort
1. Commit current work to a branch; snapshot prod behavior.
2. Stand up **realistic-latency repro** (throttled WS or two real browsers on Fly) — this is
   the prerequisite; localhost hides all of B/C.
3. Fix **C (duplication)** first (data integrity). Bisect #5 / hydration changes.
4. Fix **B (coalescing)** so marks stay whole — this likely makes A and the review pane
   correct as a side effect.
5. Revisit **A (accept verification)** — with B fixed, verification may pass; otherwise relax
   it for mark-status mutations.
6. Remove the temporary `PROOF_COLLAB_HOT_SLUG_DENYLIST` once docs can be re-seeded.

## Also pending
- **Re-seed `79ch6unw` and `y1v0g018`** from `.doc-backups/` and lift their entries from
  `PROOF_COLLAB_HOT_SLUG_DENYLIST` in `fly.toml`. Their stored Yjs state has tombstone
  bloat from the original loop; the code fix prevents new docs from looping but doesn't
  unwind their existing corruption.
