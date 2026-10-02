import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  REQUIRED_PRODUCTION_SECRETS,
  assertCleanWorktree,
  assertFixedProductionDeployArgs,
  findMissingSecrets,
  parseSecretNames,
  validateReadinessInputs,
} from '../scripts/check-deploy-readiness.mjs';

const completeSecretList = REQUIRED_PRODUCTION_SECRETS.map((name) => ({
  name,
  type: 'secret_text',
}));

test('deployment readiness requires a clean worktree', () => {
  assert.doesNotThrow(() => assertCleanWorktree(''));
  assert.throws(
    () => assertCleanWorktree(' M cloudflare/src/index.js\n?? scratch.txt\n'),
    /uncommitted or untracked changes/,
  );
});

test('deployment wrapper accepts only the fixed production target and dry-run switch', () => {
  assert.doesNotThrow(() => assertFixedProductionDeployArgs([]));
  assert.doesNotThrow(() => assertFixedProductionDeployArgs(['--dry-run']));

  for (const args of [
    ['--env', 'staging'],
    ['--name=another-worker'],
    ['--config', 'other.toml'],
    ['--profile=other-account'],
    ['other-worker.js'],
    ['--tag', 'manual'],
    ['--message=manual'],
    ['--dry-run=false'],
    ['--dry-run', '--dry-run'],
  ]) {
    assert.throws(
      () => assertFixedProductionDeployArgs(args),
      /fixed flux-image-gen production target/,
    );
  }

  assert.throws(
    () => assertFixedProductionDeployArgs(['--name=do-not-print-this-value']),
    (error) => !error.message.includes('do-not-print-this-value'),
  );
});

test('deployment readiness parses only secret names and rejects malformed output', () => {
  assert.deepEqual(
    parseSecretNames(JSON.stringify(completeSecretList)),
    REQUIRED_PRODUCTION_SECRETS,
  );
  assert.throws(() => parseSecretNames('not-json'), /valid JSON/);
  assert.throws(() => parseSecretNames('{}'), /array/);
  assert.throws(() => parseSecretNames('[{"type":"secret_text"}]'), /invalid entry/);
});

test('deployment readiness reports only missing required secret names', () => {
  assert.deepEqual(
    findMissingSecrets(['NVIDIA_API_KEY', 'GEMINI_API_KEY']),
    ['TURNSTILE_SECRET_KEY', 'GALLERY_TOKEN_SECRET', 'GALLERY_ADMIN_TOKEN'],
  );
  assert.throws(
    () => validateReadinessInputs({
      gitStatus: '',
      secretListOutput: JSON.stringify(completeSecretList.slice(1)),
    }),
    /^Error: Missing required production secrets: TURNSTILE_SECRET_KEY$/,
  );
});

test('both real deployment paths invoke readiness before resolving the commit', async () => {
  const deployScript = await readFile(new URL('../scripts/deploy.mjs', import.meta.url), 'utf8');
  const wslScript = await readFile(new URL('../scripts/deploy-wsl.sh', import.meta.url), 'utf8');

  const deployGateIndex = deployScript.indexOf("requireGate('production deployment readiness'");
  const deployCommitIndex = deployScript.indexOf('commit = currentGitCommit()');
  assert.ok(deployGateIndex >= 0 && deployGateIndex < deployCommitIndex);
  assert.doesNotMatch(deployScript, /concat\(forwardedArgs\)/);
  assert.match(deployScript, /wranglerArgs\.push\('--tag', `git-\$\{commit\.slice\(0, 12\)\}`\)/);
  assert.match(deployScript, /wranglerArgs\.push\('--message', `commit \$\{commit\}`\)/);

  const wslGateIndex = wslScript.indexOf('check-deploy-readiness.mjs');
  const wslCommitIndex = wslScript.indexOf('GIT_COMMIT=');
  assert.ok(wslGateIndex >= 0 && wslGateIndex < wslCommitIndex);
  assert.match(wslScript, /--wrangler-npx-version "\$WRANGLER_VERSION"/);

  const cleanupStart = wslScript.indexOf('cleanup_credentials()');
  const cleanupEnd = wslScript.indexOf('trap cleanup_credentials EXIT');
  const cleanupBody = wslScript.slice(cleanupStart, cleanupEnd);
  assert.ok(cleanupStart >= 0 && cleanupStart < cleanupEnd);
  assert.ok(cleanupBody.indexOf('sync_windows_credentials') < cleanupBody.indexOf('restore_wsl_credentials'));
  assert.match(wslScript, /BORROWED_WSL_CREDS_READY=yes/);
  assert.match(wslScript, /default\.toml.*\.bak-|\$\{WIN_CREDS\}\.bak-/);
});


