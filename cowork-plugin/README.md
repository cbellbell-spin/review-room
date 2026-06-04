# Review Room — Cowork Plugin

A Cowork plugin that lets Claude agents read, create, and review shared Review Room documents via the Review Room MCP server.

## What it does

The plugin exposes the Review Room MCP (`https://proof-sdk-psi.vercel.app/mcp`) to the agent, giving it these tools:

- `review_room_get_state` — read a document (markdown, marks, revision, links)
- `review_room_add_comment` — add an anchored human-review comment
- `review_room_add_suggestion` — add a pending suggestion (replace/insert/delete)
- `review_room_accept_suggestion` — accept and apply a pending suggestion
- `review_room_reject_suggestion` — reject a pending suggestion without applying it

The agent uses these to read docs, propose edits, and respond to user review requests without leaving Cowork.

## Install

Two options.

**From the prebuilt zip:**

1. Open Cowork → Plugins → Upload.
2. Pick `review-room.zip` from this directory.
3. The plugin auto-connects to the MCP server on next agent start.

**From source:**

The plugin is a Cowork plugin — the zip is just `cowork-plugin/.claude-plugin/`, `cowork-plugin/.mcp.json`, and `cowork-plugin/skills/`. To rebuild the zip:

```bash
cd cowork-plugin
zip -r ../review-room.zip .claude-plugin .mcp.json skills
```

## Files

```
cowork-plugin/
├── .claude-plugin/plugin.json     # Cowork plugin manifest (v0.3.0)
├── .mcp.json                      # MCP server config (review-room)
├── skills/
│   └── review-room/SKILL.md       # Agent instructions for the MCP tools
└── TEST_PLAN.md                   # Field-validation test plan for suggestion.add
```

## Configuration

`.mcp.json` points the agent at the production MCP endpoint. To point at a local dev server, edit the URL:

```json
{
  "mcpServers": {
    "review-room": {
      "type": "http",
      "url": "http://localhost:<port>/mcp"
    }
  }
}
```

## Auth

The MCP takes a per-document share token on every call. The agent extracts the token from the share URL the user gives it and passes it as the `token` parameter on each tool call. No global API key is required.

## Test plan

`TEST_PLAN.md` documents the field-validation test for `suggestion.add` — the run that confirmed the server silently drops unverified `rationale` / `severity` / `category` fields, which is why the skill deliberately omits them.
