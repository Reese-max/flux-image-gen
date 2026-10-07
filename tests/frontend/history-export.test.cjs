const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const historyWallJsPath = path.resolve(__dirname, '../../app/static/history-wall.js');
const historyWallJsSource = fs.readFileSync(historyWallJsPath, 'utf8');
const historyStoreJsSource = fs.readFileSync(path.resolve(__dirname, '../../app/static/history-store.js'), 'utf8');

function setupEnvironment(options = {}) {
  const listeners = {};
  const elements = {};
  const timers = [];
  const revoked = [];
  const createdUrls = [];
  const statuses = [];
  const toasts = [];
  const anchors = [];
  const timerDelays = [];

  const record = {
    id: 'rec-1',
    prompt: '貓咪在花園',
    providerPrompt: 'a cat in a garden',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    provider: 'nvidia',
    size: 'square',
    seed: 42,
    steps: 10,
    cfgScale: 3
  };
  const records = options.records || [record];
  let stored = JSON.stringify(records);

  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      if (tag === 'a') {
        if (options.fault === 'anchor') { throw new Error('test anchor failure'); }
        const anchor = {
          href: '',
          download: '',
          parentNode: null,
          clicked: false,
          click() {
            if (options.fault === 'click') { throw new Error('test click failure'); }
            this.clicked = true;
          },
          remove() { this.parentNode = null; },
          addEventListener() {},
          setAttribute() {}
        };
        anchors.push(anchor);
        return anchor;
      }
      return {
        tagName: tag.toUpperCase(),
        children: [],
        firstChild: null,
        appendChild(child) { this.children.push(child); },
        removeChild() {},
        addEventListener() {},
        setAttribute() {},
        classList: { add() {}, remove() {}, toggle() {} }
      };
    },
    body: {
      appendChild(node) {
        if (options.fault === 'append') { throw new Error('test append failure'); }
        node.parentNode = this;
      },
      removeChild(node) {
        if (options.fault === 'remove') { throw new Error('test cleanup failure'); }
        if (node.parentNode === this) { node.parentNode = null; }
      }
    },
    addEventListener: (type, handler) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    dispatchEvent: () => true
  };

  const window = {
    document,
    addEventListener() {},
    localStorage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } },
    confirm: () => true,
    URL: {
      createObjectURL(blob) {
        if (options.fault === 'url') { throw new Error('test URL failure'); }
        const url = 'blob:fake-' + createdUrls.length;
        createdUrls.push({ url, blob });
        return url;
      },
      revokeObjectURL(url) { revoked.push(url); }
    },
    ImageHistoryStore: {
      loadRecords: () => records,
      findRecordById: (list, id) => list.find((item) => item && item.id === id) || null,
      normalizeRecord: (value) => value
    },
    ImageGenApp: {
      setStatus(text, cls) { statuses.push({ text, cls }); },
      showToast(text, cls) { toasts.push({ text, cls }); }
    }
  };
  elements.exportAllHistoryJson = {
    hidden: true,
    disabled: true,
    addEventListener(_type, handler) { this.handler = handler; },
    click() { this.handler(); }
  };
  elements.historyGrid = { firstChild: null, appendChild() {}, removeChild() {} };

  elements['historyDetailModal'] = {
    hidden: true,
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {}
  };

  const context = vm.createContext({
    window,
    document,
    navigator: {},
    performance: { now: () => Date.now() },
    console,
    Blob,
    setTimeout: (fn, delay) => { timers.push(fn); timerDelays.push(delay); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {}
  });
  context.globalThis = window;

  if (options.useRealStore) { vm.runInContext(historyStoreJsSource, context); }
  vm.runInContext(historyWallJsSource, context, { filename: historyWallJsPath });
  (listeners['DOMContentLoaded'] || []).forEach((handler) => handler());

  function runDeferred() {
    while (timers.length) {
      timers.shift()();
    }
  }

  return { window, record, anchors, revoked, createdUrls, statuses, toasts, runDeferred, timerDelays, elements, context };
}

test('exportHistoryJson clicks an anchor and keeps the blob URL alive until the download starts', async () => {
  const { window, record, anchors, revoked, createdUrls, statuses, runDeferred } = setupEnvironment();

  window.ImageHistoryWall.openHistoryDetail(record);
  window.ImageHistoryWall.exportHistoryJson();

  assert.equal(anchors.length, 1, 'an anchor should be created for the download');
  const anchor = anchors[0];
  assert.equal(anchor.clicked, true, 'anchor.click() must trigger the download');
  assert.equal(anchor.download, 'history_rec-1.json');
  assert.ok(anchor.href.startsWith('blob:'), 'anchor should point at the blob URL');

  assert.equal(createdUrls.length, 1);
  const exported = JSON.parse(await createdUrls[0].blob.text());
  assert.equal(exported.id, 'rec-1');
  assert.equal(exported.prompt, '貓咪在花園');
  assert.equal(exported.providerPrompt, 'a cat in a garden');

  // Keep the URL alive across tasks to avoid a browser consumption race.
  // Current Chromium can also download the immediate-revoke control; this
  // lifecycle assertion does not establish the original deployed root cause.
  assert.deepEqual(revoked, [], 'blob URL must not be revoked in the same task as click()');
  runDeferred();
  assert.deepEqual(revoked, [createdUrls[0].url], 'blob URL should be revoked by the deferred cleanup');

  assert.ok(statuses.some((entry) => entry.cls === 'done'), 'a success status should be reported');
});

