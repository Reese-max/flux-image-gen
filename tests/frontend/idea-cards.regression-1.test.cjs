const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ideaCardsPath = path.resolve(__dirname, '../../app/static/idea-cards.js');

function loadPromptCards(imageGenApp, fetchImpl) {
  const root = { ImageGenApp: imageGenApp };
  const context = {
    console,
    globalThis: root,
    document: {
      addEventListener() {},
      getElementById() { return null; },
    },
    fetch: fetchImpl,
    setTimeout,
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(ideaCardsPath, 'utf8'), context, { filename: ideaCardsPath });
  return root.PromptCards;
}

function createImageGenApp() {
  const calls = { generate: 0, review: [], settings: [] };
  return {
    calls,
    setGenerationSettings(settings) { calls.settings.push(settings); },
    setPromptForReview(prompt, label) { calls.review.push([prompt, label]); },
    setStatus() {},
    generate() { calls.generate += 1; },
  };
}

test('Regression: style card with an English prompt only applies settings and never generates', () => {
  const app = createImageGenApp();
  const cards = loadPromptCards(app, () => { throw new Error('不應轉換已有英文提示詞的卡片'); });

  cards.generateFromCard({
    userPrompt: '月光下的玻璃小屋',
    providerPrompt: 'a glass cabin under moonlight',
    negativePrompt: 'text',
    modelPreset: 'schnell',
    sizePreset: 'portrait',
    seed: 42,
  });

  assert.equal(app.calls.generate, 0);
  assert.deepEqual(app.calls.review, [['a glass cabin under moonlight', '風格卡']]);
  assert.equal(app.calls.settings.length, 1);
  assert.equal(app.calls.settings[0].size, 'portrait');
});

test('Regression: style card with only Chinese text transforms the prompt but never generates', async () => {
  const app = createImageGenApp();
  let transformCalls = 0;
  const cards = loadPromptCards(app, () => {
    transformCalls += 1;
    return Promise.resolve({
      ok: true,
      json() { return Promise.resolve({ prompt: 'a moonlit glass cabin in a forest' }); },
    });
  });

  cards.generateFromCard({
    userPrompt: '月光下的玻璃小屋',
    providerPrompt: '',
    negativePrompt: '',
    modelPreset: 'schnell',
    sizePreset: 'square',
    seed: 0,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(transformCalls, 1);
  assert.equal(app.calls.generate, 0);
  assert.deepEqual(app.calls.review, [['a moonlit glass cabin in a forest', '風格卡']]);
});
