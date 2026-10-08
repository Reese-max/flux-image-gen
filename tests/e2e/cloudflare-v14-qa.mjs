import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// Full deployed QA: npm --prefix cloudflare run qa:browser -- <target URL>
// Offline source/deploy JSON acceptance: npm --prefix cloudflare run qa:history-exports
// Negative controls (expected failure): append --disable-history-download,
// --invalid-history-asset-route, or --delayed-cancel-download to the offline command.

function loadPlaywright() {
  const cloudflarePackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cloudflare/package.json');
  if (fs.existsSync(cloudflarePackage)) return createRequire(cloudflarePackage)('playwright');
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire('playwright');
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter);
  for (const entry of pathEntries) {
    const normalized = entry.replace(/[\\/]+$/, '');
    const binName = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
    const binPath = path.join(normalized, binName);
    const packagePath = path.resolve(normalized, '..', 'playwright', 'package.json');
    if (fs.existsSync(binPath) && fs.existsSync(packagePath)) {
      return createRequire(packagePath)('playwright');
    }
  }

  throw new Error(
    'Cannot load Playwright. Run from cloudflare with `npm run qa:browser`, or install it with `npm install --save-dev playwright`.'
  );
}

const { chromium } = loadPlaywright();

const targetUrl = process.argv[2] || 'https://flux-image-gen.irisx-tracker.workers.dev';
const screenshotPath = path.resolve(
  process.argv[3] || 'output/playwright/cloudflare-v14-qa.png'
);
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const checks = [];
const errors = [];

function ok(name, condition, detail = '') {
  if (!condition) {
    throw new Error(name + (detail ? ': ' + detail : ''));
  }
  checks.push(name + (detail ? ' — ' + detail : ''));
}

async function closeTutorialIfOpen(page) {
  if (await page.locator('#tutorialModal:not([hidden])').count()) {
    await page.click('#closeTutorial');
    await page.waitForSelector('#tutorialModal[hidden]', { state: 'attached', timeout: 10000 });
  }
}

