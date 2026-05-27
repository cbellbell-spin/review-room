# Review Room Manual Test Cases

Use these checks after visible Review Room UI changes or workflow changes that touch document creation, registration, opening, or document chrome.

## Setup

```bash
npm run build
DATABASE_PATH=/private/tmp/review-room-manual.db npm run serve
```

Open `http://127.0.0.1:4000/review-room`.

## Dashboard Loads

1. Open `/review-room`.
2. Confirm the top nav shows `Review Room`, `Documents`, and `Agent API`.
3. Confirm the document list loads without an error.
4. Confirm the side panel shows:
   - `New Review`
   - `Create and open`
   - `Existing document slug or URL`
   - `Access token`
   - `Register and open`

Expected: dashboard is usable, with no visible script error banner.

## Create Review Room Document

1. In `New Review`, enter a unique title.
2. Enter Markdown content.
3. Click `Create and open`.
4. Confirm the browser opens `/d/:slug?rr=1&token=...`.
5. Confirm the document header has the title on its own top row.
6. Confirm the second header row has `Review Room`, `Documents`, `Agent API`, saved/sync state, `Add agent`, and `Share`.
7. Return to `/review-room`.

Expected: the document appears in the list with source label `Created in Review Room`.

## Register Existing Active Document

Create a document outside the Review Room dashboard:

```bash
curl -s http://127.0.0.1:4000/documents \
  -H 'Content-Type: application/json' \
  -d '{"title":"Existing Document Manual Test","markdown":"# Existing Document Manual Test\n\nBody."}'
```

1. Copy the returned `shareUrl` or `/d/:slug?token=...` URL.
2. Open `/review-room`.
3. Paste that URL into `Existing document slug or URL`.
4. Leave `Access token` empty if the pasted URL includes `token=`.
5. Click `Register and open`.
6. Confirm the browser opens `/d/:slug?rr=1&token=...`.
7. Return to `/review-room`.

Expected: the document appears in the list with source label `Registered document`.

## Register Existing Slug With Separate Token

1. Create a document with the curl command above.
2. Paste only the returned slug into `Existing document slug or URL`.
3. Paste the returned `accessToken` into `Access token`.
4. Click `Register and open`.

Expected: the document opens in Review Room mode and is listed as `Registered document`.

## Register Duplicate Document

1. Register an existing active document.
2. Return to `/review-room`.
3. Register the same slug or URL again.

Expected: registration is idempotent. It opens the existing Review Room record and does not create a duplicate list item.

## Register Missing Slug

1. Open `/review-room`.
2. Enter a made-up slug such as `missing-review-doc`.
3. Click `Register and open`.

Expected: the form shows `No document exists for that slug.` and stays on the dashboard.

## Register With Invalid Token

1. Create a document.
2. Paste its slug into `Existing document slug or URL`.
3. Paste `not-a-real-token` into `Access token`.
4. Click `Register and open`.

Expected: the form shows `The provided token does not grant access to that document.`

## Register Paused Document

1. Create a document and keep its `ownerSecret`.
2. Pause it:

```bash
curl -s http://127.0.0.1:4000/documents/SLUG/pause \
  -H 'Content-Type: application/json' \
  -d '{"ownerSecret":"OWNER_SECRET"}'
```

3. Try to register the slug with the owner secret as the access token.

Expected: the form shows `This document is paused. Resume it before registering it in Review Room.`

## Register Revoked Document

1. Create a document and keep its `ownerSecret`.
2. Revoke it:

```bash
curl -s http://127.0.0.1:4000/documents/SLUG/revoke \
  -H 'Content-Type: application/json' \
  -d '{"ownerSecret":"OWNER_SECRET"}'
```

3. Try to register the slug with the owner secret as the access token.

Expected: the form shows `This document has been revoked and cannot be registered in Review Room.`

## Register Deleted Document

1. Create a document and keep its `ownerSecret`.
2. Delete it:

```bash
curl -s http://127.0.0.1:4000/documents/SLUG/delete \
  -H 'Content-Type: application/json' \
  -d '{"ownerSecret":"OWNER_SECRET"}'
```

3. Try to register the slug with the owner secret as the access token.

Expected: the form shows `This document was deleted and cannot be registered in Review Room.`

## Standalone Document Page Stays Separate

1. Open a document URL without `rr=1`, such as `/d/:slug?token=...`.
2. Confirm the standalone share controls appear.
3. Confirm there is no Review Room document header.

Expected: standalone document mode remains separate from Review Room mode.

## Review Room Header Responsiveness

1. Open a Review Room document URL with `rr=1`.
2. At desktop width, confirm:
   - title row is above the controls row,
   - there is no duplicate floating share pill,
   - `Add agent` and `Share` are usable.
3. At a narrow mobile width, confirm:
   - title stays on its own row,
   - controls stay inside the viewport,
   - document content starts below the fixed header.

Expected: no overlap, clipping, or duplicate toolbar.
