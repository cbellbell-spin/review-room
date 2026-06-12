# Review Room Implementation Plan

This plan tracks the product split from Proof SDK into the Review Room app.

## Current State

Review Room now has its own GitHub repository at `cbellbell-spin/review-room`.

Phase 1 is complete:

- Review Room dashboard at `/review-room`.
- Local Review Room workspace, identities, and document registry.
- Create, list, and open Review Room documents backed by reusable document slugs.
- Review Room editor mode with document opening, agent comments, replies, resolve, and reopen.
- Resolved comments are discoverable from the comments drawer.
- Basic viewer/commenter/editor permission behavior is covered.
- Root `/` redirects to `/review-room`.
- Repo identity has been updated from Proof SDK toward Review Room while still keeping the Proof SDK runtime it depends on.

Phase 1.5 is complete enough to close as the product-layer foundation:

- Review Room product state is unified through `server/review-room-store.ts` for local and hosted libSQL-backed flows.
- Product tables and routes cover workspace/document/member records, identities, agents, document-agent settings, assignment tasks, published versions, and history events.
- Legacy GET-only agent actions are disabled by default; MCP plus POST bridge routes are the preferred agent path.
- The review cockpit lives in `src/review-room/` instead of the editor monolith, with tabs for Suggestions, Comments, History, Tasks, and Publish.
- CJB design tokens are applied to the Review Room shell, dashboard, header, and cockpit foundation.
- Cockpit filters cover actor/type/status/event filters across suggestions, comments, history, and tasks.
- Suggestion decisions record product history and history rows summarize accepted/rejected additions, replacements, deletions, baselines, documents, and task status changes.
- Mention-to-task wiring is in place: `@mentions` in comments/replies create assignment tasks, Tasks can be completed/dismissed, and task events appear in history.
- Manual publish/baseline creation is in place, including baseline list and a compact Changes since baseline view.
- The hosted accept path strips persisted Proof mark spans and accepts suggestions by span identity, fixing the hosted polluted-markdown `ANCHOR_NOT_FOUND` failure.

Remaining cockpit polish, timezone/status-prose conventions, richer severity/category metadata, and deeper changes-since-baseline review views should move to later cockpit/product-depth work. They should not block Phase 2.

## Product Direction

Review Room should own the page chrome. Standalone shared-document controls remain useful for direct document links, but they should use Review Room branding and stay out of the way when a document is opened from Review Room.

Target Review Room document header:

```text
Review Room | Documents | Agent API | Document title | Saved | + Add agent | Share
```

The standalone editor pill has been folded into Review Room-owned document chrome for Review Room mode. Keep generic shared-document mode separate for non-Review Room `/d/:slug` pages.

## Phase 2 Permissions Runway

Goal: make the owner-plus-collaborator flow real without reopening Phase 1.5 cockpit polish.

First server/API slice implemented:

- Review Room document listing is member-scoped for the current identity instead of exposing every workspace document to every identity.
- Review Room product APIs resolve current access from either `x-review-room-identity-id` or the presented share token, so opened collaborator links carry the correct member role into History, Tasks, Baselines, and Members routes.
- Owners can add or update document members through `POST /review-room/api/documents/:proofSlug/members`; responses return the collaborator's role-scoped open link/token.
- Role changes mint a new Proof access token for that member and revoke the previous member token, so downgrades stop preserving older edit access.
- History, task list, and baseline list require document membership; baseline creation requires edit capability; task status changes require comment capability; member management requires owner role.
- Focused coverage lives in `src/tests/review-room-permissions.test.ts` and is wired into `npm test` as `test:review-room-permissions`.

Owner-facing collaborator UI slice implemented:

- The Review Room header Share menu is visible for all Review Room roles, not only edit-capable roles.
- The Share menu shows the current Review Room access role and opens a Collaborators modal.
- The Collaborators modal lists document members for every member role; only owners see the add/update collaborator form.
- Owners can create or update a collaborator identity and role from the modal, then copy the returned role-scoped Review Room open link.
- The Review cockpit disables baseline creation for non-edit roles and disables task status changes for roles without comment access.
- Header wiring coverage pins the typed member client, Share menu entry, Collaborators modal, and role-gated cockpit affordances.
- Local browser smoke verified the owner flow: Share menu -> Manage collaborators -> add commenter -> copyable collaborator link.

Work items:

- Carry current Review Room identity into dashboard/editor UI state explicitly, not only through tokens and local defaults.
- Finish hiding or disabling remaining document actions the current role cannot use: title editing, comment/reply/resolve, suggestion accept/reject, and sharing/member controls outside the modal.
- Extend focused tests across owner/editor/commenter/viewer behavior for comments, suggestions, title updates, tasks, baselines, and share/member controls.
- Add one local browser verification pass for a non-owner role opening the same Review Room document.

## Next Slice: Phase 2 Fly.io Migration Runway

Goal: move Review Room from the Vercel serverless target to a Fly.io target that can run the app, MCP routes, `/ws`, and live-collab runtime in one long-lived Node process.

First deployment scaffold implemented:

- `Dockerfile` builds the Vite app in a Node 20 image with native build tools for `better-sqlite3`, then starts `npm run serve`.
- `fly.toml` targets a single always-on `sjc` Machine, mounts `/data`, stores SQLite and snapshots on the volume, exposes `/health`, and keeps the public base URL at `https://review-room.chrisjbell.dev`.
- `.dockerignore` excludes local databases, built assets, snapshots, and bulky workspace folders from the Docker context.
- `.github/workflows/fly-deploy.yml` deploys `main` with `flyctl deploy --remote-only`.
- Fly live-collab mode is documented as volume-backed SQLite. `TURSO_DATABASE_URL` remains the Vercel hosted/libSQL compatibility switch and should not be set for the live-collab Fly launch.
- The first Fly app, volume, secret, deploy, health check, and restart-persistence smoke are complete for `review-room` in `sjc`.
- The custom hostname `review-room.chrisjbell.dev` is pointed at Fly, the Fly certificate is issued, and `/health` is live on the custom domain.
- Browser smoke opened a custom-domain document in two tabs with no browser warnings/errors; Fly logs showed authenticated live-collab presence for both connections.
- Fly deploy metadata is wired through Docker build args and `.proof-build-info.json` so `/health` can report a real deployment SHA after the next deploy.

Work items:

- Decide whether to keep the Fly smoke document or clean it up after the live-collab smoke.
- Decide whether to migrate existing Vercel/Turso documents into the Fly volume before DNS cutover, or treat Fly as a fresh production start.

## Following Slices

### Workspace And Permissions

- Replace local seeded identities with real session-backed users.
- Model owner, editor, commenter, viewer, and agent permissions in Review Room UI state.
- Hide or disable actions the current user cannot perform.
- Add explicit permission tests for document opening, comments, resolve/reopen, title editing, sharing, and agent actions.

### Existing Document Opening

- Keep the registration/opening flow covered as permissions are added.
- Make the dashboard distinguish newly-created drafts from registered documents.
- Show helpful error states when a slug is missing, revoked, paused, or permission-denied.

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

Use [Review Room manual test cases](./review-room-manual-test-cases.md) for dashboard, create/open, existing-document registration, unavailable-state, and responsive header checks.
