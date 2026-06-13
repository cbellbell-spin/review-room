import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

const packageJson = read('package.json');
const exportScript = read('scripts/review-room-export-vercel.ts');
const importScript = read('scripts/review-room-import-fly.ts');
const verifyScript = read('scripts/review-room-verify-migration.ts');
const migrationRunbook = read('docs/review-room-vercel-to-fly-migration.md');
const deploymentNotes = read('docs/review-room-deployment.md');

assert(
  packageJson.includes('"migrate:review-room:export": "tsx scripts/review-room-export-vercel.ts"')
    && packageJson.includes('"migrate:review-room:import": "tsx scripts/review-room-import-fly.ts"')
    && packageJson.includes('"migrate:review-room:verify": "tsx scripts/review-room-verify-migration.ts"'),
  'Expected package scripts for Vercel to Fly document migration',
);

assert(
  exportScript.includes("tokenPolicy: 'omitted'")
    && exportScript.includes('sanitizeDocumentSecrets(tables.documents)')
    && exportScript.includes('row.owner_secret = null')
    && exportScript.includes('row.owner_secret_hash = null')
    && !exportScript.includes('SELECT * FROM document_access'),
  'Expected exporter to omit legacy access rows and owner secrets',
);

assert(
  importScript.includes("role === 'owner') return 'owner_bot'")
    && importScript.includes('hashSecret(token)')
    && importScript.includes('owner_secret, owner_secret_hash')
    && importScript.includes('NULL, NULL')
    && importScript.includes('VALUES (?, ?, ?, ?, ?, ?, 0, ?')
    && importScript.includes('eventIdMap.set(`${slug}:${oldId}`, newId)')
    && importScript.includes('Fresh tokens can only be viewed at import time'),
  'Expected importer to mint fresh tokens, reset Yjs state, and remap event ids',
);

assert(
  verifyScript.includes('legacy owner secret was imported')
    && verifyScript.includes('no active fresh access token')
    && verifyScript.includes('expected imported projection y_state_version=0'),
  'Expected verifier to guard token and projection invariants',
);

assert(
  migrationRunbook.includes('does not preserve legacy access material')
    && migrationRunbook.includes('--apply')
    && migrationRunbook.includes('review-room-fly-tokens.json')
    && deploymentNotes.includes('review-room-vercel-to-fly-migration.md')
    && deploymentNotes.includes('mints fresh Fly access tokens'),
  'Expected migration runbook to document the fresh-token migration flow',
);

console.log('✓ Review Room migration tooling preserves content while minting fresh Fly tokens');
