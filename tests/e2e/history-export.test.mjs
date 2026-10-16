import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(path.join(rootDir, 'cloudflare/package.json'))('playwright');
const origin = 'http://history-export.test';
const records = [
  {
    id: 'export-1',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    prompt: '雨夜的貓', providerPrompt: 'A cat on a rainy night', negativePrompt: 'blur',
    model: 'dev', size: 'portrait', seed: 123, steps: 45, cfgScale: 4,
    width: 768, height: 1344, provider: 'demo', createdAt: '2026-10-01T12:00:00Z',
    tags: ['測試'], favorite: true, versionGroupId: 'group-1', versionNumber: 2,
    sourceRecordId: 'export-0'
  },
  { id: 'export-2', image: 'data:image/png;base64,cG5n', prompt: '森林', seed: 456, createdAt: '2026-10-01T11:00:00Z' }
];
const mime = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp'
};
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

for (const variant of ['source', 'minified']) {
  for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
    test(`${variant} JSON downloads at ${viewport.width}px`, { timeout: 30000 }, async (t) => {
      const context = await browser.newContext({ viewport, acceptDownloads: true, serviceWorkers: 'block' });
      t.after(() => context.close());
      const unexpectedRequests = [];
      const pageErrors = [];
      const downloads = [];
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname === '/api/health') {
          await route.fulfill({ json: { provider: 'demo', providers: { workersAI: false }, turnstile: { required: false } } });
          return;
        }
        const staticDir = path.join(rootDir, variant === 'source' ? 'app/static' : 'cloudflare/public');
        const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\//, '');
        const file = path.resolve(staticDir, variant === 'source' ? relative.replace(/^static\//, '') : relative);
        if (url.origin !== origin || request.method() !== 'GET' || !file.startsWith(staticDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          unexpectedRequests.push(request.method() + ' ' + url.pathname);
          await route.abort();
          return;
        }
        await route.fulfill({ body: fs.readFileSync(file), contentType: mime[path.extname(file)] || 'application/octet-stream' });
      });
      await context.addInitScript((items) => {
        localStorage.setItem('aiImageGenerationHistory.v1', JSON.stringify(items));
      }, records);
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('download', (download) => downloads.push(download));
      await page.goto(origin, { waitUntil: 'networkidle' });
      if (await page.locator('#tutorialModal:not([hidden])').count()) await page.click('#closeTutorial');
      await page.click('#tab-history');
      assert.equal(await page.locator('.history-card').count(), records.length);
      const originalStorage = await page.evaluate(() => localStorage.getItem(ImageHistoryStore.STORAGE_KEY));
      const expected = await page.evaluate(() => ImageHistoryStore.loadRecords());

      async function downloadJson(selector, filename) {
        page.once('dialog', (dialog) => dialog.accept());
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 5000 }),
          page.click(selector)
        ]);
        assert.match(download.suggestedFilename(), filename);
        assert.equal(await download.failure(), null);
        const bytes = fs.readFileSync(await download.path());
        assert.ok(bytes.length > 0, 'download must contain JSON bytes');
        await page.waitForFunction(() => !document.getElementById('appToast').hidden && document.getElementById('appToast').textContent.includes('已匯出'));
        return JSON.parse(bytes.toString('utf8'));
      }

      async function checkCancelAndFailure(selector) {
        const before = downloads.length;
        page.once('dialog', (dialog) => dialog.dismiss());
        await page.click(selector);
        await page.waitForFunction(() => !document.getElementById('appToast').hidden && document.getElementById('appToast').textContent.includes('已取消匯出'));
        await page.waitForTimeout(300);
        assert.equal(downloads.length, before, 'cancelled export must not emit a delayed download');
        await page.evaluate(() => {
          window.savedExportUrlFactory = URL.createObjectURL;
          URL.createObjectURL = () => { throw new Error('synthetic export failure'); };
        });
        page.once('dialog', (dialog) => dialog.accept());
        await page.click(selector);
        await page.waitForFunction(() => !document.getElementById('appToast').hidden && document.getElementById('appToast').textContent.includes('匯出 JSON 失敗'));
        await page.evaluate(() => { URL.createObjectURL = window.savedExportUrlFactory; });
        await page.waitForTimeout(300);
        assert.equal(downloads.length, before, 'failed export must not emit a delayed download');
      }

      await page.locator('.history-card').first().click();
      const single = await downloadJson('#exportHistoryJson', /^history_export-1\.json$/);
      assert.deepEqual(single, expected[0], 'single download must preserve prompt, settings and metadata');
      await checkCancelAndFailure('#exportHistoryJson');
      await page.click('#closeHistoryDetail');
      await page.fill('#historySearch', '雨夜');
      assert.equal(await page.locator('.history-card').count(), 1);
      const backup = await downloadJson('#exportAllHistoryJson', /^history_backup_.*\.json$/);
      assert.equal(backup.schema, 'GenerationRecordCollection');
      assert.equal(backup.version, 2);
      assert.deepEqual(backup.records, expected, 'backup must include records hidden by the active filter');
      const restored = await page.evaluate((payload) => {
        let saved;
        const storage = { getItem: () => saved, setItem: (key, value) => { saved = value; } };
        ImageHistoryStore.saveRecords(ImageHistoryStore.parseRecords(JSON.stringify(payload)), storage);
        return ImageHistoryStore.loadRecords(storage);
      }, backup);
      assert.deepEqual(restored, expected, 'downloaded backup must restore through parse/save/load');
      await checkCancelAndFailure('#exportAllHistoryJson');
      assert.equal(await page.evaluate(() => localStorage.getItem(ImageHistoryStore.STORAGE_KEY)), originalStorage);
      assert.equal(downloads.length, 2, 'cancelled and failed exports must not download');
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(unexpectedRequests, [], 'fixture must not reach a provider or use missing/wrong asset routes');
      const outputDir = path.join(rootDir, 'output/playwright');
      fs.mkdirSync(outputDir, { recursive: true });
      await page.screenshot({ path: path.join(outputDir, `history-export-${variant}-${viewport.width}.png`) });
      t.diagnostic('2 real JSON downloads; payloads, filtered backup, restore, cancellation and failure feedback verified');
    });
  }
}
