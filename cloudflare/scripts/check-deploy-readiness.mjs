#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = path.resolve(rootDir, '..');
const localWranglerScript = path.join(rootDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export const REQUIRED_PRODUCTION_SECRETS = Object.freeze([
  'TURNSTILE_SECRET_KEY',
  'GALLERY_TOKEN_SECRET',
  'GALLERY_ADMIN_TOKEN',
  'NVIDIA_API_KEY',
  'GEMINI_API_KEY',
]);

function safeArgumentLabel(argument) {
  const value = String(argument || '');
  if (!value.startsWith('-')) return '<positional>';
  return value.split('=', 1)[0] || '<option>';
}

export function assertFixedProductionDeployArgs(args) {
  const dryRunCount = args.filter((argument) => argument === '--dry-run').length;
  const unsupported = args.filter((argument) => argument !== '--dry-run');
  if (dryRunCount > 1) unsupported.push('--dry-run');
  if (unsupported.length > 0) {
    const labels = [...new Set(unsupported.map(safeArgumentLabel))];
    throw new Error(
      `Unsupported deploy arguments for fixed flux-image-gen production target: ${labels.join(', ')}`,
    );
  }
}

export function assertCleanWorktree(statusOutput) {
  if (String(statusOutput || '').trim()) {
    throw new Error('Git worktree has uncommitted or untracked changes.');
  }
}

export function parseSecretNames(secretListOutput) {
  let entries;
  try {
    entries = JSON.parse(String(secretListOutput || ''));
  } catch {
    throw new Error('Wrangler secret list did not return valid JSON.');
  }

  if (!Array.isArray(entries)) {
    throw new Error('Wrangler secret list did not return an array.');
  }

  return entries.map((entry) => {
    const name = entry && typeof entry === 'object' ? String(entry.name || '').trim() : '';
    if (!name) {
      throw new Error('Wrangler secret list contained an invalid entry.');
    }
    return name;
  });
}

export function findMissingSecrets(secretNames, requiredNames = REQUIRED_PRODUCTION_SECRETS) {
  const present = new Set(secretNames);
  return requiredNames.filter((name) => !present.has(name));
}

function runCaptured(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function wranglerInvocation(argv) {
  if (argv.length === 0) {
    if (!existsSync(localWranglerScript)) {
      throw new Error('Project-local Wrangler is missing; run npm ci in cloudflare/.');
    }
    return {
      command: process.execPath,
      args: [localWranglerScript],
    };
  }

  if (argv.length === 2 && argv[0] === '--wrangler-npx-version' && /^\d+\.\d+\.\d+$/.test(argv[1])) {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['--yes', `wrangler@${argv[1]}`],
    };
  }

  throw new Error('Usage: check-deploy-readiness.mjs [--wrangler-npx-version X.Y.Z]');
}

export function validateReadinessInputs({ gitStatus, secretListOutput, wranglerTomlContent }) {
  assertCleanWorktree(gitStatus);
  const missing = findMissingSecrets(parseSecretNames(secretListOutput));
  if (missing.length > 0) {
    throw new Error(`Missing required production secrets: ${missing.join(', ')}`);
  }
  if (wranglerTomlContent != null) {
    assertProductionAbuseControls(wranglerTomlContent);
  }
}

/**
 * Reject a production deployment configuration that has no abuse controls.
 *
 * A configuration is considered inadequate when ALL of the following are true:
 *   1. ENVIRONMENT is not "production" (rate limiter won't fail-closed).
 *   2. TURNSTILE_REQUIRED is not "true" (Turnstile gate is off).
 *
 * This prevents accidental public exposure where both layers are disabled.
 */
export function assertProductionAbuseControls(tomlContent) {
  const content = String(tomlContent || '');
  const environmentMatch = content.match(/^\s*ENVIRONMENT\s*=\s*"([^"]*)"/m);
  const turnstileMatch = content.match(/^\s*TURNSTILE_REQUIRED\s*=\s*"([^"]*)"/m);

  const environmentValue = (environmentMatch && environmentMatch[1]) || 'development';
  const turnstileValue = (turnstileMatch && turnstileMatch[1]) || 'false';

  const hasProductionMode = environmentValue.trim().toLowerCase() === 'production';
  const hasTurnstile = turnstileValue.trim().toLowerCase() === 'true';

  if (!hasProductionMode && !hasTurnstile) {
    throw new Error(
      'Production deployment rejected: ENVIRONMENT is not "production" (rate limiter will not fail-closed) ' +
      'AND TURNSTILE_REQUIRED is not "true". At least one abuse control must be active. ' +
      'Set ENVIRONMENT="production" in wrangler.toml or enable TURNSTILE_REQUIRED="true".',
    );
  }
}

function fail(message) {
  console.error(`[deploy-readiness] FAIL: ${message}`);
  process.exit(1);
}

function main() {
  const gitStatus = runCaptured(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    repoDir,
  );
  if (gitStatus.error || gitStatus.status !== 0) {
    fail('Unable to verify that the Git worktree is clean.');
  }

  try {
    assertCleanWorktree(gitStatus.stdout);
  } catch (error) {
    fail(error.message);
  }

  let invocation;
  try {
    invocation = wranglerInvocation(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }

  const secretList = runCaptured(
    invocation.command,
    invocation.args.concat(['secret', 'list', '--config', 'wrangler.toml', '--format', 'json']),
    rootDir,
  );
  if (secretList.error || secretList.status !== 0) {
    fail('Unable to verify production secret names with Wrangler.');
  }

  try {
    validateReadinessInputs({ gitStatus: gitStatus.stdout, secretListOutput: secretList.stdout });
  } catch (error) {
    fail(error.message);
  }

  // Read wrangler.toml to verify abuse controls are configured.
  let wranglerTomlContent;
  try {
    wranglerTomlContent = readFileSync(path.join(rootDir, 'wrangler.toml'), 'utf8');
  } catch {
    fail('Unable to read wrangler.toml for abuse-control verification.');
  }

  try {
    assertProductionAbuseControls(wranglerTomlContent);
  } catch (error) {
    fail(error.message);
  }

  console.log(`[deploy-readiness] PASS: ${REQUIRED_PRODUCTION_SECRETS.join(', ')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
