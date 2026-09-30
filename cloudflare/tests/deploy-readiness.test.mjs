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


test('assertProductionAbuseControls rejects production with Turnstile disabled', () => {
  assert.throws(() =>
    assertProductionAbuseControls('ENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "false"'),
    /Production deployment rejected/,
  );
});

test('GitHub deployment workflow gates preview version uploads and production deploys', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const check = workflow.split('  deploy-preview:')[0];
  const preview = workflow.split('  deploy-preview:')[1].split('  deploy-production:')[0];
  const production = workflow.split('  deploy-production:')[1];
  assert.match(check, /npm run check/);
  assert.match(check, /npm test/);
  assert.match(check, /npm run sync:check/);
  assert.doesNotMatch(check, /\|\| true/);
  assert.ok(preview);
  const previewPreflightIndex = preview.indexOf('check_deployment_preflight.py --public');
  assert.ok(previewPreflightIndex >= 0 && previewPreflightIndex < preview.indexOf('Refresh Cloudflare Token'));
  assert.ok(previewPreflightIndex < preview.indexOf('Deploy Preview'));
  assert.ok(production);
  const productionPreflightIndex = production.indexOf('check_deployment_preflight.py --public');
  assert.ok(productionPreflightIndex >= 0 && productionPreflightIndex < production.indexOf('Deploy Production'));
});

test('assertProductionAbuseControls rejects development even with Turnstile', () => {
  assert.throws(() =>
    assertProductionAbuseControls('ENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "true"\nTURNSTILE_SITE_KEY = "site"'),
    /Production deployment rejected/,
  );
});

test('assertProductionAbuseControls passes when both are enabled with a site key', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls('ENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"\nTURNSTILE_SITE_KEY = "site"')
  );
});

test('assertProductionAbuseControls rejects missing site key', () => {
  assert.throws(() =>
    assertProductionAbuseControls('ENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"'),
    /Production deployment rejected/,
  );
});

test('assertProductionAbuseControls rejects when neither abuse control is active', () => {
  assert.throws(
    () => assertProductionAbuseControls('ENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "false"'),
    /Production deployment rejected/,
  );
});

test('assertProductionAbuseControls rejects when ENVIRONMENT is missing and TURNSTILE is false', () => {
  assert.throws(
    () => assertProductionAbuseControls('TURNSTILE_REQUIRED = "false"'),
    /Production deployment rejected/,
  );
});

test('assertProductionAbuseControls rejects when no vars set', () => {
  assert.throws(
    () => assertProductionAbuseControls(''),
    /Production deployment rejected/,
  );
});
