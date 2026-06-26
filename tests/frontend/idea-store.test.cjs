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

function createFakeStorage(initialValue) {
  const calls = {
    getItem: [],
    setItem: []
  };

  return {
    calls,
    getItem(key) {
      calls.getItem.push(key);
      return initialValue;
    },
    setItem(key, value) {
      calls.setItem.push([key, value]);
    }
  };
}

test('normalizeCard trims input, uses injected id factory, and applies defaults', () => {
  const IdeaStore = loadIdeaStore();
  let idCalls = 0;

  const card = IdeaStore.normalizeCard({
    id: '   ',
    emoji: '  🎨  ',
    title: '  我的靈感卡  ',
    promptZh: '  一隻在月光下發光的貓  ',
    promptEn: '  a glowing cat under moonlight  ',
    model: '',
    size: ''
  }, () => {
    idCalls += 1;
    return 'stable-card-id';
  });

  assert.equal(idCalls, 1);
  assert.deepEqual(plain(card), {
    id: 'stable-card-id',
    emoji: '🎨',
    title: '我的靈感卡',
    promptZh: '一隻在月光下發光的貓',
    promptEn: 'a glowing cat under moonlight',
    model: 'schnell',
    size: 'square'
  });
});

test('normalizeCard rejects missing title', () => {
  const IdeaStore = loadIdeaStore();

  assert.throws(
    () => IdeaStore.normalizeCard({ title: '  ', promptZh: '有描述' }, () => 'id-1'),
    /請輸入卡片名稱/
  );
});

test('normalizeCard rejects cards without Chinese or English prompt text', () => {
  const IdeaStore = loadIdeaStore();

  assert.throws(
    () => IdeaStore.normalizeCard({ title: '空白提示', promptZh: '   ', promptEn: '\n\t' }, () => 'id-1'),
    /請輸入中文描述或英文提示詞/
  );
});

test('parseImportedCards accepts a valid card array', () => {
  const IdeaStore = loadIdeaStore();
  const cards = IdeaStore.parseImportedCards(JSON.stringify([
    {
      id: ' imported-1 ',
      title: ' 匯入卡 ',
      promptZh: ' 中文描述 ',
      promptEn: '',
      model: 'dev',
      size: 'portrait'
    }
  ]));

  assert.deepEqual(plain(cards), [{
    id: 'imported-1',
    emoji: '✨',
    title: '匯入卡',
    promptZh: '中文描述',
    promptEn: '',
    model: 'dev',
    size: 'portrait'
  }]);
});

test('parseImportedCards rejects invalid JSON', () => {
  const IdeaStore = loadIdeaStore();

  assert.throws(
    () => IdeaStore.parseImportedCards('{not-json'),
    /匯入資料不是有效 JSON/
  );
});

test('loadCards returns an empty array when storage is missing', () => {
  const IdeaStore = loadIdeaStore();

  assert.deepEqual(plain(IdeaStore.loadCards(null)), []);
});

test('loadCards returns an empty array when storage contains invalid JSON', () => {
  const IdeaStore = loadIdeaStore();
  const storage = createFakeStorage('{not-json');

  assert.deepEqual(plain(IdeaStore.loadCards(storage)), []);
  assert.deepEqual(storage.calls.getItem, [IdeaStore.STORAGE_KEY]);
});

test('loadCards returns an empty array when storage JSON is not an array', () => {
  const IdeaStore = loadIdeaStore();
  const storage = createFakeStorage(JSON.stringify({ id: 'not-array' }));

  assert.deepEqual(plain(IdeaStore.loadCards(storage)), []);
  assert.deepEqual(storage.calls.getItem, [IdeaStore.STORAGE_KEY]);
});

test('loadCards returns normalized cards from valid storage data', () => {
  const IdeaStore = loadIdeaStore();
  const storage = createFakeStorage(JSON.stringify([
    {
      id: ' card-1 ',
      emoji: '  🖼️  ',
      title: '  海邊夕陽  ',
      promptZh: '  金色夕陽照在海面  ',
      promptEn: '',
      model: '',
      size: ''
    }
  ]));

  assert.deepEqual(plain(IdeaStore.loadCards(storage)), [{
    id: 'card-1',
    emoji: '🖼️',
    title: '海邊夕陽',
    promptZh: '金色夕陽照在海面',
    promptEn: '',
    model: 'schnell',
    size: 'square'
  }]);
  assert.deepEqual(storage.calls.getItem, [IdeaStore.STORAGE_KEY]);
});

