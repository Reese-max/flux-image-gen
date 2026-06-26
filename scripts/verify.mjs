// Local CI gate: run every offline check before deploying.
// No network, no Cloudflare deploy, no NVIDIA/Gemini calls.
//
//   node scripts/verify.mjs
//
// Exits non-zero on the first failing step.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cloudflareDir = path.join(rootDir, 'cloudflare');

const frontendTests = readdirSync(path.join(rootDir, 'tests', 'frontend'))
  .filter((name) => name.endsWith('.test.cjs'))
  .map((name) => `tests/frontend/${name}`);

const steps = [
  { name: 'Python tests (pytest)', command: 'python -m pytest -q', cwd: rootDir },
  { name: 'Frontend JS tests (node --test)', command: `node --test ${frontendTests.join(' ')}`, cwd: rootDir },
  { name: 'Cloudflare static sync check', command: 'npm run sync:check', cwd: cloudflareDir },
  { name: 'Cloudflare JS syntax check', command: 'npm run check', cwd: cloudflareDir },
  { name: 'Cloudflare Worker tests', command: 'npm test', cwd: cloudflareDir },
];

let failed = null;
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(step.command, { cwd: step.cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    failed = step.name;
    break;
  }
}

console.log('');
if (failed) {
  console.error(`[verify] FAILED at: ${failed}`);
  process.exit(1);
}
console.log('[verify] All checks passed.');
