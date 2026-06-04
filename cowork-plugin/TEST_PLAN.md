# Test Plan: Unverified `suggestion.add` Fields

**Goal:** Determine whether the document server's `suggestion.add` op accepts the `rationale`, `severity`, and `category` fields — and if accepted, whether the values are persisted or silently stripped.

The merged `review-room` skill deliberately omits these fields. This test decides whether to add them back.

## Result — 2026-06-03

**Outcome D.** Server returns 200 for all ops (T0–T6, including bogus `severity: "purple"` and `category: "smell"`), but T7 shows none of the three fields appear in the persisted suggestion marks. The server accepts and silently strips `rationale`, `severity`, and `category`.

**Decision: skill unchanged.** Do not add these fields. Re-run this test if the server API is updated.

## Pre-flight

1. Confirm the host. Default: `https://proof-sdk-psi.vercel.app` (or whatever you point at).
2. Get a slug + token. `POST /share/markdown` may or may not return a share token — if it doesn't, you'll need a separate share step. Save them as env vars:
   ```bash
   export HOST="https://proof-sdk-psi.vercel.app"
   export SLUG="..."
   export TOKEN="..."
   ```
3. Need `curl` and `jq` (or a similar JSON viewer).

## Setup: create a throwaway test doc

The doc must have at least 7 non-overlapping substrings for the test cases. The default below uses 8 "Sentence N." strings so each test can anchor against a unique range.

```bash
curl -sS -X POST "$HOST/share/markdown" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Review Room field-test (throwaway)",
    "markdown": "# Field test\n\nSentence one. Sentence two. Sentence three. Sentence four. Sentence five. Sentence six. Sentence seven. Sentence eight."
  }'
```

The response includes the slug and `accessToken` (the share token). Save both. No separate share step is needed — the create response always returns a token.

## Test cases

For each test, capture **both** the HTTP status code **and** the response body. The status tells you if the server accepts the payload. To confirm whether unverified fields are *persisted*, follow up with a state read (T7 below).

### T0 — Baseline (documented fields only)

```bash
curl -sS -X POST "$HOST/api/agent/$SLUG/ops" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "suggestion.add",
    "by": "ai:review-room",
    "kind": "replace",
    "quote": "Sentence one",
    "content": "Replacement one"
  }'
```

**Expect:** 200. If this fails, none of the other tests are meaningful — fix the baseline first.

### T1 — Add `rationale`

```bash
... -d '{
  "type": "suggestion.add",
  "by": "ai:review-room",
  "kind": "replace",
  "quote": "Sentence two",
  "content": "Replacement two",
  "rationale": "More vivid imagery"
}'
```

### T2 — Add `severity` (valid-looking value)

```bash
... -d '{
  "type": "suggestion.add",
  "by": "ai:review-room",
  "kind": "replace",
  "quote": "Sentence three",
  "content": "Replacement three",
  "severity": "high"
}'
```

### T3 — Add `category` (valid-looking value)

```bash
... -d '{
  "type": "suggestion.add",
  "by": "ai:review-room",
  "kind": "replace",
  "quote": "Sentence four",
  "content": "Replacement four",
  "category": "polish"
}'
```

### T4 — All three together

```bash
... -d '{
  "type": "suggestion.add",
  "by": "ai:review-room",
  "kind": "replace",
  "quote": "Sentence five",
  "content": "Replacement five",
  "rationale": "Test combining all three",
  "severity": "medium",
  "category": "ambiguity"
}'
```

### T5 — Bogus `severity` (tests enum validation)

```bash
... -d '{
  "type": "suggestion.add",
  "by": "ai:review-room",
  "kind": "replace",
  "quote": "Sentence six",
  "content": "Replacement six",
  "severity": "purple"
}'
```

### T6 — Bogus `category` (tests enum validation)

```bash
... -d '{
  "type": "suggestion.add",
  "by": "ai:review-room",
  "kind": "replace",
  "quote": "Sentence seven",
  "content": "Replacement seven",
  "category": "smell"
}'
```

### T7 — Verify persistence

After each successful (200) call, read the document state and inspect the suggestions:

```bash
curl -sS "$HOST/api/agent/$SLUG/state" \
  -H "Authorization: Bearer $TOKEN" | jq '.suggestions // .'
```

(Suggestion field path is a guess — adjust to whatever the state response actually returns. The point is to look at each persisted suggestion and check whether `rationale` / `severity` / `category` are present.)

## Result interpretation

| Outcome | T1–T4 (valid values) | T5–T6 (bogus values) | Action |
|---|---|---|---|
| **A. Server validates, accepts valid + rejects bogus** | 200 | 4xx | Add fields to skill. Document the valid values (probe with a few to enumerate the closed set if needed). |
| **B. Server accepts everything** | 200 | 200 | Add fields to skill with a caveat: *"server does not validate severity/category enums; treat values as unconstrained."* |
| **C. Server rejects unknown fields** | 4xx | 4xx | Do not add fields. Document the limitation in the skill. |
| **D. Server accepts payload but strips fields (T7 shows no persistence)** | 200 | 200 | Do not add fields. The skill is correct as-is. |
| **E. Mixed/inconsistent** | varies | varies | Do not add fields. Report the inconsistency; the docs and server don't agree. |

## Decision

Once you have results, we update the skill in one of two ways:

1. **If A or B:** add a "Structured review items" section to `SKILL.md` showing the example payloads with the field names and a note about enum validity.
2. **If C, D, or E:** leave the skill unchanged. Optionally add a one-line note: *"`rationale` / `severity` / `category` are not supported by the current server."*

## Cleanup

The test doc will have 6+ pending suggestions attached. Options:

- Leave it — title marks it as throwaway, you can reject all suggestions in the UI.
- Delete via UI (no API path for this is in the skill).

## Optional follow-up: same tests for `comment.add`

If you also want to verify the `text` / `quote` field shape on `comment.add`, repeat the same pattern. The merged skill already uses the documented shape, so this is lower-priority — only do it if you want to be sure.
