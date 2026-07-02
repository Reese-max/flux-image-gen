const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPromptEnhancer(fetchImpl) {
  const sourcePath = path.resolve(__dirname, '../../app/static/prompt-enhancer.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { console: console, fetch: fetchImpl, Promise: Promise, JSON: JSON };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return context.PromptEnhancer;
}

test('applyEffect posts prompt and effect to /prompt/enhance and returns the refined prompt', async () => {
  let calledUrl = '';
  let sentBody = null;
  const enhancer = loadPromptEnhancer(function (url, init) {
    calledUrl = url;
    sentBody = JSON.parse(init.body);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({ prompt: 'a dreamy misty cat', provider: 'gemini', effect: '更夢幻' });
      },
    });
  });

  const result = await enhancer.applyEffect('a cat', '更夢幻');
  assert.equal(calledUrl, '/prompt/enhance');
  assert.deepEqual(sentBody, { prompt: 'a cat', effect: '更夢幻' });
  assert.equal(result.prompt, 'a dreamy misty cat');
  assert.equal(result.provider, 'gemini');
});

test('applyEffect surfaces the server error message when the response is not ok', async () => {
  const enhancer = loadPromptEnhancer(function () {
    return Promise.resolve({
      ok: false,
      status: 503,
      json: function () {
        return Promise.resolve({ error: '效果優化需要 Gemini（缺少 GEMINI_API_KEY）', code: 'missing_api_key' });
      },
    });
  });

  await assert.rejects(() => enhancer.applyEffect('a cat', '更夢幻'), /Gemini/);
});

test('applyEffect throws when the response lacks a prompt', async () => {
  const enhancer = loadPromptEnhancer(function () {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({ provider: 'gemini' });
      },
    });
  });

  await assert.rejects(() => enhancer.applyEffect('a cat', '更夢幻'), /缺少提示詞/);
});
