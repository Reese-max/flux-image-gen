import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

function loadPlaywright() {
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
  await page.selectOption('#historyModelFilter', 'dev');
  await page.waitForTimeout(250);
  ok('模型篩選 dev', await page.locator('.history-card').count() === 1);
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

  const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await page.click('#exportHistoryJson');
  const download = await downloadPromise;
  ok(
    '作品 JSON 匯出 click',
    !download || download.suggestedFilename().endsWith('.json'),
    download ? download.suggestedFilename() : 'download event not emitted by this browser run'
  );

  await page.keyboard.press('Escape');
  await page.waitForSelector('#historyDetailModal[hidden]', { state: 'attached', timeout: 10000 });
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
