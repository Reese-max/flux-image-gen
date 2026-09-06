// Sync the canonical frontend (app/static) into the Cloudflare deploy copy.
//
// Source of truth: app/static/. JavaScript deploy copies are minified so the
// public page stays below its transfer budget without sacrificing readable
// FastAPI source files.
// Deploy copy:
//   - index.html / manifest.webmanifest / service-worker.js
//                                  -> cloudflare/public/<file>          (root scope ONLY)
//   - every other app/static/<file> -> cloudflare/public/static/<file>
//
// Usage:
//   node scripts/sync-static.mjs           Copy any out-of-date files, report changes.
//   node scripts/sync-static.mjs --check   Verify only; exit 1 if anything is out of sync.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const cloudflareDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(cloudflareDir, '..', 'app', 'static');
const publicDir = path.join(cloudflareDir, 'public');
const publicStaticDir = path.join(publicDir, 'static');

// Files served from the public/ root ONLY (never duplicated into public/static):
// index.html (entry point), manifest.webmanifest + service-worker.js (root-scope PWA).
// This list must match `rootAssets` in tests/worker-transform.test.mjs.
const ROOT_SCOPE_FILES = new Set(['index.html', 'manifest.webmanifest', 'service-worker.js']);

const checkOnly = process.argv.includes('--check');

function listRelativeFiles(root) {
  const files = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function listSourceFiles() {
  return listRelativeFiles(sourceDir);
}

// Returns the list of destination absolute paths a given source file maps to.
// Root-scope files go to public/ only; everything else goes to public/static/ only.
function destinationsFor(relativePath) {
  if (ROOT_SCOPE_FILES.has(relativePath)) {
    return [path.join(publicDir, relativePath)];
  }
  return [path.join(publicStaticDir, relativePath)];
}

function deployContent(relativePath, sourcePath) {
  const source = readFileSync(sourcePath);
  if (!ROOT_SCOPE_FILES.has(relativePath) && relativePath.endsWith('.js')) {
    return Buffer.from(transformSync(source.toString('utf8'), {
      loader: 'js',
      minify: true,
      target: 'es2018',
    }).code);
  }
  return source;
}

function isUpToDate(expected, destPath) {
  if (!statSync(destPath, { throwIfNoEntry: false })?.isFile()) {
    return false;
  }
  const destContent = readFileSync(destPath);
  if (expected.equals(destContent)) {
    return true;
  }
  return expected.toString('utf8').replace(/\r\n/g, '\n') === destContent.toString('utf8').replace(/\r\n/g, '\n');
}

function relative(absolutePath) {
  return path.relative(cloudflareDir, absolutePath).replaceAll(path.sep, '/');
}

const sourceFiles = listSourceFiles();
const expectedStaticFiles = new Set(sourceFiles.filter((relativePath) => !ROOT_SCOPE_FILES.has(relativePath)));
const outOfSync = [];
let copied = 0;
let removed = 0;

for (const relativePath of sourceFiles) {
  const sourcePath = path.join(sourceDir, relativePath);
  const expected = deployContent(relativePath, sourcePath);
  for (const destPath of destinationsFor(relativePath)) {
    if (isUpToDate(expected, destPath)) {
      continue;
    }
    if (checkOnly) {
      outOfSync.push(relative(destPath));
      continue;
    }
    mkdirSync(path.dirname(destPath), { recursive: true });
    writeFileSync(destPath, expected);
    console.log(`synced ${relative(destPath)}`);
    copied += 1;
  }
}

for (const relativePath of listRelativeFiles(publicStaticDir)) {
  if (expectedStaticFiles.has(relativePath)) {
    continue;
  }
  const stalePath = path.join(publicStaticDir, relativePath);
  if (checkOnly) {
    outOfSync.push(`${relative(stalePath)} (stale)`);
    continue;
  }
  unlinkSync(stalePath);
  console.log(`removed stale ${relative(stalePath)}`);
  removed += 1;
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
  if (copied === 0 && removed === 0) {
    console.log('[sync-static] Already in sync.');
  } else {
    console.log(`[sync-static] Synced ${copied} file(s), removed ${removed} stale file(s).`);
  }
}
