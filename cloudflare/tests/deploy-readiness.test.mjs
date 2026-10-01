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

test('Deploy Preview upload is guarded while a pull request is a draft', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const ciWorkflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

  assert.match(
    workflow,
    /deploy-preview:\s+needs: check\s+if: github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false/
  );
  assert.match(workflow, /command: versions upload/);
  assert.match(workflow, /deploy-production:\s+needs: check\s+if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/production'/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /check:[\s\S]*?run: npm run sync[\s\S]*?uses: actions\/upload-artifact@v7/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'[\s\S]*?cloudflare\/public\/static\/app\.js[\s\S]*?cloudflare\/public\/static\/generation-settings\.js[\s\S]*?cloudflare\/public\/static\/history-store\.js[\s\S]*?if-no-files-found: error/);
  assert.doesNotMatch(workflow, /git push|contents:\s*write/);

  const syncIndex = ciWorkflow.indexOf('run: npm run sync');
  const verifyIndex = ciWorkflow.indexOf('run: node scripts/verify.mjs');
  assert.ok(syncIndex >= 0 && syncIndex < verifyIndex, 'CI must sync deploy assets before full offline verification');
});


import { assertProductionAbuseControls } from '../scripts/check-deploy-readiness.mjs';


test('assertProductionAbuseControls passes when ENVIRONMENT=production', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls('ENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "false"')
  );
});

test('assertProductionAbuseControls passes when TURNSTILE_REQUIRED=true', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls('ENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "true"')
  );
});

test('assertProductionAbuseControls passes when both are enabled', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls('ENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"')
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
