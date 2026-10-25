const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appJsPath = path.resolve(__dirname, '../../app/static/app.js');
const appJsSource = fs.readFileSync(appJsPath, 'utf8');
const historyWallJsPath = path.resolve(__dirname, '../../app/static/history-wall.js');
const historyWallJsSource = fs.readFileSync(historyWallJsPath, 'utf8');

function setupEnvironment() {
  const listeners = {};
  const elements = {};

  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      setAttribute: () => {},
      getAttribute: () => null,
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      appendChild: () => {},
      addEventListener: () => {}
    }),
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
  return { context, window };
}

test('providerNoteFor maps pollinations and all providers consistently', () => {
  const { window } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;
  assert.ok(ImageGenApp, 'ImageGenApp should be exposed');
  assert.equal(typeof ImageGenApp.providerNoteFor, 'function');

  // Issue #3: Pollinations must NOT default to NVIDIA FLUX
  assert.equal(ImageGenApp.providerNoteFor('pollinations'), '（Pollinations FLUX）');

  // Other standard providers
  assert.equal(ImageGenApp.providerNoteFor('nvidia'), '（NVIDIA FLUX）');
  assert.equal(ImageGenApp.providerNoteFor('workers-ai'), '（Workers AI FLUX）');
  assert.equal(ImageGenApp.providerNoteFor('demo'), '（示範圖片，圖片服務連接後可產生正式圖片）');
  assert.equal(ImageGenApp.providerNoteFor('nvidia-fallback'), '（Workers AI 忙碌，已自動改用 NVIDIA FLUX 備援）');

  // Fallback / legacy behavior
  assert.equal(ImageGenApp.providerNoteFor(''), '（NVIDIA FLUX）');
  assert.equal(ImageGenApp.providerNoteFor(null), '（NVIDIA FLUX）');
  assert.equal(ImageGenApp.providerNoteFor(undefined), '（NVIDIA FLUX）');

  // Custom non-empty provider uses display name
  assert.equal(ImageGenApp.providerNoteFor('custom-gpu'), '（custom-gpu）');
});

test('providerDisplayName returns readable labels for all providers', () => {
  const { window } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;

  assert.equal(ImageGenApp.providerDisplayName('pollinations'), 'Pollinations');
  assert.equal(ImageGenApp.providerDisplayName('workers-ai'), 'Workers AI');
  assert.equal(ImageGenApp.providerDisplayName('nvidia'), 'NVIDIA FLUX');
  assert.equal(ImageGenApp.providerDisplayName('nvidia-fallback'), 'NVIDIA FLUX 備援');
  assert.equal(ImageGenApp.providerDisplayName('other'), 'other');
});

test('history wall recordMatchesFilters matches by provider', () => {
  const { context, window } = setupEnvironment();
  vm.runInContext(historyWallJsSource, context, { filename: historyWallJsPath });

  const ImageHistoryWall = window.ImageHistoryWall;
  assert.ok(ImageHistoryWall, 'ImageHistoryWall should be exposed');
  assert.equal(typeof ImageHistoryWall.recordMatchesFilters, 'function');

  const pollinationsRecord = {
    id: 'rec-1',
    prompt: '貓咪在花園',
    providerPrompt: 'a cat in a garden',
    provider: 'pollinations',
    size: 'square',
    steps: 10,
    cfgScale: 3
  };

  const workersAiRecord = {
    id: 'rec-2',
    prompt: '柴犬在海灘',
    providerPrompt: 'a shiba on the beach',
    provider: 'workers-ai',
    size: 'square',
    steps: '',
    cfgScale: ''
  };

  // Searching 'pollinations' should match rec-1 but not rec-2
  window.ImageHistoryWall.applyHistoryFilters(); // resets/reads filters
  // Mock search input
  const searchInput = { value: 'pollinations' };
  window.document.getElementById = (id) => id === 'historySearch' ? searchInput : null;
  window.ImageHistoryWall.applyHistoryFilters();

  assert.equal(window.ImageHistoryWall.recordMatchesFilters(pollinationsRecord), true);
  assert.equal(window.ImageHistoryWall.recordMatchesFilters(workersAiRecord), false);
});
