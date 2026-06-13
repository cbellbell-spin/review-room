# Review Room Deployment Notes

## Current Fly Production Deployment

Review Room production now runs on Fly.io:

```text
app=review-room
primary_hostname=https://review-room.chrisjbell.dev
fly_hostname=https://review-room.fly.dev
machine=9080d39efdd708
region=sjc
volume=data
```

The Fly production mode is intentionally single-machine and volume-backed:

```text
DATABASE_PATH=/data/proof-share.db
SNAPSHOT_DIR=/data/snapshots
PROOF_PUBLIC_BASE_URL=https://review-room.chrisjbell.dev
PROOF_TRUST_PROXY_HEADERS=true
PROOF_COLLAB_V2=1
```

Do not set `TURSO_DATABASE_URL` for the live-collab Fly launch. In this codebase, that environment variable selects the hosted/libSQL adapter used by the legacy Vercel deployment, and that adapter intentionally returns non-collab editor bootstrap responses.

Use Turso on Fly only for an explicit lift-and-shift compatibility deploy where live WebSocket collaboration remains disabled. The live-collab production path uses the Fly volume as the durable SQLite store, so existing Vercel/Turso documents need a migration/export-import step before they can appear on Fly.

## Legacy Vercel Staging Deployment

Vercel project:

- Team: `chris-bells-projects-ca98ffd5`
- Project: `proof-sdk`
- Legacy alias: `https://proof-sdk-psi.vercel.app`

The deployment uses a Vercel Function entrypoint at `api/index.js`, with all paths rewritten through the Express app.

Runtime environment used for the initial staging deploy:

```text
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
SNAPSHOT_DIR=/tmp/review-room-snapshots
PROOF_TRUST_PROXY_HEADERS=true
PROOF_COLLAB_V2=0
```

When `TURSO_DATABASE_URL` is present, Review Room uses the hosted libSQL adapter for the dashboard create/register/list flow, document state reads, editor open-context bootstrap, and bridge comment writes. Local development and tests keep using `better-sqlite3` through `DATABASE_PATH`.

Live WebSocket collaboration remains disabled for this target. The hosted adapter returns non-collab editor bootstrap responses so Vercel serverless instances can still open, read, and comment on Review Room documents against the same durable database.

Do not use `DATABASE_PATH=/tmp/review-room.db` for hosted smoke tests except when intentionally checking packaging only. The temp SQLite path is per function instance, so document creation can succeed on one invocation while a later document-state request lands on another instance and cannot see the same file.

## Fly.io Launch And Operations

Fly.io is the production target for Review Room because it can run one long-lived Node process with the Express app, `/ws` WebSocket entrypoint, MCP routes, and the Hocuspocus collab runtime in the same Machine.

Launch sequence:

```bash
brew install flyctl
fly auth login
cd ~/projects/proof-sdk
fly apps create review-room --org personal
fly volumes create data --size 1 --region sjc
fly secrets set PROOF_COLLAB_SIGNING_SECRET=...
fly deploy
fly certs add review-room.chrisjbell.dev
```

Set optional secrets only when the corresponding integration is enabled:

```bash
fly secrets set PROOF_SHARE_MARKDOWN_API_KEY=...
fly secrets set SNAPSHOT_S3_BUCKET=... SNAPSHOT_S3_ACCESS_KEY_ID=... SNAPSHOT_S3_SECRET_ACCESS_KEY=... SNAPSHOT_S3_REGION=...
fly secrets set PROOF_GITHUB_ISSUES_TOKEN=... PROOF_GITHUB_ISSUES_REPO=...
```

After deploy, verify:

- `/health` returns `collab.enabled: true` and a `wss://review-room.chrisjbell.dev/ws` URL.
- Creating a Review Room document persists across a Machine restart.
- Two browser sessions opening the same role-scoped document link see live comments/suggestions without REST-only fallback.
- Run `npm run smoke:review-room-production` to create a throwaway Fly document, create a role-scoped commenter link, connect to live-collab over `wss`, add a comment and suggestion, and reload state to verify persistence.

First Fly launch validation completed on June 12, 2026:

- `flyctl deploy --remote-only --app review-room` passed Fly config validation, remote Docker build, image push, and first Machine rollout.
- `https://review-room.fly.dev/health` returned `collab.enabled: true` and `wsUrlBase: wss://review-room.chrisjbell.dev/ws`.
- A smoke document created through `POST /documents` was readable before and after restarting Machine `9080d39efdd708`, verifying that the mounted `/data` SQLite store persists across restart.
- `fly certs add review-room.chrisjbell.dev --app review-room` created the custom-hostname certificate record.
- Cloudflare DNS was pointed at Fly with A/AAAA records, and `fly certs check review-room.chrisjbell.dev --app review-room` reported `Issued` and active.
- `https://review-room.chrisjbell.dev/health` returned `collab.enabled: true` and `wsUrlBase: wss://review-room.chrisjbell.dev/ws`.
- Browser smoke opened the same custom-domain document in two tabs without console warnings/errors; Fly logs showed live-collab session leases plus authenticated collab presence attachments for both connections.
- Future Fly deploys pass `GIT_COMMIT_SHA` and `BUILD_RELEASE_DATE` as Docker build args, and the build writes `.proof-build-info.json` so `/health` can report the deployed SHA.

GitHub Actions production deploy validation completed on June 13, 2026:

- A one-year app-scoped Fly deploy token named `github-actions-review-room` is stored in GitHub Actions as `FLY_API_TOKEN` for `cbellbell-spin/review-room`.
- The duplicate token created during setup was revoked; `flyctl tokens list --app review-room --scope app` should show only one active `github-actions-review-room` token.
- `package-lock.json` is tracked because the Dockerfile uses `npm ci`; `src/tests/fly-config.test.ts` guards this contract.
- The `fly deploy` workflow deployed commit `12d0d68fc42fa599b2678e99378a73bb350a5255` successfully, and `https://review-room.chrisjbell.dev/health` reported that SHA with `collab.enabled: true`.

## Rollback

Prefer rolling forward unless the deployed app cannot serve `/health`, open existing Fly documents, or preserve live-collab state.

1. Check the current production state:

   ```bash
   curl -fsS https://review-room.chrisjbell.dev/health
   fly releases --app review-room
   fly status --app review-room
   ```

2. Roll back the app image to the previous complete Fly release:

   ```bash
   fly releases --app review-room
   fly deploy --image <previous-image-ref> --app review-room
   ```

   If the previous release is still available through Fly's release tooling, `fly releases --app review-room` is the source of truth for the version and image to redeploy.

3. Do not delete or recreate the `data` volume during rollback. It contains the production SQLite database and snapshots at `/data/proof-share.db` and `/data/snapshots`.

4. Do not set `TURSO_DATABASE_URL` while rolling back the live-collab Fly app. That switches Review Room into the legacy hosted/libSQL adapter and disables the live WebSocket collaboration path.

5. If Fly itself is unreachable and a temporary service fallback is required, point DNS back to the legacy Vercel alias only after accepting that live-collab sessions will be disabled and Fly-volume documents will not automatically exist in the Vercel/Turso store.

Fly DNS setup options for `review-room.chrisjbell.dev`:

```text
A     review-room.chrisjbell.dev -> 66.241.125.169
AAAA  review-room.chrisjbell.dev -> 2a09:8280:1::128:3192:0
```

or:

```text
CNAME review-room.chrisjbell.dev -> 6njyzon.review-room.fly.dev
```

If routing through a CDN/proxy, add:

```text
TXT _fly-ownership.review-room.chrisjbell.dev -> app-6njyzon
```

## Database Direction

For the next hosted database slice, prefer one of these paths:

- Hosted SQLite service, such as Turso/libSQL, if we want to keep the SQLite model until Review Room needs Postgres scale or richer relational operations.
- Supabase Postgres in a disposable schema if we are ready to port the persistence layer from `better-sqlite3` to Postgres and validate the Review Room schema there.
- New Supabase project only when we want isolated billing, auth, policies, and operational ownership for Review Room.

Hosted SQLite can be the real database for the early product if it is network-backed or attached to a persistent volume. A local SQLite file inside a serverless runtime is only suitable for disposable smoke testing.