import { assertProductionAbuseControls } from '../scripts/check-deploy-readiness.mjs';

const LIMITER_BINDING = '[[ratelimits]]\nname = "GENERATE_RATE_LIMITER"\nnamespace_id = "1001"\nsimple = { limit = 12, period = 60 }';

test('assertProductionAbuseControls rejects development mode even when Turnstile is active', () => {
  // Turnstile is not verified by Gemini-backed /prompt/* routes.
  assert.throws(
    () => assertProductionAbuseControls(
      `[vars]\nENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "true"\nTURNSTILE_SITE_KEY = "0x_site"\n${LIMITER_BINDING}`,
    ),
    /ENVIRONMENT must be "production"/,
  );
});

test('assertProductionAbuseControls passes on a durable fail-closed limiter alone', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls(
      `[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "false"\n${LIMITER_BINDING}`,
    )
  );
});

test('assertProductionAbuseControls passes when every control is enabled', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls(
      `[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"\nTURNSTILE_SITE_KEY = "0x_site"\n${LIMITER_BINDING}`,
    )
  );
});

test('assertProductionAbuseControls rejects when Turnstile is off and the limiter is not fail-closed', () => {
  assert.throws(
    () => assertProductionAbuseControls(
      `[vars]\nENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "false"\n${LIMITER_BINDING}`,
    ),
    /Production deployment rejected/,
  );
});

test('assertProductionAbuseControls rejects production mode without the limiter binding', () => {
  // The GENERATE_RATE_LIMITER binding is mandatory: without it the
  // Gemini-backed prompt routes have no equivalent hard gate at all.
  assert.throws(
    () => assertProductionAbuseControls('[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "false"'),
    /GENERATE_RATE_LIMITER/,
  );
});

test('assertProductionAbuseControls rejects a Turnstile-only config without the limiter binding', () => {
  // Even a correct Turnstile gate does not cover /prompt/* routes, which
  // never verify Turnstile tokens — the limiter binding is still required.
  assert.throws(
    () => assertProductionAbuseControls(
      '[vars]\nENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "true"\nTURNSTILE_SITE_KEY = "0x_site"',
    ),
    /GENERATE_RATE_LIMITER/,
  );
});

test('assertProductionAbuseControls rejects Turnstile-required config without a site key', () => {
  assert.throws(
    () => assertProductionAbuseControls(
      `[vars]\nENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "true"\n${LIMITER_BINDING}`,
    ),
    /TURNSTILE_SITE_KEY/,
  );
});

test('assertProductionAbuseControls rejects a commented-out limiter binding', () => {
  // Wrangler ignores commented tables, so the deployment would ship with no
  // limiter at all; a raw-text match would wrongly accept this.
  const commentedOut =
    '[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"\nTURNSTILE_SITE_KEY = "0x_site"\n' +
    '# [[ratelimits]]\n# name = "GENERATE_RATE_LIMITER"\n# simple = { limit = 12, period = 60 }\n';
  assert.throws(
    () => assertProductionAbuseControls(commentedOut),
    /GENERATE_RATE_LIMITER/,
  );
});

test('assertProductionAbuseControls ignores a limiter name declared under another table', () => {
  const foreign =
    '[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"\nTURNSTILE_SITE_KEY = "0x_site"\n' +
    '[observability]\nname = "GENERATE_RATE_LIMITER"\n';
  assert.throws(
    () => assertProductionAbuseControls(foreign),
    /GENERATE_RATE_LIMITER/,
  );
});

