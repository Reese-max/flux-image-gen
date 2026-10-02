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

// Extract the [vars] table body: section headers only count at line start, so
// brackets inside comments can't truncate the section early, and [env.*]
// tables can't shadow the deployment policy values.
function varsTable(content) {
  const lines = stripTomlComments(String(content || '')).split('\n');
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

// Drop `#` comments so a commented-out binding cannot satisfy a required one.
function stripTomlComments(content) {
  return content
    .split('\n')
    .map((line) => (/^\s*\[/.test(line) ? line : line.replace(/(^|\s)#[^\n]*/, '$1')))
    .join('\n');
}

// Bodies of every real [[ratelimits]] block, as arrays of uncommented lines.
function ratelimitBlocks(content) {
  const lines = stripTomlComments(String(content || '')).split('\n');
  let current = null;
  const blocks = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      current = /^\s*\[\[\s*ratelimits\s*\]\]/.test(line) ? [] : null;
      if (current) blocks.push(current);
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

// True only when a real (uncommented) [[ratelimits]] table declares this name.
// A commented-out block, or the name appearing under a different table, does
// not count: wrangler would deploy without the binding, which is exactly the
// fail-open state this gate exists to prevent.
function hasRatLimitBinding(content, name) {
  const pattern = new RegExp(`^\\s*name\\s*=\\s*"${name}"`);
  return ratelimitBlocks(content).some((block) => block.some((line) => pattern.test(line)));
}

// `simple = { limit = 12, period = 60 }` — both bounds must be positive, matching
// scripts/check_deployment_preflight.py so the two gates cannot disagree.
function hasUsableRateLimitBounds(content, name) {
  const namePattern = new RegExp(`^\\s*name\\s*=\\s*"${name}"`);
  return ratelimitBlocks(content)
    .filter((block) => block.some((line) => namePattern.test(line)))
    .some((block) => {
      const simple = block.map((line) => line.match(/^\s*simple\s*=\s*\{(.*)\}/)?.[1]).find(Boolean);
      if (!simple) return false;
      const limit = Number(simple.match(/\blimit\s*=\s*(\d+)/)?.[1]);
      const period = Number(simple.match(/\bperiod\s*=\s*(\d+)/)?.[1]);
      return Number.isFinite(limit) && limit > 0 && Number.isFinite(period) && period > 0;
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
  const environmentMatch = varsSection.match(/^\s*ENVIRONMENT\s*=\s*"([^"]*)"/m);
  const turnstileMatch = varsSection.match(/^\s*TURNSTILE_REQUIRED\s*=\s*"([^"]*)"/m);
  const siteKeyMatch = varsSection.match(/^\s*TURNSTILE_SITE_KEY\s*=\s*"([^"]*)"/m);

  const environmentValue = (environmentMatch && environmentMatch[1]) || 'development';
  const turnstileValue = (turnstileMatch && turnstileMatch[1]) || 'false';
  const siteKeyValue = (siteKeyMatch && siteKeyMatch[1]) || '';

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

  if (hasTurnstile && !hasSiteKey) {
    throw new Error(
      'Production deployment rejected: TURNSTILE_REQUIRED is "true" but TURNSTILE_SITE_KEY is missing or empty.',
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
