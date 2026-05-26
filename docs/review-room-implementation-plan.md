# Review Room Implementation Plan

This plan tracks the product split from Proof SDK into the Review Room app.

## Current State

Review Room now has its own GitHub repository at `cbellbell-spin/review-room`.

Phase 1 is complete:

- Review Room dashboard at `/review-room`.
- Local Review Room workspace, identities, and document registry.
- Create, list, and open Review Room documents backed by Proof document slugs.
- Review Room editor mode with document opening, agent comments, replies, resolve, and reopen.
- Resolved comments are discoverable from the comments drawer.
- Basic viewer/commenter/editor permission behavior is covered.
- Root `/` redirects to `/review-room`.
- Repo identity has been updated from Proof SDK toward Review Room while still keeping the Proof SDK runtime it depends on.

## Product Direction

Review Room should own the page chrome. The generic Proof shared-document pill remains useful for standalone Proof SDK share pages, but it should not compete with the Review Room navigation when a document is opened from Review Room.

Target Review Room document header:

```text
Review Room | Documents | Agent API | Document title | Saved | + Add agent | Share
```

The Proof/editor pill should be folded into the Review Room nav/header for Review Room mode.

## Next Slice: Unified Review Room Header

Goal: replace the stacked Review Room nav plus floating editor pill with one Review Room-owned header.

Work items:

- Render Review Room document controls into the Review Room header when `window.__PROOF_CONFIG__.reviewRoom === true`.
- Keep generic shared-document mode unchanged for non-Review Room `/d/:slug` pages.
- Move document title, saved/sync status, Add agent, and Share controls into the Review Room header.
- Keep the header responsive: compact title, stable buttons, no overlap with document content on desktop or mobile.
- Preserve existing title editing, share menu, agent menu, presence, and sync behavior.
- Add browser verification for:
  - no duplicate/stacked toolbar,
  - header says Review Room,
  - title and saved state are visible,
  - Add agent and Share remain usable,
  - mobile layout does not clip or overlap.

## Following Slices

### Existing Document Opening

- Add a first-class flow for registering/opening an existing Proof document in Review Room.
- Make the dashboard distinguish newly-created drafts from registered documents.
- Show helpful error states when a slug is missing, revoked, paused, or permission-denied.

### Permissions

- Replace local seeded identities with real session-backed users.
- Model owner, editor, commenter, viewer, and agent permissions in Review Room UI state.
- Hide or disable actions the current user cannot perform.
- Add explicit permission tests for document opening, comments, resolve/reopen, title editing, sharing, and agent actions.

### Agent Review Workflow

- Make Add agent run an actual review flow rather than acting as a placeholder.
- Show agent status, activity, and failures in the header/drawer.
- Let users reply to, resolve, and reopen agent comments from the same review surface.

### Repo Pruning

- Continue separating Review Room-specific code from reusable Proof SDK runtime code.
- Remove demos/docs that are only relevant to Proof SDK once Review Room has its own app-level documentation.
- Keep compatibility docs for the Proof-compatible agent/document APIs Review Room relies on.

## Validation Baseline

Before pushing implementation slices:

```bash
npm test
npm run build
```

For comment UI work:

```bash
npx tsx src/tests/mobile-comment-ux.test.ts
```

For visible UI work, also verify in the browser against `http://localhost:4000/review-room` and an opened Review Room document URL such as `/d/:slug?rr=1`.
