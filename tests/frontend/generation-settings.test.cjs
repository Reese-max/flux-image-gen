const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../../app/static/generation-settings.js');

function readGenerationSettingsSource() {
  return fs.readFileSync(scriptPath, 'utf8');
}

function loadGenerationSettings() {
  const source = readGenerationSettingsSource();
  const context = vm.createContext({});

  vm.runInContext(source, context, { filename: scriptPath });

  assert.ok(context.GenerationSettings, 'GenerationSettings should be exposed on globalThis');
  return context.GenerationSettings;
}

test('normalizeSeed returns 0 for empty, whitespace, and zero text', () => {
  const settings = loadGenerationSettings();

  assert.strictEqual(settings.normalizeSeed(''), 0);
  assert.strictEqual(settings.normalizeSeed('   '), 0);
  assert.strictEqual(settings.normalizeSeed('0'), 0);
});

test('normalizeSeed parses integer text', () => {
  const settings = loadGenerationSettings();

  assert.strictEqual(settings.normalizeSeed('12345'), 12345);
  assert.strictEqual(settings.normalizeSeed(' 42 '), 42);
  assert.strictEqual(settings.normalizeSeed('2147483647'), 2147483647);
});

test('normalizeSeed rejects non-integer or negative text', () => {
  const settings = loadGenerationSettings();
  const message = /seed 必須是 0 到 2147483647 之間的整數/;

  assert.throws(() => settings.normalizeSeed('-1'), message);
  assert.throws(() => settings.normalizeSeed('1.5'), message);
  assert.throws(() => settings.normalizeSeed('abc'), message);
  assert.throws(() => settings.normalizeSeed('2147483648'), message);
});

test('buildProviderPrompt appends avoid text', () => {
  const settings = loadGenerationSettings();

  assert.strictEqual(
    settings.buildProviderPrompt('a portrait photo', 'blurry, extra fingers'),
    'a portrait photo, avoid blurry, extra fingers'
  );
});

test('serializeSettings includes validated custom dimensions', () => {
  const settings = loadGenerationSettings();
  const serialized = settings.serializeSettings({
    prompt: '一張海報',
    providerPrompt: 'a poster',
    model: 'schnell',
    size: 'custom',
    width: '1152',
    height: '1536',
    seed: '7',
  });

  assert.strictEqual(serialized.size, 'custom');
  assert.strictEqual(serialized.width, 1152);
  assert.strictEqual(serialized.height, 1536);
});

test('serializeSettings rejects invalid custom dimensions', () => {
  const settings = loadGenerationSettings();

  assert.throws(
    () => settings.serializeSettings({ prompt: 'x', size: 'custom', width: '1000', height: '1024' }),
    /自訂寬度必須是 256 到 1920 之間，且為 64 的倍數/
  );
  assert.throws(
    () => settings.serializeSettings({ prompt: 'x', size: 'custom', width: '1024', height: '2048' }),
    /自訂高度必須是 256 到 1920 之間，且為 64 的倍數/
  );
});

test('source avoids ES6-only Number.isSafeInteger for ES5 compatibility', () => {
  assert.doesNotMatch(readGenerationSettingsSource(), /Number\.isSafeInteger/);
});