async function main() {
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push('console: ' + msg.text());
    }
  });

  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
  ok('首頁載入', await page.locator('#promptEnhancer').count() === 1);
  ok('Manifest link 存在', await page.locator('link[rel="manifest"][href="/manifest.webmanifest"]').count() === 1);
  await closeTutorialIfOpen(page);
  checks.push('首次教學 modal 可關閉');

  await page.evaluate(() => {
    const prompt = document.querySelector('#prompt');
    if (!prompt) return;
    prompt.value = 'a cat portrait';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.dispatchEvent(new Event('change', { bubbles: true }));
  });
  ok(
    '效果優化欄位存在',
    (await page.locator('#effectPrompt').count()) === 1 && (await page.locator('#applyEffect').count()) === 1
  );
  // 效果優化改為 Gemini 後端，改寫結果視部署金鑰而定；此處只驗證控制項可觸發，不斷言輸出內容。
  await page.evaluate(() => {
    const effect = document.querySelector('#effectPrompt');
    if (!effect) return;
    effect.value = '更夢幻';
    effect.dispatchEvent(new Event('input', { bubbles: true }));
    effect.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => document.querySelector('#applyEffect')?.click());

  await page.evaluate((tinyPngValue) => {
    const records = [
      {
        id: 'qa-v2',
        image: tinyPngValue,
        thumbnail: tinyPngValue,
        prompt: 'qa robot portrait',
        providerPrompt: 'qa robot portrait, cinematic lighting, film still',
        model: 'dev',
        size: 'portrait',
        seed: 222,
        steps: 10,
        cfgScale: 3,
        provider: 'qa-demo',
        createdAt: '2026-06-25T19:00:00.000Z',
        favorite: false,
        tags: ['qa', 'robot'],
        sourceRecordId: 'qa-v1',
        versionGroupId: 'qa-group',
        versionNumber: 2,
      },
      {
        id: 'qa-v1',
        image: tinyPngValue,
        thumbnail: tinyPngValue,
        prompt: 'qa cat portrait',
        providerPrompt: 'qa cat portrait, clean composition',
        model: 'schnell',
        size: 'square',
        seed: 111,
        provider: 'qa-demo',
        createdAt: '2026-06-25T18:59:00.000Z',
        favorite: false,
        tags: ['qa', 'cat'],
        sourceRecordId: '',
        versionGroupId: 'qa-group',
        versionNumber: 1,
      },
    ];
    localStorage.setItem('aiImageGenerationHistory.v1', JSON.stringify(records));
  }, tinyPng);
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
  await closeTutorialIfOpen(page);
  await page.evaluate(() => window.showTab && window.showTab('history'));
  await page.waitForFunction(() => document.body.getAttribute('data-tab') === 'history', { timeout: 10000 });
  await page.waitForSelector('.history-card', { timeout: 15000 });
  ok('歷史牆載入 localStorage cards', await page.locator('.history-card').count() === 2);

  await page.click('.history-card-favorite');
  ok('收藏星號 click', (await page.locator('.history-card-favorite').first().getAttribute('aria-pressed')) === 'true');

  await page.fill('#historySearch', 'robot');
  await page.waitForTimeout(250);
  ok('歷史搜尋 prompt/tag', await page.locator('.history-card').count() === 1);
  await page.fill('#historySearch', '');
  await page.selectOption('#historyModelFilter', '草稿');
  await page.waitForTimeout(250);
  ok('畫質篩選 草稿', await page.locator('.history-card').count() === 1);
  await page.selectOption('#historyModelFilter', '');

  await page.locator('.history-card').first().click();
  await page.waitForSelector('#historyDetailModal:not([hidden])', { timeout: 10000 });
  ok('作品詳情 modal 開啟', await page.locator('#historyDetailImage').count() === 1);
  ok('版本比較列表', await page.locator('#historyVersionList .version-chip').count() >= 2);

  await page.fill('#historyTagEditor', 'qa, smoke, 測試');
  await page.click('#saveHistoryTags');
  await page.waitForTimeout(300);
  const storedTags = await page.evaluate(() => {
    const parsed = JSON.parse(localStorage.getItem('aiImageGenerationHistory.v1') || '[]');
    const records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.records) ? parsed.records : []);
    const record = records.find((item) => item && item.id === 'qa-v2') || records[0] || {};
    return Array.isArray(record.tags) ? record.tags.join(',') : '';
  });
  ok('標籤編輯儲存', storedTags.includes('smoke') && storedTags.includes('測試'), storedTags);

  await page.check('#hidePromptInShare');
  await page.click('#copyHistoryShareText');
  await page.waitForTimeout(200);
  const clipText = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  ok('分享文案複製 click', clipText.includes('AI 圖片作品') && !clipText.includes('qa robot portrait'), clipText.slice(0, 80));

  const expectedRecords = await page.evaluate(() => window.ImageHistoryStore.loadRecords());
  const exports = await verifyHistoryExports(page, expectedRecords, path.join(path.dirname(screenshotPath), 'history-exports'), 'browser-qa');
  ok('作品與全部 JSON 實際下載及內容驗證', true, exports.single.filename + ', ' + exports.all.filename);
  ok('備份往返、取消及失敗 toast', true);
  ok('Esc 可關閉作品詳情 modal', true);

  const swScope = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
    ]);
    return registration ? registration.scope : 'timeout';
  });
  ok('PWA service worker registration', swScope !== 'unsupported' && swScope !== 'timeout', swScope);

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await closeTutorialIfOpen(mobile);
  await mobile.evaluate(() => window.showTab && window.showTab('generate'));
  await mobile.waitForFunction(() => document.body.getAttribute('data-tab') === 'generate', { timeout: 10000 });
  const mobileBarVisible = await mobile.locator('#mobileGenerateBar').evaluate((el) => {
    const style = window.getComputedStyle(el);
    return !el.hidden && style.display !== 'none' && style.position === 'fixed';
  });
  ok('手機底部生成列顯示', mobileBarVisible);
  await mobile.close();

  await page.screenshot({ path: screenshotPath, fullPage: true });
  ok('QA 截圖輸出', fs.existsSync(screenshotPath), screenshotPath);

  await browser.close();

  console.log(JSON.stringify({ status: errors.length ? 'PASS_WITH_CONSOLE_ERRORS' : 'PASS', checks, errors, screenshotPath }, null, 2));
  if (errors.length) {
    process.exitCode = 1;
  }
}

