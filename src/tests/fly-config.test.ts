import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

const dockerfile = read('Dockerfile');
const flyToml = read('fly.toml');
const dockerignore = read('.dockerignore');
const gitignore = read('.gitignore');
const workflow = read('.github/workflows/fly-deploy.yml');
const deploymentNotes = read('docs/review-room-deployment.md');
const agentDocs = read('docs/agent-docs.md');
const coworkMcpConfig = read('cowork-plugin/.mcp.json');
const coworkSkill = read('cowork-plugin/skills/review-room/SKILL.md');
const pluginPackage = read('server/claude-plugin-package.ts');

assert(
  dockerfile.includes('FROM node:20-slim')
    && dockerfile.includes('python3 make g++ ca-certificates')
    && dockerfile.includes('ARG GIT_COMMIT_SHA\n')
    && dockerfile.includes('ARG BUILD_RELEASE_DATE')
    && dockerfile.includes('RUN npm ci')
    && dockerfile.includes('RUN npm run build')
    && dockerfile.includes('PROOF_BUILD_SHA=$GIT_COMMIT_SHA')
    && dockerfile.includes('CMD ["npm", "run", "serve"]'),
  'Expected Dockerfile to build and serve the Review Room Node runtime',
);

assert(
  flyToml.includes('app = "review-room"')
    && flyToml.includes('primary_region = "sjc"')
    && flyToml.includes('PROOF_PUBLIC_BASE_URL = "https://review-room.chrisjbell.dev"')
    && flyToml.includes('PROOF_TRUST_PROXY_HEADERS = "true"')
    && flyToml.includes('PROOF_COLLAB_V2 = "1"')
    && flyToml.includes('DATABASE_PATH = "/data/proof-share.db"')
    && flyToml.includes('SNAPSHOT_DIR = "/data/snapshots"'),
  'Expected fly.toml to pin the Review Room public URL and volume-backed runtime env',
);

assert(
  flyToml.includes('source = "data"')
    && flyToml.includes('destination = "/data"')
    && flyToml.includes('auto_stop_machines = "off"')
    && flyToml.includes('min_machines_running = 1')
    && flyToml.includes('idle_timeout = 600')
    && flyToml.includes('path = "/health"'),
  'Expected fly.toml to keep one always-on volume-backed Machine with a health check',
);

assert(
  !flyToml.includes('auto_stop_machines = false')
    && !/^\s*TURSO_DATABASE_URL\s*=/m.test(flyToml)
    && flyToml.includes('Do not set TURSO_DATABASE_URL for the live-collab Fly launch'),
  'Expected fly.toml to avoid hosted/Turso mode for live-collab Fly launches',
);

assert(
  dockerignore.includes('node_modules')
    && dockerignore.includes('dist')
    && dockerignore.includes('snapshots/')
    && dockerignore.includes('*.db')
    && dockerignore.includes('*.db-wal')
    && !/^\.git$/m.test(dockerignore),
  'Expected .dockerignore to exclude generated assets, snapshots, and local SQLite files',
);

assert(
  gitignore.includes('.proof-build-info.json'),
  'Expected generated runtime build metadata to stay out of git',
);

assert(
  existsSync(path.join(root, 'package-lock.json')) && !/^\s*package-lock\.json\s*$/m.test(gitignore),
  'Expected package-lock.json to be tracked because the Fly Dockerfile uses npm ci',
);

assert(
  workflow.includes('branches: [main]')
    && workflow.includes('actions/checkout@v6')
    && workflow.includes('superfly/flyctl-actions/setup-flyctl@master')
    && workflow.includes('flyctl deploy --remote-only --build-arg GIT_COMMIT_SHA=${{ github.sha }} --build-arg BUILD_RELEASE_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)')
    && workflow.includes('FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}'),
  'Expected GitHub Actions workflow to deploy main to Fly with FLY_API_TOKEN and build metadata args',
);

assert(
  read('scripts/finalize-web-build.mjs').includes("const buildInfoPath = path.join(root, '.proof-build-info.json');")
    && read('scripts/finalize-web-build.mjs').includes('writeFileSync(buildInfoPath'),
  'Expected build finalization to write runtime build metadata for /health',
);

assert(
  deploymentNotes.includes('Do not set `TURSO_DATABASE_URL` for the live-collab Fly launch')
    && deploymentNotes.includes('live-collab production path uses the Fly volume as the durable SQLite store')
    && deploymentNotes.includes('/health` returns `collab.enabled: true`')
    && deploymentNotes.includes('npm run smoke:review-room-production')
    && deploymentNotes.includes('## Rollback'),
  'Expected deployment notes to distinguish Fly live-collab mode from Vercel/Turso hosted mode',
);

assert(
  agentDocs.includes('https://review-room.chrisjbell.dev/mcp')
    && !agentDocs.includes('proof-sdk-psi.vercel.app')
    && coworkMcpConfig.includes('https://review-room.chrisjbell.dev/mcp')
    && !coworkMcpConfig.includes('proof-sdk-psi.vercel.app')
    && coworkSkill.includes('https://review-room.chrisjbell.dev/agent-docs')
    && !coworkSkill.includes('proof-sdk-psi.vercel.app')
    && pluginPackage.includes('https://review-room.chrisjbell.dev/mcp')
    && !pluginPackage.includes('proof-sdk-psi.vercel.app'),
  'Expected public agent docs, Cowork plugin config, and plugin package fallback to advertise the Fly production hostname',
);

console.log('✓ Fly deployment config pins live-collab volume mode');
