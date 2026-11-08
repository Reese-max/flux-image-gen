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
    dispatchEvent: (event) => Promise.all((listeners[event.type] || []).map(handler => handler(event)))
  };

  const window = {
    crypto: require('node:crypto').webcrypto,
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
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    atob,
    btoa,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout: (fn, delay) => { timers.push(fn); timerDelays.push(delay); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {}
  });
  context.globalThis = window;

  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/static/provenance.js'), 'utf8'), context);
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

// The three original PR #19 behaviors are exercised through the current
// public history API and privacy-preserving receipt/export implementation.
test('PR19 JSON export clicks a blob link and defers revocation until download consumption', async () => {
  const env = setupEnvironment({ useRealStore: true });
  env.window.ImageHistoryWall.openHistoryDetail(env.record);
  env.window.ImageHistoryWall.exportHistoryJson();
  assert.equal(env.anchors.length, 1);
  assert.equal(env.anchors[0].clicked, true);
  assert.equal(env.anchors[0].download, 'history_rec-1.json');
  assert.match(env.anchors[0].href, /^blob:/);
  assert.equal(JSON.parse(await env.createdUrls[0].blob.text()).id, 'rec-1');
  assert.deepEqual(env.revoked, []);
  assert.deepEqual(env.timerDelays, [30000]);
  env.runDeferred();
  assert.deepEqual(env.revoked, [env.anchors[0].href]);
});

test('PR19 single-work JSON export preserves selected settings while redacting capabilities', async () => {
  const record = {
    id: 'record-one', prompt: '晨霧中的山景', providerPrompt: 'mountains in morning mist',
    negativePrompt: 'blurry api_key=synthetic-private-value', model: 'dev', size: 'portrait',
    steps: 28, cfgScale: 5, seed: 123, provider: 'nvidia',
    createdAt: '2026-10-02T00:00:00.000Z', image: 'data:image/png;base64,aGVsbG8=',
    cloudShareUrl: 'https://example.invalid/share/item?token=synthetic-private-value',
  };
  const env = setupEnvironment({ records: [record], useRealStore: true });
  env.window.ImageHistoryWall.openHistoryDetail(record);
  env.window.ImageHistoryWall.exportHistoryJson();
  assert.equal(env.anchors[0].download, 'history_record-one.json');
  const saved = JSON.parse(await env.createdUrls[0].blob.text());
  for (const field of ['id', 'prompt', 'providerPrompt', 'model', 'size', 'steps', 'cfgScale', 'seed', 'provider', 'image']) {
    assert.equal(saved[field], record[field], field);
  }
  assert.equal(saved.negativePrompt, 'blurry [redacted]');
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-private-value|cloudShareUrl/);
  assert.equal(env.window.ImageHistoryStore.parseRecords(JSON.stringify(saved))[0].negativePrompt, 'blurry [redacted]');
  assert.match(env.statuses.at(-1).text, /已匯出備份檔/);
});

test('PR19 export-all control downloads a versioned backup with every record', async () => {
  const first = { id: 'one', prompt: '第一張', providerPrompt: 'first', model: 'dev', size: 'square',
    seed: 11, image: 'data:image/png;base64,b25l', createdAt: '2026-10-02T00:00:00.000Z' };
  const second = { id: 'two', prompt: '第二張', providerPrompt: 'second', model: 'dev', size: 'landscape',
    seed: 22, image: 'data:image/jpeg;base64,dHdv', createdAt: '2026-10-02T01:00:00.000Z' };
  const env = setupEnvironment({ records: [first, second], useRealStore: true });
  env.elements.exportAllHistoryJson.click();
  assert.match(env.anchors[0].download, /^history_backup_\d{4}-\d{2}-\d{2}\.json$/);
  const backup = JSON.parse(await env.createdUrls[0].blob.text());
  assert.equal(backup.schema, 'GenerationRecordCollection');
  assert.equal(backup.version, 2);
  assert.deepEqual(backup.records.map(item => [item.id, item.seed]).sort(), [['one', 11], ['two', 22]]);
  assert.match(env.statuses.at(-1).text, /已匯出全部歷史備份檔/);
});

test('PR19 single-work negative prompt remains private without explicit prompt sharing', () => {
  const env = setupEnvironment({ useRealStore: true });
  const record = { ...env.record, negativePrompt: 'private negative prompt' };
  const privateExport = env.window.ImageProvenance.exportArtwork(record);
  assert.doesNotMatch(JSON.stringify(privateExport), /private negative prompt/);
});