async function downloaded(page, selector, expectedName, destination) {
  page.once('dialog', dialog => dialog.accept());
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.locator(selector).click(),
  ]);
  assert.equal(download.suggestedFilename(), expectedName);
  assert.equal(await download.failure(), null);
  await download.saveAs(destination);
  const bytes = fs.readFileSync(destination);
  assert.ok(bytes.length > 0);
  return { payload: JSON.parse(bytes.toString('utf8')), filename: expectedName, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function verifyHistoryExports(page, expected, output, tag) {
  fs.mkdirSync(output, { recursive: true });
  const selected = expected[0];
  assert.equal(await page.locator('#historyDetailPrompt').innerText(), selected.prompt);
  const safeId = String(selected.id).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) || 'history';
  const single = await downloaded(page, '#exportHistoryJson', 'history_' + safeId + '.json', path.join(output, tag + '-single.json'));
  assert.deepEqual(single.payload, expected.find(record => record.id === selected.id));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#historyDetailModal[hidden]', { state: 'attached' });
  await page.locator('#historySearch').fill(expected[0].prompt);
  await page.waitForFunction(() => document.querySelectorAll('.history-card').length === 1);
  const date = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  const all = await downloaded(page, '#exportAllHistoryJson', 'history_backup_' + date + '.json', path.join(output, tag + '-all.json'));
  assert.equal(all.payload.schema, 'GenerationRecordCollection');
  assert.equal(all.payload.version, 2);
  assert.deepEqual(all.payload.records, expected);
  const restored = await page.evaluate(payload => {
    localStorage.removeItem(window.ImageHistoryStore.STORAGE_KEY);
    const parsed = window.ImageHistoryStore.parseRecords(JSON.stringify(payload));
    window.ImageHistoryStore.saveRecords(parsed);
    return window.ImageHistoryStore.loadRecords();
  }, all.payload);
  assert.deepEqual(restored, expected);
  let extraDownloads = 0;
  const countUnexpectedDownload = () => { extraDownloads += 1; };
  page.on('download', countUnexpectedDownload);
  async function withoutDownload(action) {
    const event = page.waitForEvent('download', { timeout: 500 }).then(
      () => true,
      error => { assert.equal(error.name, 'TimeoutError'); return false; }
    );
    await action();
    assert.equal(await event, false, 'cancel/fault must not cause a download');
  }
  try {
    page.once('dialog', dialog => dialog.dismiss());
    await withoutDownload(() => page.locator('#exportAllHistoryJson').click());
    assert.ok((await page.locator('#status').innerText()).includes('已取消'));
    await page.evaluate(() => {
      window.__historyQaCreateObjectURL = window.URL.createObjectURL;
      window.URL.createObjectURL = () => { throw new Error('offline object URL fault'); };
    });
    page.once('dialog', dialog => dialog.accept());
    await withoutDownload(() => page.locator('#exportAllHistoryJson').click());
    assert.ok((await page.locator('#status').innerText()).includes('無法建立下載連結'));
    await page.locator('#appToast').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#appToast').innerText()).includes('offline object URL fault'));
    assert.equal(extraDownloads, 0);
  } finally {
    await page.evaluate(() => {
      if (window.__historyQaCreateObjectURL) window.URL.createObjectURL = window.__historyQaCreateObjectURL;
      delete window.__historyQaCreateObjectURL;
    });
    page.off('download', countUnexpectedDownload);
    await page.locator('#historySearch').fill('');
  }
  return { single: { ...single, payload: undefined }, all: { ...all, payload: undefined } };
}

