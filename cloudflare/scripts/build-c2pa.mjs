import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const cloudflareDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(cloudflareDir, '..');
const packagePath = path.join(cloudflareDir, 'node_modules', '@contentauth', 'c2pa-web', 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const expectedVersion = '0.14.4';
if (packageJson.version !== expectedVersion) {
  throw new Error(`Expected @contentauth/c2pa-web ${expectedVersion}, found ${packageJson.version}`);
}

const staticDir = path.join(repoDir, 'app', 'static');
mkdirSync(staticDir, { recursive: true });
await build({
  entryPoints: [path.join(cloudflareDir, 'src', 'c2pa-entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2018',
  outfile: path.join(staticDir, 'c2pa-web.js'),
  legalComments: 'none',
});

copyFileSync(
  path.join(cloudflareDir, 'node_modules', '@contentauth', 'c2pa-web', 'dist', 'resources', 'c2pa_bg.wasm'),
  path.join(staticDir, 'c2pa_bg.wasm'),
);
copyFileSync(
  path.join(cloudflareDir, 'node_modules', '@contentauth', 'c2pa-web', 'dist', 'c2pa_worker.js'),
  path.join(staticDir, 'c2pa-worker.js'),
);
console.log(`[build-c2pa] bundled @contentauth/c2pa-web@${expectedVersion} and copied the matching WASM/worker assets`);
