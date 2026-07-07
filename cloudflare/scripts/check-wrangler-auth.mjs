import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const verbose = process.argv.includes('--verbose');
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);

function redactOutput(text) {
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b[0-9a-f]{32}\b/gi, '[redacted-account-id]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted-token]');
}

function run(command, args, useShell = false) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      shell: useShell,
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      if (verbose) {
        process.stdout.write(redactOutput(text));
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      if (verbose) {
        process.stderr.write(redactOutput(text));
      }
    });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function wranglerCommand(extraArgs) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return {
      command: process.execPath,
      args: [npmCli, 'exec', '--', 'wrangler'].concat(extraArgs),
      shell: false,
    };
  }
  return {
    command: 'npx',
    args: ['wrangler'].concat(extraArgs),
    shell: process.platform === 'win32',
  };
}

function hasWhoamiSuccess(output) {
  return /You are logged in/i.test(output)
    || /Account Name/i.test(output)
    || /Account ID/i.test(output)
    || /User ID/i.test(output);
}

function hasConfigSuccess(output) {
  return /Total Upload:/i.test(output)
    || /Your Worker has access to the following bindings/i.test(output)
    || /--dry-run:\s+exiting now\./i.test(output)
    || /assets directory/i.test(output);
}

function isLikelyCrashExit(code) {
  return typeof code === 'number' && (code < 0 || code > 255);
}

function formatExitCode(code) {
  return typeof code === 'number' ? String(code) : 'unknown';
}

async function runWrangler(extraArgs) {
  const invocation = wranglerCommand(extraArgs);
  return run(invocation.command, invocation.args, invocation.shell);
}

const failures = [];

console.log('[wrangler-check] Checking Wrangler login with "wrangler whoami"...');
const whoami = await runWrangler(['whoami']);
if (whoami.code !== 0 || !hasWhoamiSuccess(whoami.output)) {
  failures.push('Wrangler whoami 未確認登入狀態。請執行 `npx wrangler login`，或在 CI 設定有效的 CLOUDFLARE_API_TOKEN。');
} else {
  console.log('[wrangler-check] Wrangler login verified. Account details are redacted by default; rerun with --verbose for sanitized command output.');
}

console.log('[wrangler-check] Checking deploy configuration with "wrangler deploy --dry-run"...');
const dryRun = await runWrangler(['deploy', '--dry-run']);
if (dryRun.code !== 0 || !hasConfigSuccess(dryRun.output)) {
  let message = 'Wrangler deploy --dry-run 未跑到可驗證輸出。';
  if (isLikelyCrashExit(dryRun.code) || /Assertion failed|UV_HANDLE_CLOSING|CommandLineArgsError/i.test(dryRun.output)) {
    message += ` 偵測到 Wrangler / Node 子程序可能 crash（exit ${formatExitCode(dryRun.code)}，Node ${process.version}）。請先切到 Node 20 或 22 LTS 後重跑，再檢查 Cloudflare 帳號權限與 binding。`;
  } else if (nodeMajor > 22) {
    message += ` 目前 Node ${process.version} 高於 Wrangler 公開部署建議的 LTS 範圍；請先切到 Node 20 或 22 LTS 後重跑。`;
  } else {
    message += ' 請確認 Cloudflare 帳號、權限、wrangler.toml、R2 bucket、AI binding 與 rate limit binding。';
  }
  failures.push(message);
} else {
  console.log('[wrangler-check] Wrangler deploy --dry-run output verified.');
}

if (failures.length) {
  console.error('[wrangler-check] FAIL');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  if (!verbose) {
    console.error('[wrangler-check] Raw Wrangler output was hidden to avoid leaking account details. Rerun with `npm run check:wrangler -- --verbose` for sanitized output.');
  }
  process.exit(1);
}

console.log('[wrangler-check] PASS: Wrangler login and dry-run configuration are verifiable.');
