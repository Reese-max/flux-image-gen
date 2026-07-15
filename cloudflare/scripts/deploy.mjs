import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertFixedProductionDeployArgs } from './check-deploy-readiness.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = path.resolve(rootDir, '..');
const verifyScript = path.join(repoDir, 'scripts', 'verify.mjs');
const publicPreflightScript = path.join(repoDir, 'scripts', 'check_deployment_preflight.py');
const deployReadinessScript = path.join(rootDir, 'scripts', 'check-deploy-readiness.mjs');
const wranglerScript = path.join(rootDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function run(command, args, useShell = false) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      shell: useShell,
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function hasSuccessfulDeployOutput(output) {
  return /Uploaded\s+flux-image-gen/.test(output)
    && /Deployed\s+flux-image-gen\s+triggers/.test(output)
    && /https:\/\/flux-image-gen\.irisx-tracker\.workers\.dev/.test(output)
    && /Current Version ID:\s+[0-9a-f-]+/i.test(output);
}

function hasSuccessfulDryRunOutput(output) {
  return /--dry-run:\s+exiting now\./.test(output) && /assets directory/i.test(output);
}

function currentGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function requireGate(name, command, args) {
  console.log(`[deploy] Running required gate: ${name}`);
  const result = await run(command, args);
  if (result.code !== 0) {
    console.error(`[deploy] Aborting: required gate failed: ${name}`);
    process.exit(result.code || 1);
  }
}

const forwardedArgs = process.argv.slice(2);
try {
  assertFixedProductionDeployArgs(forwardedArgs);
} catch (error) {
  console.error(`[deploy] Aborting: ${error.message}`);
  process.exit(1);
}
const dryRun = forwardedArgs.includes('--dry-run');

// Every deploy path runs the same offline gate. A real public deploy also
// requires production Turnstile configuration; dry-run remains usable while
// that external blocker is being resolved.
await requireGate('full offline verify', process.execPath, [verifyScript]);
if (!dryRun) {
  await requireGate('public deployment preflight', 'python', [publicPreflightScript, '--root', repoDir, '--public']);
}

// Gate: the Cloudflare copy must match the canonical app/static before deploy.
const syncCheck = await run(process.execPath, ['scripts/sync-static.mjs', '--check']);
if (syncCheck.code !== 0) {
  console.error('[deploy] Aborting: frontend copy is out of sync. Run "npm run sync" first.');
  process.exit(syncCheck.code || 1);
}

if (!existsSync(wranglerScript)) {
  console.error('[deploy] Local Wrangler is missing. Run "npm ci" in cloudflare/; deployment never falls back to an unpinned npx download.');
  process.exit(1);
}

let commit = '';
if (!dryRun) {
  // This gate is intentionally last: version metadata must describe the exact,
  // committed tree uploaded by Wrangler, and production secrets must already
  // exist before any upload begins.
  await requireGate('production deployment readiness', process.execPath, [deployReadinessScript]);
  commit = currentGitCommit();
  if (!commit) {
    console.error('[deploy] Aborting: unable to resolve the verified Git commit.');
    process.exit(1);
  }
}

const wranglerArgs = ['deploy', '--config', 'wrangler.toml'];
if (dryRun) wranglerArgs.push('--dry-run');
if (!dryRun) {
  wranglerArgs.push('--tag', `git-${commit.slice(0, 12)}`);
  wranglerArgs.push('--message', `commit ${commit}`);
}

const result = await run(process.execPath, [wranglerScript].concat(wranglerArgs));

if (dryRun) {
  if (hasSuccessfulDryRunOutput(result.output)) {
    if (result.code !== 0) {
      console.warn('[deploy] Wrangler returned non-zero, but dry-run success markers were present. Normalizing exit code to 0.');
    } else {
      console.log('[deploy] Wrangler dry-run output verified.');
    }
    process.exit(0);
  }

  if (result.code === 0) {
    console.error('[deploy] Wrangler dry-run exited 0 but expected success markers were missing. Treating this as an unverified dry-run.');
  } else {
    console.error('[deploy] Wrangler dry-run failed before success markers. Confirm Cloudflare credentials, account access, and wrangler configuration, then rerun "npm run deploy:dry-run".');
  }
  console.error('[deploy] Expected dry-run markers: "--dry-run: exiting now." and an assets directory summary.');
  process.exit(result.code || 1);
}

const versionMatch = result.output.match(/Current Version ID:\s+([0-9a-f-]+)/i);
if (!dryRun && commit && versionMatch) {
  console.log(`[deploy] Deployment record: commit=${commit} version=${versionMatch[1]}`);
}

if (result.code === 0) {
  process.exit(0);
}

if (!dryRun && hasSuccessfulDeployOutput(result.output)) {
  console.warn('[deploy] Wrangler returned non-zero, but deploy success markers were present. Normalizing exit code to 0.');
  process.exit(0);
}

process.exit(result.code || 1);
