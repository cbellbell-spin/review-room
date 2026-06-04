import express from 'express';
import { createServer, type Server } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { apiRoutes } from './routes.js';
import { agentRoutes } from './agent-routes.js';
import { setupWebSocket } from './ws.js';
import { createBridgeMountRouter } from './bridge.js';
import { getCollabRuntime, startCollabRuntimeEmbedded } from './collab.js';
import { discoveryRoutes } from './discovery-routes.js';
import { shareWebRoutes } from './share-web-routes.js';
import { reviewRoomRoutes } from './review-room-routes.js';
import { reviewRoomMcpRoutes } from './review-room-mcp-routes.js';
import {
  capabilitiesPayload,
  enforceApiClientCompatibility,
  enforceBridgeClientCompatibility,
} from './client-capabilities.js';
import { getBuildInfo } from './build-info.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || '4000', 10);
const DEFAULT_ALLOWED_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'null',
];

function parseAllowedCorsOrigins(): Set<string> {
  const configured = (process.env.PROOF_CORS_ALLOW_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_CORS_ORIGINS);
}

export function createReviewRoomExpressApp(): express.Express {
  const app = express();
  const allowedCorsOrigins = parseAllowedCorsOrigins();

  app.use(express.json({ limit: '10mb' }));

  app.get('/', (_req, res) => {
    res.redirect(302, '/review-room');
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.static(path.join(__dirname, '..', 'dist')));

  app.use((req, res, next) => {
    const originHeader = req.header('origin');
    if (originHeader && allowedCorsOrigins.has(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      [
        'Content-Type',
        'Authorization',
        'X-Proof-Client-Version',
        'X-Proof-Client-Build',
        'X-Proof-Client-Protocol',
        'x-share-token',
        'x-bridge-token',
        'x-auth-poll-token',
        'X-Agent-Id',
        'X-Window-Id',
        'X-Document-Id',
        'Idempotency-Key',
        'X-Idempotency-Key',
      ].join(', '),
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    const buildInfo = getBuildInfo();
    res.json({
      ok: true,
      buildInfo,
      collab: getCollabRuntime(),
    });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json(capabilitiesPayload());
  });

  app.use(discoveryRoutes);
  app.use(reviewRoomRoutes);
  app.use(reviewRoomMcpRoutes);
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  return app;
}

export async function createReviewRoomHttpServer(mainHttpPort = PORT): Promise<Server> {
  const app = createReviewRoomExpressApp();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('error', (error) => {
    console.error('[server] WebSocketServer error (non-fatal):', error);
  });

  setupWebSocket(wss);
  await startCollabRuntimeEmbedded(mainHttpPort);

  return server;
}

export async function startReviewRoomServer(port = PORT): Promise<Server> {
  const server = await createReviewRoomHttpServer(port);
  server.listen(port, () => {
    console.log(`[proof-sdk] listening on http://127.0.0.1:${port}`);
  });
  return server;
}

const isDirectRun = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isDirectRun) {
  startReviewRoomServer().catch((error) => {
    console.error('[proof-sdk] failed to start server', error);
    process.exit(1);
  });
}
