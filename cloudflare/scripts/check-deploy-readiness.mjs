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

// A TOML basic or literal string. Only line-anchored assignments are matched
// anywhere in this module, so commented-out values can never satisfy a gate.
function tomlString(line, key) {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return match ? match[1] ?? match[2] : undefined;
}

// Extract the [vars] table body: section headers only count at line start, so
// brackets inside comments can't truncate the section early, and [env.*]
// tables can't shadow the deployment policy values.
function varsTable(content) {
  const lines = String(content || '').split('\n');
  let inVars = false;
  const collected = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inVars = /^\s*\[\s*vars\s*\]/.test(line);
      continue;
    }
    if (inVars) collected.push(line);
  }
  return collected.join('\n');
}

// Every real [[ratelimits]] block, with the `[ratelimits.simple]` sub-table form
// recorded separately from the block's own keys. Commented-out headers and keys
// are excluded by the same line anchors, so they never open or populate a block.
function ratelimitBlocks(content) {
  const lines = String(content || '').split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (/^\s*\[\[\s*ratelimits\s*\]\]/.test(line)) {
        current = { keys: [], simple: null };
        blocks.push(current);
      } else if (current && /^\s*\[\s*ratelimits\s*\.\s*"?simple"?\s*\]/.test(line)) {
        current.simple = [];
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    if (current.simple) current.simple.push(line);
    else current.keys.push(line);
  }
  return blocks;
}

function namedRateLimitBlocks(content, name) {
  return ratelimitBlocks(content).filter((block) => block.keys.some((line) => tomlString(line, 'name') === name));
}

// True only when a real [[ratelimits]] table declares this name. A commented-out
// block, or the name appearing under a different table, does not count: wrangler
// would deploy without the binding, which is exactly the fail-open state this
// gate exists to prevent.
function hasRatLimitBinding(content, name) {
  return namedRateLimitBlocks(content, name).length > 0;
}

// Both `simple = { limit = 12, period = 60 }` and the equivalent
// `[ratelimits.simple]` sub-table need positive bounds, matching
// scripts/check_deployment_preflight.py.
function hasUsableRateLimitBounds(content, name) {
  return namedRateLimitBlocks(content, name).some(({ keys, simple }) => {
    const inline = keys.map((line) => line.match(/^\s*simple\s*=\s*\{(.*)\}/)?.[1]).find(Boolean);
    const bounds = inline
      ? { limit: inline.match(/\blimit\s*=\s*(\d+)/)?.[1], period: inline.match(/\bperiod\s*=\s*(\d+)/)?.[1] }
      : {
        limit: simple?.map((line) => line.match(/^\s*limit\s*=\s*(\d+)/)?.[1]).find(Boolean),
        period: simple?.map((line) => line.match(/^\s*period\s*=\s*(\d+)/)?.[1]).find(Boolean),
      };
    return Number(bounds.limit) > 0 && Number(bounds.period) > 0;
  });
}

/**
 * Reject a production deployment configuration that cannot gate abuse.
 *
 * Every layer is mandatory, not interchangeable: the [[ratelimits]]
 * GENERATE_RATE_LIMITER binding is the only hard request gate the
 * Gemini-backed /prompt/* routes have (they never verify Turnstile), and
 * Turnstile is the bot gate for the image routes. Production mode makes a
 * missing or broken limiter fail closed instead of silently allowing the
 * request.
 */
export function assertProductionAbuseControls(tomlContent) {
  const content = String(tomlContent || '');
  const varsSection = varsTable(content);

  const environmentValue = varsSection.split('\n').map((line) => tomlString(line, 'ENVIRONMENT')).find(Boolean) ?? 'development';
  const turnstileValue = varsSection.split('\n').map((line) => tomlString(line, 'TURNSTILE_REQUIRED')).find(Boolean) ?? 'false';
  const siteKeyValue = varsSection.split('\n').map((line) => tomlString(line, 'TURNSTILE_SITE_KEY')).find(Boolean) ?? '';

  const hasProductionMode = environmentValue.trim().toLowerCase() === 'production';
  const hasTurnstile = turnstileValue.trim().toLowerCase() === 'true';
  const hasSiteKey = siteKeyValue.trim().length > 0;
  const hasRateLimiterBinding = hasRatLimitBinding(content, 'GENERATE_RATE_LIMITER');

  if (!hasRateLimiterBinding) {
    throw new Error(
      'Production deployment rejected: wrangler.toml must declare the ' +
      '[[ratelimits]] GENERATE_RATE_LIMITER binding so generation routes keep a hard request gate.',
    );
  }

  if (!hasTurnstile) {
    throw new Error(
      'Production deployment rejected: TURNSTILE_REQUIRED must be "true" so /generate, /generate/batch ' +
      'and /edit verify a human token; the per-IP limiter alone is trivially rotated.',
    );
  }

  if (!hasSiteKey) {
    throw new Error(
      'Production deployment rejected: TURNSTILE_SITE_KEY must be a nonempty public site key.',
    );
  }

  if (!hasUsableRateLimitBounds(content, 'GENERATE_RATE_LIMITER')) {
    throw new Error(
      'Production deployment rejected: the GENERATE_RATE_LIMITER binding needs a positive ' +
      '`simple = { limit = N, period = M }`, otherwise the gate allows every request.',
    );
  }

  if (!hasProductionMode) {
    throw new Error(
      'Production deployment rejected: ENVIRONMENT must be "production" so GENERATE_RATE_LIMITER ' +
      'fails closed for public routes; Turnstile does not cover /prompt/*.',
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

  // Read the tracked wrangler.toml; the abuse-control policy is part of the
  // same readiness input set, so one validation pass covers every gate.
  let wranglerTomlContent;
  try {
    wranglerTomlContent = readFileSync(path.join(rootDir, 'wrangler.toml'), 'utf8');
  } catch {
    fail('Unable to read wrangler.toml for abuse-control verification.');
  }

  try {
    validateReadinessInputs({
      gitStatus: gitStatus.stdout,
      secretListOutput: secretList.stdout,
      wranglerTomlContent,
    });
  } catch (error) {
    fail(error.message);
  }

  console.log(`[deploy-readiness] PASS: ${REQUIRED_PRODUCTION_SECRETS.join(', ')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
