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
   - `Workspace`
   - `New document`
   - `Create new document`
   - `Import Markdown or Text`
   - `Choose File`
   - `Import and open`
   - `Review Room slug or URL`
   - `Access token`
   - `Add and open`
   - `Google Docs and SharePoint imports are not supported yet.`

Expected: dashboard is usable, with no visible script error banner.

## Import Local File

1. Click `Choose File` in `Create or import`.
2. Pick a `.md`, `.markdown`, or `.txt` file.
3. Confirm the selected file name appears in the import target.
4. Click `Import and open`.
5. Confirm the browser opens `/d/:slug?rr=1&token=...` and the editor contains the imported file content.
6. Return to `/review-room`.
7. Drag an unsupported file type onto the import target.

Expected: supported files import and open as Review Room documents. Unsupported files show `Review Room can import .md, .markdown, and .txt files right now.`

## Create Review Room Document

1. Click `Create new document`.
2. Confirm the browser opens `/d/:slug?rr=1&token=...`.
3. Confirm the editor opens as an empty document window.
4. Edit the title in the header and confirm the updated title remains visible.
5. Use the formatting toolbar for heading, bold, italic, quote, and list formatting.
6. Enter Markdown content in the editor.
7. Confirm the status changes to unsaved/saving and returns to saved after autosave.
8. Make one more edit, click `Cancel`, and confirm the unsaved-change warning appears.
9. Stay on the document, click `Save`, and confirm the browser returns to `/review-room`.

Expected: the document appears in the list with source label `Created in Review Room` and the edited title.

## Review Room Role Controls

Create a Review Room document and keep the owner token from the opened URL:

```text
http://127.0.0.1:4000/d/SLUG?rr=1&token=OWNER_TOKEN
```

Create role-specific links from that owner token:

```bash
curl -s http://127.0.0.1:4000/api/documents/SLUG/access-links \
  -H 'Content-Type: application/json' \
  -H 'X-Proof-Client-Version: 0.31.0' \
  -H 'X-Proof-Client-Build: manual' \
  -H 'X-Proof-Client-Protocol: 3' \
  -H 'X-Share-Token: OWNER_TOKEN' \
  -d '{"role":"editor"}'

curl -s http://127.0.0.1:4000/api/documents/SLUG/access-links \
  -H 'Content-Type: application/json' \
  -H 'X-Proof-Client-Version: 0.31.0' \
  -H 'X-Proof-Client-Build: manual' \
  -H 'X-Proof-Client-Protocol: 3' \
  -H 'X-Share-Token: OWNER_TOKEN' \
  -d '{"role":"commenter"}'

curl -s http://127.0.0.1:4000/api/documents/SLUG/access-links \
  -H 'Content-Type: application/json' \
  -H 'X-Proof-Client-Version: 0.31.0' \
  -H 'X-Proof-Client-Build: manual' \
  -H 'X-Proof-Client-Protocol: 3' \
  -H 'X-Share-Token: OWNER_TOKEN' \
  -d '{"role":"viewer"}'
```

Open each returned `webShareUrl` with `&rr=1` appended, or open:

```text
http://127.0.0.1:4000/d/SLUG?rr=1&token=ROLE_TOKEN
```

Expected:

- Owner and editor can edit the title, edit document content, comment/reply, resolve/reopen comments, use `Add agent`, and use `Share`.
- Commenter can read and comment/reply, but cannot edit the title, edit document content, use `Add agent`, or use `Share`.
- Viewer can read only. They cannot edit title/content, comment/reply, resolve/reopen comments, use `Add agent`, or use `Share`.
- Non-owner roles should not see controls they cannot use, or those controls should be disabled with no successful server mutation.

Check the open payload for each token:

```bash
curl -s http://127.0.0.1:4000/api/documents/SLUG/open-context \
  -H 'X-Proof-Client-Version: 0.31.0' \
  -H 'X-Proof-Client-Build: manual' \
  -H 'X-Proof-Client-Protocol: 3' \
  -H 'X-Share-Token: ROLE_TOKEN'
```

Expected: the payload reports the matching `capabilities` for the opened role. Review Room-created and registered documents should also include the current Review Room role when opened with a Review Room member token.

## Register Existing Active Document

Create a document outside the Review Room dashboard:

```bash
curl -s http://127.0.0.1:4000/documents \
  -H 'Content-Type: application/json' \
  -d '{"title":"Existing Document Manual Test","markdown":"# Existing Document Manual Test\n\nBody."}'
```

1. Copy the returned `shareUrl` or `/d/:slug?token=...` URL.
2. Open `/review-room`.
3. Paste that URL into `Review Room slug or URL`.
4. Leave `Access token` empty if the pasted URL includes `token=`.
5. Click `Add and open`.
6. Confirm the browser opens `/d/:slug?rr=1&token=...`.
7. Return to `/review-room`.

Expected: the document appears in the list with source label `Registered document`.

## Register Existing Slug With Separate Token

1. Create a document with the curl command above.
2. Paste only the returned slug into `Review Room slug or URL`.
3. Paste the returned `accessToken` into `Access token`.
4. Click `Add and open`.

Expected: the document opens in Review Room mode and is listed as `Registered document`.

## Register Duplicate Document

1. Register an existing active document.
2. Return to `/review-room`.
3. Register the same slug or URL again.

Expected: registration is idempotent. It opens the existing Review Room record and does not create a duplicate list item.

## Register Missing Slug

1. Open `/review-room`.
2. Enter a made-up slug such as `missing-review-doc`.
3. Click `Add and open`.

Expected: the form shows `No document exists for that slug.` and stays on the dashboard.

## Register With Invalid Token

1. Create a document.
2. Paste its slug into `Review Room slug or URL`.
3. Paste `not-a-real-token` into `Access token`.
4. Click `Add and open`.

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
   - formatting controls, `Add agent`, `Cancel`, `Save`, and `Share` are usable.
3. At a narrow mobile width, confirm:
   - title stays on its own row,
   - formatting controls scroll horizontally if needed,
   - controls stay inside the viewport,
   - document content starts below the fixed header.

Expected: no overlap, clipping, or duplicate toolbar.
