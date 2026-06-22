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

Collaboration reliability and clarity reached a stable checkpoint on June 19, 2026:

- The two-browser contract now covers concurrent direct edits, comments/replies, suggestions from either editor, self/cross-user accept and reject, hard reconnects, and exact content convergence without duplicate text or resurrected marks.
- Editing remains locked until y-prosemirror is structurally bound to the active Y.Doc and both halves of a real metadata-only Yjs transport probe are acknowledged by the server. Connected/synced events alone do not authorize editing.
- Suggestion decisions are scoped to the target mark; empty canonical mark maps remain authoritative after reconnect; ambiguous short fragments are not hydrated onto guessed text.
- Review Room open context carries stored display names and actor-label mappings while persisted marks keep UUID-backed actor IDs. Existing UUID-only owners fall back to “Document owner,” and identities have a rename API.
- Suggestions use deterministic, accessible per-actor colors in both the editor and Review cards while operation meaning remains visible through line style.
- Recovery telemetry records probe, provider generation, access epoch, recovery outcome, unhealthy duration, unsynced count, edit-gate state, and request correlation without document text or tokens. Prolonged recovery shows an editing-paused message; exhausted recovery offers Retry and Copy diagnostics.
- Docker builds preserve Git metadata when an explicit build arg is absent, so `/health` can report the deployed commit instead of `uncommitted`.

The architectural invariants and regression contract live in `docs/review-room-suggestion-convergence-plan.md` and must be read before changing collaboration, reconnect, hydration, or mark logic.

## Product Direction

Review Room should own the page chrome. Standalone shared-document controls remain useful for direct document links, but they should use Review Room branding and stay out of the way when a document is opened from Review Room.

Target Review Room document header:

```text
Review Room | Documents | Agent API | Document title | Saved | + Add agent | Share
```

The standalone editor pill has been folded into Review Room-owned document chrome for Review Room mode. Keep generic shared-document mode separate for non-Review Room `/d/:slug` pages.

## BYO Agent Architectural Invariant

Review Room is a BYO-agent product. This is a hard product and architecture boundary:

- Review Room never chooses, hosts, or invokes an LLM provider on behalf of a user.
- Review Room never requires or stores Anthropic, OpenAI, Vercel AI Gateway, or other model-provider credentials.
- Review Room never sends document content to a model provider itself.
- Users bring an external agent running in Claude, Codex, Cowork, or another agent host. That agent owns its model choice, provider account, credentials, execution environment, and inference cost.
- Review Room owns the collaboration protocol: authenticated document access, review requests, assignment/claim state, presence, lifecycle status, comments, suggestions, history, idempotency, and human accept/reject/resolve controls.
- “Add agent” means create or expose work for a BYO agent and help that agent connect. It does not mean run a built-in Review Room model.

Any implementation that adds a server-side model SDK, provider API key, model router, or embedded inference runner violates this invariant and must not ship.

## Deferred Product Notes

These observations are recorded for a later UX slice and do not block the current agent-access work:

- The document controls were reverted from the fixed Review Room bar at the top back to the floating island. Treat the floating island as the current implementation state; do not assume the earlier top-bar consolidation is still the active direction.
- The editability and access controls on shared Review Room documents are unclear. A later pass should make the visitor's current access explicit, distinguish document editability from sharing/member management, and make owner actions for changing or revoking access understandable.

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

Completed in the June 19 identity/clarity slice:

- Current Review Room identity is explicit in editor/open-context state, with human-readable names separated from stable actor IDs.
- Owner/editor/commenter/viewer behavior is covered across title updates, comments, suggestions, tasks, baselines, member management, and role-scoped open links.
- Independent-browser coverage verifies owner/editor identity, presence, suggestion colors, and the complete suggestion decision matrix.

Session-backed identity foundation implemented:

- Owners now receive a one-time, seven-day identity invitation when adding or updating a collaborator. A replacement invitation revokes any older unused invitation for the same collaborator and document.
- Accepting the invitation binds the existing stable Review Room identity to a 30-day server session in an `HttpOnly`, `SameSite=Lax` cookie, then opens the collaborator's existing role-scoped document link.
- Invitation and session secrets are stored only as SHA-256 hashes. Invitations are single-use and sessions can be explicitly revoked through logout.
- An authenticated session takes precedence over legacy identity headers, preventing a caller from changing actor attribution while a browser session is active.
- Existing UUID-backed identities, memberships, role tokens, document links, and open-context actor IDs remain compatible. Document authority and live-collab transport are unchanged.
- Manual invitation distribution is intentional for this foundation; no email provider is required. A delivery adapter can be added later without changing the invitation/session model.
- Focused regression coverage pins invitation rotation and replay rejection, cookie flags, session precedence, stable-ID profile rename, and logout revocation.

