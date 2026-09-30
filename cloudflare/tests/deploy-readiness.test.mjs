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

test('assertProductionAbuseControls passes on the Turnstile gate alone', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls(
      `[vars]\nENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "true"\nTURNSTILE_SITE_KEY = "0x_site"\n${LIMITER_BINDING}`,
    )
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
