import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  { dir: 'scripts', ext: '.mjs' },
  { dir: 'src', ext: '.js' },
  { dir: path.join('public', 'static'), ext: '.js' },
  { dir: 'tests', ext: '.mjs' },
];
const ROOT_JS_FILES = ['public/service-worker.js'];

function collectFiles(relativeDir, extension) {
  const absoluteDir = path.join(rootDir, relativeDir);
  const files = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && absolutePath.endsWith(extension)) {
        files.push(absolutePath);
      }
    }
  }

  if (statSync(absoluteDir, { throwIfNoEntry: false })?.isDirectory()) {
    walk(absoluteDir);
  }

  return files;
}

const files = targets
  .flatMap((target) => collectFiles(target.dir, target.ext))
  .concat(
    ROOT_JS_FILES
      .map((file) => path.join(rootDir, file))
      .filter((file) => statSync(file, { throwIfNoEntry: false })?.isFile())
  )
  .sort((left, right) => left.localeCompare(right));

for (const file of files) {
  const relativePath = path.relative(rootDir, file).replaceAll(path.sep, '/');
  console.log(`node --check ${relativePath}`);
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
