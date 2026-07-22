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
    await page.waitForSelector('.prompt-pack', { timeout: 15000 });
    const reducedEntryState = await page.evaluate(() => {
      const resultActions = document.querySelector('#resultActions');
      const moreActions = document.querySelector('#resultMoreActions');
      const clearHistory = document.querySelector('#clearHistory');
      const historyFilters = document.querySelector('#historyFilters');
      return {
        quickIdeaCount: document.querySelectorAll('#ideasSection > .idea-grid > .idea').length,
        promptPackCardCount: document.querySelectorAll('.prompt-pack .idea').length,
        promptPackClosed: Boolean(document.querySelector('.prompt-pack-browser:not([open])')),
        primaryActionIds: resultActions
          ? Array.from(resultActions.children).filter((node) => node.matches('a, button')).map((node) => node.id)
          : [],
        downloadIsPrimary: Boolean(document.querySelector('#dl.btn.primary')),
        moreActionIds: moreActions
          ? Array.from(moreActions.querySelectorAll('button')).map((node) => node.id)
          : [],
        emptyHistoryControlsHidden: Boolean(clearHistory && clearHistory.hidden && historyFilters && historyFilters.hidden),
        emptyHistoryCtaVisible: Boolean(document.querySelector('.history-empty .history-empty-cta')),
      };
    });
    ok('首頁只保留六個快速靈感', reducedEntryState.quickIdeaCount === 6, JSON.stringify(reducedEntryState));
    ok('完整提示詞初始不建立卡片 DOM', reducedEntryState.promptPackCardCount === 0 && reducedEntryState.promptPackClosed, JSON.stringify(reducedEntryState));
    ok('結果操作只直接顯示下載、再生與構圖變化', reducedEntryState.primaryActionIds.join(',') === 'dl,regenerate,useComposition'
      && reducedEntryState.downloadIsPrimary
      && reducedEntryState.moreActionIds.join(',') === 'copySettings,copyPrompt', JSON.stringify(reducedEntryState));
    ok('空歷史隱藏無效控制並提供生成入口', reducedEntryState.emptyHistoryControlsHidden && reducedEntryState.emptyHistoryCtaVisible, JSON.stringify(reducedEntryState));

    await page.locator('.prompt-pack-browser > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('.prompt-pack .pack-cat').length > 0, null, { timeout: 10000 });
    ok('展開完整提示詞時仍不提前建立分類卡片', await page.locator('.prompt-pack .idea').count() === 0);
    await page.locator('.prompt-pack .pack-cat > summary').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.prompt-pack .idea').length === 6, null, { timeout: 10000 });
    ok('首次展開分類時才建立該分類卡片', await page.locator('.prompt-pack .idea').count() === 6);
    const mobileTargets = await page.evaluate(() => {
      const selectors = ['#openTutorialTopbar', '#tab-generate', '#tab-edit', '#tab-history', '#promptStyle', '#useCase', '.prompt-pack-browser > summary', '.prompt-pack .pack-cat > summary', '#openPrivacyPolicy', '#openLicensePolicy', '#openUsagePanel'];
      return selectors.map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, width: rect.width, height: rect.height };
      });
    });
    ok('手機主要操作目標至少 44px', mobileTargets.every((item) => item.width >= 44 && item.height >= 44), JSON.stringify(mobileTargets));
    await page.locator('.prompt-pack-browser > summary').click();
    await page.locator('#mobileGenerate').click();
    await page.waitForFunction(() => /請先輸入描述文字/.test((document.querySelector('#status') || {}).textContent || ''), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    const emptyPromptFocus = await page.evaluate(() => {
      const field = document.activeElement;
      const bar = document.querySelector('#mobileGenerateBar');
      const fieldRect = field.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      return { id: field.id, fieldBottom: fieldRect.bottom, barTop: barRect.top };
    });
    ok('手機空白送出後輸入框完整可見', emptyPromptFocus.id === 'plainPrompt' && emptyPromptFocus.fieldBottom <= emptyPromptFocus.barTop - 8, JSON.stringify(emptyPromptFocus));
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
    const compactLayout = await page.evaluate(() => {
      const tabs = document.querySelector('.tabs');
      const historyTab = document.querySelector('#tab-history');
      const composer = document.querySelector('#panel-generate .composer');
      const tabsRect = tabs.getBoundingClientRect();
      const historyRect = historyTab.getBoundingClientRect();
      return {
        composerHeight: composer.getBoundingClientRect().height,
        tabsDisplay: getComputedStyle(tabs).display,
        tabsScrollWidth: tabs.scrollWidth,
        tabsClientWidth: tabs.clientWidth,
        historyLeft: historyRect.left,
        historyRight: historyRect.right,
        tabsLeft: tabsRect.left,
        tabsRight: tabsRect.right,
        historyLabel: historyTab.querySelector('.tab-mobile-label').textContent,
      };
    });
    ok('手機底部生成列固定可用', !barBefore.hidden && barBefore.position === 'fixed' && barBefore.height > 0, JSON.stringify(barBefore));
    ok('手機生成表單維持緊湊高度', compactLayout.composerHeight <= 460, JSON.stringify(compactLayout));
    ok('手機三個分頁完整顯示且歷史未被截斷', compactLayout.tabsDisplay === 'grid'
      && compactLayout.tabsScrollWidth <= compactLayout.tabsClientWidth + 1
      && compactLayout.historyLeft >= compactLayout.tabsLeft
      && compactLayout.historyRight <= compactLayout.tabsRight + 1
      && compactLayout.historyLabel === '歷史', JSON.stringify(compactLayout));

    await page.focus('#plainPrompt');
    for (let step = 0; step < 5 && await page.evaluate(() => document.activeElement?.id !== 'promptStyle'); step += 1) {
      await page.keyboard.press('Tab');
    }
    await page.waitForTimeout(100);
    const focusedStyle = await page.evaluate(() => {
      const field = document.activeElement;
      const bar = document.querySelector('#mobileGenerateBar');
      const fieldRect = field.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      return { id: field.id, fieldBottom: fieldRect.bottom, barTop: barRect.top };
    });
    ok('手機固定生成列不遮住鍵盤焦點', focusedStyle.id === 'promptStyle' && focusedStyle.fieldBottom <= focusedStyle.barTop - 8, JSON.stringify(focusedStyle));

    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    const focusedUseCase = await page.evaluate(() => {
      const field = document.activeElement;
      const bar = document.querySelector('#mobileGenerateBar');
      const fieldRect = field.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      return { id: field.id, fieldBottom: fieldRect.bottom, barTop: barRect.top };
    });
    ok('手機用途選單取得焦點時完整可見', focusedUseCase.id === 'useCase' && focusedUseCase.fieldBottom <= focusedUseCase.barTop - 8, JSON.stringify(focusedUseCase));

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator('#mobileGenerate').click({ force: true });
    await page.waitForSelector('.batch-grid .batch-card', { timeout: 20000 });
    await page.waitForTimeout(500);

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
    const firstDownload = await page.locator('.batch-main-meta a[download]').first().evaluate((node) => ({
      text: node.textContent,
      download: node.getAttribute('download'),
      hrefPrefix: node.getAttribute('href').slice(0, 22),
    }));
    const mobileButtonText = await page.locator('#mobileGenerate').textContent();
    const resultVisibility = await page.locator('#stage').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        viewportHeight: window.innerHeight,
        focused: document.activeElement === node,
      };
    });
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
    ok('生成完成後自動帶到結果並聚焦', resultVisibility.top >= 0 && resultVisibility.top < resultVisibility.viewportHeight && resultVisibility.focused, JSON.stringify(resultVisibility));
    ok('手機多張結果卡片可左右滑動', cardCount === 3 && gridMetrics.ariaLabel === '多張生成結果，可左右滑動挑選' && gridMetrics.scrollSnapType.indexOf('x') !== -1, JSON.stringify({ cardCount, gridMetrics }));
    ok('手機結果顯示保存提示', (saveHint || '').indexOf('長按圖片保存') !== -1, saveHint || '');
    ok('手機下載按鈕可用', firstDownload.hrefPrefix.indexOf('data:image/png') === 0 && !!firstDownload.download, JSON.stringify(firstDownload));
    ok('手機生成後歷史保存多張結果', historyCount >= 3, String(historyCount));
    ok('手機生成成功後主要 CTA 保持生成語意', /生成圖片/.test(mobileButtonText || '') && !/再生成|重試/.test(mobileButtonText || ''), mobileButtonText || '');

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