test('exportHistoryJson without a selected record warns and creates no download', () => {
  const { window, anchors, revoked, statuses } = setupEnvironment();

  window.ImageHistoryWall.exportHistoryJson();

  assert.equal(anchors.length, 0);
  assert.deepEqual(revoked, []);
  assert.ok(statuses.some((entry) => entry.cls === 'warn' && entry.text.includes('尚無可匯出')));
});

test('exportHistoryJson honours the confirm dialog cancellation', () => {
  const env = setupEnvironment();
  env.window.confirm = () => false;

  env.window.ImageHistoryWall.openHistoryDetail(env.record);
  env.window.ImageHistoryWall.exportHistoryJson();

  assert.equal(env.anchors.length, 0);
  assert.deepEqual(env.revoked, []);
  assert.ok(env.statuses.some((entry) => entry.cls === 'warn' && entry.text.includes('已取消匯出')));
});

for (const fault of ['serialize', 'url', 'anchor', 'append', 'click', 'remove']) {
  test('exportHistoryJson reports ' + fault + ' failures and reclaims any allocated URL', () => {
    const env = setupEnvironment({ fault });
    env.window.ImageHistoryWall.openHistoryDetail(env.record);
    if (fault === 'serialize') {
      vm.runInContext("JSON.stringify = function () { throw new Error('test serialize failure'); };", env.context);
    }
    let thrown;
    try { env.window.ImageHistoryWall.exportHistoryJson(); } catch (error) { thrown = error; }
    assert.deepEqual(env.revoked, [], 'cleanup remains deferred even when triggering fails');
    const allocated = ['anchor', 'append', 'click', 'remove'].includes(fault);
    assert.equal(env.createdUrls.length, allocated ? 1 : 0);
    assert.deepEqual(env.timerDelays, allocated ? [30000] : []);
    env.runDeferred();
    assert.deepEqual(env.revoked, env.createdUrls.map(item => item.url));
    assert.equal(thrown, undefined, 'download failures must not escape the UI handler');
    assert.ok(env.statuses.some(entry => entry.cls === 'fail'), 'the error must be reported');
    assert.ok(env.toasts.some(entry => entry.text.includes('失敗') || entry.text.includes('無法')), 'failure feedback must reach the history view via a toast');
    assert.ok(!env.statuses.some(entry => entry.cls === 'done'), 'a failed export must not report success');
  });
}

test('export-all button downloads every record and the backup survives a storage roundtrip', async () => {
  const seed = setupEnvironment().record;
  const records = [
    { ...seed, width: 1024, height: 768, tags: ['收藏'], favorite: true, versionGroupId: 'series-1', versionNumber: 1, createdAt: '2026-10-07T00:00:00Z' },
    { ...seed, id: 'rec-2', prompt: '版本二 🌿', negativePrompt: 'blur', sourceRecordId: 'rec-1', versionGroupId: 'series-1', versionNumber: 2, cloudShareUrl: '/s/test', cloudDeleteUrl: '/delete/test', createdAt: '2026-10-07T01:00:00Z' }
  ];
  const env = setupEnvironment({ records, useRealStore: true });
  const store = env.window.ImageHistoryStore;
  const expected = JSON.parse(JSON.stringify(store.loadRecords()));
  assert.equal(env.elements.exportAllHistoryJson.hidden, false);
  assert.equal(env.elements.exportAllHistoryJson.disabled, false);
  env.elements.exportAllHistoryJson.click();
  assert.equal(env.anchors.length, 1);
  assert.equal(env.anchors[0].clicked, true);
  assert.match(env.anchors[0].download, /^history_backup_\d{4}-\d{2}-\d{2}\.json$/);
  const text = await env.createdUrls[0].blob.text();
  const backup = JSON.parse(text);
  assert.equal(backup.schema, 'GenerationRecordCollection');
  assert.equal(backup.version, 2);
  assert.deepEqual(backup.records, expected);
  let restored = '';
  const cleanStorage = { getItem: () => restored, setItem: (_key, value) => { restored = value; } };
  store.saveRecords(store.parseRecords(text), cleanStorage);
  assert.deepEqual(JSON.parse(JSON.stringify(store.loadRecords(cleanStorage))), expected);
  const reexported = store.exportRecordCollection(store.loadRecords(cleanStorage));
  assert.deepEqual(JSON.parse(JSON.stringify(reexported.records)), backup.records);
  env.runDeferred();
  assert.deepEqual(env.revoked, [env.createdUrls[0].url]);
});

test('export-all honours cancellation and hides the button with no history', () => {
  const env = setupEnvironment({ useRealStore: true });
  env.window.confirm = () => false;
  env.elements.exportAllHistoryJson.click();
  assert.equal(env.createdUrls.length, 0);
  assert.ok(env.statuses.some(entry => entry.cls === 'warn' && entry.text.includes('已取消')));
  const empty = setupEnvironment({ records: [], useRealStore: true });
  assert.equal(empty.elements.exportAllHistoryJson.hidden, true);
  assert.equal(empty.elements.exportAllHistoryJson.disabled, true);
  empty.window.ImageHistoryWall.exportAllHistoryJson();
  assert.equal(empty.createdUrls.length, 0);
  assert.ok(empty.statuses.some(entry => entry.cls === 'warn' && entry.text.includes('尚無可匯出')));
});
