const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const historyWallJsPath = path.resolve(__dirname, '../../app/static/history-wall.js');
const historyWallJsSource = fs.readFileSync(historyWallJsPath, 'utf8');
const historyStoreJsSource = fs.readFileSync(path.resolve(__dirname, '../../app/static/history-store.js'), 'utf8');

function setupEnvironment({ removeItemFails } = {}) {
  const listeners = {};
  const elements = {};
  const statuses = [];
  const timers = [];

  const records = [{
    id: 'rec-1',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    prompt: '貓咪在花園',
    model: 'schnell',
    size: 'square',
    seed: 42,
    createdAt: '2026-11-01T00:00:00.000Z'
  }];
  let stored = JSON.stringify(records);
  let removed = false;

  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      children: [],
      firstChild: null,
      appendChild(child) { this.children.push(child); },
      removeChild() {},
      addEventListener() {},
      setAttribute() {},
      classList: { add() {}, remove() {}, toggle() {} }
    }),
    body: { appendChild() {}, removeChild() {} },
    addEventListener: (type, handler) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    }
  };

  const window = {
    crypto: require('node:crypto').webcrypto,
    document,
    addEventListener() {},
    localStorage: {
      getItem: () => stored,
      setItem: (_key, value) => { stored = value; },
      removeItem: () => {
        if (removeItemFails) { throw new Error('storage denied'); }
        removed = true;
        stored = '[]';
      }
    },
    confirm: () => true,
    ImageGenApp: {
      setStatus(text, cls) { statuses.push({ text, cls }); },
      showToast(text, cls) { statuses.push({ text, cls }); }
    }
  };

  elements.clearHistory = {
    hidden: false,
    disabled: false,
    addEventListener(_type, handler) { this.handler = handler; },
    click() { this.handler(); }
  };
  elements.historyGrid = { firstChild: null, appendChild() {}, removeChild() {} };

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
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {}
  });
  context.globalThis = window;

  vm.runInContext(historyStoreJsSource, context);
  vm.runInContext(historyWallJsSource, context, { filename: historyWallJsPath });
  (listeners['DOMContentLoaded'] || []).forEach((handler) => handler());

  return { window, elements, statuses, isRemoved: () => removed, getStored: () => stored };
}

test('history wall shows a failure message when clearRecords cannot remove storage', () => {
  const { elements, statuses, isRemoved } = setupEnvironment({ removeItemFails: true });

  elements.clearHistory.click();

  assert.equal(isRemoved(), false);
  assert.ok(statuses.some((entry) => entry.cls === 'fail' && entry.text === '歷史記錄清除失敗'),
    'the clear failure must surface as a fail status');
  assert.ok(!statuses.some((entry) => entry.text === '已清空歷史記錄'),
    'history must not be reported as cleared when removal failed');
});

test('history wall reports success only after clearRecords removes storage', () => {
  const { elements, statuses, isRemoved } = setupEnvironment();

  elements.clearHistory.click();

  assert.equal(isRemoved(), true);
  assert.ok(statuses.some((entry) => entry.cls === 'done' && entry.text === '已清空歷史記錄'));
});
