// Sync the canonical frontend (app/static) into the Cloudflare deploy copy.
//
// Source of truth: app/static/
// Deploy copy:
//   - app/static/<file>            -> cloudflare/public/static/<file>   (all except index.html)
//   - index.html / manifest.webmanifest / service-worker.js
//                                  -> cloudflare/public/<file>          (root scope)
//
// Usage:
//   node scripts/sync-static.mjs           Copy any out-of-date files, report changes.
//   node scripts/sync-static.mjs --check   Verify only; exit 1 if anything is out of sync.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cloudflareDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(cloudflareDir, '..', 'app', 'static');
const publicDir = path.join(cloudflareDir, 'public');
const publicStaticDir = path.join(publicDir, 'static');

// Files that must also live at the public/ root for correct serving:
// index.html (entry point), manifest.webmanifest + service-worker.js (root-scope PWA).
const ROOT_SCOPE_FILES = new Set(['index.html', 'manifest.webmanifest', 'service-worker.js']);

const checkOnly = process.argv.includes('--check');

function listSourceFiles() {
  return readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

// Returns the list of destination absolute paths a given source file maps to.
function destinationsFor(fileName) {
  const destinations = [];
  if (fileName !== 'index.html') {
    destinations.push(path.join(publicStaticDir, fileName));
  }
  if (ROOT_SCOPE_FILES.has(fileName)) {
    destinations.push(path.join(publicDir, fileName));
  }
  return destinations;
}

function isUpToDate(sourcePath, destPath) {
  if (!statSync(destPath, { throwIfNoEntry: false })?.isFile()) {
    return false;
  }
  return readFileSync(sourcePath).equals(readFileSync(destPath));
}

function relative(absolutePath) {
  return path.relative(cloudflareDir, absolutePath).replaceAll(path.sep, '/');
}

const outOfSync = [];
let copied = 0;

for (const fileName of listSourceFiles()) {
  const sourcePath = path.join(sourceDir, fileName);
  for (const destPath of destinationsFor(fileName)) {
    if (isUpToDate(sourcePath, destPath)) {
      continue;
    }
    if (checkOnly) {
      outOfSync.push(relative(destPath));
      continue;
    }
    mkdirSync(path.dirname(destPath), { recursive: true });
    writeFileSync(destPath, readFileSync(sourcePath));
    console.log(`synced ${relative(destPath)}`);
    copied += 1;
  }
}

if (checkOnly) {
  if (outOfSync.length > 0) {
    console.error(`[sync-static] OUT OF SYNC (${outOfSync.length}):`);
    for (const file of outOfSync) {
      console.error(`  - ${file}`);
    }
    console.error('[sync-static] Run "npm run sync" to update the Cloudflare copy.');
    process.exit(1);
  }
  console.log('[sync-static] Cloudflare copy is in sync with app/static.');
} else {
  console.log(copied === 0 ? '[sync-static] Already in sync.' : `[sync-static] Synced ${copied} file(s).`);
}
