# Review Room

Review Room is a collaborative document review app with human and agent comments layered on top of Proof SDK documents.

The current app is intentionally small: it gives Review Room its own dashboard, document registry, review-oriented editor chrome, and agent/comment lifecycle while reusing the Proof SDK editor, collaboration server, provenance model, and HTTP bridge.

## What Is Included

- Review Room dashboard at `/review-room`
- Registry-backed Review Room documents mapped to Proof document slugs
- Collaborative markdown editor with comments, replies, resolve, and reopen support
- Agent HTTP bridge for document state, marks, edits, presence, and events
- Local identity seed data for human reviewer and review agent development
- Regression coverage for document opening, agent comments, permissions, and comment lifecycle

## Local Development

Requirements:

- Node.js 18+

Install dependencies:

```bash
npm install
```

Start the editor dev server:

```bash
npm run dev
```

Start the local API/collaboration server:

```bash
npm run serve
```

Open the app at:

```text
http://localhost:3000/review-room
```

The dev server runs on `http://localhost:3000` and proxies the API/server on `http://localhost:4000`.

## Core Routes

Review Room routes:

- `GET /review-room`
- `GET /review-room/api/identity`
- `GET /review-room/api/documents`
- `POST /review-room/api/documents`
- `POST /review-room/api/documents/register`

Underlying Proof-compatible document routes remain available for agents and integrations:

- `POST /documents`
- `GET /documents/:slug/state`
- `POST /documents/:slug/edit`
- `POST /documents/:slug/ops`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `GET /documents/:slug/events/pending`
- `POST /documents/:slug/events/ack`

## Build

```bash
npm run build
```

The build outputs the web bundle to `dist/` and writes `dist/web-artifact-manifest.json`.

## Tests

```bash
npm test
```

Useful focused checks:

```bash
npm run test:server-routes-share
npx tsx src/tests/mobile-comment-ux.test.ts
```

## Repository Notes

Review Room currently includes the Proof SDK runtime it depends on. The next cleanup pass should separate product-specific Review Room code from reusable Proof SDK packages more aggressively.

## License

MIT. See `LICENSE`.
