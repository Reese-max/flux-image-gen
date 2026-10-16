const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const staticDir = path.resolve(__dirname, '../../app/static');
const records = [
  {
    id: 'export-1', image: 'data:image/png;base64,cG5n', prompt: '雨夜的貓',
    providerPrompt: 'A cat on a rainy night', negativePrompt: 'blur',
    model: 'dev', size: 'portrait', seed: 123, steps: 45, cfgScale: 4,
    width: 768, height: 1344, provider: 'demo', createdAt: '2026-10-01T12:00:00Z',
    tags: ['測試'], favorite: true, versionGroupId: 'group-1', versionNumber: 2,
    sourceRecordId: 'export-0', cloudDeleteUrl: 'https://example.test/delete/fixture'
  },
  { id: 'export-2', image: 'data:image/png;base64,cG5n', prompt: '森林', seed: 456, createdAt: '2026-10-01T11:00:00Z' }
];

function setup({ failure, unsupported, empty = false, confirm = true } = {}) {
  const blobs = [];
  const clicks = [];
  const revoked = [];
  const timers = [];
  const toasts = [];
  const confirmations = [];
  const listeners = {};
  const elements = {};
  let writes = 0;
  for (const id of ['historyDetailModal', 'historySearch', 'exportHistoryJson', 'exportAllHistoryJson']) {
    elements[id] = { value: '', addEventListener: (event, fn) => { listeners[id + ':' + event] = fn; } };
  }
  const body = {
    appendChild(link) {
      if (failure === 'append') throw new Error('append failed');
      link.parentNode = body;
    },
    removeChild(link) { link.parentNode = null; }
  };
  const context = vm.createContext({
    Blob: unsupported === 'Blob' ? undefined : failure === 'blob' ? function () { throw new Error('Blob failed'); } : Blob,
    URL: unsupported === 'URL' ? undefined : {
      createObjectURL(blob) {
        if (failure === 'url') throw new Error('URL failed');
        blobs.push(blob);
        return 'blob:export-' + blobs.length;
      },
      revokeObjectURL(url) { revoked.push(url); }
    },
    JSON: failure === 'stringify' ? { parse: JSON.parse, stringify() { throw new Error('JSON failed'); } } : JSON,
    localStorage: {
      getItem: () => JSON.stringify(empty ? [] : records),
      setItem() { writes += 1; }
    },
    confirm(message) { confirmations.push(message); return confirm; },
    ImageGenApp: { setStatus() {}, showToast: (text, type) => toasts.push({ text, type }) },
    document: {
      body,
      getElementById: (id) => elements[id] || null,
      addEventListener: (event, fn) => { listeners[event] = fn; },
      createElement: () => ({
        click() {
          if (failure === 'click') throw new Error('click failed');
          assert.equal(this.parentNode, body);
          clicks.push(this);
        }
      })
    },
    setTimeout(fn, delay) { timers.push({ fn, delay }); }
  });
  for (const file of ['history-store.js', 'history-wall.js']) {
    vm.runInContext(fs.readFileSync(path.join(staticDir, file), 'utf8'), context, { filename: file });
  }
  listeners.DOMContentLoaded();
  if (!empty) context.ImageHistoryWall.openHistoryDetail(records[0]);
  return { context, listeners, elements, blobs, clicks, revoked, timers, toasts, confirmations, writes: () => writes };
}

test('single JSON export preserves the normalized record and keeps its URL alive until delayed cleanup', async () => {
  const env = setup();
  env.listeners['exportHistoryJson:click']();
  assert.equal(env.clicks.length, 1);
  assert.equal(env.clicks[0].download, 'history_export-1.json');
  assert.equal(env.blobs[0].type, 'application/json');
  assert.deepEqual(JSON.parse(await env.blobs[0].text()), JSON.parse(JSON.stringify(env.context.ImageHistoryStore.normalizeRecord(records[0]))));
  assert.deepEqual(env.revoked, [], 'JSON Blob URL must not be revoked synchronously after click');
  assert.ok(env.timers.some(({ delay }) => delay >= 1000), 'download cleanup must be deferred');
  assert.equal(env.toasts.at(-1).type, 'done');
  assert.match(env.confirmations[0], /完整中文描述.*雲端分享或刪除連結/);
  env.timers.forEach(({ fn }) => fn());
  assert.deepEqual(env.revoked, ['blob:export-1']);
  assert.equal(env.clicks[0].parentNode, null);
  assert.equal(env.writes(), 0);
});

