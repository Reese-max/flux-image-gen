import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from '../../cloudflare/node_modules/playwright/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update'] });
test.after(async () => browser.close());

for (const [label, directory] of [
  ['Python static distribution', 'app/static'],
  ['Cloudflare static distribution', 'cloudflare/public/static'],
]) {
  test(`${label}: real service worker installs and serves the app shell offline`, { timeout: 25000 }, async () => {
    const staticRoot = path.join(root, directory);
    const workerPath = label.startsWith('Python')
      ? path.join(staticRoot, 'service-worker.js')
      : path.join(root, 'cloudflare/public/service-worker.js');
    const fixtureHtml = '<!doctype html><title>offline fixture</title><p>offline shell</p>';
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixtureHtml);
        return;
      }
      const file = pathname === '/service-worker.js' ? workerPath
        : pathname.startsWith('/static/') ? path.join(staticRoot, pathname.slice('/static/'.length)) : null;
      if (!file || !path.resolve(file).startsWith(path.resolve(root) + path.sep)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const data = await readFile(file);
        const contentType = file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
        response.writeHead(200, { 'content-type': contentType }).end(data);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    try {
      const page = await context.newPage();
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.goto(origin);
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register('/service-worker.js');
        const worker = registration.installing || registration.waiting || registration.active;
        if (!worker) throw new Error('Service worker did not start');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Service worker activation timed out')), 15000);
          function check() {
            if (worker.state === 'activated') { clearTimeout(timer); resolve(); }
            if (worker.state === 'redundant') { clearTimeout(timer); reject(new Error('Service worker installation failed')); }
          }
          worker.addEventListener('statechange', check);
          check();
        });
        await navigator.serviceWorker.ready;
      });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.reload();
      assert.equal(await page.title(), 'offline fixture');
      const cachedProvenance = await page.evaluate(async () => {
        const response = await fetch('/static/provenance.js');
        return { ok: response.ok, content: await response.text() };
      });
      assert.equal(cachedProvenance.ok, true);
      assert.equal(cachedProvenance.content, await readFile(path.join(staticRoot, 'provenance.js'), 'utf8'));
    } finally {
      await context.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
