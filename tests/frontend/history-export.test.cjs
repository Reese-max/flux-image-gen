const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const historyWallJsPath = path.resolve(__dirname, '../../app/static/history-wall.js');
const historyWallJsSource = fs.readFileSync(historyWallJsPath, 'utf8');

function setupEnvironment() {
  const listeners = {};
  const elements = {};
  const timers = [];
  const revoked = [];
  const createdUrls = [];
  const statuses = [];
  const anchors = [];

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

  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      if (tag === 'a') {
        const anchor = {
          href: '',
          download: '',
          parentNode: null,
          clicked: false,
          click() { this.clicked = true; },
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
      appendChild(node) { node.parentNode = this; },
      removeChild(node) { if (node.parentNode === this) { node.parentNode = null; } }
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
    confirm: () => true,
    URL: {
      createObjectURL(blob) {
        const url = 'blob:fake-' + createdUrls.length;
        createdUrls.push({ url, blob });
        return url;
      },
      revokeObjectURL(url) { revoked.push(url); }
    },
    ImageHistoryStore: {
      loadRecords: () => [record],
      findRecordById: (list, id) => list.find((item) => item && item.id === id) || null,
      normalizeRecord: (value) => value
    },
    ImageGenApp: {
      setStatus(text, cls) { statuses.push({ text, cls }); }
    }
  };

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
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {}
  });
  context.globalThis = window;

  vm.runInContext(historyWallJsSource, context, { filename: historyWallJsPath });
  (listeners['DOMContentLoaded'] || []).forEach((handler) => handler());

  function runDeferred() {
    while (timers.length) {
      timers.shift()();
    }
  }

  return { window, record, anchors, revoked, createdUrls, statuses, runDeferred };
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

  // Issue #8: revoking the blob URL synchronously after click() cancels the
  // download before the browser can start it. The URL must stay alive until a
  // deferred task runs, exactly like downloadHistoryImage.
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
