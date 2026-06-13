# Review Room Vercel to Fly Document Migration

This runbook migrates legacy Review Room documents from the Vercel/Turso deployment into the Fly production SQLite volume.

The migration preserves document slugs, document IDs, content, Review Room records, comments/suggestions, tasks, baselines, and history records. It does not preserve legacy access material: Vercel `document_access` rows, document owner secrets, and Review Room member token values are omitted during export. The Fly import mints fresh tokens and writes them to a local token manifest.

## Safety Model

- Use a short Vercel write freeze before export.
- Back up the Fly volume database before import.
- Run the import once in dry-run mode before `--apply`.
- Keep the generated token manifest private. It contains the only copy of the fresh Fly share URLs.
- Do not import into a database that already has the same slugs unless you intentionally use `--skip-existing`.

## 1. Freeze Vercel Writes

Pick a quiet window and avoid editing/commenting on the Vercel deployment while the export runs. If Vercel remains writable, any edits after export must be migrated manually or the export must be repeated.

## 2. Export From Vercel/Turso

Run from the repo root with the legacy Turso credentials available:

```bash
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
  npm run migrate:review-room:export -- \
  --out /tmp/review-room-vercel-export.json
```

To export only a subset:

```bash
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
  npm run migrate:review-room:export -- \
  --out /tmp/review-room-vercel-export.json \
  --slug y1v0g018
```

The export file is written with mode `0600`. It intentionally omits old tokens and owner secrets.

## 3. Back Up Fly SQLite

Before importing, copy `/data/proof-share.db` out of the Fly machine or take a volume snapshot. Keep the matching `-wal` and `-shm` files if they exist and you copy the database while the app is running.

Preferred operational shape:

1. Pause public writes.
2. Stop or scale down the app process if practical.
3. Copy `/data/proof-share.db*`.
4. Start the app again only after import and verification.

## 4. Copy the Export to Fly

Place the export JSON somewhere the Fly machine can read, for example `/data/review-room-vercel-export.json`.

## 5. Dry Run the Import

On the Fly machine or against a local copy of the Fly database:

```bash
DATABASE_PATH=/data/proof-share.db PROOF_ENV=production \
  npm run migrate:review-room:import -- \
  --in /data/review-room-vercel-export.json \
  --database /data/proof-share.db \
  --token-out /data/review-room-fly-tokens.json
```

Without `--apply`, the script reports what it would import and exits without writing.

## 6. Apply the Import

```bash
DATABASE_PATH=/data/proof-share.db PROOF_ENV=production \
  npm run migrate:review-room:import -- \
  --in /data/review-room-vercel-export.json \
  --database /data/proof-share.db \
  --token-out /data/review-room-fly-tokens.json \
  --apply
```

The importer:

- inserts the exported document and Review Room rows;
- resets imported document `y_state_version` to `0`, so Fly live-collab starts from the imported markdown/projection baseline;
- leaves `owner_secret` and `owner_secret_hash` empty;
- creates new `document_access` rows for each Review Room member;
- writes new Fly URLs to the token manifest.

## 7. Verify

```bash
DATABASE_PATH=/data/proof-share.db PROOF_ENV=production \
  npm run migrate:review-room:verify -- \
  --in /data/review-room-vercel-export.json \
  --database /data/proof-share.db
```

Then open a few generated Fly URLs from `/data/review-room-fly-tokens.json` and check:

- the document loads at `https://review-room.chrisjbell.dev`;
- comments and suggestions are present;
- Review Room sidebar tabs load;
- owner/editor/commenter permissions behave as expected;
- a small comment or suggestion persists after reload.

Finish with:

```bash
npm run smoke:review-room-production
```

## 8. Retire or Redirect Vercel

Because fresh tokens are minted, old Vercel URLs will not authorize on Fly. Keep the token manifest as the new source of truth, and retire the old Vercel deployment once the imported Fly docs are checked.
