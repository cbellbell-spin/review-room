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

## Database Direction

For the next hosted database slice, prefer one of these paths:

- Hosted SQLite service, such as Turso/libSQL, if we want to keep the SQLite model until Review Room needs Postgres scale or richer relational operations.
- Supabase Postgres in a disposable schema if we are ready to port the persistence layer from `better-sqlite3` to Postgres and validate the Review Room schema there.
- New Supabase project only when we want isolated billing, auth, policies, and operational ownership for Review Room.

Hosted SQLite can be the real database for the early product if it is network-backed or attached to a persistent volume. A local SQLite file inside a serverless runtime is only suitable for disposable smoke testing.
