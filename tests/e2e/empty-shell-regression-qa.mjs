import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const staticDir = path.join(rootDir, 'app', 'static');
const screenshotPath = path.join(rootDir, 'output', 'playwright', 'empty-shell-regression-qa.png');
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const { chromium } = createRequire(path.join(rootDir, 'cloudflare', 'package.json'))('playwright');
const checks = [];

function ok(name, condition, detail = '') {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
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

function sendJson(response, payload) {
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

function staticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const relativePath = cleanPath === '' ? 'index.html' : cleanPath.replace(/^static\//, '');
  const filePath = path.resolve(staticDir, relativePath);
  return filePath.startsWith(staticDir) ? filePath : null;
}

function generatedImage(seed) {
  return {
    image: tinyPng,
    thumbnail: tinyPng,
    seed,
    model: 'schnell',
    width: 1024,
    height: 1024,
    provider: 'empty-shell-e2e',
    imageQuality: {
      checked: true,
      mime: 'image/png',
      width: 1024,
      height: 1024,
      byteSize: 96,
      visualQualityScore: 96,
      issues: [],
    },
  };
}

function startServer(generationRequests) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, {
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
      const body = JSON.parse(await readBody(request));
      sendJson(response, {
        source: body.source,
        prompt: 'A detailed FLUX prompt for a Taipei night-market cat, cinematic light',
        provider: 'local-e2e',
        warnings: [],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/generate') {
      generationRequests.push({ path: url.pathname, body: JSON.parse(await readBody(request)) });
      sendJson(response, { ...generatedImage(9100), requestId: 'single-regression' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/generate/batch') {
      const body = JSON.parse(await readBody(request));
      generationRequests.push({ path: url.pathname, body });
      sendJson(response, {
        images: Array.from({ length: body.count }, (_, index) => generatedImage(9200 + index)),
        requestId: 'batch-regression',
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/client-error') {
      await readBody(request);
      sendJson(response, { ok: true });
      return;
    }

    const filePath = staticPath(url.pathname === '/' ? '' : url.pathname);
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
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function closeTutorial(page) {
  if (await page.locator('#tutorialModal:not([hidden])').count()) {
    await page.click('#closeTutorial');
  }
}

async function main() {
  const generationRequests = [];
  const networkRequests = [];
  const errors = [];
  const { server, url } = await startServer(generationRequests);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();

  page.on('request', (request) => networkRequests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  try {
    await page.goto(url + '/', { waitUntil: 'networkidle', timeout: 60000 });
    await closeTutorial(page);
    await page.fill('#plainPrompt', '一隻橘貓在台北夜市喝珍珠奶茶，電影感');
    await page.getByText('讓 AI 幫我調設定', { exact: true }).click();
    await page.locator('#advancedSettings > summary').click();
    await page.selectOption('#batchCount', '1');
    await page.click('#go');
    await page.waitForSelector('#stage img', { timeout: 20000 });

    // Regression for ISSUE-003: agent preparation must not reset the user's 1-image choice to 4.
    ok('AI 模式保留使用者選擇的 1 張', generationRequests[0]?.path === '/generate'
      && await page.locator('#batchCount').inputValue() === '1'
      && await page.locator('.batch-thumb').count() === 0, JSON.stringify(generationRequests[0]));

    await page.selectOption('#batchCount', '2');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelectorAll('.batch-thumb').length === 2, null, { timeout: 20000 });
    await page.locator('.batch-thumb').nth(1).click();

    // Regression for ISSUE-004: the canvas pan capture must not swallow thumbnail clicks.
    ok('第二張縮圖可切換主預覽', await page.locator('.batch-thumb').nth(1).getAttribute('aria-pressed') === 'true'
      && /9201/.test(await page.locator('.batch-main-meta .batch-seed').textContent()));

    await page.click('#seedLock');

    // Regression for ISSUE-005: global composition actions must use the selected batch record.
    ok('全域構圖鎖定使用目前選取圖', await page.locator('#seedLock').getAttribute('aria-pressed') === 'true'
      && /9201/.test(await page.locator('#seed').inputValue())
      && /已鎖定剛才那張的構圖/.test(await page.locator('#status').textContent()));

    // Regression for ISSUE-006: the batch download link must remain clickable inside the canvas.
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('.batch-main-meta a[download]').click();
    const download = await downloadPromise;
    ok('批次主圖下載會觸發檔案', /_9201\.png$/.test(download.suggestedFilename()), download.suggestedFilename());

    await page.locator('.prompt-pack-browser > summary').click();
    await page.locator('.prompt-pack .pack-cat > summary').first().click();
    await page.waitForSelector('.hf-ideas', { timeout: 10000 });
    await page.locator('.hf-ideas button').click();
    await page.waitForFunction(() => document.querySelectorAll('.hf-ideas .idea-prompt').length === 10, null, { timeout: 10000 });

    // Regression for ISSUE-007: inspiration cards come from the bundled prompt pack, not a CORS-fragile API.
    ok('隨機靈感顯示 10 張本機精選卡', await page.locator('.hf-ideas .idea-prompt').count() === 10);
    ok('隨機靈感不再呼叫 Hugging Face API', networkRequests.some((requestUrl) => /prompt-pack\.json/.test(requestUrl))
      && !networkRequests.some((requestUrl) => /huggingface|datasets-server/i.test(requestUrl)));

    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.locator('.hf-ideas').screenshot({ path: screenshotPath });
    ok('集中式回歸截圖輸出', fs.existsSync(screenshotPath), screenshotPath);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const filteredErrors = errors.filter((message) => !/Failed to load resource/.test(message));
  ok('瀏覽器主控台無錯誤', filteredErrors.length === 0, JSON.stringify(filteredErrors));
  console.log(JSON.stringify({ status: 'PASS', checks, generationRequests, screenshotPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
