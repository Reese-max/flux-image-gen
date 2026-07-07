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
  { name: 'Product prompt test set', command: 'python scripts\\validate_test_prompts.py', cwd: rootDir },
  { name: 'Error scenario matrix', command: 'python scripts\\validate_error_scenarios.py', cwd: rootDir },
  { name: 'Public bundle secret scan', command: 'python scripts\\scan_public_secrets.py', cwd: rootDir },
  { name: 'Cloudflare deployment preflight', command: 'python scripts\\check_deployment_preflight.py', cwd: rootDir },
  { name: 'Python tests (pytest)', command: 'python -m pytest -q', cwd: rootDir },
  { name: 'Frontend JS tests (node --test)', command: `node --test ${frontendTests.join(' ')}`, cwd: rootDir },
  { name: 'Browser E2E network interruption QA', command: 'npm run qa:network', cwd: cloudflareDir },
  { name: 'Browser E2E mobile generation QA', command: 'npm run qa:mobile', cwd: cloudflareDir },
  { name: 'Browser E2E accessibility keyboard QA', command: 'npm run qa:a11y', cwd: cloudflareDir },
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
