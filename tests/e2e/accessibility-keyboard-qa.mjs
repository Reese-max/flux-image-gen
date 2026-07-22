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
const counters = { health: 0, generate: 0, transform: 0, complete: 0, enhance: 0, edit: 0 };

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
      counters.health += 1;
      sendJson(response, 200, {
        providerStatus: 'demo',
        mode: 'demo',
        providers: { nvidia: false, workersAI: false },
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
    if (request.method === 'POST' && url.pathname === '/prompt/complete') {
      counters.complete += 1;
      const body = await readRequestBody(request);
      let source = '中文 prompt';
      try {
        source = JSON.parse(body).source || source;
      } catch (error) {}
      await delay(180);
      sendJson(response, 200, {
        source,
        prompt: source + '，主體清楚，構圖完整，明亮柔和光線',
        provider: 'local-e2e',
        warnings: [],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/prompt/enhance') {
      counters.enhance += 1;
      await readRequestBody(request);
      await delay(120);
      sendJson(response, 200, {
        prompt: 'An accessible keyboard QA image prompt. Add a dreamy ethereal atmosphere while preserving the original subject.',
        provider: 'rule_based',
        effect: '更夢幻',
        warnings: ['未設定 Gemini，已使用離線效果強化'],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/edit') {
      counters.edit += 1;
      await readRequestBody(request);
      await delay(260);
      sendJson(response, 200, { image: tinyPng });
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
  const editInputPath = path.join(path.dirname(screenshotPath), 'accessibility-edit-input.png');
  fs.writeFileSync(editInputPath, Buffer.from(tinyPng.split(',')[1], 'base64'));
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

    const initialFeatureScripts = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter((entry) => entry.initiatorType === 'script')
      .map((entry) => new URL(entry.name).pathname.split('/').pop()));
    ok('非首屏功能初始不下載', ['image-edit.js', 'usage-dashboard.js']
      .every((name) => initialFeatureScripts.indexOf(name) === -1), JSON.stringify(initialFeatureScripts));

    const workspaceLayout = await page.evaluate(() => {
      const controls = document.querySelector('#generationControls').getBoundingClientRect();
      const preview = document.querySelector('#generationPreview').getBoundingClientRect();
      return {
        controlsWidth: controls.width,
        previewWidth: preview.width,
        topDelta: Math.abs(controls.top - preview.top),
      };
    });
    ok('桌面生成頁採左側控制、右側大預覽', workspaceLayout.previewWidth > workspaceLayout.controlsWidth && workspaceLayout.topDelta < 2, JSON.stringify(workspaceLayout));

    const brandLayout = await page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        invokeInspired: document.body.classList.contains('invoke-inspired'),
        duplicateLibraryCount: document.querySelectorAll('.invoke-library').length,
        backgroundToken: rootStyle.getPropertyValue('--bg').trim(),
      };
    });
    ok('桌面版使用一致的暖色基準且不重複顯示資源庫', !brandLayout.invokeInspired
      && brandLayout.duplicateLibraryCount === 0
      && /^#(?:f|e|d|c)/i.test(brandLayout.backgroundToken), JSON.stringify(brandLayout));

    const desktopTargets = await page.evaluate(() => {
      const selectors = ['#toggleGenerationControls', '#previewFit', '#previewActual', '#canvasZoomOut', '#canvasZoomValue', '#canvasZoomIn'];
      return selectors.map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, width: rect.width, height: rect.height };
      });
    });
    ok('桌面畫布操作目標至少 44px', desktopTargets.every((item) => item.width >= 44 && item.height >= 44), JSON.stringify(desktopTargets));

    await page.evaluate(() => {
      const size = document.querySelector('#size');
      size.value = 'ppt_16_9';
      size.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const canvasMetadata = await page.evaluate(() => ({
      chip: document.querySelector('#canvasPresetChip').textContent,
      size: document.querySelector('#canvasSizeMeta').textContent,
      state: document.querySelector('#canvasStateMeta').textContent,
    }));
    ok('畫布資訊列會同步尺寸與待命狀態', /1344/.test(canvasMetadata.chip) && /1344/.test(canvasMetadata.size) && canvasMetadata.state === '待命', JSON.stringify(canvasMetadata));

    await page.focus('#workspaceDivider');
    const dividerWidthBefore = Number(await page.locator('#workspaceDivider').getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowRight');
    const dividerWidthAfter = Number(await page.locator('#workspaceDivider').getAttribute('aria-valuenow'));
    ok('分隔線可用鍵盤調整左側寬度', dividerWidthAfter === dividerWidthBefore + 16, JSON.stringify({ dividerWidthBefore, dividerWidthAfter }));

    await page.click('#toggleGenerationControls');
    const collapsedLayout = await page.evaluate(() => {
      const workspace = document.querySelector('#generationWorkspace');
      const controls = document.querySelector('#generationControls').getBoundingClientRect();
      const toggle = document.querySelector('#toggleGenerationControls');
      return {
        collapsed: workspace.classList.contains('is-controls-collapsed'),
        controlsWidth: controls.width,
        expanded: toggle.getAttribute('aria-expanded'),
      };
    });
    ok('左側設定可收合成窄欄', collapsedLayout.collapsed && collapsedLayout.controlsWidth <= 70 && collapsedLayout.expanded === 'false', JSON.stringify(collapsedLayout));
    await page.click('#toggleGenerationControls');

    await page.click('#previewActual');
    const actualMode = await page.evaluate(() => ({
      actualPressed: document.querySelector('#previewActual').getAttribute('aria-pressed'),
      fitPressed: document.querySelector('#previewFit').getAttribute('aria-pressed'),
      stageActual: document.querySelector('#stage').classList.contains('is-actual-size'),
    }));
    ok('預覽可切換原尺寸檢視', actualMode.actualPressed === 'true' && actualMode.fitPressed === 'false' && actualMode.stageActual, JSON.stringify(actualMode));
    await page.click('#previewFit');

    await page.click('#tab-edit');
    await page.waitForFunction(() => window.ImageEdit && typeof window.ImageEdit.applyHealth === 'function', null, { timeout: 10000 });
    await page.waitForFunction(() => /尚未啟用 Workers AI 改圖/.test((document.querySelector('#editStatus') || {}).textContent || ''), null, { timeout: 10000 });
    const unavailableEditState = await page.evaluate(() => ({
      disabled: document.querySelector('#editGo') && document.querySelector('#editGo').disabled,
      ariaDisabled: document.querySelector('#editGo') && document.querySelector('#editGo').getAttribute('aria-disabled'),
      status: document.querySelector('#editStatus') && document.querySelector('#editStatus').textContent,
      filesDisabled: document.querySelector('#editFiles') && document.querySelector('#editFiles').disabled,
    }));
    ok('未啟用 Workers AI 時改圖送出會停用並說明原因', unavailableEditState.disabled === true && unavailableEditState.ariaDisabled === 'true' && /尚未啟用 Workers AI 改圖/.test(unavailableEditState.status || ''), JSON.stringify(unavailableEditState));
    ok('改圖不可送出時仍可整理參考圖與指令', unavailableEditState.filesDisabled === false, JSON.stringify(unavailableEditState));
    ok('改圖模組重播既有服務狀態且不重抓 health', counters.health === 1, JSON.stringify(counters));
    await page.evaluate(() => window.ImageEdit.applyHealth({ providers: { workersAI: true } }));
    await page.setInputFiles('#editFiles', editInputPath);
    await page.waitForSelector('.edit-thumb img', { timeout: 10000 });
    await page.fill('#editPrompt', '把背景改成藍色攝影棚');
    await page.click('#editGo');
    await page.waitForFunction(() => /AI 改圖中… 已用 \d+\.\d 秒/.test((document.querySelector('#editStatus') || {}).textContent || ''), null, { timeout: 10000 });
    ok('AI 改圖執行時會即時顯示秒數', /秒/.test(await page.locator('#editStatus').innerText()));
    await page.waitForFunction(() => /完成 ✓ · 耗時 \d+\.\d 秒/.test((document.querySelector('#editStatus') || {}).textContent || ''), null, { timeout: 10000 });
    ok('AI 改圖完成後保留總耗時', counters.edit === 1, JSON.stringify(counters));
    await page.evaluate(() => window.showTab('usage'));
    await page.waitForFunction(() => window.UsageDashboard, null, { timeout: 10000 });
    ok('站長工具切換時才載入', await page.locator('#usageDashboard').count() === 1);
    await page.click('#tab-generate');

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
        generateText: document.querySelector('#go') && document.querySelector('#go').textContent,
        duplicateAnnouncements: Array.from(document.querySelectorAll('[role="alert"], [aria-live]:not([aria-live="off"])')).filter((node) => /請先輸入描述文字/.test(node.textContent || '')).length,
      };
    });
    ok('空 prompt 錯誤可被螢幕閱讀器讀到', emptyPromptA11y.invalid === 'true' && emptyPromptA11y.errormessage === 'status' && emptyPromptA11y.statusRole === 'alert' && emptyPromptA11y.statusLive === 'assertive', JSON.stringify(emptyPromptA11y));
    ok('空 prompt 後焦點回到中文輸入框', emptyPromptA11y.activeId === 'plainPrompt', JSON.stringify(emptyPromptA11y));
    ok('空 prompt 保留生成按鈕原始語意', /生成圖片/.test(emptyPromptA11y.generateText || '') && !/重試/.test(emptyPromptA11y.generateText || ''), JSON.stringify(emptyPromptA11y));
    ok('空 prompt 只由單一 live alert 宣告', emptyPromptA11y.duplicateAnnouncements === 1, JSON.stringify(emptyPromptA11y));

    await page.keyboard.type(promptText);
    const invalidAfterTyping = await page.locator('#plainPrompt').getAttribute('aria-invalid');
    ok('輸入後清除欄位錯誤狀態', invalidAfterTyping === null, String(invalidAfterTyping));

    await page.focus('#completePrompt');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const button = document.querySelector('#completePrompt');
      return button && button.getAttribute('aria-busy') === 'true' && button.disabled;
    }, null, { timeout: 10000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const button = document.querySelector('#completePrompt');
      const prompt = document.querySelector('#plainPrompt');
      return button && prompt && button.getAttribute('aria-busy') === null && !button.disabled && /構圖完整/.test(prompt.value);
    }, null, { timeout: 10000 });
    ok('中文補全按鈕可用鍵盤操作並恢復狀態', counters.complete === 1, JSON.stringify(counters));
    ok('中文補全完成後顯示總耗時', /耗時 \d+\.\d 秒/.test(await page.locator('#transformStatus').innerText()));

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
        goText: go && go.textContent,
        imageAlt: image && image.getAttribute('alt'),
      };
    });
    ok('鍵盤主流程可完成生成並恢復可操作狀態', /完成/.test(doneA11y.statusText || '') && doneA11y.statusRole === 'status' && doneA11y.statusLive === 'polite' && doneA11y.stageBusy === 'false' && doneA11y.goBusy === 'false' && doneA11y.goDisabled === 'false', JSON.stringify(doneA11y));
    ok('成功後結果操作與圖片替代文字可用', doneA11y.actionsHidden === false && doneA11y.imageAlt === '生成完成的圖片', JSON.stringify(doneA11y));
    ok('成功後主要 CTA 保持生成語意', /生成圖片/.test(doneA11y.goText || '') && !/再生成|重試/.test(doneA11y.goText || ''), JSON.stringify(doneA11y));
    const resultTargets = await page.locator('#resultActions > .btn, #resultActions > details > summary').evaluateAll((nodes) => nodes
      .filter((node) => !node.hidden)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.id || node.textContent.trim(), width: rect.width, height: rect.height };
      }));
    ok('結果主要操作目標至少 44px', resultTargets.every((item) => item.height >= 44), JSON.stringify(resultTargets));
    ok('鍵盤重複 Enter 未造成重複請求', counters.generate === 1, JSON.stringify(counters));

    await page.locator('#advancedSettings').evaluate((element) => {
      element.open = true;
    });
    await page.fill('#effectPrompt', '更夢幻');
    await page.click('#applyEffect');
    await page.waitForFunction(() => {
      const prompt = document.querySelector('#prompt');
      const status = document.querySelector('#status');
      return prompt && status && /dreamy ethereal/.test(prompt.value) && /離線強化/.test(status.textContent || '');
    }, null, { timeout: 10000 });
    ok('效果強化在離線 fallback 下仍可操作', counters.enhance === 1, JSON.stringify(counters));
    ok('AI 效果強化完成後顯示總耗時', /耗時 \d+\.\d 秒/.test(await page.locator('#status').innerText()));

    // 調參欄位（devSteps/devCfgScale）合併後永遠顯示，走到結果按鈕需要多幾步。
    const tabStops = await collectTabStops(page, 20);
    ok('成功後結果操作可用鍵盤抵達', tabStops.indexOf('dl') !== -1 || tabStops.indexOf('regenerate') !== -1 || tabStops.indexOf('copyPrompt') !== -1, JSON.stringify(tabStops));

    await page.fill('#plainPrompt', '全新的產品攝影描述');
    const stalePromptState = await page.evaluate(() => ({
      providerPrompt: document.querySelector('#prompt') && document.querySelector('#prompt').value,
      autoSource: document.querySelector('#prompt') && document.querySelector('#prompt').getAttribute('data-auto-source'),
    }));
    ok('修改中文描述會清除舊的自動英文提示詞', stalePromptState.providerPrompt === '' && stalePromptState.autoSource === null, JSON.stringify(stalePromptState));

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
