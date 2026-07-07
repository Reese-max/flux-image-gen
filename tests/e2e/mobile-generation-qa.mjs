import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadPlaywright() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cloudflarePackage = path.join(rootDir, 'cloudflare', 'package.json');
  if (fs.existsSync(cloudflarePackage)) {
    return createRequire(cloudflarePackage)('playwright');
  }
  return createRequire(import.meta.url)('playwright');
}

const { chromium } = loadPlaywright();
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const staticDir = path.join(rootDir, 'app', 'static');
const screenshotPath = path.resolve(process.argv[2] || 'output/playwright/mobile-generation-qa.png');
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const checks = [];

function ok(name, condition, detail = '') {
  if (!condition) {
    throw new Error(name + (detail ? ': ' + detail : ''));
  }
  checks.push(name + (detail ? ' — ' + detail : ''));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json' || ext === '.webmanifest') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', () => resolve(''));
  });
}

function safeStaticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const relativePath = cleanPath === '' ? 'index.html' : cleanPath.replace(/^static\//, '');
  const fullPath = path.resolve(staticDir, relativePath);
  if (!fullPath.startsWith(staticDir)) {
    return null;
  }
  return fullPath;
}

function batchImages(count) {
  return Array.from({ length: count }, (_, index) => ({
    image: tinyPng,
    thumbnail: tinyPng,
    seed: 8000 + index,
    model: 'schnell',
    width: 1024,
    height: 1024,
    provider: 'mobile-e2e',
    imageQuality: {
      checked: true,
      mime: 'image/png',
      width: 1024,
      height: 1024,
      byteSize: 96,
      visualQualityScore: 88,
      issues: [],
    },
  }));
}

function startServer() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, {
        providerStatus: 'demo',
        mode: 'demo',
        providers: { nvidia: false, workersAI: false, modal: false },
        hasApiKey: false,
        storageAvailable: true,
        message: 'Demo 模式，不會真實出圖',
        checkedAt: new Date().toISOString(),
        turnstile: { required: false, siteKey: '' },
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/prompt/transform') {
      const body = await readRequestBody(request);
      let source = '中文 prompt';
      try {
        source = JSON.parse(body).source || source;
      } catch (error) {}
      sendJson(response, 200, {
        source,
        prompt: 'A mobile friendly FLUX prompt, clear subject, presentation illustration, bright background',
        provider: 'local-e2e',
        warnings: [],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/generate/batch') {
      const body = await readRequestBody(request);
      let count = 3;
      try {
        const payload = JSON.parse(body);
        count = Math.max(1, Math.min(4, Number(payload.count) || 3));
      } catch (error) {}
      sendJson(response, 200, { images: batchImages(count), requestId: 'mobile-batch-e2e' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/generate') {
      await readRequestBody(request);
      sendJson(response, 200, {
        image: tinyPng,
        seed: 8001,
        model: 'schnell',
        width: 1024,
        height: 1024,
        provider: 'mobile-e2e',
        requestId: 'mobile-single-e2e',
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/client-error') {
      await readRequestBody(request);
      sendJson(response, 200, { ok: true, requestId: 'mobile-e2e' });
      return;
    }

    const filePath = safeStaticPath(url.pathname === '/' ? '' : url.pathname);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
    fs.createReadStream(filePath).pipe(response);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function closeTutorialIfOpen(page) {
  if (await page.locator('#tutorialModal:not([hidden])').count()) {
    await page.click('#closeTutorial');
    await page.waitForSelector('#tutorialModal[hidden]', { state: 'attached', timeout: 10000 });
  }
}

async function main() {
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const { server, url } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  const errors = [];
  const promptText = '一隻柴犬在月球吃拉麵，PPT 插圖，明亮背景';

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });

  try {
    await page.goto(url + '/', { waitUntil: 'networkidle', timeout: 60000 });
    await closeTutorialIfOpen(page);
    await page.waitForSelector('#mobileGenerate:not([disabled])', { timeout: 15000 });
    await page.fill('#plainPrompt', promptText);
    await page.evaluate(() => {
      const batchCount = document.querySelector('#batchCount');
      if (batchCount) {
        batchCount.value = '3';
        batchCount.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    const barBefore = await page.locator('#mobileGenerateBar').evaluate((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        hidden: node.hidden,
        position: style.position,
        bottom: style.bottom,
        height: rect.height,
        top: rect.top,
      };
    });
    ok('手機底部生成列固定可用', !barBefore.hidden && barBefore.position === 'fixed' && barBefore.height > 0, JSON.stringify(barBefore));

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator('#mobileGenerate').click({ force: true });
    await page.waitForSelector('.batch-grid .batch-card', { timeout: 20000 });

    const promptAfterGeneration = await page.locator('#plainPrompt').inputValue();
    const cardCount = await page.locator('.batch-grid .batch-card').count();
    const gridMetrics = await page.locator('.batch-grid').evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        display: style.display,
        overflowX: style.overflowX,
        scrollSnapType: style.scrollSnapType,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        ariaLabel: node.getAttribute('aria-label'),
      };
    });
    const saveHint = await page.locator('.mobile-save-hint').textContent();
    const firstDownload = await page.locator('.batch-card a[download]').first().evaluate((node) => ({
      text: node.textContent,
      download: node.getAttribute('download'),
      hrefPrefix: node.getAttribute('href').slice(0, 22),
    }));
    const mobileButtonText = await page.locator('#mobileGenerate').textContent();
    const historyCount = await page.evaluate(() => {
      const raw = localStorage.getItem('aiImageGenerationHistory.v1');
      if (!raw) return 0;
      try {
        return JSON.parse(raw).records.length;
      } catch (error) {
        return -1;
      }
    });

    ok('手機使用者不需滑回頂部即可生成', promptAfterGeneration === promptText, promptAfterGeneration);
    ok('手機多張結果卡片可左右滑動', cardCount === 3 && gridMetrics.ariaLabel === '多張生成結果，可左右滑動挑選' && gridMetrics.scrollSnapType.indexOf('x') !== -1, JSON.stringify({ cardCount, gridMetrics }));
    ok('手機結果顯示保存提示', (saveHint || '').indexOf('長按圖片保存') !== -1, saveHint || '');
    ok('手機下載按鈕可用', firstDownload.hrefPrefix.indexOf('data:image/png') === 0 && !!firstDownload.download, JSON.stringify(firstDownload));
    ok('手機生成後歷史保存多張結果', historyCount >= 3, String(historyCount));
    ok('手機生成按鈕成功後可再生成', (mobileButtonText || '').indexOf('再生成') !== -1, mobileButtonText || '');

    await page.screenshot({ path: screenshotPath, fullPage: true });
    ok('mobile QA 截圖輸出', fs.existsSync(screenshotPath), screenshotPath);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const filteredErrors = errors.filter((message) => message.indexOf('Failed to load resource') === -1);
  console.log(JSON.stringify({ status: 'PASS', checks, consoleErrors: filteredErrors, screenshotPath }, null, 2));
  if (filteredErrors.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
