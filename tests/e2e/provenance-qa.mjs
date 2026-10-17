import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(path.join(root, 'cloudflare/package.json'))('playwright');
const publicDir = path.join(root, 'cloudflare/public');
const fixtureDir = path.join(root, 'cloudflare/tests/fixtures/c2pa');
const csp = fs.readFileSync(path.join(publicDir, '_headers'), 'utf8')
  .match(/^\s*Content-Security-Policy:\s*(.+)$/m)[1];
const fixture = (name) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(fixtureDir, name)).toString('base64');
const signed = fixture('C_with_CAWG_data.jpg');
const absent = fixture('C_with_CAWG_data_thumbnail.jpg');
const invalid = fixture('no_alg.jpg');
let providerInputHash;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('aiImageTutorialSeen.v1', 'true'));
  // Serve the deploy copy under HTTPS with its real CSP; no provider or third-party requests.
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://provenance.test') return route.abort();
    if (url.pathname === '/api/health') return route.fulfill({ json: {
      providerStatus: 'demo', providerList: ['workers-ai'], providers: { workersAI: true },
      turnstile: { required: false },
    } });
    if (url.pathname === '/edit') {
      const request = route.request();
      const form = await new Request(url, {
        method: 'POST', headers: request.headers(), body: request.postDataBuffer(),
      }).formData();
      providerInputHash = createHash('sha256').update(Buffer.from(await form.get('images').arrayBuffer())).digest('hex');
      return route.fulfill({ json: {
        image: absent, provider: 'workers-ai', model: '@cf/black-forest-labs/flux-2-klein-4b',
      } });
    }
    const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.css': 'text/css' }[path.extname(file)];
    await route.fulfill({ path: file, contentType, headers: { 'content-security-policy': csp } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto('https://provenance.test/');
  const credentials = await page.evaluate(async ({ signed, absent, invalid }) => {
    const helper = window.ProvenanceReceipt;
    return Promise.all([signed, absent, invalid].map(async (image) => (await helper.inspectCredential(image)).status));
  }, { signed, absent, invalid });
  assert.deepEqual(credentials, ['present_untrusted', 'absent', 'invalid'], 'real C2PA fixtures under deployment CSP');

  const anchors = fs.readFileSync(path.join(fixtureDir, 'anchor-correct.pem'), 'utf8');
  const trusted = await page.evaluate(async ({ image, anchors }) => (
    await window.ProvenanceReceipt.inspectCredential(image, {
      settings: { verify: { verifyTrust: true }, trust: { trustAnchors: anchors }, cawgTrust: { verifyTrustList: false } },
    })
  ).status, { image: signed, anchors });
  assert.equal(trusted, 'verified', 'test-only trust anchor validates the signed fixture');

  await page.evaluate((image) => document.dispatchEvent(new CustomEvent('imagegen:generated', { detail: {
    id: 'fixture-download', image, prompt: 'local fixture', provider: 'demo',
  } })), signed);
  await page.waitForFunction(() => window.ImageHistoryStore.loadRecords().some((record) => record.id === 'fixture-download'));
  await page.evaluate(() => window.ImageHistoryWall.openHistoryDetail(window.ImageHistoryStore.loadRecords()[0]));
  const downloadReady = page.waitForEvent('download');
  await page.locator('#downloadHistoryDetail').click();
  const download = await downloadReady;
  const downloaded = fs.readFileSync(await download.path());
  const original = fs.readFileSync(path.join(fixtureDir, 'C_with_CAWG_data.jpg'));
  assert.deepEqual(downloaded, original, 'download preserves the complete signed image');
  await page.locator('#closeHistoryDetail').click();

  await page.evaluate(() => window.showTab('edit'));
  await page.locator('#editFiles').setInputFiles(path.join(fixtureDir, 'C_with_CAWG_data.jpg'));
  await page.waitForFunction(() => document.querySelectorAll('#editThumbs img').length === 1);
  await page.locator('#editPrompt').fill('Change the background');
  await page.locator('#editGo').click();
  await page.waitForFunction(() => window.ImageHistoryStore.loadRecords().some((record) => record.provenanceReceipt.operation === 'edit'));
  const edited = await page.evaluate(() => window.ImageHistoryStore.loadRecords().find((record) => record.provenanceReceipt.operation === 'edit'));
  assert.equal(edited.provenanceReceipt.credential_status, 'unknown_after_transform');
  assert.deepEqual(edited.provenanceReceipt.original_input_image_hashes, [createHash('sha256').update(original).digest('hex')]);
  assert.deepEqual(edited.provenanceReceipt.input_image_hashes, [providerInputHash]);
  assert.notEqual(edited.provenanceReceipt.input_image_hashes[0], edited.provenanceReceipt.original_input_image_hashes[0]);
  assert.equal(edited.createdAt, edited.provenanceReceipt.created_at);
  console.log('[provenance-qa] 6 checks passed: CSP fixtures, trusted fixture, byte-preserving download, real edit receipt, input hash domains, timestamp');
} finally {
  await browser.close();
}
