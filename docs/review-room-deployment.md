# Review Room Deployment Notes

## Current Vercel Staging Deployment

Vercel project:

- Team: `chris-bells-projects-ca98ffd5`
- Project: `proof-sdk`
- Production alias: `https://proof-sdk-psi.vercel.app`

The deployment uses a Vercel Function entrypoint at `api/index.js`, with all paths rewritten through the Express app.

Runtime environment used for the initial staging deploy:

```text
DATABASE_PATH=/tmp/review-room.db
PROOF_TRUST_PROXY_HEADERS=true
PROOF_COLLAB_V2=0
```

This is a smoke-test deployment, not durable production persistence. The SQLite file lives in the function runtime temp directory and may disappear when the function instance is replaced. Live WebSocket collaboration is disabled for this target.

## Database Direction

For the next hosted database slice, prefer one of these paths:

- Hosted SQLite service, such as Turso/libSQL, if we want to keep the SQLite model until Review Room needs Postgres scale or richer relational operations.
- Supabase Postgres in a disposable schema if we are ready to port the persistence layer from `better-sqlite3` to Postgres and validate the Review Room schema there.
- New Supabase project only when we want isolated billing, auth, policies, and operational ownership for Review Room.

Hosted SQLite can be the real database for the early product if it is network-backed or attached to a persistent volume. A local SQLite file inside a serverless runtime is only suitable for disposable smoke testing.
