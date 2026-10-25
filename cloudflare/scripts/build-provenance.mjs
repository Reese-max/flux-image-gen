// Reproducible local SDK assets. The browser never contacts a CDN or verifier.
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
export function provenanceAssets() {
  const pkg = path.dirname(require.resolve('@contentauth/c2pa-web/package.json'));
  const bundle = entry => buildSync({ entryPoints: [entry], bundle: true, format: 'esm',
    platform: 'browser', target: 'es2020', minify: true, write: false, legalComments: 'eof' }).outputFiles[0].contents;
  return new Map([
    ['vendor/c2pa-web.js', Buffer.from(bundle(require.resolve('@contentauth/c2pa-web')))],
    ['vendor/c2pa-worker.js', Buffer.from(bundle(require.resolve('@contentauth/c2pa-web/c2pa_worker')))],
    ['vendor/c2pa.wasm', readFileSync(require.resolve('@contentauth/c2pa-web/resources/c2pa.wasm'))],
    ['vendor/C2PA-LICENSE.txt', readFileSync(path.join(pkg, 'LICENSE'))],
  ]);
}
