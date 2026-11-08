import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from '../../cloudflare/node_modules/playwright/index.mjs';
import worker from '../../cloudflare/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update'] });
test.after(async () => browser.close());

function json(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

for (const [distribution, directory] of [['python', 'app/static'], ['cloudflare', 'cloudflare/public']]) {
  for (const failedIndex of [0, 1]) {
    for (const variant of ['explicit', 'legacy', 'inconsistent']) {
    test(`${distribution} ${variant} UI/history preserve positions and seeds after failure ${failedIndex}`, { timeout: 45000 }, async () => {
      const staticRoot = path.join(root, directory);
      const calls = [];
      let batchPayload;
      const env = { ENVIRONMENT: 'test', NVIDIA_API_KEY: 'fixture-only' };
      const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/api/health') {
          json(response, { providerStatus: 'demo', mode: 'demo', providers: {}, hasApiKey: false,
            storageAvailable: true, turnstile: { required: false, siteKey: '' } });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/prompt/transform') {
          json(response, { source: 'synthetic', prompt: 'a synthetic cat', provider: 'fixture', warnings: [] });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/client-error') { json(response, { ok: true }); return; }
        if (request.method === 'POST' && url.pathname === '/generate/batch') {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const realFetch = globalThis.fetch;
          globalThis.fetch = async (url, options) => {
            assert.match(String(url), /^https:\/\/ai\.api\.nvidia\.com\//);
            const fields = JSON.parse(options.body);
            const index = calls.length;
            calls.push({ fields });
            if (index === failedIndex) return new Response(JSON.stringify({ error: 'synthetic rejection' }), { status: 422 });
            return new Response(JSON.stringify({ artifacts: [{ base64: Buffer.concat([png, Buffer.from([index])]).toString('base64') }] }));
          };
          let result;
          try {
            result = await worker.fetch(new Request('https://fixture.invalid/generate/batch', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks),
            }), env);
          } finally { globalThis.fetch = realFetch; }
          batchPayload = await result.json();
          if (variant === 'legacy') batchPayload.images.forEach(item => delete item.index);
          if (variant === 'inconsistent') {
            batchPayload.images[0].index = failedIndex;
            delete batchPayload.images[1].index;
          }
          response.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(batchPayload));
          return;
        }
        let file;
        if (url.pathname === '/') file = path.join(staticRoot, 'index.html');
        else if (url.pathname === '/service-worker.js') file = path.join(staticRoot, 'service-worker.js');
        else if (url.pathname.startsWith('/static/')) {
          const leaf = url.pathname.slice('/static/'.length);
          file = path.join(staticRoot, distribution === 'python' ? leaf : path.join('static', leaf));
        }
        if (!file || !path.resolve(file).startsWith(path.resolve(root) + path.sep)) { response.writeHead(404).end(); return; }
        try {
          const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript'
            : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
          response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(await readFile(file));
        } catch { response.writeHead(404).end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      // The production UI is loaded only from this synthetic loopback server.
      // Block service workers here so every browser request passes this guard;
      // the separate service-worker test exercises the real worker lifecycle.
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      await context.route('**/*', route => {
        try {
          return new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient');
        } catch { return route.abort('blockedbyclient'); }
      });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
        if (await page.locator('#tutorialModal:not([hidden])').count()) await page.click('#closeTutorial');
        await page.fill('#plainPrompt', '合成貓');
        await page.locator('#advancedSettings > summary').click();
        await page.selectOption('#batchCount', '3');
        await page.click('#go');
        await page.waitForFunction(() => document.querySelectorAll('.batch-thumb').length === 2);
        const indexes = [0, 1, 2].filter(index => index !== failedIndex);
        if (variant === 'explicit') assert.deepEqual(batchPayload.images.map(item => item.index), indexes);
        const expectedLabels = variant === 'inconsistent' ? ['第 1 個結果', '第 2 個結果'] : indexes.map(index => `第 ${index + 1} 張`);
        assert.deepEqual(await page.locator('.batch-thumb-label').allTextContents(), expectedLabels);
        for (const [visible, source] of indexes.entries()) {
          const thumb = page.locator('.batch-thumb').nth(visible);
          assert.equal(await thumb.getAttribute('aria-label'), `檢視${expectedLabels[visible]}生成圖片`);
          assert.equal(await thumb.locator('img').getAttribute('alt'), `生成圖片${expectedLabels[visible]}`);
          await thumb.focus();
          await page.keyboard.press('Enter');
          assert.equal(await thumb.getAttribute('aria-pressed'), 'true');
          const expectedAlt = variant === 'inconsistent' ? `生成圖片結果 ${visible + 1}` : `生成圖片變體第 ${source + 1} 張`;
          assert.equal(await page.locator('.batch-main-image').getAttribute('alt'), expectedAlt);
          assert.match(await page.locator('.batch-seed').textContent(), new RegExp(String(calls[source].fields.seed)));
        }
        await page.waitForFunction(() => window.ImageHistoryStore.loadRecords().length >= 2);
        const saved = await page.evaluate(() => window.ImageHistoryStore.loadRecords().map(item => ({
          batchIndex: item.batchIndex, seed: item.seed, image: item.image,
          singleIndex: window.ImageProvenance.exportArtwork(item, { promptPublic: true }).batchIndex,
          backupIndex: window.ImageProvenance.exportBackupRecord(item).batchIndex,
        })));
        saved.sort((a, b) => indexes.findIndex(index => String(calls[index].fields.seed) === String(a.seed))
          - indexes.findIndex(index => String(calls[index].fields.seed) === String(b.seed)));
        const expectedIndexes = variant === 'inconsistent' ? [undefined, undefined] : indexes;
        assert.deepEqual(saved.map(item => item.batchIndex), expectedIndexes);
        assert.deepEqual(saved.map(item => item.singleIndex), expectedIndexes);
        assert.deepEqual(saved.map(item => item.backupIndex), expectedIndexes);
        assert.deepEqual(saved.map(item => String(item.seed)), indexes.map(index => String(calls[index].fields.seed)));
        assert.deepEqual(saved.map(item => item.image), indexes.map(index =>
          `data:image/png;base64,${Buffer.concat([png, Buffer.from([index])]).toString('base64')}`));
      } finally {
        await context.close();
        await new Promise(resolve => server.close(resolve));
      }
    });
    }
  }
}