async function offlineHistoryExportMain() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const output = path.join(root, 'output/history-export-qa');
  const origin = 'https://issue8.invalid';
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  const fixture = [
    { id: 'export-1', prompt: '貓咪在花園', providerPrompt: 'a cat in a garden', image, provider: 'offline-fixture', model: 'dev', size: 'portrait', seed: 42, width: 768, height: 1024, steps: 28, cfgScale: 4, tags: ['cat', '測試'], favorite: true, createdAt: '2026-10-01T00:00:00Z', versionNumber: 2, versionGroupId: 'group-1', sourceRecordId: 'export-2' },
    { id: 'export-2', prompt: '森林小屋', providerPrompt: 'a forest cabin', image, provider: 'offline-fixture', model: 'schnell', size: 'square', seed: 84, width: 1024, height: 1024, steps: 10, cfgScale: 3, tags: ['cabin'], createdAt: '2026-09-01T00:00:00Z', versionNumber: 1, versionGroupId: 'group-1' },
  ];
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
  const receipt = {
    testedHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    trackedChanges: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
    mode: 'offline route fulfillment; no remote deployment',
    cases: [],
  };
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  receipt.browser = browser.version();

  try {
    for (const bundle of ['source', 'deploy']) {
      for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport, acceptDownloads: true, serviceWorkers: 'block' });
        const page = await context.newPage();
        const errors = [];
        const external = [];
        const unexpectedDynamic = [];
        const servedHashes = {};
        const downloads = [];
        const base = path.join(root, bundle === 'source' ? 'app/static' : 'cloudflare/public');
        page.on('pageerror', error => errors.push(error.message));
        page.on('download', download => downloads.push(download.suggestedFilename()));
        await context.route('**/*', async route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== origin) {
            external.push(url.origin + url.pathname);
            return route.abort();
          }
          if (url.pathname === '/api/health' || url.pathname === '/health') {
            return route.fulfill({ json: { providerStatus: 'demo', mode: 'demo', providers: {}, hasApiKey: false, storageAvailable: true, turnstile: { required: false, siteKey: '' } } });
          }
          if (request.method() !== 'GET') {
            unexpectedDynamic.push(request.method() + ' ' + url.pathname);
            return route.abort();
          }
          const rootAsset = ['/', '/manifest.webmanifest', '/service-worker.js'].includes(url.pathname);
          if (!rootAsset && !url.pathname.startsWith('/static/')) {
            unexpectedDynamic.push(request.method() + ' ' + url.pathname);
            return route.fulfill({ status: 404, body: 'not a frontend asset route' });
          }
          const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
          const file = path.resolve(base, bundle === 'source' ? relative.replace(/^static\//, '') : relative);
          if (!file.startsWith(base + path.sep)) {
            unexpectedDynamic.push(request.method() + ' ' + url.pathname);
            return route.abort();
          }
          try {
            let bytes = fs.readFileSync(file);
            if (bundle === 'source' && relative === 'index.html' && process.argv.includes('--invalid-history-asset-route')) {
              bytes = Buffer.from(bytes.toString('utf8').replace('/static/history-wall.js', '/history-wall.js'));
            }
            if (relative.endsWith('history-wall.js') || relative.endsWith('history-store.js') || relative === 'index.html') servedHashes[relative] = createHash('sha256').update(bytes).digest('hex');
            return route.fulfill({ body: bytes, contentType: types[path.extname(file)] || 'application/octet-stream' });
          } catch {
            unexpectedDynamic.push(request.method() + ' ' + url.pathname);
            return route.fulfill({ status: 404, body: 'offline fixture route absent' });
          }
        });
        await context.addInitScript(records => {
          localStorage.setItem('aiImageTutorialSeen.v1', 'true');
          localStorage.setItem('imggen.activeTab', 'history');
          localStorage.setItem('aiImageGenerationHistory.v1', JSON.stringify(records));
        }, fixture);
        await page.goto(origin, { waitUntil: 'networkidle' });
        assert.deepEqual(unexpectedDynamic, [], 'only actual frontend routes may load');
        await page.waitForFunction(() => window.ImageHistoryWall && window.ImageHistoryStore && document.body.getAttribute('data-tab') === 'history');
        assert.equal(await page.locator('.history-card').count(), 2);
        const expected = await page.evaluate(() => window.ImageHistoryStore.loadRecords());
        assert.equal(expected.length, fixture.length);
        for (let index = 0; index < fixture.length; index += 1) {
          for (const [field, value] of Object.entries(fixture[index])) {
            assert.deepEqual(expected[index][field], value, 'fixture field retained: ' + field);
          }
        }
        await page.locator('.history-card').first().click();
        const tag = bundle + '-' + viewport.width;
        if (process.argv.includes('--disable-history-download')) {
          await page.evaluate(() => { HTMLAnchorElement.prototype.click = () => {}; });
        }
        if (process.argv.includes('--delayed-cancel-download')) {
          await page.evaluate(() => {
            const confirm = window.confirm;
            window.confirm = (...args) => {
              const accepted = confirm(...args);
              if (!accepted) setTimeout(() => {
                const anchor = document.createElement('a');
                anchor.href = URL.createObjectURL(new Blob(['unexpected delayed download']));
                anchor.download = 'unexpected-delayed.txt';
                anchor.click();
              }, 250);
              return accepted;
            };
          });
        }
        const { single, all } = await verifyHistoryExports(page, expected, output, tag);
        assert.equal(downloads.length, 2);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        assert.deepEqual(unexpectedDynamic, []);
        receipt.cases.push({ bundle, viewport, single: { ...single, payload: undefined }, all: { ...all, payload: undefined }, checks: ['single bytes and filename', 'all bytes and filename under active filter', 'backup parse/save/load roundtrip', 'cancel without download', 'object URL error visible toast'], servedHashes, externalRequests: external.length, providerRequests: unexpectedDynamic.length });
        await context.close();
      }
    }
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ passed: receipt.cases.length, downloads: receipt.cases.length * 2, receipt: path.join(output, 'receipt.json'), browser: receipt.browser }, null, 2));
  } finally {
    await browser.close();
  }
}

// The same strict checks run in full QA and the isolated source/deploy replay.
const run = process.argv.includes('--history-export-offline') ? offlineHistoryExportMain : main;
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
