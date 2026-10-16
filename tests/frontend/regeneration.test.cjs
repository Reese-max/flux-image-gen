const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const cat = {
  id: 'cat', image: 'https://example.test/cat.png', prompt: '一隻貓在草地上',
  providerPrompt: 'A tabby cat resting on a green lawn, avoid blurry', avoid: 'blurry',
  model: 'dev', size: 'ppt_16_9', width: 1344, height: 768,
  steps: 45, cfgScale: 4, seed: 42
};
const girlPrompt = '動漫女孩肖像';
const girlProviderPrompt = 'An anime girl portrait';

function response(data) {
  return { ok: true, json: async () => data };
}

function setup(transform) {
  const elements = {};
  const listeners = {};
  const storage = new Map();
  const requests = [];
  const generated = [];
  function element() {
    const attrs = {};
    const children = [];
    return {
      value: '', dataset: {}, hidden: true, children,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(key, value) { attrs[key] = String(value); },
      getAttribute(key) { return attrs[key] || null; },
      removeAttribute(key) { delete attrs[key]; },
      appendChild(child) { children.push(child); },
      removeChild(child) { children.splice(children.indexOf(child), 1); },
      get firstChild() { return children[0]; },
      querySelectorAll() { return []; }, focus() {}, addEventListener() {}
    };
  }
  for (const id of ['plainPrompt', 'prompt', 'avoid', 'model', 'size', 'seed',
    'devSteps', 'devCfgScale', 'customWidth', 'customHeight', 'stage', 'dl',
    'status', 'historyDetailModal']) {
    elements[id] = element();
  }
  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null, querySelectorAll: () => [], createElement: element,
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    dispatchEvent(event) {
      if (event.type === 'imagegen:generated') { generated.push(event.detail); }
      for (const listener of listeners[event.type] || []) { listener(event); }
    }
  };
  const context = vm.createContext({
    document, navigator: {}, console, performance: { now: () => 1000 },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    addEventListener() {}, requestAnimationFrame(callback) { callback(); },
    showTab: () => true,
    ElapsedTimer: { start: () => ({ stop: () => '0.1' }) },
    async fetch(url, options) {
      const payload = JSON.parse(options.body);
      requests.push({ url, payload });
      if (url === '/prompt/transform') {
        return transform ? transform(payload) : response({ prompt: girlProviderPrompt });
      }
      assert.equal(url, '/generate');
      return response({
        image: 'https://example.test/generated.png', provider: 'test',
        model: payload.model, seed: payload.seed, ...context.getSizeDimensions(payload.size)
      });
    }
  });
  context.window = context;
  for (const name of ['generation-settings.js', 'history-store.js', 'app.js', 'history-wall.js']) {
    const filename = path.resolve(__dirname, '../../app/static', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  // Load the selected history record through the real generated-record listener.
  document.dispatchEvent({ type: 'imagegen:generated', detail: cat });
  return { context, elements, requests, generated, storage, app: context.ImageGenApp, wall: context.ImageHistoryWall };
}

const settle = () => new Promise(setImmediate);

test('history regeneration replays the selected final prompt, settings and version source with a fresh seed', async () => {
  const { app, wall, context, requests, generated, storage } = setup();
  app.setGenerationSettings({ prompt: girlPrompt, providerPrompt: girlProviderPrompt, size: 'ig_story', steps: 10, cfgScale: 3 });
  context.lockCompositionSeed(99);
  wall.openHistoryDetail(cat);
  wall.regenerateHistoryDetail();
  await settle();

  assert.equal(requests.length, 1, 'a stored final prompt must not be recompiled');
  const payload = requests[0].payload;
  assert.equal(payload.prompt, cat.providerPrompt);
  assert.equal(payload.userPrompt, cat.prompt);
  assert.equal(payload.model, cat.model);
  assert.equal(payload.size, cat.size);
  assert.equal(payload.steps, cat.steps);
  assert.equal(payload.cfgScale, cat.cfgScale);
  assert.ok(payload.seed > 0 && payload.seed !== cat.seed && payload.seed !== 99);
  assert.equal(generated.at(-1).sourceRecordId, cat.id);
  assert.equal(generated.at(-1).providerPrompt, payload.prompt);
  assert.equal(generated.at(-1).prompt, payload.userPrompt);
  const saved = app.getLastGeneration();
  assert.equal(saved.width, cat.width);
  assert.equal(saved.height, cat.height);
  const records = context.ImageHistoryStore.loadRecords();
  assert.equal(records[0].versionGroupId, cat.id);
  assert.equal(records[0].versionNumber, 2);
  assert.ok(storage.size > 0);
});

test('result regeneration restores its final prompt, custom dimensions and tuning instead of the composer', async () => {
  const { app, context, requests } = setup();
  app.setGenerationSettings({ ...cat, avoid: '', size: 'custom', width: 1152, height: 1536 });
  await app.generate();
  const original = app.getLastGeneration();
  app.setGenerationSettings({ prompt: girlPrompt, providerPrompt: girlProviderPrompt, size: 'ig_story', width: 768, height: 1344, steps: 10, cfgScale: 3 });
  context.lockCompositionSeed(99);
  context.regenerate();
  await settle();

  const payload = requests.at(-1).payload;
  assert.equal(payload.prompt, original.providerPrompt);
  assert.equal(payload.userPrompt, original.prompt);
  assert.equal(payload.model, original.model);
  assert.equal(payload.size, original.size);
  assert.equal(payload.width, original.width);
  assert.equal(payload.height, original.height);
  assert.equal(payload.steps, original.steps);
  assert.equal(payload.cfgScale, original.cfgScale);
  assert.notEqual(payload.seed, 99);
});

for (const entry of ['history', 'result']) {
  test(`${entry} regeneration cannot mix a pending anime prompt with the cat description`, async () => {
    let finishTransform;
    const transformed = new Promise((resolve) => { finishTransform = resolve; });
    const { app, wall, context, elements, requests, generated } = setup(() => transformed);
    app.setGenerationSettings({ ...cat, avoid: '' });
    await app.generate();
    app.setGenerationSettings({ prompt: girlPrompt, providerPrompt: '', avoid: '', size: 'ig_story' });
    app.setNextGenerationSourceRecord('active-source');
    const active = app.generate();
    wall.openHistoryDetail(cat);
    if (entry === 'history') { wall.regenerateHistoryDetail(); } else { context.regenerate(); }
    finishTransform(response({ prompt: girlProviderPrompt }));
    await active;
    await settle();

    const payload = requests.at(-1).payload;
    assert.equal(payload.prompt, girlProviderPrompt);
    assert.equal(payload.userPrompt, girlPrompt, 'the pending request must retain its own description');
    assert.equal(generated.at(-1).sourceRecordId, 'active-source', 'blocked replay must not clear active lineage');
    assert.equal(elements.historyDetailModal.hidden, false, 'the history selection stays available for retry');

    wall.regenerateHistoryDetail();
    await settle();
    assert.equal(requests.at(-1).payload.prompt, cat.providerPrompt);
    assert.equal(requests.at(-1).payload.userPrompt, cat.prompt);
    assert.equal(generated.at(-1).sourceRecordId, cat.id);
  });
}
