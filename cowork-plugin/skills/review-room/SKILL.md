---
name: review-room
description: Review shared Review Room documents through the hosted MCP server. Use when given a Review Room URL, slug+token, or review assignment to read the document, leave comments/questions, propose suggestions or redlines, and report completion without applying changes unless explicitly asked.
---

# Review Room Reviewer

Review Room is a document-first review workspace where humans and agents collaborate through attributed comments, questions, and reviewable suggestions. Humans control the final document state.

Production endpoints:

- MCP: `https://proof-sdk-psi.vercel.app/mcp`
- Discovery: `https://proof-sdk-psi.vercel.app/.well-known/agent.json`
- Agent docs: `https://proof-sdk-psi.vercel.app/agent-docs`

The MCP server exposes these tools:

- `review_room_get_state` — read a document (markdown, marks, revision, links)
- `review_room_add_comment` — add an anchored human-review comment
- `review_room_reply_comment` — reply to an existing comment thread
- `review_room_resolve_comment` — resolve an existing comment thread
- `review_room_add_suggestion` — add a pending suggestion (replace/insert/delete)
- `review_room_accept_suggestion` — accept and apply a pending suggestion
- `review_room_reject_suggestion` — reject a pending suggestion without applying it

Tool names use underscores, not dots. Always pass `by: "ai:<agent-name>"` on writes so authorship remains visible.

## Inputs

You will be given one of:

- A share URL: `https://<host>/d/<slug>?token=<token>`
- A slug and token separately
- A review task that contains a slug and token

Extract `<host>`, `<slug>`, and `<token>`.

## Auth

Pass the token per call as the `token` parameter on each MCP tool. The server also accepts `Authorization: Bearer <token>` and `x-share-token: <token>` if you fall back to raw HTTP.

Treat share tokens as secrets. Do not paste them into comments, suggestions, public logs, or generated documents.

## Rules

- One tool call per review item. Do not batch comments or suggestions.
- Use `review_room_add_suggestion` for proposed edits the human will review. Only use `review_room_accept_suggestion` if the user explicitly asks to apply changes without review.
- Put rationale in the comment/suggestion text itself. Do not send `rationale`, `severity`, or `category` on `add_suggestion`; the current server silently drops them.
- Prefer precise anchors. Use the shortest exact quote that uniquely identifies the span.
- For uncertainty, ask a question as a comment instead of rewriting around an assumption.
- Keep suggestions scoped. Split unrelated edits into separate suggestions so humans can accept or reject them independently.
- If a write fails 401/403, the token is invalid or expired — report to the user.
- If a write fails 409 with `ANCHOR_NOT_FOUND`, re-read state and pick a tighter anchor.
- If a write fails 409 with `STALE_REVISION`, re-read state and retry once.
- If a write fails 422, fix the payload and retry.
- If a write fails 429, back off with jitter and retry.

## Read

Call `review_room_get_state` with `{ slug, token }`. Returns `markdown`, `marks` (comments + suggestions keyed by id), `revision`, and `_links`.

Use the state before every review pass. Inspect:

- Markdown content and headings.
- Existing unresolved comments/questions.
- Existing pending suggestions, so you do not duplicate work.
- Accepted/rejected suggestions if they are present in marks/history.

To see only the document body without marks, the underlying public endpoint is also available:

```
GET https://<host>/d/<slug>?token=<token>
Accept: application/json
```

## Create

The MCP does not currently expose a create tool. If the user asks you to create a new Review Room document, use the underlying API:

```
POST https://<host>/documents
Content-Type: application/json

{"title": "<title>", "markdown": "# <heading>\n\n<body>"}
```

The response includes the new document's slug and a share URL. Save the slug and token, then continue with MCP tools.

## Review workflow

1. Read state with `review_room_get_state`.
2. Summarize the document's purpose and the review angle you will take.
3. Identify issues as comments/questions when human judgment is needed.
4. Use suggestions for concrete text changes.
5. Re-read state if anchors fail or if the document changed.
6. Finish with a concise summary of what you left for the human: comments, questions, suggestions, and any unresolved risk.

## Comments and questions

Use `review_room_add_comment` with `{ slug, token, quote, text, by }`.

Good comments include:

- The issue or question.
- Why it matters.
- A suggested path or decision needed.

Use comments for ambiguity, missing context, feasibility concerns, launch risk, testing gaps, and questions that should not be silently edited away.

Reply with `review_room_reply_comment` when continuing an existing thread. Resolve with `review_room_resolve_comment` only when the human or task clearly says the thread is handled.

## Suggestions and redlines

Use `review_room_add_suggestion` with `{ slug, token, kind, quote, content, by }`.

Kinds:

- `replace`: replace the exact `quote` with `content`.
- `insert`: insert `content` immediately after the exact `quote`.
- `delete`: delete the anchored `quote`; omit `content`.

For hard returns or paragraph-level changes, include the needed leading/trailing blank lines in `content` so Markdown blocks do not concatenate. To add a new section before an existing heading, prefer a `replace` suggestion that replaces the heading with `"<new section>\\n\\n<same heading>"`; do not use `insert` anchored to the previous heading unless the new content belongs after that previous heading.

Safe insert example:

```json
{
  "kind": "insert",
  "quote": "Last sentence of the previous section.",
  "content": "\n\n## New section\n\nNew section body."
}
```

For hard returns or paragraph-level changes, split suggestions into separate logical edits when possible. Do not combine unrelated edits in one large replacement.

Only use `review_room_accept_suggestion` or `review_room_reject_suggestion` if the user explicitly asks you to accept/reject on their behalf. Review Room's default model is reviewable suggestions first.

## Completing a review task

When a review pass is done:

- State what you reviewed.
- List the number of comments/questions/suggestions you created.
- Call out any important issue you did not change because it needs human judgment.
- Do not claim the document is final; say it is ready for human review.

## Mark IDs

Suggestions and comments come back from `get_state` keyed by their mark id (e.g. `5784bfc3-1ed2-4cb1-bd5f-22aab0dcf78e`). To accept or reject a suggestion later, pass that exact id as `markId` to `accept_suggestion` or `reject_suggestion`.