test('assertProductionAbuseControls rejects when no vars set', () => {
  assert.throws(
    () => assertProductionAbuseControls(''),
    /Production deployment rejected|GENERATE_RATE_LIMITER/,
  );
});

test('assertProductionAbuseControls ignores matching names outside the [vars] table', () => {
  // An env-specific [env.staging.vars] table must not shadow the real [vars]
  // deployment policy values.
  const spoofed =
    '[vars]\nENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "false"\n' +
    '[env.staging.vars]\nENVIRONMENT = "production"\n' +
    LIMITER_BINDING;
  assert.throws(
    () => assertProductionAbuseControls(spoofed),
    /Production deployment rejected/,
  );
});

test('assertProductionAbuseControls accepts the tracked production wrangler.toml', async () => {
  const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.doesNotThrow(() => assertProductionAbuseControls(toml));
});

test('GitHub Actions production deploy runs the hardened abuse gates before wrangler deploy', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const productionJob = workflow.slice(workflow.indexOf('deploy-production:'));

  const preflightIndex = productionJob.indexOf('check_deployment_preflight.py --public');
  const readinessIndex = productionJob.indexOf('check-deploy-readiness.mjs');
  const deployIndex = productionJob.indexOf('command: deploy');

  assert.ok(preflightIndex >= 0, 'production job must run the public deployment preflight');
  assert.ok(readinessIndex >= 0, 'production job must run check-deploy-readiness.mjs');
  assert.ok(
    deployIndex > preflightIndex && deployIndex > readinessIndex,
    'wrangler deploy must run only after both abuse-control gates pass',
  );
});

test('GitHub Actions preview upload runs the public preflight before versions upload', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const previewJob = workflow.slice(
    workflow.indexOf('deploy-preview:'),
    workflow.indexOf('deploy-production:'),
  );

  const preflightIndex = previewJob.indexOf('check_deployment_preflight.py --public');
  const uploadIndex = previewJob.indexOf('command: versions upload');

  assert.ok(preflightIndex >= 0, 'preview job must run the public deployment preflight');
  assert.ok(uploadIndex > preflightIndex, 'versions upload must run after the preflight passes');
});

test('GitHub Actions preview versions upload overrides the production abuse policy', async () => {
  // The tracked wrangler.toml is deliberately production-hardened, and no
  // TURNSTILE_SECRET_KEY is provisioned for preview versions. Without an
  // explicit non-production override every PR preview answers 503.
  const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const previewJob = workflow.slice(
    workflow.indexOf('deploy-preview:'),
    workflow.indexOf('deploy-production:'),
  );
  const uploadIndex = previewJob.indexOf('command: versions upload');
  const uploadStep = previewJob.slice(uploadIndex);

  assert.match(uploadStep, /--var ENVIRONMENT:development/);
  assert.match(uploadStep, /--var TURNSTILE_REQUIRED:false/);
});

