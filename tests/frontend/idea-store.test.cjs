const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadIdeaStore() {
  const sourcePath = path.resolve(__dirname, '../../app/static/idea-store.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return context.IdeaStore;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(card) {
  const copy = Object.assign({}, card);
  copy.createdAt = 'created';
  copy.updatedAt = 'updated';
  return copy;
}

function createFakeStorage(initialValue, legacyValue) {
  const calls = { getItem: [], setItem: [] };
  return {
    calls,
    getItem(key) {
      calls.getItem.push(key);
      if (key === 'aiImagePromptCards.v1') return initialValue;
      if (key === 'aiImageCustomIdeaCards.v1') return legacyValue;
      return null;
    },
    setItem(key, value) {
      calls.setItem.push([key, value]);
    }
  };
}

test('normalizeCard trims input, uses injected id factory, and applies PromptCard defaults', () => {
  const IdeaStore = loadIdeaStore();
  let idCalls = 0;
  const card = IdeaStore.normalizeCard({
    id: '   ',
    emoji: '  🎨  ',
    name: '  我的靈感卡  ',
    userPrompt: '  一隻在月光下發光的貓  ',
    providerPrompt: '  a glowing cat under moonlight  ',
    negativePrompt: ' blurry ',
    modelPreset: '',
    sizePreset: '',
    seed: '42',
    tags: ' cat, moon, cat ',
    previewImageUrl: ' data:image/png;base64,abc '
  }, () => {
    idCalls += 1;
    return 'stable-card-id';
  });

  assert.equal(idCalls, 1);
  assert.deepEqual(plain(stable(card)), {
    id: 'stable-card-id',
    name: '我的靈感卡',
    emoji: '🎨',
    userPrompt: '一隻在月光下發光的貓',
    providerPrompt: 'a glowing cat under moonlight',
    negativePrompt: 'blurry',
    modelPreset: 'schnell',
    sizePreset: 'square',
    seed: 42,
    tags: ['cat', 'moon'],
    previewImageUrl: 'data:image/png;base64,abc',
    createdAt: 'created',
    updatedAt: 'updated',
    version: 1
  });
});

test('normalizeCard migrates legacy idea card fields', () => {
  const IdeaStore = loadIdeaStore();
  const card = IdeaStore.normalizeCard({
    id: 'legacy-1',
    title: '舊卡',
    promptZh: '中文描述',
    promptEn: 'provider prompt',
    model: 'dev',
    size: 'portrait'
  });

  assert.equal(card.name, '舊卡');
  assert.equal(card.userPrompt, '中文描述');
  assert.equal(card.providerPrompt, 'provider prompt');
  assert.equal(card.modelPreset, 'dev');
  assert.equal(card.sizePreset, 'portrait');
});

test('normalizeCard rejects missing name', () => {
  const IdeaStore = loadIdeaStore();
  assert.throws(() => IdeaStore.normalizeCard({ name: '  ', userPrompt: '有描述' }, () => 'id-1'), /請輸入卡片名稱/);
});

test('normalizeCard rejects cards without user or provider prompt text', () => {
  const IdeaStore = loadIdeaStore();
  assert.throws(() => IdeaStore.normalizeCard({ name: '空白提示', userPrompt: '   ', providerPrompt: '\n\t' }, () => 'id-1'), /請輸入中文描述或 provider prompt/);
});

test('parseImportedCards accepts v1 PromptCard collection', () => {
  const IdeaStore = loadIdeaStore();
  const cards = IdeaStore.parseImportedCards(JSON.stringify({
    schema: 'PromptCardCollection',
    version: 1,
    cards: [{ id: ' imported-1 ', name: ' 匯入卡 ', userPrompt: ' 中文描述 ', providerPrompt: '', modelPreset: 'dev', sizePreset: 'portrait' }]
  }));

  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'imported-1');
  assert.equal(cards[0].name, '匯入卡');
  assert.equal(cards[0].modelPreset, 'dev');
  assert.equal(cards[0].sizePreset, 'portrait');
});

test('parseImportedCards accepts legacy card arrays and rejects invalid schema', () => {
  const IdeaStore = loadIdeaStore();
  assert.equal(IdeaStore.parseImportedCards(JSON.stringify([{ title: '匯入卡', promptZh: '中文描述' }])).length, 1);
  assert.throws(() => IdeaStore.parseImportedCards('{not-json'), /匯入資料不是有效 JSON/);
  assert.throws(() => IdeaStore.parseImportedCards(JSON.stringify({ id: 'not-array' })), /PromptCard 陣列/);
  assert.throws(() => IdeaStore.parseImportedCards(JSON.stringify({ version: 99, cards: [] })), /不支援的 PromptCard schema version/);
});

test('loadCards returns [] when storage is missing, invalid, or unavailable', () => {
  const IdeaStore = loadIdeaStore();
  assert.deepEqual(plain(IdeaStore.loadCards(null)), []);
  assert.deepEqual(plain(IdeaStore.loadCards(createFakeStorage('{not-json'))), []);
  assert.deepEqual(plain(IdeaStore.loadCards({ getItem() { throw new Error('storage unavailable'); } })), []);
});

