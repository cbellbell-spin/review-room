import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveShareMarkdownAuthMode } from './hosted-auth.js';
import {
  AGENT_DOCS_PATH,
  ALT_SHARE_TOKEN_HEADER_FORMAT,
  AUTH_HEADER_FORMAT,
  CANONICAL_CREATE_API_PATH,
} from './agent-guidance.js';
import { getPublicBaseUrl } from './public-base-url.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const discoveryRoutes = Router();

const textSearchDirs = [
  path.resolve(__dirname, '..'),
  path.resolve(process.cwd()),
];

function loadRepoText(fileName: string): string | null {
  for (const dir of textSearchDirs) {
    try {
      return readFileSync(path.join(dir, fileName), 'utf8');
    } catch {
      // continue
    }
  }
  return null;
}

function loadAgentDocsMarkdown(): string | null {
  const docs = loadRepoText(path.join('docs', 'agent-docs.md'));
  if (docs) return docs;
  return loadRepoText('AGENT_CONTRACT.md');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shouldServeAgentDocsHtml(req: Request): boolean {
  const format = typeof req.query.format === 'string' ? req.query.format.trim().toLowerCase() : '';
  if (format === 'markdown' || format === 'md') return false;
  if (format === 'html') return true;
  const accept = req.header('accept') || '';
  return /\btext\/html\b/i.test(accept);
}

function renderAgentDocsHtml(input: { docsMarkdown: string; docsUrl: string; discoveryUrl: string; mcpUrl: string }): string {
  const docsMarkdown = escapeHtml(input.docsMarkdown);
  const markdownDocsUrl = escapeHtml(`${input.docsUrl}?format=markdown`);
  const discoveryUrl = escapeHtml(input.discoveryUrl);
  const mcpUrl = escapeHtml(input.mcpUrl);
  const pluginUrl = escapeHtml(input.docsUrl.replace(/\/agent-docs$/, '/review-room/claude-plugin.zip'));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Review Room Agent API</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f8faf7;
      --text: #17231d;
      --muted: #58675f;
      --line: #d9e2da;
      --panel: #ffffff;
      --accent: #266854;
      --accent-strong: #174b3c;
      --code: #eef4ef;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    .topbar {
      min-height: 64px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 28px;
      background: rgba(248, 250, 247, 0.96);
      position: sticky;
      top: 0;
    }
    .brand { font-weight: 760; letter-spacing: 0; }
    .nav { display: flex; gap: 16px; align-items: center; }
    .nav a { color: var(--muted); text-decoration: none; font-size: 14px; font-weight: 650; }
    .nav a[aria-current="page"] { color: var(--accent-strong); }
    main {
      width: min(1120px, calc(100% - 40px));
      margin: 0 auto;
      padding: 34px 0 56px;
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(360px, 1.08fr);
      gap: 24px;
      align-items: start;
    }
    h1 { font-size: clamp(30px, 4vw, 48px); line-height: 1.04; margin: 0; letter-spacing: 0; }
    h2 { font-size: 18px; margin: 0 0 10px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); }
    .intro { display: grid; gap: 18px; }
    .intro-copy { font-size: 17px; max-width: 64ch; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      display: grid;
      gap: 14px;
      box-shadow: 0 1px 1px rgba(23, 35, 29, 0.04);
    }
    .mcp-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
    }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
    }
    code {
      background: var(--code);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 6px;
      overflow-wrap: anywhere;
    }
    pre {
      background: #111a16;
      color: #eef8f1;
      border-radius: 8px;
      padding: 16px;
      overflow: auto;
      margin: 0;
      max-height: 560px;
      white-space: pre-wrap;
    }
    .button {
      appearance: none;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: var(--accent);
      color: white;
      min-height: 38px;
      padding: 0 13px;
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }
    .button:focus-visible, a:focus-visible {
      outline: 3px solid rgba(38, 104, 84, 0.25);
      outline-offset: 2px;
    }
    .steps {
      display: grid;
      gap: 10px;
      margin: 0;
      padding-left: 20px;
      color: var(--text);
    }
    .steps li { padding-left: 3px; }
    .docs { grid-column: 1 / -1; }
    .doc-links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 16px;
      font-size: 14px;
    }
    .doc-links a { color: var(--accent-strong); font-weight: 700; }
    .status {
      min-height: 20px;
      color: var(--accent-strong);
      font-size: 13px;
      font-weight: 700;
    }
    @media (max-width: 860px) {
      .topbar { padding: 0 18px; }
      main { grid-template-columns: 1fr; width: min(100% - 28px, 680px); padding-top: 24px; }
      .mcp-row { grid-template-columns: 1fr; }
      .button { width: max-content; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">Review Room</div>
    <nav class="nav" aria-label="Review Room navigation">
      <a href="/review-room">Documents</a>
      <a href="/agent-docs" aria-current="page">Agent API</a>
    </nav>
  </header>
  <main>
    <section class="intro" aria-labelledby="agent-api-title">
      <h1 id="agent-api-title">Agent API</h1>
      <p class="intro-copy">Connect Claude or another MCP client to Review Room, then pass document slugs and share tokens to read, comment, and propose reviewable edits.</p>
      <div class="doc-links">
        <a href="${discoveryUrl}">Discovery JSON</a>
        <a href="${markdownDocsUrl}">Markdown docs</a>
      </div>
    </section>
    <section class="panel" aria-labelledby="mcp-heading">
      <h2 id="mcp-heading">MCP URL</h2>
      <div class="mcp-row">
        <code id="mcp-url">${mcpUrl}</code>
        <button id="copy-mcp-url" class="button" type="button">Copy MCP URL</button>
      </div>
      <div id="copy-status" class="status" aria-live="polite"></div>
      <h2>ChatGPT setup</h2>
      <ol class="steps">
        <li>Enable developer mode if your ChatGPT workspace allows it.</li>
        <li>Open Settings, then Connectors, then Create.</li>
        <li>Paste the MCP URL above as the connector URL.</li>
        <li>Use a document share token in the tool arguments or as <code>Authorization: Bearer &lt;token&gt;</code>.</li>
      </ol>
      <h2>Codex setup</h2>
      <ol class="steps">
        <li>Add <code>[mcp_servers.review_room]</code> to Codex <code>config.toml</code>.</li>
        <li>Set <code>url = "${mcpUrl}"</code>.</li>
        <li>Start a new thread and pass a Review Room document URL or slug plus token.</li>
      </ol>
      <h2>Claude setup</h2>
      <ol class="steps">
        <li>Open Claude settings and add a custom connector, or install the plugin below.</li>
        <li>Choose streamable HTTP as the transport.</li>
        <li>Paste the MCP URL above.</li>
        <li>Use a document share token in the tool arguments or as <code>Authorization: Bearer &lt;token&gt;</code>.</li>
      </ol>
      <h2>Plugin download</h2>
      <p>Install the Review Room Cowork plugin to add the MCP server and skill instructions in one step.</p>
      <p><a href="${pluginUrl}" download>Download Claude/Cowork plugin</a></p>
    </section>
    <section class="panel docs" aria-labelledby="docs-heading">
      <h2 id="docs-heading">Full Agent Reference</h2>
      <pre>${docsMarkdown}</pre>
    </section>
  </main>
  <script>
    const button = document.getElementById('copy-mcp-url');
    const status = document.getElementById('copy-status');
    const value = document.getElementById('mcp-url')?.textContent || '';
    button?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        status.textContent = 'Copied';
      } catch {
        status.textContent = 'Select and copy the MCP URL above';
      }
      window.setTimeout(() => {
        if (status.textContent === 'Copied') status.textContent = '';
      }, 1800);
    });
  </script>