test('GitHub Actions deploy jobs reference script paths that exist from their working directory', async () => {
  // GitHub Actions resolves each step from the job's working directory; a path
  // that only exists relative to another job makes the deploy step fail.
  const repoRoot = new URL('../../', import.meta.url);
  const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

  // Only the `jobs:` block declares jobs; `on:` triggers share the same indent.
  const lines = workflow.slice(workflow.indexOf('\njobs:\n')).split('\n');
  const jobStarts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  assert.equal(jobStarts.length, 3, 'expected the check, preview and production jobs');

  for (const [position, { line }] of jobStarts.entries()) {
    const name = line.trim().replace(/:$/, '');
    const body = lines
      .slice(jobStarts[position].index, jobStarts[position + 1]?.index ?? lines.length)
      .join('\n');
    const defaultsIndex = body.search(/^\s+defaults:\s*$/m);
    const stepsIndex = body.search(/^\s+steps:\s*$/m);
    assert.ok(stepsIndex >= 0, `${name} must declare steps`);
    const jobWorkingDirectory =
      defaultsIndex >= 0 && defaultsIndex < stepsIndex
        ? body.slice(defaultsIndex, stepsIndex).match(/working-directory:\s*(\S+)/)?.[1] ?? ''
        : '';

    for (const step of body.slice(stepsIndex).split(/\n(?=\s+- )/)) {
      const stepWorkingDirectory =
        step.match(/^\s+working-directory:\s*(\S+)/m)?.[1] ?? jobWorkingDirectory;
      for (const [, reference] of step.matchAll(/\bnode\s+([\w./-]+\.(?:mjs|js))/g)) {
        const resolved = new URL(
          stepWorkingDirectory ? `${stepWorkingDirectory}/${reference}` : reference,
          repoRoot,
        );
        assert.ok(
          existsSync(fileURLToPath(resolved)),
          `${name}: node ${reference} does not exist from ${stepWorkingDirectory || 'the repository root'}`,
        );
      }
    }
  }
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tokenParserPath = fileURLToPath(new URL('../scripts/parse_cloudflare_access_token.mjs', import.meta.url));

function parseTokenResponse(body, status) {
  const directory = mkdtempSync(join(tmpdir(), 'cf-token-response-'));
  const responsePath = join(directory, 'response.json');
  try {
    writeFileSync(responsePath, body, 'utf8');
    return spawnSync(process.execPath, [tokenParserPath, responsePath, String(status)], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('Cloudflare token response parser emits only a valid synthetic token', () => {
  const result = parseTokenResponse(JSON.stringify({ access_token: 'synthetic-access-token' }), 200);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'synthetic-access-token');
  assert.equal(result.stderr, '');
});

test('Cloudflare token response parser rejects non-200 responses without echoing response bodies', () => {
  const result = parseTokenResponse(JSON.stringify({ access_token: 'SYNTHETIC_SECRET_SENTINEL' }), 400);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /HTTP 400/);
  assert.doesNotMatch(result.stderr, /SYNTHETIC_SECRET_SENTINEL/);
});

test('Cloudflare token response parser rejects malformed JSON without echoing it', () => {
  const result = parseTokenResponse('{"access_token":"SYNTHETIC_SECRET_SENTINEL"', 200);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid JSON/);
  assert.doesNotMatch(result.stderr, /SYNTHETIC_SECRET_SENTINEL/);
});

test('Cloudflare token response parser rejects missing, empty, or newline-bearing access tokens', () => {
  const cases = [
    ['missing', {}],
    ['null', { access_token: null }],
    ['number', { access_token: 1 }],
    ['empty', { access_token: '' }],
    ['whitespace', { access_token: ' ' }],
    ['newline', { access_token: 'synthetic-token\ninjected=value' }],
  ];
  for (const [name, body] of cases) {
    const result = parseTokenResponse(JSON.stringify(body), 200);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usable access token/);
  }
});

test('both Cloudflare deploy jobs validate refreshed tokens and mask before exporting', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const preview = workflow.slice(workflow.indexOf('  deploy-preview:'), workflow.indexOf('  deploy-production:'));
  const production = workflow.slice(workflow.indexOf('  deploy-production:'));
  for (const job of [preview, production]) {
    const stepStart = job.indexOf('      - name: Refresh Cloudflare Token');
    assert.ok(stepStart >= 0, "each deploy job must refresh its token");
    const nextStep = job.indexOf('\n      - name:', stepStart + 1);
    const step = job.slice(stepStart, nextStep < 0 ? undefined : nextStep);
    assert.match(step, /CF_REFRESH_TOKEN: \$\{\{ secrets\.CF_REFRESH_TOKEN \}\}/);
    assert.match(step, /--write-out '%\{http_code\}'/);
    assert.match(step, /parse_cloudflare_access_token\.mjs/);
    assert.ok(step.indexOf('::add-mask::') >= 0 && step.indexOf('::add-mask::') < step.indexOf('$GITHUB_OUTPUT'));
    assert.doesNotMatch(step, /jq -r '\.access_token'/);
  }
});