test('loadCards loads the new key and migrates the legacy key when needed', () => {
  const IdeaStore = loadIdeaStore();
  const storage = createFakeStorage(null, JSON.stringify([{ id: ' card-1 ', title: ' 海邊夕陽 ', promptZh: ' 金色夕陽照在海面 ', emoji: '  🖼️  ' }]));
  const loaded = IdeaStore.loadCards(storage);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'card-1');
  assert.equal(loaded[0].name, '海邊夕陽');
  assert.equal(loaded[0].userPrompt, '金色夕陽照在海面');
  assert.deepEqual(storage.calls.getItem, [IdeaStore.STORAGE_KEY, IdeaStore.LEGACY_STORAGE_KEY]);
});

test('saveCards writes PromptCard collection JSON to storage key', () => {
  const IdeaStore = loadIdeaStore();
  const storage = createFakeStorage(null);
  const result = IdeaStore.saveCards([{ id: ' card-2 ', name: ' 森林小屋 ', providerPrompt: ' cabin in a misty forest ', sizePreset: ' portrait ' }], storage);

  assert.equal(result[0].name, '森林小屋');
  assert.equal(result[0].providerPrompt, 'cabin in a misty forest');
  assert.equal(result[0].sizePreset, 'portrait');
  assert.equal(storage.calls.setItem.length, 1);
  assert.equal(storage.calls.setItem[0][0], IdeaStore.STORAGE_KEY);
  const saved = JSON.parse(storage.calls.setItem[0][1]);
  assert.equal(saved.schema, 'PromptCardCollection');
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.cards, plain(result));
});

test('saveCards drops oldest cards on quota failure and keeps newer cards', () => {
  const IdeaStore = loadIdeaStore();
  const attempts = [];
  const storage = {
    setItem(key, value) {
      const parsed = JSON.parse(value);
      attempts.push({ key, ids: parsed.cards.map((card) => card.id) });
      if (parsed.cards.length > 2) {
        throw new Error('quota exceeded');
      }
    }
  };
  const result = IdeaStore.saveCards([
    { id: 'old-card', name: '舊卡', userPrompt: '舊描述', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'mid-card', name: '中卡', userPrompt: '中描述', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'new-card', name: '新卡', userPrompt: '新描述', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }
  ], storage);

  assert.deepEqual(attempts.map((attempt) => attempt.ids), [
    ['old-card', 'mid-card', 'new-card'],
    ['mid-card', 'new-card']
  ]);
  assert.deepEqual(plain(result.map((card) => card.id)), ['mid-card', 'new-card']);
});

test('upsertCard adds new cards, replaces existing cards, and does not mutate input cards', () => {
  const IdeaStore = loadIdeaStore();
  const original = [{ id: 'existing-card', emoji: '💡', name: '原本卡片', userPrompt: '原本描述', modelPreset: 'dev', sizePreset: 'landscape' }];
  const originalSnapshot = plain(original);
  const added = IdeaStore.upsertCard(original, { id: 'new-card', name: '新增卡片', providerPrompt: 'new prompt' });

  assert.deepEqual(plain(original), originalSnapshot);
  assert.equal(added.length, 2);
  assert.equal(added[0].name, '原本卡片');
  assert.equal(added[1].name, '新增卡片');

  const replaced = IdeaStore.upsertCard(original, { id: 'existing-card', emoji: '🔥', name: '更新卡片', userPrompt: '更新描述' });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].emoji, '🔥');
  assert.equal(replaced[0].name, '更新卡片');
});

test('deleteCard removes existing ids, keeps missing ids unchanged, and treats empty ids as no-op', () => {
  const IdeaStore = loadIdeaStore();
  const cards = [
    { id: 'delete-me', emoji: '🗑️', name: '刪除目標', userPrompt: '要刪除', modelPreset: 'dev', sizePreset: 'square' },
    { id: 'keep-me', emoji: '✅', name: '保留目標', providerPrompt: 'keep this card', modelPreset: 'schnell', sizePreset: 'portrait' }
  ];
  const snapshot = plain(cards);

  assert.equal(IdeaStore.deleteCard(cards, 'delete-me').length, 1);
  assert.equal(IdeaStore.deleteCard(cards, 'delete-me')[0].id, 'keep-me');
  assert.equal(IdeaStore.deleteCard(cards, 'missing-id').length, 2);
  assert.equal(IdeaStore.deleteCard(cards, '   ').length, 2);
  assert.deepEqual(plain(cards), snapshot);
});

test('createCardFromGeneration builds a PromptCard from a successful record', () => {
  const IdeaStore = loadIdeaStore();
  const card = IdeaStore.createCardFromGeneration({
    image: 'data:image/png;base64,img',
    thumbnail: 'data:image/png;base64,thumb',
    prompt: '一隻柴犬在月球吃拉麵',
    providerPrompt: 'a shiba dog eating ramen on the moon',
    avoid: 'text, watermark',
    model: 'dev',
    size: 'landscape',
    seed: 123
  }, () => 'from-generation');

  assert.equal(card.id, 'from-generation');
  assert.equal(card.userPrompt, '一隻柴犬在月球吃拉麵');
  assert.equal(card.providerPrompt, 'a shiba dog eating ramen on the moon');
  assert.equal(card.negativePrompt, 'text, watermark');
  assert.equal(card.modelPreset, 'dev');
  assert.equal(card.sizePreset, 'landscape');
  assert.equal(card.seed, 123);
  assert.equal(card.previewImageUrl, 'data:image/png;base64,thumb');
  assert.deepEqual(plain(card.tags), ['生成作品']);
});
