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
const screenshotPath = path.resolve(process.argv[2] || 'output/playwright/accessibility-keyboard-qa.png');
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const checks = [];
const counters = { generate: 0, transform: 0 };

function ok(name, condition, detail = '') {
  if (!condition) {
    throw new Error(name + (detail ? ': ' + detail : ''));
  }
  checks.push(name + (detail ? ' — ' + detail : ''));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      counters.transform += 1;
      const body = await readRequestBody(request);
      let source = '中文 prompt';
      try {
        source = JSON.parse(body).source || source;
      } catch (error) {}
      await delay(180);
      sendJson(response, 200, {
        source,
        prompt: 'An accessible keyboard QA image prompt, clear subject, clean lighting, presentation illustration',
        provider: 'local-e2e',
        warnings: [],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/generate') {
      counters.generate += 1;
      await readRequestBody(request);
      await delay(260);
      sendJson(response, 200, {
        image: tinyPng,
        seed: 9001,
        model: 'schnell',
        width: 1024,
        height: 1024,
        provider: 'keyboard-e2e',
        requestId: 'keyboard-single-e2e',
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/client-error') {
      await readRequestBody(request);
      sendJson(response, 200, { ok: true, requestId: 'keyboard-e2e' });
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

async function tabUntilActiveId(page, targetId, maxTabs = 24) {
  for (let i = 0; i < maxTabs; i += 1) {
    const current = await page.evaluate(() => document.activeElement && document.activeElement.id);
    if (current === targetId) return true;
    await page.keyboard.press('Tab');
    await page.waitForTimeout(25);
  }
  return (await page.evaluate(() => document.activeElement && document.activeElement.id)) === targetId;
}

async function collectTabStops(page, maxTabs = 16) {
  const stops = [];
  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.textContent || document.activeElement.tagName)));
  }
  return stops;
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

  try {
    await page.goto(url + '/', { waitUntil: 'networkidle', timeout: 60000 });
    await closeTutorialIfOpen(page);
    await page.waitForSelector('#go:not([disabled])', { timeout: 15000 });

    await page.focus('#go');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /請先輸入描述文字/.test((document.querySelector('#status') || {}).textContent || ''), null, { timeout: 10000 });
    const emptyPromptA11y = await page.evaluate(() => {
      const plain = document.querySelector('#plainPrompt');
      const status = document.querySelector('#status');
      const stage = document.querySelector('#stage');
      return {
        activeId: document.activeElement && document.activeElement.id,
        invalid: plain && plain.getAttribute('aria-invalid'),
        errormessage: plain && plain.getAttribute('aria-errormessage'),
        statusRole: status && status.getAttribute('role'),
        statusLive: status && status.getAttribute('aria-live'),
        stageBusy: stage && stage.getAttribute('aria-busy'),
        stageText: stage && stage.textContent,
      };
    });
    ok('空 prompt 錯誤可被螢幕閱讀器讀到', emptyPromptA11y.invalid === 'true' && emptyPromptA11y.errormessage === 'status' && emptyPromptA11y.statusRole === 'alert' && emptyPromptA11y.statusLive === 'assertive', JSON.stringify(emptyPromptA11y));
    ok('空 prompt 後焦點回到中文輸入框', emptyPromptA11y.activeId === 'plainPrompt', JSON.stringify(emptyPromptA11y));

    await page.keyboard.type(promptText);
    const invalidAfterTyping = await page.locator('#plainPrompt').getAttribute('aria-invalid');
    ok('輸入後清除欄位錯誤狀態', invalidAfterTyping === null, String(invalidAfterTyping));

    const reachedGo = await tabUntilActiveId(page, 'go');
    ok('鍵盤 Tab 可抵達主要生成按鈕', reachedGo, await page.evaluate(() => document.activeElement && document.activeElement.id));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const go = document.querySelector('#go');
      const stage = document.querySelector('#stage');
      return go && stage && go.getAttribute('aria-busy') === 'true' && stage.getAttribute('aria-busy') === 'true';
    }, null, { timeout: 10000 });
    await page.keyboard.press('Enter');
    const busyA11y = await page.evaluate(() => ({
      goBusy: document.querySelector('#go') && document.querySelector('#go').getAttribute('aria-busy'),
      goDisabled: document.querySelector('#go') && document.querySelector('#go').getAttribute('aria-disabled'),
      stageBusy: document.querySelector('#stage') && document.querySelector('#stage').getAttribute('aria-busy'),
      statusText: document.querySelector('#status') && document.querySelector('#status').textContent,
    }));
    ok('生成中按鈕宣告 busy 且不可重複送出', busyA11y.goBusy === 'true' && busyA11y.goDisabled === 'true' && busyA11y.stageBusy === 'true', JSON.stringify(busyA11y));

    await page.waitForSelector('#stage img[alt="生成完成的圖片"]', { timeout: 20000 });
    const doneA11y = await page.evaluate(() => {
      const status = document.querySelector('#status');
      const stage = document.querySelector('#stage');
      const actions = document.querySelector('#resultActions');
      const go = document.querySelector('#go');
      const image = document.querySelector('#stage img');
      return {
        statusText: status && status.textContent,
        statusRole: status && status.getAttribute('role'),
        statusLive: status && status.getAttribute('aria-live'),
        stageBusy: stage && stage.getAttribute('aria-busy'),
        actionsHidden: actions && actions.hidden,
        goBusy: go && go.getAttribute('aria-busy'),
        goDisabled: go && go.getAttribute('aria-disabled'),
        imageAlt: image && image.getAttribute('alt'),
      };
    });
    ok('鍵盤主流程可完成生成並恢復可操作狀態', /完成/.test(doneA11y.statusText || '') && doneA11y.statusRole === 'status' && doneA11y.statusLive === 'polite' && doneA11y.stageBusy === 'false' && doneA11y.goBusy === 'false' && doneA11y.goDisabled === 'false', JSON.stringify(doneA11y));
    ok('成功後結果操作與圖片替代文字可用', doneA11y.actionsHidden === false && doneA11y.imageAlt === '生成完成的圖片', JSON.stringify(doneA11y));
    ok('鍵盤重複 Enter 未造成重複請求', counters.generate === 1, JSON.stringify(counters));

    const tabStops = await collectTabStops(page);
    ok('成功後結果操作可用鍵盤抵達', tabStops.indexOf('dl') !== -1 || tabStops.indexOf('regenerate') !== -1 || tabStops.indexOf('copyPrompt') !== -1, JSON.stringify(tabStops));

    await page.screenshot({ path: screenshotPath, fullPage: true });
    ok('accessibility QA 截圖輸出', fs.existsSync(screenshotPath), screenshotPath);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const filteredErrors = errors.filter((message) => message.indexOf('Failed to load resource') === -1);
  console.log(JSON.stringify({ status: 'PASS', checks, consoleErrors: filteredErrors, counters, screenshotPath }, null, 2));
  if (filteredErrors.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
