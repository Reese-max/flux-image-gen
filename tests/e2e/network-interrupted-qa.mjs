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
const screenshotPath = path.resolve(process.argv[2] || 'output/playwright/network-interrupted-qa.png');
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
        prompt: 'A resilient offline QA image prompt, clear subject, clean lighting',
        provider: 'local-e2e',
        warnings: [],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/client-error') {
      await readRequestBody(request);
      sendJson(response, 200, { ok: true, requestId: 'network-e2e' });
      return;
    }
    if (request.method === 'POST' && (url.pathname === '/generate' || url.pathname === '/generate/batch')) {
      sendJson(response, 503, { error: 'E2E generate route should have been aborted by Playwright', code: 'e2e_unexpected_generate' });
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const promptText = '一隻柴犬在月球吃拉麵，PPT 插圖，明亮背景';

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  await page.route('**/generate', (route) => route.abort('failed'));
  await page.route('**/generate/batch', (route) => route.abort('failed'));

  try {
    await page.goto(url + '/', { waitUntil: 'networkidle', timeout: 60000 });
    await closeTutorialIfOpen(page);
    await page.waitForSelector('#go:not([disabled])', { timeout: 15000 });
    await page.fill('#plainPrompt', promptText);
    await page.locator('#go').click({ force: true });
    await page.waitForFunction(() => {
      return !!document.querySelector('.failure-advice') || /失敗|出錯|提示詞整理失敗/.test((document.querySelector('#status') || {}).textContent || '');
    }, null, { timeout: 20000 });

    const statusText = await page.locator('#status').textContent();
    const stageText = await page.locator('#stage').textContent();
    const promptAfterFailure = await page.locator('#plainPrompt').inputValue();
    const historyValue = await page.evaluate(() => localStorage.getItem('aiImageGenerationHistory.v1'));

    ok('網路中斷顯示失敗狀態', /失敗|ERR_FAILED|failed|fetch|出錯/i.test(statusText || ''), statusText || '');
    ok('網路中斷顯示專用建議', (stageText || '').indexOf('網路連線中斷') !== -1, stageText || '');
    ok('使用者中文輸入未遺失', promptAfterFailure === promptText, promptAfterFailure);
    ok('失敗時不建立歷史作品', !historyValue, historyValue || '');
    ok('重試按鈕文案可見', (await page.locator('#go').textContent()).indexOf('重試') !== -1);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    ok('network QA 截圖輸出', fs.existsSync(screenshotPath), screenshotPath);
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