test('export-all button backs up every record despite filters and round-trips through the existing store', async () => {
  const env = setup();
  env.elements.historySearch.value = '雨夜';
  env.context.ImageHistoryWall.applyHistoryFilters();
  assert.equal(env.context.ImageHistoryWall.recordMatchesFilters(records[1]), false);
  assert.equal(typeof env.listeners['exportAllHistoryJson:click'], 'function', 'export-all button must be wired');
  env.listeners['exportAllHistoryJson:click']();
  assert.match(env.clicks[0].download, /^history_backup_.*\.json$/);
  const text = await env.blobs[0].text();
  const payload = JSON.parse(text);
  assert.equal(payload.schema, 'GenerationRecordCollection');
  assert.equal(payload.version, env.context.ImageHistoryStore.COLLECTION_VERSION);
  assert.equal(payload.records.length, records.length);
  let saved;
  const storage = { setItem: (key, value) => { saved = value; }, getItem: () => saved };
  const store = env.context.ImageHistoryStore;
  const restored = store.saveRecords(store.parseRecords(text), storage);
  assert.deepEqual(JSON.parse(JSON.stringify(store.loadRecords(storage))), payload.records);
  assert.equal(restored.length, records.length);
  assert.equal(env.toasts.at(-1).type, 'done');
  assert.equal(env.writes(), 0);
});

for (const action of ['exportHistoryJson', 'exportAllHistoryJson']) {
  test(action + ' cancellation gives visible feedback without allocating a download', () => {
    const env = setup({ confirm: false });
    assert.equal(typeof env.listeners[action + ':click'], 'function');
    env.listeners[action + ':click']();
    assert.equal(env.blobs.length, 0);
    assert.equal(env.clicks.length, 0);
    assert.match(env.toasts.at(-1)?.text || '', /已取消匯出/);
    assert.equal(env.toasts.at(-1)?.type, 'warn');
    assert.equal(env.timers.length, 0, 'cancelled export must not schedule a delayed download');
  });

  for (const failure of ['stringify', 'blob', 'url', 'append', 'click']) {
    test(action + ' catches ' + failure + ' failure, reports it and cleans up any allocated URL', () => {
      const env = setup({ failure });
      assert.equal(typeof env.listeners[action + ':click'], 'function');
      assert.doesNotThrow(() => env.listeners[action + ':click']());
      assert.equal(env.toasts.at(-1)?.type, 'fail');
      assert.match(env.toasts.at(-1)?.text || '', /匯出.*失敗/);
      assert.equal(env.clicks.length, 0);
      assert.equal(env.revoked.length, env.blobs.length);
      assert.equal(env.writes(), 0);
    });
  }

  for (const unsupported of ['Blob', 'URL']) {
    test(action + ' handles missing ' + unsupported + ' support', () => {
      const env = setup({ unsupported });
      assert.equal(typeof env.listeners[action + ':click'], 'function');
      assert.doesNotThrow(() => env.listeners[action + ':click']());
      assert.equal(env.toasts.at(-1)?.type, 'fail');
      assert.equal(env.blobs.length, 0);
    });
  }

  test(action + ' handles empty history without a download', () => {
    const env = setup({ empty: true });
    assert.equal(typeof env.listeners[action + ':click'], 'function');
    env.listeners[action + ':click']();
    assert.equal(env.clicks.length, 0);
    assert.equal(env.toasts.at(-1)?.type, 'warn');
  });
}
