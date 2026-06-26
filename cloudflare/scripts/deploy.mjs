import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

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

// Gate: the Cloudflare copy must match the canonical app/static before deploy.
const syncCheck = await run(process.execPath, ['scripts/sync-static.mjs', '--check']);
if (syncCheck.code !== 0) {
  console.error('[deploy] Aborting: frontend copy is out of sync. Run "npm run sync" first.');
  process.exit(syncCheck.code || 1);
}

const wranglerArgs = ['wrangler', 'deploy'].concat(process.argv.slice(2));
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : 'npx';
const args = npmCli ? [npmCli, 'exec', '--'].concat(wranglerArgs) : wranglerArgs;
const result = await run(command, args, !npmCli && process.platform === 'win32');
const dryRun = args.indexOf('--dry-run') !== -1;

if (result.code === 0) {
  process.exit(0);
}

if (dryRun && hasSuccessfulDryRunOutput(result.output)) {
  console.warn('[deploy] Wrangler returned non-zero, but dry-run success markers were present. Normalizing exit code to 0.');
  process.exit(0);
}

if (!dryRun && hasSuccessfulDeployOutput(result.output)) {
  console.warn('[deploy] Wrangler returned non-zero, but deploy success markers were present. Normalizing exit code to 0.');
  process.exit(0);
}

process.exit(result.code || 1);
