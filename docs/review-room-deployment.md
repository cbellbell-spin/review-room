# Review Room Deployment Notes

## Current Vercel Staging Deployment

Vercel project:

- Team: `chris-bells-projects-ca98ffd5`
- Project: `proof-sdk`
- Production alias: `https://proof-sdk-psi.vercel.app`

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

## Fly.io Production Migration

Fly.io is the next production target for Review Room because it can run one long-lived Node process with the Express app, `/ws` WebSocket entrypoint, MCP routes, and the Hocuspocus collab runtime in the same Machine.

Current Fly app:

```text
app=review-room
hostname=https://review-room.fly.dev
machine=9080d39efdd708
region=sjc
volume=data
```

The first Fly production mode is intentionally single-machine and volume-backed:

```text
DATABASE_PATH=/data/proof-share.db
SNAPSHOT_DIR=/data/snapshots
PROOF_PUBLIC_BASE_URL=https://review-room.chrisjbell.dev
PROOF_TRUST_PROXY_HEADERS=true
PROOF_COLLAB_V2=1
```

Do not set `TURSO_DATABASE_URL` for the live-collab Fly launch. In this codebase, that environment variable selects the hosted/libSQL adapter used by the Vercel deployment, and that adapter intentionally returns non-collab editor bootstrap responses.

Use Turso on Fly only for an explicit lift-and-shift compatibility deploy where live WebSocket collaboration remains disabled. The live-collab production path uses the Fly volume as the durable SQLite store, so existing Vercel/Turso documents need a migration/export-import step before cutover.

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

First Fly launch validation completed on June 12, 2026:

- `flyctl deploy --remote-only --app review-room` passed Fly config validation, remote Docker build, image push, and first Machine rollout.
- `https://review-room.fly.dev/health` returned `collab.enabled: true` and `wsUrlBase: wss://review-room.chrisjbell.dev/ws`.
- A smoke document created through `POST /documents` was readable before and after restarting Machine `9080d39efdd708`, verifying that the mounted `/data` SQLite store persists across restart.
- `fly certs add review-room.chrisjbell.dev --app review-room` created the custom-hostname certificate record.
- Cloudflare DNS was pointed at Fly with A/AAAA records, and `fly certs check review-room.chrisjbell.dev --app review-room` reported `Issued` and active.
- `https://review-room.chrisjbell.dev/health` returned `collab.enabled: true` and `wsUrlBase: wss://review-room.chrisjbell.dev/ws`.
- Browser smoke opened the same custom-domain document in two tabs without console warnings/errors; Fly logs showed live-collab session leases plus authenticated collab presence attachments for both connections.
- Future Fly deploys pass `GIT_COMMIT_SHA` and `BUILD_RELEASE_DATE` as Docker build args, and the build writes `.proof-build-info.json` so `/health` can report the deployed SHA.

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