</body>
</html>`;
}

discoveryRoutes.get('/.well-known/agent.json', (req: Request, res: Response) => {
  const base = getPublicBaseUrl(req);
  const apiBase = base ? `${base}/api` : '/api';
  const docsUrl = base ? `${base}${AGENT_DOCS_PATH}` : AGENT_DOCS_PATH;
  const skillUrl = base ? `${base}/proof.SKILL.md` : '/proof.SKILL.md';
  const setupUrl = base ? `${base}/agent-setup` : '/agent-setup';
  const mcpUrl = base ? `${base}/mcp` : '/mcp';
  const shareBase = base || '';

  const authMode = resolveShareMarkdownAuthMode(base);
  const authMethods = authMode === 'none'
    ? ['none']
    : authMode === 'api_key'
      ? ['api_key']
      : authMode === 'oauth_or_api_key'
        ? ['api_key', 'oauth']
        : ['oauth'];

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    name: 'Review Room',
    description: 'Hosted human-agent document review workspace with comments, questions, and reviewable suggestions',
    api_base: apiBase,
    docs_url: docsUrl,
    skill_url: skillUrl,
    setup_url: setupUrl,
    mcp_url: mcpUrl,
    capabilities: ['create_document', 'share', 'comment', 'suggest', 'rewrite', 'collab', 'provenance', 'mcp'],
    auth: {
      methods: authMethods,
      api_key_header: 'Authorization: Bearer <key>',
      no_auth_allowed: authMode === 'none',
      shared_link: {
        token_from_url: '?token=<token>',
        preferred_header: AUTH_HEADER_FORMAT,
        alt_header: ALT_SHARE_TOKEN_HEADER_FORMAT,
      },
    },
    quickstart: {
      received_link: {
        description: 'Given a Proof share URL, read it (and discover state/ops) in one step.',
        method: 'GET',
        url: `${shareBase}/d/{slug}?token={token}`,
        headers: { Accept: 'application/json' },
        returns: 'markdown + _links + agent.auth',
      },
      create_and_share: {
        method: 'POST',
        url: CANONICAL_CREATE_API_PATH,
        body: { markdown: '# Hello World', title: 'My Document' },
        returns: 'shareUrl (editable link to share with anyone)',
      },
    },
    mcp: {
      transport: 'streamable-http',
      url: mcpUrl,
      tools: [
        'review_room_get_state',
        'review_room_list_review_requests',
        'review_room_claim_review_request',
        'review_room_heartbeat_review_request',
        'review_room_complete_review_request',
        'review_room_fail_review_request',
        'review_room_release_review_request',
        'review_room_add_comment',
        'review_room_reply_comment',
        'review_room_resolve_comment',
        'review_room_add_suggestion',
        'review_room_accept_suggestion',
        'review_room_reject_suggestion',
      ],
    },
  });
});

discoveryRoutes.get('/AGENT_CONTRACT.md', (_req: Request, res: Response) => {
  const contract = loadRepoText('AGENT_CONTRACT.md');
  if (!contract) {
    res.status(404).type('text/plain').send('AGENT_CONTRACT.md not found');
    return;
  }
  res.type('text/markdown; charset=utf-8').send(contract);
});

discoveryRoutes.get('/agent-docs', (req: Request, res: Response) => {
  const base = getPublicBaseUrl(req);
  const docsUrl = base ? `${base}${AGENT_DOCS_PATH}` : AGENT_DOCS_PATH;
  const discoveryUrl = base ? `${base}/.well-known/agent.json` : '/.well-known/agent.json';
  const mcpUrl = base ? `${base}/mcp` : '/mcp';
  const doc = loadAgentDocsMarkdown();
  if (!doc) {
    const fallback = `# Review Room Agent API

The full documentation bundle is unavailable in this deployment, but the Agent API is available.

MCP URL: \`${mcpUrl}\`

Start from a shared Review Room document URL:

- \`GET /api/agent/:slug/state\`
- \`GET /api/agent/:slug/snapshot\`
- \`POST /api/agent/:slug/edit/v2\`
- \`POST /api/agent/:slug/ops\`
- \`POST /api/agent/:slug/presence\`

Use the document URL token as \`Authorization: Bearer <token>\` or \`x-share-token: <token>\`.
`;
    if (shouldServeAgentDocsHtml(req)) {
      res.status(200).type('text/html; charset=utf-8').send(renderAgentDocsHtml({
        docsMarkdown: fallback,
        docsUrl,
        discoveryUrl,
        mcpUrl,
      }));
      return;
    }
    res.status(200).type('text/markdown; charset=utf-8').send(fallback);
    return;
  }
  if (shouldServeAgentDocsHtml(req)) {
    res.type('text/html; charset=utf-8').send(renderAgentDocsHtml({
      docsMarkdown: doc,
      docsUrl,
      discoveryUrl,
      mcpUrl,
    }));
    return;
  }
  res.type('text/markdown; charset=utf-8').send(doc);
});