Identity continuity UI completed on June 20, 2026:

- The dashboard and Review Room document chrome surface the active display name and distinguish session-linked identity from local or document-link identity.
- Display-name editing and current-device sign-out are first-class profile actions backed by the existing identity/session APIs.
- Profile guidance explains the one-browser invitation model, fresh invitations for additional devices, the current lack of recovery/email delivery, and that document links may continue to grant access after session sign-out.
- Document authority, stable mark identity, role resolution, and live-collab transport remain unchanged.
- Focused Playwright coverage pins invitation acceptance, identity visibility, rename persistence across editor/dashboard chrome, current-device sign-out, and 390px overflow behavior.

Remaining permissions work:

- Define account recovery and additional-device enrollment before enabling self-service invitation email.
- Re-check every affordance against capabilities as new controls are added; permission behavior should stay centralized rather than inferred from display state.

## Phase 2 Fly.io Migration Closeout

Goal: move Review Room from the Vercel serverless target to a Fly.io target that can run the app, MCP routes, `/ws`, and live-collab runtime in one long-lived Node process.

Migration closeout is complete:

- `Dockerfile` builds the Vite app in a Node 20 image with native build tools for `better-sqlite3`, then starts `npm run serve`.
- `fly.toml` targets a single always-on `sjc` Machine, mounts `/data`, stores SQLite and snapshots on the volume, exposes `/health`, and keeps the public base URL at `https://review-room.chrisjbell.dev`.
- `.dockerignore` excludes local databases, built assets, snapshots, and bulky workspace folders from the Docker context.
- `.github/workflows/fly-deploy.yml` deploys `main` with `flyctl deploy --remote-only`, using an app-scoped one-year Fly deploy token stored as `FLY_API_TOKEN`.
- Fly live-collab mode is documented as volume-backed SQLite. `TURSO_DATABASE_URL` remains the Vercel hosted/libSQL compatibility switch and should not be set for the live-collab Fly launch.
- The first Fly app, volume, secret, deploy, health check, and restart-persistence smoke are complete for `review-room` in `sjc`.
- The custom hostname `review-room.chrisjbell.dev` is pointed at Fly, the Fly certificate is issued, and `/health` is live on the custom domain.
- Browser smoke opened a custom-domain document in two tabs with no browser warnings/errors; Fly logs showed authenticated live-collab presence for both connections.
- Fly deploy metadata is wired through Docker build args and `.proof-build-info.json` so `/health` reports the deployed SHA.
- Public agent docs, Cowork plugin config, and plugin download instructions now point at `https://review-room.chrisjbell.dev`.
- The deployment guide documents production validation, legacy Vercel posture, and rollback steps that preserve the Fly `/data` volume.
- Fly is treated as a fresh production start unless a future migration/export-import slice explicitly moves existing Vercel/Turso documents into the Fly volume.

## Following Slices

### Completed Slice: Identity Continuity UI

The identity continuity UI is implemented and verified as of June 20, 2026. Account recovery, additional-device enrollment without a fresh owner invitation, and email delivery remain intentionally deferred.

### Removed Experiment: Provider-Bound Agent Review

An uncommitted local experiment incorrectly interpreted “run an agent review” as Review Room invoking Anthropic through AI SDK. That approach was rejected and removed before commit or deployment because it violated the BYO-agent invariant.

- `ai`, `@ai-sdk/anthropic`, `ANTHROPIC_API_KEY`, model configuration, and the server-side inference runner are absent.
- Only lifecycle, permission, idempotency, and UI ideas compatible with the BYO claim protocol were retained.
- No provider-bound path was committed or deployed.

### Implemented Slice: BYO Agent Review Request Protocol

Goal: let a document owner request a review, let an external BYO agent claim and perform it with its own provider credentials, and show trustworthy lifecycle/results inside Review Room.