test('loadCards returns an empty array when storage getItem throws', () => {
  const IdeaStore = loadIdeaStore();
  const storage = {
    getItem() {
      throw new Error('storage unavailable');
    }
  };

  assert.deepEqual(plain(IdeaStore.loadCards(storage)), []);
});

test('saveCards writes normalized JSON to storage key and returns normalized cards', () => {
  const IdeaStore = loadIdeaStore();
  const storage = createFakeStorage(null);
  const result = IdeaStore.saveCards([
    {
      id: ' card-2 ',
      emoji: '',
      title: '  森林小屋  ',
      promptZh: '',
      promptEn: '  cabin in a misty forest  ',
      model: '',
      size: ' portrait '
    }
  ], storage);

  assert.deepEqual(plain(result), [{
    id: 'card-2',
    emoji: '✨',
    title: '森林小屋',
    promptZh: '',
    promptEn: 'cabin in a misty forest',
    model: 'schnell',
    size: 'portrait'
  }]);
  assert.equal(storage.calls.setItem.length, 1);
  assert.equal(storage.calls.setItem[0][0], IdeaStore.STORAGE_KEY);
  assert.deepEqual(JSON.parse(storage.calls.setItem[0][1]), plain(result));
});

test('saveCards does not throw when storage setItem throws and returns normalized cards', () => {
  const IdeaStore = loadIdeaStore();
  const storage = {
    setItem() {
      throw new Error('quota exceeded');
    }
  };

  const result = IdeaStore.saveCards([
    {
      id: 'card-3',
      title: '星空',
      promptZh: '滿天星星',
      promptEn: '',
      model: '',
      size: ''
    }
  ], storage);

  assert.deepEqual(plain(result), [{
    id: 'card-3',
    emoji: '✨',
    title: '星空',
    promptZh: '滿天星星',
    promptEn: '',
    model: 'schnell',
    size: 'square'
  }]);
});

test('upsertCard adds new cards, replaces existing cards, and does not mutate input cards', () => {
  const IdeaStore = loadIdeaStore();
  const original = [{
    id: 'existing-card',
    emoji: '💡',
    title: '原本卡片',
    promptZh: '原本描述',
    promptEn: '',
    model: 'dev',
    size: 'landscape'
  }];
  const originalSnapshot = plain(original);

  const added = IdeaStore.upsertCard(original, {
    id: 'new-card',
    title: '新增卡片',
    promptZh: '',
    promptEn: 'new prompt'
  });

  assert.deepEqual(plain(original), originalSnapshot);
  assert.deepEqual(plain(added), [
    originalSnapshot[0],
    {
      id: 'new-card',
      emoji: '✨',
      title: '新增卡片',
      promptZh: '',
      promptEn: 'new prompt',
      model: 'schnell',
      size: 'square'
    }
  ]);

  const replaced = IdeaStore.upsertCard(original, {
    id: 'existing-card',
    emoji: '🔥',
    title: '更新卡片',
    promptZh: '更新描述',
    promptEn: '',
    model: '',
    size: ''
  });

  assert.deepEqual(plain(original), originalSnapshot);
  assert.deepEqual(plain(replaced), [{
    id: 'existing-card',
    emoji: '🔥',
    title: '更新卡片',
    promptZh: '更新描述',
    promptEn: '',
    model: 'schnell',
    size: 'square'
  }]);
});

test('deleteCard removes existing ids, keeps missing ids unchanged, and treats empty ids as no-op', () => {
  const IdeaStore = loadIdeaStore();
  const cards = [
    {
      id: 'delete-me',
      emoji: '🗑️',
      title: '刪除目標',
      promptZh: '要刪除',
      promptEn: '',
      model: 'dev',
      size: 'square'
    },
    {
      id: 'keep-me',
      emoji: '✅',
      title: '保留目標',
      promptZh: '',
      promptEn: 'keep this card',
      model: 'schnell',
      size: 'portrait'
    }
  ];
  const snapshot = plain(cards);

  assert.deepEqual(plain(IdeaStore.deleteCard(cards, 'delete-me')), [snapshot[1]]);
  assert.deepEqual(plain(IdeaStore.deleteCard(cards, 'missing-id')), snapshot);
  assert.deepEqual(plain(IdeaStore.deleteCard(cards, '   ')), snapshot);
  assert.deepEqual(plain(cards), snapshot);
});

