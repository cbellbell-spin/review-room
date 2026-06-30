import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

type ZipEntry = {
  name: string;
  data: Buffer;
};

const PLUGIN_ROOT = 'cowork-plugin';
const INCLUDED_PLUGIN_PATHS = ['.claude-plugin', '.mcp.json', 'skills'];

let crcTable: Uint32Array | null = null;

const EMBEDDED_PLUGIN_ENTRIES: Array<{ name: string; text: string }> = [
  {
    name: '.claude-plugin/plugin.json',
    text: `{
  "name": "review-room",
  "version": "0.4.0",
  "description": "Claim and complete BYO-agent review requests through Review Room MCP, with comments and suggestions kept under human control."
}
`,
  },
  {
    name: '.mcp.json',
    text: `{
  "mcpServers": {
    "review-room": {
      "type": "http",
      "url": "https://review-room.chrisjbell.dev/mcp"
    }
  }
}
`,
  },
  {
    name: 'skills/review-room/SKILL.md',
    text: `---
name: review-room
description: Read, create, and review shared Review Room documents via MCP. Use when given a share URL or slug+token to fetch document state, create new documents, and submit review items (comments and suggested edits) for human review.
---

# Review Room Reviewer

The Review Room MCP server is configured via \`.mcp.json\` and exposes these tools:

Production endpoints:

- MCP: \`https://review-room.chrisjbell.dev/mcp\`
- Discovery: \`https://review-room.chrisjbell.dev/.well-known/agent.json\`
- Agent docs: \`https://review-room.chrisjbell.dev/agent-docs\`

- \`review_room_get_state\` \\u2014 read a document (markdown, marks, revision, links)
- \`review_room_list_review_requests\` \\u2014 list queued and historical review requests
- \`review_room_claim_review_request\` \\u2014 claim queued work and receive a short-lived lease token
- \`review_room_heartbeat_review_request\` \\u2014 start work or renew a lease
- \`review_room_complete_review_request\` \\u2014 complete claimed work
- \`review_room_fail_review_request\` \\u2014 fail claimed work with a safe explanation
- \`review_room_release_review_request\` \\u2014 return claimed work to the queue
- \`review_room_add_comment\` \\u2014 add an anchored human-review comment
- \`review_room_reply_comment\` \\u2014 reply to an existing comment thread
- \`review_room_resolve_comment\` \\u2014 resolve an existing comment thread
- \`review_room_add_suggestion\` \\u2014 add a pending suggestion (replace/insert/delete)
- \`review_room_accept_suggestion\` \\u2014 accept and apply a pending suggestion
- \`review_room_reject_suggestion\` \\u2014 reject a pending suggestion without applying it

Tool names use underscores, not dots. Always pass \`by: "ai:<agent-name>"\` on writes.

## Inputs

You will be given one of:
- A share URL: \`https://<host>/d/<slug>?token=<token>\`
- A slug and token separately

Extract \`<host>\`, \`<slug>\`, and \`<token>\`.

## Auth

Pass the token per call as the \`token\` parameter on each MCP tool. The server also accepts \`Authorization: Bearer <token>\` and \`x-share-token: <token>\` if you ever need to fall back to raw HTTP.

## Rules

- One tool call per review item. Do not batch comments or suggestions.
- Use \`review_room_add_suggestion\` for proposed edits the human will review. Only use \`review_room_accept_suggestion\` if the user explicitly asks to apply changes without review.
- Do not send \`rationale\`, \`severity\`, or \`category\` on \`add_suggestion\` \\u2014 the server silently drops them.
- If a write fails 401/403, the token is invalid or expired \\u2014 report to the user.
- If a write fails 409 with \`ANCHOR_NOT_FOUND\`, re-read state and pick a tighter anchor.
- If a write fails 409 with \`STALE_REVISION\`, re-read state and retry once.
- If a write fails 422, fix the payload and retry.
- If a write fails 429, back off with jitter and retry.

## Read

Call \`review_room_get_state\` with \`{ slug, token }\`. Returns \`markdown\`, \`marks\` (comments + suggestions keyed by id), \`revision\`, and \`_links\`.

## Claim a requested review

Review Room is BYO agent: it never runs a model or stores provider credentials. When the owner has queued a review, use the supplied request-scoped credential to list and claim that request; Review Room binds its stable agent identity. Heartbeat the lease and include \`requestId\` plus \`leaseToken\` with each comment or suggestion. Complete, fail, or release the request when finished. Never put either token in document content or logs.

To see only the doc body without marks, the underlying public endpoint is also available:

\`\`\`
GET https://<host>/d/<slug>?token=<token>
Accept: application/json
\`\`\`

## Create

The MCP does not currently expose a create tool. Create a new document with the underlying API:

\`\`\`
POST https://<host>/documents
Content-Type: application/json

{"title": "<title>", "markdown": "# <heading>\\n\\n<body>"}
\`\`\`

The response includes the new document's slug and a share URL. Save the slug and token, then continue with MCP tools.

## Submit review items

- **Comment**: \`review_room_add_comment\` with \`{ slug, token, quote, text, by }\`. \`quote\` anchors the comment to exact text in the document.
- **Reply**: \`review_room_reply_comment\` with \`{ slug, token, markId, text, by }\`. Use the comment mark id from \`review_room_get_state\`.
- **Resolve**: \`review_room_resolve_comment\` with \`{ slug, token, markId, by }\`. Only resolve when the user asks you to close a thread or the issue has clearly been addressed.
- **Suggested edit**: \`review_room_add_suggestion\` with \`{ slug, token, kind, quote, content, by }\`. \`kind\` is \`replace\`, \`insert\`, or \`delete\`. \`quote\` is the text to anchor; \`content\` is the replacement (omit for \`delete\`).

## Mark IDs

Suggestions and comments come back from \`get_state\` keyed by their mark id (e.g. \`5784bfc3-1ed2-4cb1-bd5f-22aab0dcf78e\`). To accept or reject a suggestion later, pass that exact id as \`markId\` to \`accept_suggestion\` or \`reject_suggestion\`.
`,
  },
];

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(buffer: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function writeUInt32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function collectPluginEntries(rootDir: string): ZipEntry[] {
  const entries: ZipEntry[] = [];

  const visit = (relativePath: string) => {
    const absolutePath = path.join(rootDir, relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolutePath).sort()) {
        visit(path.join(relativePath, child));
      }
      return;
    }
    if (!stat.isFile()) return;
    entries.push({
      name: relativePath.split(path.sep).join('/'),
      data: readFileSync(absolutePath),
    });
  };

  for (const relativePath of INCLUDED_PLUGIN_PATHS) {
    visit(relativePath);
  }
  return entries;
}

function embeddedPluginEntries(): ZipEntry[] {
  return EMBEDDED_PLUGIN_ENTRIES.map((entry) => ({
    name: entry.name,
    data: Buffer.from(entry.text.replaceAll('\\u2014', '\u2014'), 'utf8'),
  }));
}

export function buildClaudePluginZip(cwd = process.cwd()): Buffer {
  const rootDir = path.join(cwd, PLUGIN_ROOT);
  let entries: ZipEntry[];
  try {
    entries = collectPluginEntries(rootDir);
  } catch {
    entries = embeddedPluginEntries();
  }
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(crc),
      writeUInt32(size),
      writeUInt32(size),
      writeUInt16(name.length),
      writeUInt16(0),
      name,
    ]);
    localParts.push(localHeader, entry.data);
    centralParts.push(Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(crc),
      writeUInt32(size),
      writeUInt32(size),
      writeUInt16(name.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(offset),
      name,
    ]));
    offset += localHeader.length + entry.data.length;
  }

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(central.length),
    writeUInt32(local.length),
    writeUInt16(0),
  ]);

  return Buffer.concat([local, central, end]);
}
