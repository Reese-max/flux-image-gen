const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadFrontend(staticDir, record) {
  const listeners = {};
  const requests = [];
  const storage = new Map([['aiImageGenerationHistory.v1', JSON.stringify([record])]]);
  function element() {
    const attrs = {};
    return {
      value: '', hidden: true, dataset: {}, style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(key, value) { attrs[key] = String(value); },
      getAttribute(key) { return attrs[key] ?? null; },
      removeAttribute(key) { delete attrs[key]; },
      appendChild() {}, addEventListener() {}, focus() {},
      querySelectorAll() { return []; }
    };
  }
  const elements = Object.fromEntries([
    'plainPrompt', 'prompt', 'model', 'size', 'seed', 'customWidth', 'customHeight',
    'devSteps', 'devCfgScale', 'stage', 'go', 'dl', 'status', 'historyDetailModal'
  ].map(id => [id, element()]));
  const document = {
    getElementById: id => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: element,
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    dispatchEvent(event) { (listeners[event.type] || []).forEach(callback => callback(event)); }
  };
  const sandbox = {
    document, console, Promise, performance: { now: () => 1000 },
    navigator: { userAgent: 'test-agent' },
    location: { href: 'http://localhost/' },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    addEventListener() {}, showTab: () => true,
    requestAnimationFrame: callback => callback(),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    fetch(url, options) {
      assert.equal(url, '/generate', 'saved provider prompt should not use an unrelated endpoint');
      const body = JSON.parse(options.body);
      requests.push(body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        image: 'data:image/png;base64,AAAA', provider: 'nvidia', model: body.model,
        seed: body.seed, width: body.width, height: body.height
      }) });
    }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['generation-settings.js', 'history-store.js', 'app.js', 'history-wall.js']) {
    const filename = path.join(staticDir, name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  // Initialize history only; the test supplies the composer DOM directly.
  listeners.DOMContentLoaded.at(-1)();
  return { sandbox, elements, requests };
}

for (const staticPath of ['app/static', 'cloudflare/public/static']) {
  test(`history regeneration submits the selected record through the real app API (${staticPath})`, async () => {
    const record = {
      id: 'saved-cat', image: 'data:image/png;base64,AAAA',
      userPrompt: '一隻貓在草地上', prompt: '一隻貓在草地上',
      providerPrompt: 'a cat sitting on green grass', model: 'dev',
      size: 'custom', width: 1344, height: 768, seed: 424242, steps: 45, cfgScale: 4
    };
    const { sandbox, elements, requests } = loadFrontend(path.resolve(__dirname, '../..', staticPath), record);
    sandbox.ImageGenApp.setGenerationSettings({
      prompt: '另一張人物肖像', providerPrompt: 'an unrelated anime portrait',
      model: 'schnell', size: 'square', seed: 777
    });
    sandbox.ImageHistoryWall.openHistoryDetail(record);
    assert.equal(elements.historyDetailModal.hidden, false);

    assert.doesNotThrow(() => sandbox.ImageHistoryWall.regenerateHistoryDetail());
    await new Promise(setImmediate);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].userPrompt, record.userPrompt);
    assert.equal(requests[0].prompt, record.providerPrompt);
    for (const key of ['model', 'size', 'width', 'height', 'steps', 'cfgScale']) {
      assert.equal(requests[0][key], record[key], key);
    }
    assert.notEqual(requests[0].seed, record.seed, 'regeneration should request a fresh seed to produce a variant');
    assert.ok(
      Number.isInteger(requests[0].seed) && requests[0].seed > 0 && requests[0].seed <= 2147483647,
      'regenerated seed should be a valid positive seed'
    );
    assert.equal(elements.historyDetailModal.hidden, true);
    const generated = sandbox.ImageGenApp.getLastGeneration();
    assert.ok(generated, elements.status.textContent);
    assert.equal(generated.sourceRecordId, record.id);
    assert.equal(generated.prompt, record.userPrompt);
    assert.equal(generated.providerPrompt, record.providerPrompt);
  });
}
