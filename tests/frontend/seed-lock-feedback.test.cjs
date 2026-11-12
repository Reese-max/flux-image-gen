const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appJsPath = path.resolve(__dirname, '../../app/static/app.js');
const appJsSource = fs.readFileSync(appJsPath, 'utf8');

function setupEnvironment() {
  const listeners = {};
  const elements = {};

  function makeElement(id, tag = 'div') {
    const classList = new Set();
    const attrs = {};
    return {
      id: id,
      tagName: tag.toUpperCase(),
      textContent: '',
      className: '',
      hidden: false,
      value: '',
      classList: {
        add: (...cls) => cls.forEach(c => classList.add(c)),
        remove: (...cls) => cls.forEach(c => classList.delete(c)),
        toggle: (c, force) => {
          if (force === undefined) {
            classList.has(c) ? classList.delete(c) : classList.add(c);
          } else if (force) {
            classList.add(c);
          } else {
            classList.delete(c);
          }
        },
        contains: (c) => classList.has(c)
      },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] !== undefined ? attrs[k] : null,
      removeAttribute: (k) => { delete attrs[k]; },
      appendChild: () => {},
      addEventListener: (type, handler) => {
        listeners[id + ':' + type] = listeners[id + ':' + type] || [];
        listeners[id + ':' + type].push(handler);
      },
      focus: () => {}
    };
  }

  // Setup DOM elements needed by app.js seed lock & toast
  elements['appToast'] = makeElement('appToast');
  elements['seedLockTooltip'] = makeElement('seedLockTooltip');
  elements['seedLock'] = makeElement('seedLock', 'button');
  elements['seedRandom'] = makeElement('seedRandom', 'button');
  elements['seedModeHint'] = makeElement('seedModeHint', 'p');
  elements['seed'] = makeElement('seed', 'input');
  elements['status'] = makeElement('status');
  elements['prompt'] = makeElement('prompt', 'textarea');
  elements['plainPrompt'] = makeElement('plainPrompt', 'textarea');
  elements['avoid'] = makeElement('avoid', 'textarea');
  elements['model'] = makeElement('model', 'select');
  elements['size'] = makeElement('size', 'select');

  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement('', tag),
    addEventListener: (type, handler) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    dispatchEvent: () => true
  };

  const window = {
    document: document,
    addEventListener: () => {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    location: { href: 'http://localhost/', pathname: '/', hash: '', search: '' },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  };

  const context = vm.createContext({
    window: window,
    document: document,
    navigator: { userAgent: 'test-agent' },
    performance: { now: () => 1000 },
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, opt) { this.type = type; this.detail = opt ? opt.detail : null; } },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval
  });
  context.globalThis = window;

  vm.runInContext(appJsSource, context, { filename: appJsPath });
  return { context, window, elements };
}

test('showToast displays message and applies correct styling classes', () => {
  const { window, elements } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;
  assert.ok(ImageGenApp, 'ImageGenApp should be exposed');
  assert.equal(typeof ImageGenApp.showToast, 'function');

  ImageGenApp.showToast('測試通知', 'warn');
  const toast = elements['appToast'];
  assert.equal(toast.textContent, '測試通知');
  assert.equal(toast.hidden, false);
  assert.equal(toast.getAttribute('aria-hidden'), 'false');
  assert.ok(toast.classList.contains('is-visible'));
  assert.ok(toast.className.includes('is-warn'));
});

test('showSeedLockFeedback activates tooltip, toast, shake, and hint warning', () => {
  const { window, elements } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;
  assert.equal(typeof ImageGenApp.showSeedLockFeedback, 'function');

  ImageGenApp.showSeedLockFeedback('先生成一張圖，才能鎖定它的構圖');

  const tooltip = elements['seedLockTooltip'];
  const hint = elements['seedModeHint'];
  const lockBtn = elements['seedLock'];
  const toast = elements['appToast'];
  const status = elements['status'];

  // Tooltip
  assert.equal(tooltip.textContent, '先生成一張圖，才能鎖定它的構圖');
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.getAttribute('aria-hidden'), 'false');
  assert.ok(tooltip.classList.contains('is-visible'));

  // Toast
  assert.equal(toast.textContent, '先生成一張圖，才能鎖定它的構圖');
  assert.ok(toast.classList.contains('is-visible'));

  // Button Shake
  assert.ok(lockBtn.classList.contains('is-shake'));

  // Hint
  assert.ok(hint.textContent.includes('先生成一張圖'));
  assert.ok(hint.classList.contains('is-warn'));

  // Status
  assert.equal(status.textContent, '先生成一張圖，才能鎖定它的構圖');
});

test('onSeedLockClick provides immediate warning feedback when no image generated and seed is empty', () => {
  const { window, elements } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;

  // No generation, seed empty
  elements['seed'].value = '';
  ImageGenApp.onSeedLockClick();

  const tooltip = elements['seedLockTooltip'];
  const toast = elements['appToast'];
  assert.equal(tooltip.hidden, false);
  assert.ok(tooltip.classList.contains('is-visible'));
  assert.equal(toast.textContent, '先生成一張圖，才能鎖定它的構圖');
  assert.ok(elements['seedLock'].classList.contains('is-shake'));
});

test('onSeedLockClick successfully locks when concrete seed exists and shows positive toast', () => {
  const { window, elements } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;

  // Set a concrete seed in input
  elements['seed'].value = '424242';
  ImageGenApp.onSeedLockClick();

  const toast = elements['appToast'];
  assert.equal(toast.textContent, '已鎖定構圖，改描述後按生成即可微調');
  assert.ok(toast.className.includes('is-done'));
  assert.equal(elements['seedLock'].getAttribute('aria-pressed'), 'true');
});

test('useComposition warns when no generation is present', () => {
  const { window, elements } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;

  ImageGenApp.useComposition();

  const toast = elements['appToast'];
  assert.equal(toast.textContent, '尚無可鎖定構圖的圖片，請先生成一張圖');
  assert.ok(toast.className.includes('is-warn'));
});
