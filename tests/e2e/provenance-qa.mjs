// Offline integration: real C2PA binaries and browser, real Worker handlers,
// fixture-backed AI and in-memory R2. Never calls a billable provider or verifier.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import worker from '../../cloudflare/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(path.join(root, 'cloudflare/package.json'))('playwright');
const fixtureDir = path.join(root, 'tests/fixtures/provenance');
const fixture = readFileSync(path.join(fixtureDir, 'C.jpg'));
const fixtureUrl = 'data:image/jpeg;base64,' + fixture.toString('base64');
const absent = 'data:image/jpeg;base64,' + readFileSync(path.join(fixtureDir, 'absent.jpg')).toString('base64');
const anchors = readFileSync(path.join(fixtureDir, 'fixture-root.pem'), 'utf8');
const csp = readFileSync(path.join(root, 'cloudflare/public/_headers'), 'utf8').match(/Content-Security-Policy: (.+)/)[1];

test('real C2PA fixtures and generation/edit/share/download/export roundtrip in Chromium', { timeout: 90000 }, async () => {
  const objects = new Map();
  let aiCalls = 0;
  const env = {
    ENVIRONMENT: 'development', // Explicit fixture mode; missing production controls remain fail-closed.
    AI: { async run() { aiCalls++; return { image: fixture.toString('base64') }; } },
    GALLERY_TOKEN_SECRET: 'offline-runtime-fixture-only',
    IMAGE_BUCKET: {
      async put(key, value, options) { objects.set(key, { value, ...options }); },
      async list() { return { objects: [], truncated: false }; },
      async get(key) { const item = objects.get(key); return item && { body: item.value, httpMetadata: item.httpMetadata, text: async () => item.value }; }
    }
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/static/'))) {
        const base = path.join(root, 'app/static');
        const file = path.resolve(base, url.pathname === '/' ? 'index.html' : url.pathname.slice(8));
        if (!file.startsWith(base + path.sep) || !existsSync(file)) { res.writeHead(404).end(); return; }
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream';
        // Local HTTP uses the SDK inline worker; deployed HTTPS uses the self-hosted module worker.
        res.writeHead(200, { 'content-type': type, 'content-security-policy': csp.replace("worker-src 'self'", "worker-src 'self' blob:") });
        res.end(readFileSync(file));
        return;
      }
      if (url.pathname === '/service-worker.js' || url.pathname === '/manifest.webmanifest') { res.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method,
        headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('Offline test server error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript(() => localStorage.setItem('aiImageTutorialSeen.v1', 'true'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const outgoing = [];
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) { outgoing.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    await page.goto(origin);
    await page.evaluate(() => { const modal = document.querySelector('#tutorialModal'); if (modal && !modal.hidden) document.querySelector('#finishTutorial').click(); });
    const inspection = await page.evaluate(async ({ fixtureUrl, absent, anchors }) => {
      const api = ImageProvenance;
      const blob = api.imageBlob(fixtureUrl);
      const valid = await C2paInspector.inspect(blob);
      const trusted = await C2paInspector.inspect(blob, { trustAnchors: anchors });
      const missing = await C2paInspector.inspect(api.imageBlob(absent));
      const img = new Image();
      img.src = fixtureUrl;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const stripped = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
      const strippedStatus = await api.inspectCredentials(stripped, { transformed: true });
      const raw = new Uint8Array(await blob.arrayBuffer());
      // Alter entropy bytes after SOS, preserving the embedded manifest and JPEG structure.
      let sos = -1;
      for (let i = 2; i < raw.length - 3; i++) if (raw[i] === 255 && raw[i + 1] === 218) { sos = i; break; }
      raw[sos + 100] ^= 1;
      const invalid = await C2paInspector.inspect(new Blob([raw], { type: 'image/jpeg' }));
      return { valid, trusted, missing, strippedStatus, invalid };
    }, { fixtureUrl, absent, anchors });
    assert.equal(inspection.valid.status, 'present_untrusted', JSON.stringify(inspection));
    assert.equal(inspection.trusted.status, 'verified', JSON.stringify(inspection));
    assert.equal(inspection.missing.status, 'absent');
    assert.equal(inspection.strippedStatus.status, 'unknown_after_transform');
    assert.equal(inspection.invalid.status, 'invalid');

    await page.locator('#plainPrompt').fill('Private cat artwork');
    await page.evaluate(() => { document.querySelector('#advancedSettings').open = true; });
    // The hidden model select is restored through the app's existing history/settings API.
    await page.evaluate(() => ImageGenApp.setGenerationSettings({ model: 'schnell' }));
    assert.equal(await page.locator('#model').inputValue(), 'schnell');
    await page.locator('#prompt').fill('a cat in a garden');
    await page.locator('#go').click();
    await page.waitForFunction(() => ImageHistoryStore.loadRecords().length === 1 && ImageHistoryStore.loadRecords()[0].provenance?.receipt_sha256, null, { timeout: 15000 });
    const parent = await page.evaluate(() => ImageHistoryStore.loadRecords()[0]);
    assert.equal(parent.provenance.credential.status, 'present_untrusted');
    assert.equal(parent.provenance.record_id, parent.id);
    assert.equal((await page.evaluate(item => ImageProvenance.verifyReceipt(item), parent)).status, 'hash_verified');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#dl').click();
    const download = await downloadPromise;
    assert.deepEqual(readFileSync(await download.path()), fixture, 'original download must preserve embedded C2PA bytes');

    await page.locator('#tab-history').click();
    await page.evaluate(item => ImageHistoryWall.openHistoryDetail(item), parent);
    await page.locator('#historyDetailProvenance').filter({ hasText: 'hash verified' }).waitFor();
    const exportPromise = page.waitForEvent('download');
    await page.locator('#exportHistoryJson').click();
    const artwork = JSON.parse(readFileSync(await (await exportPromise).path(), 'utf8'));
    assert.doesNotMatch(JSON.stringify(artwork), /Private cat artwork|a cat in a garden|deleteToken/);
    assert.equal(artwork.provenance.receipt_sha256, parent.provenance.receipt_sha256);
    const imported = await page.evaluate(artwork => ImageProvenance.verifyReceipt(ImageHistoryStore.parseRecords(JSON.stringify(artwork))[0]), artwork);
    assert.equal(imported.status, 'hash_verified');
    await page.locator('#closeHistoryDetail').click();

    // Actual edit UI: original credentials are inspected before canvas strips metadata.
    await page.locator('#tab-edit').click();
    await page.locator('#editFiles').setInputFiles(path.join(fixtureDir, 'C.jpg'));
    await page.waitForFunction(() => document.querySelectorAll('.edit-thumb').length === 1);
    await page.locator('#editPrompt').fill('Make the scene blue');
    await page.locator('#editGo').click();
    await page.waitForFunction(() => ImageHistoryStore.loadRecords().length === 2 && ImageHistoryStore.loadRecords()[0].provenance?.receipt_sha256, null, { timeout: 15000 });
    const child = await page.evaluate(() => ImageHistoryStore.loadRecords()[0]);
    assert.equal(child.provenance.settings.mode, 'edit');
    assert.equal(child.sourceRecordId, parent.id);
    assert.equal(child.versionNumber, 2);
    assert.equal(child.provenance.parent_receipt_sha256, parent.provenance.receipt_sha256);
    assert.equal(child.provenance.inputs[0].original_sha256, parent.provenance.output_sha256);
    assert.equal(child.provenance.inputs[0].credential_status, 'unknown_after_transform');
    assert.notEqual(child.provenance.inputs[0].submitted_sha256, parent.provenance.output_sha256);
    assert.equal(aiCalls, 2, 'receipt inspection must never replay billable generation/edit');

    const sharing = await page.evaluate(async item => {
      const generated = await fetch('/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a cat', model: 'schnell', size: 'square', seed: 42 }) }).then(r => r.json());
      const response = await fetch('/gallery', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gallery-token': generated.galleryToken },
        body: JSON.stringify({ image: item.image, meta: { promptPublic: false, prompt: item.prompt, provenance: item.provenance } }) });
      const saved = await response.json();
      const bytes = await fetch(saved.url).then(r => r.blob());
      const html = await fetch(saved.shareUrl).then(r => r.text());
      return { status: response.status, output: await ImageProvenance.sha256(bytes), html };
    }, parent);
    assert.equal(sharing.status, 201);
    assert.equal(sharing.output, parent.provenance.output_sha256);
    assert.match(sharing.html, /來源與驗證/);
    assert.doesNotMatch(sharing.html, /Private cat artwork|a cat in a garden/);
    assert.deepEqual(errors, []);
    assert.equal(outgoing.filter(url => !url.includes('huggingface.co')).length, 0, 'C2PA checks must remain local');
    const pending = await page.evaluate(({ image }) => {
      C2paInspector.inspect = () => new Promise(() => {});
      for (const [id, output] of [['cold-pending', image], ['remote-output', 'https://provider.example/image?token=private']]) {
        document.dispatchEvent(new CustomEvent('imagegen:generated', { detail: {
          id, image: output, prompt: 'preserve on reload', provider: 'nvidia', model: 'dev',
          createdAt: new Date().toISOString()
        } }));
      }
      return ImageHistoryStore.loadRecords().filter(item => ['cold-pending', 'remote-output'].includes(item.id));
    }, { image: fixtureUrl });
    assert.equal(pending.length, 2, 'successful images must be saved synchronously before optional C2PA inspection');
    assert.ok(pending.every(item => item.provenance?.credential.status === 'unsupported'));
    await page.reload();
    assert.equal(await page.evaluate(() => ImageHistoryStore.loadRecords().filter(item => ['cold-pending', 'remote-output'].includes(item.id)).length), 2);
    await page.waitForFunction(() => ImageHistoryStore.loadRecords().find(item => item.id === 'cold-pending')?.provenance?.receipt_sha256, null, { timeout: 5000 });
    console.log('[provenance-qa] valid, trusted, absent, invalid, stripped; generation/edit/parent/share/download/private export/import and cold reload PASS');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
