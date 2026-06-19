# Review Room collaboration convergence: incident record and invariants

_Resolved 2026-06-19. Keep this document as the design record for live collaboration changes._

## Outcome

The core Review Room contract is working in one and two independent browser processes:

- distinct human identities and presence;
- concurrent direct edits;
- comments, replies, resolve/unresolve;
- suggestions from either editor;
- self and cross-user accept/reject;
- exact content convergence without duplicated text or resurrected marks.

The production deployment was initially built from an uncommitted working tree on
`fix/collab-suggestion-stability`; the merge process commits that exact verified scope so the
next deployment and repository history correspond to a Git SHA.

## Why the failures looked circular

Several defects produced nearly identical UI symptoms (a pending suggestion, a 409, stale
text, or one browser not updating), but they occurred at different authority boundaries:

1. **Mutation readiness:** accept incorrectly required hydration of every mark in the
   document, including unrelated authored provenance.
2. **Anchor identity:** partial, ambiguous suggestion text could hydrate onto the wrong
   occurrence; a one-character update was enough to create a duplicate tail later.
3. **Epoch transition:** a retiring y-prosemirror binding could repaint stale anchors after
   the client had cleared them.
4. **Editor binding readiness:** elapsed time was used as a proxy for the editor being bound
   to the replacement Y.Doc.
5. **Transport readiness:** the editor and local Y.Doc could both be correct while the
   replacement websocket provider silently failed to carry local Yjs updates. The UI still
   appeared connected and editable.

The investigation became productive once the test reported each boundary separately:
ProseMirror document, local Y.XmlFragment, peer document, server live fragment, and canonical
state. “Green” is not a single boolean in a replicated editor.

## Fixes and invariants

### Suggestion decisions

- Accept/reject readiness is scoped to the requested suggestion, never unrelated provenance.
- A visible insert may be finalized without rehydration only when exact character anchors
  match or the server finds one unique exact occurrence. Ambiguous repeated text remains a
  conflict.
- Accepting a visible insert removes its serialized suggestion wrapper; it never inserts the
  already-visible text again.
- Nested authored/comment markup is preserved when a suggestion wrapper is removed.
- Finalized suggestion tombstones prevent stale live projections from resurrecting marks.

### Remote marks

- Empty canonical mark maps are meaningful and must be applied authoritatively after a hard
  reconnect.
- Authoritative application removes stale non-authored anchors while preserving authored
  provenance.
- Ambiguous short partial suggestions are not hydrated until enough text exists to resolve
  one target safely.

### Reconnect and edit gating

- An access-epoch change is a hard authority boundary. Local non-authored review anchors are
  cleared before attaching the replacement Y.Doc and again after the replacement binding is
  structurally active.
- The editor is writable only when y-prosemirror plugin state, XmlFragment, binding, binding
  document, editor view, and the active CollabClient Y.Doc all refer to the same generation.
- Timeouts are retry bounds, not evidence of readiness.
- “Connected” and “synced” events alone do not authorize editing. A metadata-only Yjs update
  must receive the normal server acknowledgement; its acknowledged deletion leaves no probe
  data behind.
- A failed transport probe keeps the editor locked and triggers a bounded provider/session
  rebuild. Silent local-only editing is forbidden.

## Regression contract

The principal regression test is
`src/tests/review-room-two-editor-empty-doc-fragment-drift.playwright.ts`. It launches two
separate Chromium processes and covers direct edits plus the full self/cross accept/reject
matrix through four access epochs. Failures include browser-local ProseMirror and Yjs state,
server live fragment, and canonical state.

Supporting browser contracts cover:

- single-editor typed insert acceptance;
- two-browser comment creation and reply without duplicated body text;
- Review Room create/open behavior and suggested-line placement.

Supporting unit/integration coverage includes unique versus ambiguous unhydrated inserts,
nested proof-span unwrapping, authoritative remote-mark cleanup, short ambiguous hydration,
and hosted accept regressions. These suites are part of the default `npm test` command.

Merge gate used for this fix:

- production build passes;
- full `npm test` passes (120/120 mark tests);
- three consecutive full two-browser matrices pass after the final transport recovery fix,
  plus the preceding recovery verification run;
- focused typed-accept and comment/reply browser tests pass;
- `git diff --check` is clean;
- Fly machine health and public `/health` pass after deployment.

## Observability and user feedback

Current behavior already shows Saved, Saving, Syncing, Connecting, Offline, Unsaved, Revoked,
and Unshared states in the Review Room header. It also detects unhealthy sessions and attempts
bounded recovery. The incident exposed two gaps:

1. **Telemetry:** record transport probe start/success/failure, provider generation, access
   epoch, recovery attempt/result, time unhealthy, unsynced count, and whether editing was
   gated. Correlate client events with the server connection/request ID without logging
   document text or tokens.
2. **User feedback:** when the transport gate remains closed beyond a short grace period,
   show a persistent “Reconnecting — editing paused to protect your changes” state. Escalate
   to “Couldn’t reconnect” with Retry and diagnostic-copy actions after bounded recovery is
   exhausted. Do not merely show a green Saved dot based on local Y.Doc state.

## Deliberately deferred polish

- **Human-readable identity:** browser UUIDs are durable identity keys, not display names.
  Extend Review Room open context with the stored identity display name, use that for presence
  and review UI, and retain `human:<identity-id>` internally for stable attribution. Existing
  UUID-backed identities need a rename/edit path or a friendly fallback such as “Document
  owner”.
- **Per-actor suggestion colors:** suggestion marks currently style by operation kind only.
  Assign a stable accessible actor color (with operation kind retained through line style or
  icon), apply it consistently to document highlights and Review cards, and test contrast and
  same-actor stability.

These items improve comprehension but do not change the replicated-state authority model and
should be shipped separately from the convergence fix.
