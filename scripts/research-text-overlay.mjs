// Offline research for #26. This creates fixtures, never a product control.
// Run after npm ci --prefix cloudflare and Playwright Chromium installation:
// node scripts/research-text-overlay.mjs [output-directory]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(path.join(root, 'cloudflare/package.json'))('playwright');
const output = path.resolve(process.argv[2] || path.join(root, 'output/research/text-overlay'));
const fixtures = [
  { id: 'poster', text: '明日開幕', width: 480, height: 600 },
  { id: 'thumbnail', text: '三分鐘看懂', width: 640, height: 360 },
  { id: 'social', text: '秋季限定', width: 480, height: 480 },
];
const store = await readFile(path.join(root, 'app/static/history-store.js'));
const server = createServer((request, response) => {
  if (request.url === '/history-store.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' }).end(store);
  } else {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
      <style>@font-face {font-family: FixtureCJK; src: local("Noto Sans CJK TC");}</style>
      <button id="download">Download fixture</button><script src="/history-store.js"></script>`);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  let blockedRequests = 0;
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { blockedRequests += 1; await route.abort(); }
  });
  const page = await context.newPage();
  await page.goto(origin);
  const results = [];
  for (const fixture of fixtures) {
    const started = performance.now();
    const value = await page.evaluate(async (f) => {
      const loaded = await document.fonts.load('40px FixtureCJK', f.text);
      if (loaded.length !== 1) throw new Error('Noto Sans CJK TC unavailable');
      const canvas = document.createElement('canvas');
      canvas.width = f.width; canvas.height = f.height;
      const ctx = canvas.getContext('2d');
      function draw(text) {
        ctx.fillStyle = '#123348'; ctx.fillRect(0, 0, f.width, f.height);
        ctx.fillStyle = '#29627c'; ctx.fillRect(24, 24, f.width - 48, f.height - 48);
        ctx.font = '40px FixtureCJK'; ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, f.width / 2, f.height / 2);
        return canvas.toDataURL('image/png');
      }
      const baseline = draw('');
      const image = draw(f.text);
      const wrong = draw(f.text.slice(0, -1) + '錯');
      const glyphs = Array.from(f.text).map((character) => ({
        character, codepoint: character.codePointAt(0),
        width: ctx.measureText(character).width,
        raster: draw(character),
      }));
      const missingGlyph = draw('\u0378');
      const parent = ImageHistoryStore.normalizeRecord({ id: f.id + '-source',
        prompt: 'Synthetic background', localImageData: baseline, width: f.width,
        height: f.height, provider: 'demo', createdAt: '2026-10-04T00:00:00Z' });
      const derived = ImageHistoryStore.createVersionRecord([parent], parent, {
        id: f.id + '-derived', prompt: f.text, localImageData: image,
        width: f.width, height: f.height, provider: 'demo',
        createdAt: '2026-10-04T00:00:01Z',
        credentialStatus: 'unknown_after_transform',
      });
      ImageHistoryStore.saveRecords([parent, derived]);
      const saved = ImageHistoryStore.loadRecords();
      const backup = ImageHistoryStore.exportRecordCollection(saved);
      const imported = ImageHistoryStore.parseRecords(JSON.stringify(backup));
      window.fixtureImage = image;
      document.querySelector('#download').onclick = () => {
        const a = document.createElement('a'); a.href = image;
        a.download = f.id + '.png'; a.click();
      };
      return { image, baseline, wrong, glyphs, missingGlyph, saved, imported,
        fontLoaded: loaded.length, credentialsRetained: Object.hasOwn(derived, 'credentialStatus') };
    }, fixture);
    assert.equal(value.fontLoaded, 1);
    assert.equal(value.glyphs.map((g) => g.character).join(''), fixture.text);
    assert.ok(value.glyphs.every((g) => g.width > 0));
    assert.ok(value.glyphs.every((g) => g.raster !== value.missingGlyph),
      'requested glyphs must differ from the unassigned-codepoint control');
    assert.notEqual(value.image, value.baseline);
    assert.notEqual(value.image, value.wrong, 'wrong-last-character control must differ');
    const record = value.imported.find((item) => item.id === fixture.id + '-derived');
    assert.equal(record.localImageData, value.image);
    assert.equal(record.prompt, fixture.text);
    assert.equal(record.sourceRecordId, fixture.id + '-source');
    assert.equal(record.versionGroupId, fixture.id + '-source');
    assert.equal(record.versionNumber, 2);
    assert.equal(value.saved.length, 2);
    const downloadEvent = page.waitForEvent('download');
    await page.click('#download');
    const download = await downloadEvent;
    await download.saveAs(path.join(output, fixture.id + '.png'));
    const bytes = await readFile(path.join(output, fixture.id + '.png'));
    assert.deepEqual(bytes, Buffer.from(value.image.split(',')[1], 'base64'));
    assert.equal(bytes.readUInt32BE(16), fixture.width);
    assert.equal(bytes.readUInt32BE(20), fixture.height);
    // This is a deliberately explicit current-main limitation, not a pass.
    assert.equal(value.credentialsRetained, false);
    results.push({ ...fixture, pngSha256: createHash('sha256').update(bytes).digest('hex'),
      pngBytes: bytes.length, runtimeMs: Math.round(performance.now() - started),
      canvasAndDownload: 'PASS', historyExportImportLineage: 'PASS',
      credentialStatusInCurrentHistory: 'UNSUPPORTED', glyphs: value.glyphs.map(({ raster, ...glyph }) => ({
        ...glyph, pngSha256: createHash('sha256').update(Buffer.from(raster.split(',')[1], 'base64')).digest('hex'),
      })) });
  }
  await page.reload();
  const reopened = await page.evaluate(() => ImageHistoryStore.loadRecords());
  assert.equal(reopened.length, 2);
  assert.equal(reopened[1].sourceRecordId, 'social-source');
  assert.equal(blockedRequests, 0);
  const report = { method: 'Browser Canvas with synthetic backgrounds, local CJK font',
    sourceRepoSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    node: process.version,
    browser: browser.version(), sourceHistorySha256: createHash('sha256').update(store).digest('hex'),
    fixtures: results, reopen: 'PASS', providerCalls: 0, networkEgress: 0,
    decision: 'NARROW', humanHandoffTime: 'NOT_MEASURED',
    credentialPreservation: 'NOT_ESTABLISHED; re-encoded output is unknown_after_transform',
    productionImplementation: false };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
