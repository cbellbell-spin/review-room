---
name: review-room
description: Read, create, and review shared Review Room documents via MCP. Use when given a share URL or slug+token to fetch document state, create new documents, and submit review items (comments and suggested edits) for human review.
---

# Review Room Reviewer

The Review Room MCP server is configured via `.mcp.json` and exposes these tools:

- `review_room_get_state` — read a document (markdown, marks, revision, links)
- `review_room_add_comment` — add an anchored human-review comment
- `review_room_reply_comment` — reply to an existing comment thread
- `review_room_resolve_comment` — resolve an existing comment thread
- `review_room_add_suggestion` — add a pending suggestion (replace/insert/delete)
- `review_room_accept_suggestion` — accept and apply a pending suggestion
- `review_room_reject_suggestion` — reject a pending suggestion without applying it

Tool names use underscores, not dots. Always pass `by: "ai:<agent-name>"` on writes.

## Inputs

You will be given one of:
- A share URL: `https://<host>/d/<slug>?token=<token>`
- A slug and token separately

Extract `<host>`, `<slug>`, and `<token>`.

## Auth

Pass the token per call as the `token` parameter on each MCP tool. The server also accepts `Authorization: Bearer <token>` and `x-share-token: <token>` if you ever need to fall back to raw HTTP.

## Rules

- One tool call per review item. Do not batch comments or suggestions.
- Use `review_room_add_suggestion` for proposed edits the human will review. Only use `review_room_accept_suggestion` if the user explicitly asks to apply changes without review.
- Do not send `rationale`, `severity`, or `category` on `add_suggestion` — the server silently drops them.
- If a write fails 401/403, the token is invalid or expired — report to the user.
- If a write fails 409 with `ANCHOR_NOT_FOUND`, re-read state and pick a tighter anchor.
- If a write fails 409 with `STALE_REVISION`, re-read state and retry once.
- If a write fails 422, fix the payload and retry.
- If a write fails 429, back off with jitter and retry.

## Read

Call `review_room_get_state` with `{ slug, token }`. Returns `markdown`, `marks` (comments + suggestions keyed by id), `revision`, and `_links`.

To see only the doc body without marks, the underlying public endpoint is also available:

```
GET https://<host>/d/<slug>?token=<token>
Accept: application/json
```

## Create

The MCP does not currently expose a create tool. Create a new document with the underlying API:

```
POST https://<host>/documents
Content-Type: application/json

{"title": "<title>", "markdown": "# <heading>\n\n<body>"}
```

The response includes the new document's slug and a share URL. Save the slug and token, then continue with MCP tools.

## Submit review items

- **Comment**: `review_room_add_comment` with `{ slug, token, quote, text, by }`. `quote` anchors the comment to exact text in the document.
- **Reply**: `review_room_reply_comment` with `{ slug, token, markId, text, by }`. Use the comment mark id from `review_room_get_state`.
- **Resolve**: `review_room_resolve_comment` with `{ slug, token, markId, by }`. Only resolve when the user asks you to close a thread or the issue has clearly been addressed.
- **Suggested edit**: `review_room_add_suggestion` with `{ slug, token, kind, quote, content, by }`. `kind` is `replace`, `insert`, or `delete`. `quote` is the text to anchor; `content` is the replacement (omit for `delete`).

## Mark IDs

Suggestions and comments come back from `get_state` keyed by their mark id (e.g. `5784bfc3-1ed2-4cb1-bd5f-22aab0dcf78e`). To accept or reject a suggestion later, pass that exact id as `markId` to `accept_suggestion` or `reject_suggestion`.
