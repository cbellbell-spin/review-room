---
name: proof
description: Work with hosted Proof documents and Proof SDK-compatible deployments over HTTP. Use when creating, reading, editing, or reviewing shared docs with the agent API or bridge routes.
---

# Proof

Proof is the hosted product. Proof SDK is the open-source editor, collaboration server, and agent bridge. Both use the same document model and HTTP patterns.

## Core Rules

- Include `by` on every write. Use `ai:<agent-name>`.
- Treat `slug + token` as the document address and auth pair.
- Prefer HTTP APIs over local runtime assumptions.
- Use `suggestion.add` for proposed edits the human should review. `rewrite.apply` and `/bridge/rewrite` apply content directly and should only be used when the user explicitly asks you to apply changes without review.

## Authentication

Shared URL format:

```text
http://localhost:4000/d/<slug>?token=<token>
```

Use one of:

- `Authorization: Bearer <token>` (preferred)
- `x-share-token: <token>`
- `?token=<token>`

## Primary Workflow

### Create a document

```bash
curl -sS -X POST http://localhost:4000/documents \
  -H "Content-Type: application/json" \
  -d '{"title":"My Document","markdown":"# Hello\n\nFirst draft."}'
```

Hosted Proof also keeps `POST /share/markdown` as a compatibility alias.

### Read state

```bash
curl -sS "http://localhost:4000/documents/<slug>/state" \
  -H "Authorization: Bearer <token>" \
  -H "X-Agent-Id: <your-agent-id>"
```

Include `X-Agent-Id` on `GET /state` only when you want presence to appear for that agent.

Content negotiation also works directly on shared links:

```bash
curl -sS -H "Accept: application/json" "http://localhost:4000/d/<slug>?token=<token>"
curl -sS -H "Accept: text/markdown" "http://localhost:4000/d/<slug>?token=<token>"
```

### Get a snapshot for structured edits

```bash
curl -sS "http://localhost:4000/documents/<slug>/snapshot" \
  -H "Authorization: Bearer <token>"
```

### Apply block edits with `edit/v2`

```bash
curl -sS -X POST "http://localhost:4000/documents/<slug>/edit/v2" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: <unique-key>" \
  -d '{
    "by":"ai:codex",
    "baseRevision":42,
    "operations":[
      {"op":"replace_block","ref":"b3","block":{"markdown":"Updated paragraph."}},
      {"op":"insert_after","ref":"b3","blocks":[{"markdown":"## New section"}]}
    ]
  }'
```

### Apply comments, suggestions, and rewrites with `ops`

```json
{"type":"comment.add","by":"ai:codex","quote":"anchor text","text":"Comment body"}
{"type":"suggestion.add","by":"ai:codex","kind":"replace","quote":"old text","content":"new text"}
{"type":"suggestion.add","by":"ai:codex","kind":"replace","quote":"old text","content":"new text","status":"accepted"}
{"type":"rewrite.apply","by":"ai:codex","content":"# Rewritten markdown"}
```

When the human asks for revisions, proposed changes, review, or edits they should accept/reject, use one or more `suggestion.add` calls. Do not use `rewrite.apply` for that flow because it rewrites the document directly.

Endpoint:

```text
POST /documents/<slug>/ops
```

Bridge-compatible deployments can also expose neutral bridge routes:

```text
GET  /documents/<slug>/bridge/state
GET  /documents/<slug>/bridge/marks
POST /documents/<slug>/bridge/comments
POST /documents/<slug>/bridge/suggestions
POST /documents/<slug>/bridge/rewrite
POST /documents/<slug>/bridge/presence
GET  /documents/<slug>/events
POST /documents/<slug>/events/ack
```

For bridge-compatible review flows, use `/bridge/suggestions`. `/bridge/rewrite` is a direct apply endpoint, not a proposed-edit endpoint.

### GET-only fallback

If your environment can read URLs but cannot send POST requests, use the constrained GET action endpoint for comments and pending suggestions:

```text
GET /api/agent/<slug>/action?token=<token>&type=suggestion.add&kind=replace&quote=<urlencoded-quote>&content=<urlencoded-content>&by=ai:<agent>
```

The first GET returns `CONFIRM_REQUIRED` and an `execute.href`. Fetch that URL to apply the change. This fallback only supports `comment.add` and pending `suggestion.add`; it does not support rewrites or accepted/direct-apply suggestions.

### Poll events

```bash
curl -sS "http://localhost:4000/documents/<slug>/events/pending?after=0" \
  -H "Authorization: Bearer <token>"
```

### Send presence

```bash
curl -sS -X POST "http://localhost:4000/documents/<slug>/presence" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "X-Agent-Id: <your-agent-id>" \
  -d '{"agentId":"<your-agent-id>","status":"thinking","summary":"Reviewing section 2"}'
```

## Choosing an Edit Strategy

- Use `suggestion.add` for reviewable proposed edits.
- Use `edit/v2` for deterministic block-level edits.
- Use `edit` for simple string-based operations.
- Use `ops` for comments, suggestions, and explicit direct rewrites.

## Error Handling

| Error | Meaning | Action |
|---|---|---|
| `401/403` | Bad or missing auth | Re-read token from the URL, retry with bearer token |
| `404` | Slug not found | Verify slug and environment |
| `409 PROJECTION_STALE` | Projection metadata is catching up | Re-read `state` or `snapshot`, then retry |
| `409 STALE_REVISION` | Snapshot out of date | Refresh snapshot and retry with latest revision |
| `409 ANCHOR_NOT_FOUND` | Search anchor no longer matches | Re-read state and choose a tighter anchor |
| `422` | Invalid payload | Fix schema and required fields |
| `429` | Rate limit | Back off and retry with jitter |

## Idempotency And Contracts

- Send `Idempotency-Key` for mutation requests.
- Read `contract.mutationStage` from `GET /documents/<slug>/state`.
- Honor `contract.idempotencyRequired` and `contract.preconditionMode`.
- Always re-read state before retries that depend on anchors or revisions.
- Include `by` on every write operation.
- `suggestion.add` accepts `status: "accepted"` when you want to create-and-apply a suggestion in one call.
- Prefer `content` or markdown payloads as canonical text input.

## References

- Discovery JSON: `http://localhost:4000/.well-known/agent.json`
- Docs: `http://localhost:4000/agent-docs`
- Setup: `http://localhost:4000/agent-setup`
- [AGENT_CONTRACT.md](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/AGENT_CONTRACT.md)
- [agent-docs.md](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/docs/agent-docs.md)