- Add a persistent review-request record with queued, claimed, running, completed, failed, cancelled, and lease-expired states.
- Make owner “Add agent” create a queued review request with scope and instructions; it must not invoke a model.
- Expose MCP/agent API operations to list available requests, claim one atomically, heartbeat/renew the claim lease, complete it, fail it, or release it.
- Bind submitted comments and suggestions to the claimed review request and BYO agent identity for attribution, history, and deduplication.
- Let an external agent use existing Review Room document/MCP tools and its own model/provider credentials to do the actual review.
- Show “Waiting for an agent,” claimed/running identity, completion counts, failure details, lease expiry, cancel, and safe requeue in Review Room chrome/history.
- Keep one active request per document initially; use request idempotency and per-output fingerprints to prevent duplicate work and duplicate marks.
- Add deterministic contract tests with a simulated external agent. No test or production path may require a provider API key.

Out of scope for this slice: built-in inference, provider credentials, model routing, agent hosting, multi-agent orchestration, autonomous acceptance, and collaboration/Yjs refactors.

### Implemented Slice: Agent-Scoped Access And Identity

Goal: let owners invite a BYO agent without handing it a human editor or owner token, while preserving stable attribution and the existing claim/lease protocol.

- Mint an agent-scoped, revocable document credential with only read, comment, suggest, claim, heartbeat, complete, fail, and release capabilities.
- Prevent agent credentials from directly accepting/rejecting suggestions, rewriting documents, managing members, publishing baselines, or changing owner-controlled settings.
- Bind the credential to a stable Review Room agent identity instead of trusting an arbitrary self-asserted `ai:` actor id.
- Make “Copy request for an agent” use the scoped credential and show its expiry/revocation state to the owner.
- Add permission tests proving agent credentials cannot cross documents or exercise human-only decisions.

Out of scope: provider accounts, model selection, hosted inference, agent billing, and multi-agent orchestration.

Implementation notes:

- Owners mint an MCP-only credential from “Copy request for an agent”; raw secrets are returned once and only SHA-256 hashes are stored.
- Each credential is bound to one document, one review request, and one persisted Review Room agent identity.
- Agent credentials can read, comment, suggest, claim, heartbeat, complete, fail, and release their assigned request.
- They cannot use direct document mutation routes, accept/reject/resolve review decisions, publish, manage members, or access another document.
- Rotating, completing, failing, releasing, cancelling, or lease-expiring the request revokes prior agent access.
- The request UI and copied prompt show that access is scoped and when it expires.

### Implemented Slice: Shared Document Access Clarity

Goal: make current access and editability understandable without deciding the final top-bar-versus-floating-island chrome direction in the same slice.

- The existing document control surface now shows `Full access`, `Can edit`, `Comment only`, or `View only` alongside Share, with a plain-language capability summary in its menu.
- “Your document access” is informational; human collaborator management is a separate action, and the modal explicitly separates human access from request-scoped BYO-agent access.
- Owners can explicitly rotate a collaborator’s document link and unused identity invitation or revoke the collaborator entirely. Both actions revoke the prior document token; revoke also removes active membership.
- Identity invitations name their expiry, replaced/used/expired invitations return an explicit terminal message, and revoked document links show an explicit invalid-or-revoked state.
- `src/tests/review-room-access-clarity.playwright.ts` covers owner, editor, commenter, viewer, signed-out document-link identity, rotated invitation, and revoked document-link states.
- The earlier control-placement reversal remains recorded: this slice does not decide the final fixed-bar-versus-floating-island direction.

Out of scope: moving controls back into a fixed top bar, broad visual redesign, provider integrations, and account recovery.

### Recommended Next Slice: Centralized Capability Enforcement

Goal: close the permissions runway by making the server’s capability result the single source of truth for every document affordance.

- Carry the complete capability set into typed open-context UI state instead of re-deriving permissions from role labels in each component.
- Audit title editing, direct editing, comments/replies, resolve/reopen, suggestion decisions, baselines, tasks, human access, and agent-review actions.
- Hide or disable each action consistently and pair disabled states with a short reason.
- Add a role-by-action contract test proving that every enabled UI action succeeds server-side and every forbidden action is unavailable in the UI.

Out of scope: account recovery, email invitation delivery, provider integrations, and control-placement redesign.

### Workspace And Permissions

- Complete migration from local seeded identities to session-backed users after recovery and additional-device behavior are defined.
- Model owner, editor, commenter, viewer, and agent permissions in Review Room UI state.
- Hide or disable actions the current user cannot perform.
- Add explicit permission tests for document opening, comments, resolve/reopen, title editing, sharing, and agent actions.

### Existing Document Opening

- Keep the registration/opening flow covered as permissions are added.
- Make the dashboard distinguish newly-created drafts from registered documents.
- Show helpful error states when a slug is missing, revoked, paused, or permission-denied.

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
