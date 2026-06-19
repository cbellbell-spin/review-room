import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const distDir = path.join(root, 'dist');
const indexPath = path.join(distDir, 'index.html');
const manifestPath = path.join(distDir, 'web-artifact-manifest.json');
const buildInfoPath = path.join(root, '.proof-build-info.json');

const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
let commitSha = process.env.GIT_COMMIT_SHA?.trim() || 'uncommitted';
if (!process.env.GIT_COMMIT_SHA?.trim()) {
  try {
    commitSha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    commitSha = 'uncommitted';
  }
}
const releaseDate = process.env.BUILD_RELEASE_DATE ?? new Date().toISOString();

const indexHtml = readFileSync(indexPath, 'utf8').replace(/type=\"module\" crossorigin /g, 'defer ');
writeFileSync(indexPath, indexHtml);

const manifest = {
  bundleVersion: packageJson.version,
  commitSha,
  releaseDate,
  compatibilityNote: 'Opaque web bundle for explicit external consumers. No shared runtime source is supported.',
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const runtimeBuildInfo = {
  sha: commitSha,
  env: process.env.PROOF_ENV ?? process.env.NODE_ENV ?? null,
  generatedAt: releaseDate,
};

writeFileSync(buildInfoPath, `${JSON.stringify(runtimeBuildInfo, null, 2)}\n`);
