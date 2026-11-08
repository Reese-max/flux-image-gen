const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const historyStorePath = path.resolve(__dirname, '../../app/static/history-store.js');
const generationSettingsPath = path.resolve(__dirname, '../../app/static/generation-settings.js');
const historyWallPath = path.resolve(__dirname, '../../app/static/history-wall.js');

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function createHarness(rawRecord) {
  const listeners = {};
  const modal = {
    hidden: true,
    addEventListener() {},
  };
  let generationSettings = null;
  let generated = false;
  let sourceRecordId = '';
  let seedMode = '';
  const document = {
    getElementById(id) {
      return id === 'historyDetailModal' ? modal : null;
    },
    addEventListener(name, listener) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(listener);
    },
  };
  const context = vm.createContext({
    console,
    document,
    localStorage: {
      getItem() {
        return JSON.stringify([rawRecord]);
      },
      setItem() {},
    },
    showTab(name) {
      return name === 'generate';
    },
    ImageGenApp: {
      setGenerationSettings(settings) {
        generationSettings = JSON.parse(JSON.stringify(settings));
      },
      setNextGenerationSourceRecord(id) {
        sourceRecordId = id;
      },
      setSeedMode(mode) {
        seedMode = mode;
      },
      generate() {
        generated = true;
      },
    },
  });

  vm.runInContext(readSource(historyStorePath), context, { filename: historyStorePath });
  vm.runInContext(readSource(generationSettingsPath), context, { filename: generationSettingsPath });
  vm.runInContext(readSource(historyWallPath), context, { filename: historyWallPath });

  (listeners.DOMContentLoaded || []).forEach((listener) => listener());
  const record = context.ImageHistoryStore.loadRecords()[0];
  context.ImageHistoryWall.openHistoryDetail(record);
  context.ImageHistoryWall.regenerateHistoryDetail();

  return {
    context,
    generationSettings,
    generated,
    modal,
    seedMode,
    sourceRecordId,
  };
}

test('regenerating a legacy history record preserves its source prompt and rebuilds the provider prompt', () => {
  const harness = createHarness({
    id: 'legacy-cat',
    image: 'data:image/png;base64,abc',
    prompt: '一隻貓在草地上',
    avoid: 'blurry anatomy',
    model: 'quality',
    size: 'custom',
    width: 1024,
    height: 1536,
    seed: 812,
  });

  assert.equal(harness.generationSettings.prompt, '一隻貓在草地上');
  assert.equal(harness.generationSettings.providerPrompt, '');
  assert.equal(harness.generationSettings.avoid, 'blurry anatomy');
  assert.equal(harness.generationSettings.model, 'quality');
  assert.equal(harness.generationSettings.size, 'custom');
  assert.equal(harness.generationSettings.width, 1024);
  assert.equal(harness.generationSettings.height, 1536);
  assert.equal(harness.generationSettings.seed, 0);
  assert.equal(harness.sourceRecordId, 'legacy-cat');
  assert.equal(harness.seedMode, 'random');
  assert.equal(harness.generated, true);
  assert.equal(
    harness.context.GenerationSettings.shouldCompileProviderPrompt(
      harness.generationSettings.prompt,
      harness.generationSettings.providerPrompt,
    ),
    true,
  );
  assert.equal(
    harness.context.GenerationSettings.buildProviderPrompt('a cat in a meadow', harness.generationSettings.avoid),
    'a cat in a meadow, avoid blurry anatomy',
  );
});

test('regenerating a history record retains an existing provider-ready prompt', () => {
  const harness = createHarness({
    id: 'translated-cat',
    image: 'data:image/png;base64,abc',
    prompt: '一隻貓在草地上',
    providerPrompt: 'a cat in a meadow, soft daylight',
    avoid: 'blurry anatomy',
  });

  assert.equal(harness.generationSettings.prompt, '一隻貓在草地上');
  assert.equal(harness.generationSettings.providerPrompt, 'a cat in a meadow, soft daylight');
  assert.equal(
    harness.context.GenerationSettings.shouldCompileProviderPrompt(
      harness.generationSettings.prompt,
      harness.generationSettings.providerPrompt,
    ),
    false,
  );
  assert.equal(harness.generated, true);
});
