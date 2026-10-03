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


test('assertProductionAbuseControls passes when ENVIRONMENT=production', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls('[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "false"')
  );
});

test('assertProductionAbuseControls passes when TURNSTILE_REQUIRED=true', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls('[vars]\nENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "true"')
  );
});

test('assertProductionAbuseControls passes when both are enabled', () => {
  assert.doesNotThrow(() =>
    assertProductionAbuseControls('[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"')
  );
});

test('assertProductionAbuseControls rejects when neither abuse control is active', () => {
  assert.throws(
    () => assertProductionAbuseControls('[vars]\nENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "false"'),
    /Production deployment rejected/,
  );
});

test('assertProductionAbuseControls rejects when ENVIRONMENT is missing and TURNSTILE is false', () => {
  assert.throws(
    () => assertProductionAbuseControls('[vars]\nTURNSTILE_REQUIRED = "false"'),
    /Production deployment rejected/,
  );
});

test('assertProductionAbuseControls rejects when no vars set', () => {
  assert.throws(
    () => assertProductionAbuseControls(''),
    /Production deployment rejected/,
  );
});

test('fixed production deploy rejects read-only preview even with both abuse controls', () => {
  for (const previewValue of ['"true"', "'true'", 'true', '" TRUE "']) {
    assert.throws(() => assertProductionAbuseControls(
      `[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"\nPREVIEW_READ_ONLY = ${previewValue}`,
    ), /PREVIEW_READ_ONLY is for isolated uploaded previews only/);
  }
  assert.doesNotThrow(() => assertProductionAbuseControls(
    '[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"\nPREVIEW_READ_ONLY = "false"',
  ));
  assert.throws(() => assertProductionAbuseControls(
    '[vars]\nENVIRONMENT = "development"\nTURNSTILE_REQUIRED = "false"\nPREVIEW_READ_ONLY = "false"',
  ), /At least one abuse control must be active/);
});

test('production preview guard fails closed on quoted keys and noncanonical flag values', () => {
  for (const assignment of [
    '"PREVIEW_READ_ONLY" = "true"', "'PREVIEW_READ_ONLY' = 'true'",
    'vars.PREVIEW_READ_ONLY = "true"', 'PREVIEW_READ_ONLY = "\\u0074rue"',
    'PREVIEW_READ_ONLY = """true"""', 'PREVIEW_READ_ONLY = "typo"',
  ]) {
    const config = assignment.startsWith('vars.')
      ? `vars.ENVIRONMENT = "production"\nvars.TURNSTILE_REQUIRED = "true"\n${assignment}`
      : `[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"\n${assignment}`;
    assert.throws(() => assertProductionAbuseControls(
      config,
    ), /PREVIEW_READ_ONLY is for isolated uploaded previews only/);
  }
});

test('production readiness rejects escaped root preview key decoded by TOML', () => {
  assert.throws(() => assertProductionAbuseControls(String.raw`main = "src/index.js"
[vars]
ENVIRONMENT = "production"
TURNSTILE_REQUIRED = "true"
"\u0050REVIEW_READ_ONLY" = "true"
`), /PREVIEW_READ_ONLY is for isolated uploaded previews only/);
});

test('production readiness uses root vars rather than preceding named environment vars', () => {
  assert.throws(() => assertProductionAbuseControls(`main = "src/index.js"
[env.staging.vars]
ENVIRONMENT = "production"
TURNSTILE_REQUIRED = "true"
PREVIEW_READ_ONLY = "false"
[vars]
ENVIRONMENT = "production"
TURNSTILE_REQUIRED = "true"
PREVIEW_READ_ONLY = "true"
`), /PREVIEW_READ_ONLY is for isolated uploaded previews only/);
});

test('automatic PR preview always opts into isolation and production command remains fixed', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const preview = workflow.slice(workflow.indexOf('      - name: Deploy Preview'), workflow.indexOf('      - name: Deploy Production'));
  const production = workflow.slice(workflow.indexOf('      - name: Deploy Production'));
  assert.match(preview, /command: versions upload --var PREVIEW_READ_ONLY:true/);
  assert.match(production, /command: deploy/);
  assert.doesNotMatch(production, /PREVIEW_READ_ONLY:true/);
});

test('root TOML controls support quoted, escaped, dotted, inline and multiline false values', () => {
  const configs = [
    String.raw`["\u0076ars"]
"\u0045NVIRONMENT" = "\u0070roduction"
TURNSTILE_REQUIRED = 'true'
"\u0050REVIEW_READ_ONLY" = "\u0066alse"
`,
    `vars = { ENVIRONMENT = 'production', TURNSTILE_REQUIRED = 'true', PREVIEW_READ_ONLY = 'false' }`,
    `vars.ENVIRONMENT = 'production'\nvars.TURNSTILE_REQUIRED = true\nvars.PREVIEW_READ_ONLY = false`,
    `[vars]\nENVIRONMENT = 'production'\nTURNSTILE_REQUIRED = 'true'\nPREVIEW_READ_ONLY = """false"""`,
    `main = "src/index.js"
[env.staging.vars]
PREVIEW_READ_ONLY = "true"
ENVIRONMENT = "development"
[vars]
PREVIEW_READ_ONLY = "false"
ENVIRONMENT = "production"
TURNSTILE_REQUIRED = "false"
`,
  ];
  for (const config of configs) assert.doesNotThrow(() => assertProductionAbuseControls(config));
});

test('malformed TOML is rejected without leaking parser diagnostics or config content', () => {
  for (const config of [
    '[vars]\nPREVIEW_READ_ONLY = "false"\nPREVIEW_READ_ONLY = "true"',
    '[vars]\nENVIRONMENT = "do-not-print-this-config-value',
    'vars = []',
  ]) {
    assert.throws(() => assertProductionAbuseControls(config),
      /^Error: Production deployment rejected: unable to parse root \[vars\] in Wrangler TOML\.$/);
  }
});

test('non-root environment flags cannot satisfy production abuse controls', () => {
  assert.throws(() => assertProductionAbuseControls(`[env.staging.vars]
ENVIRONMENT = "production"
TURNSTILE_REQUIRED = "true"
[vars]
PREVIEW_READ_ONLY = "false"
ENVIRONMENT = "development"
TURNSTILE_REQUIRED = "false"
`), /At least one abuse control must be active/);
});
