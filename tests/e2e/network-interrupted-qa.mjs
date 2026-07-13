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
  let failureScenario = 'network';

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  const failGenerate = (route) => {
    if (failureScenario === 'rate_limited') {
      return route.fulfill({
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-request-id': 'rate-limit-e2e' },
        body: JSON.stringify({ message: '今天生成次數已達上限', code: 'rate_limited', retry_after: 2 }),
      });
    }
    if (failureScenario === 'service_unavailable') {
      return route.fulfill({
        status: 503,
        headers: { 'content-type': 'application/json', 'x-request-id': 'service-e2e' },
        body: JSON.stringify({ message: '圖片服務維護中，請稍後再試', code: 'nvidia_error' }),
      });
    }
    return route.abort('failed');
  };
  await page.route('**/generate', failGenerate);
  await page.route('**/generate/batch', failGenerate);

  try {
    await page.goto(url + '/', { waitUntil: 'networkidle', timeout: 60000 });
    await closeTutorialIfOpen(page);
    await page.waitForSelector('#go:not([disabled])', { timeout: 15000 });
    await page.fill('#plainPrompt', promptText);
    await page.focus('#go');
    await page.keyboard.press('Enter');
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
    const activeAfterFailure = await page.evaluate(() => ({ id: document.activeElement?.id || '', tag: document.activeElement?.tagName || '' }));
    ok('錯誤後焦點保留在重試按鈕', activeAfterFailure.id === 'go', JSON.stringify(activeAfterFailure));

    failureScenario = 'rate_limited';
    await page.locator('#go').click();
    await page.waitForFunction(() => /今天生成次數已達上限/.test((document.querySelector('#status') || {}).textContent || ''), null, { timeout: 10000 });
    const rateLimitState = await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent || '',
      stage: document.querySelector('#stage')?.textContent || '',
      button: document.querySelector('#go')?.textContent || '',
      disabled: !!document.querySelector('#go')?.disabled,
    }));
    ok('429 保留後端訊息', /今天生成次數已達上限/.test(rateLimitState.status), JSON.stringify(rateLimitState));
    ok('429 顯示 retry_after 倒數並暫停重送', rateLimitState.disabled && /2 秒後/.test(rateLimitState.button + rateLimitState.stage), JSON.stringify(rateLimitState));
    ok('429 不建議修改 prompt 或模型', !/seed|縮短 prompt|另一個模型/i.test(rateLimitState.stage), rateLimitState.stage);
    await page.waitForFunction(() => !document.querySelector('#go')?.disabled, null, { timeout: 5000 });

    failureScenario = 'service_unavailable';
    await page.locator('#go').click();
    await page.waitForFunction(() => /圖片服務維護中/.test((document.querySelector('#status') || {}).textContent || ''), null, { timeout: 10000 });
    const unavailableState = await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent || '',
      stage: document.querySelector('#stage')?.textContent || '',
      disabled: !!document.querySelector('#go')?.disabled,
    }));
    ok('503 保留後端訊息並歸因服務端', /圖片服務維護中/.test(unavailableState.status) && /服務暫時不可用/.test(unavailableState.stage), JSON.stringify(unavailableState));
    ok('503 不要求使用者修改 prompt', !/seed|縮短 prompt|另一個模型/i.test(unavailableState.stage), unavailableState.stage);
    ok('503 允許稍後手動重試', unavailableState.disabled === false, JSON.stringify(unavailableState));

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
