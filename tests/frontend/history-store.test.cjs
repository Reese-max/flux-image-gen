const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../../app/static/history-store.js');

function readHistoryStoreSource() {
  return fs.readFileSync(scriptPath, 'utf8');
}

function loadHistoryStore() {
  const source = readHistoryStoreSource();
  const context = vm.createContext({ console });

  vm.runInContext(source, context, { filename: scriptPath });

  assert.ok(context.ImageHistoryStore, 'ImageHistoryStore should be exposed on globalThis');
  return context.ImageHistoryStore;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeStorage(initialValue) {
  const calls = {
    getItem: [],
    setItem: [],
    removeItem: []
  };

  return {
    calls,
    getItem(key) {
      calls.getItem.push(key);
      return initialValue;
    },
    setItem(key, value) {
      calls.setItem.push([key, value]);
    },
    removeItem(key) {
      calls.removeItem.push(key);
    }
  };
}

function makeRawRecord(index) {
  return {
    id: 'record-' + index,
    image: 'data:image/png;base64,image' + index,
    thumbnail: 'data:image/png;base64,thumb' + index,
    prompt: '提示詞 ' + index,
    providerPrompt: 'provider prompt ' + index,
    avoid: '低品質',
    model: 'dev',
    size: 'portrait',
    seed: index,
    createdAt: '2026-06-24T00:00:' + String(index).padStart(2, '0') + '.000Z'
  };
}

test('normalizeRecord trims fields, uses injected id factory, and applies defaults', () => {
  const store = loadHistoryStore();
  let idCalls = 0;

  const record = store.normalizeRecord({
    id: '   ',
    image: '  data:image/png;base64,abc  ',
    thumbnail: '   ',
    prompt: '  一隻太空貓  ',
    providerPrompt: '',
    avoid: '   ',
    model: '',
    size: '',
    seed: '',
    createdAt: ''
  }, () => {
    idCalls += 1;
    return 'history-id-1';
  });

  assert.equal(idCalls, 1);
  assert.equal(record.createdAt.length > 0, true);
  assert.deepEqual(plain(Object.assign({}, record, { createdAt: 'normalized-date' })), {
    id: 'history-id-1',
    schemaVersion: 2,
    userPrompt: '一隻太空貓',
    expandedPrompt: '',
    image: 'data:image/png;base64,abc',
    thumbnail: 'data:image/png;base64,abc',
    prompt: '一隻太空貓',
    providerPrompt: '一隻太空貓',
    negativePrompt: '',
    avoid: '',
    model: 'schnell',
    size: 'square',
    steps: null,
    cfgScale: null,
    seed: 0,
    width: 0,
    height: 0,
    imageUrl: '',
    localImageData: 'data:image/png;base64,abc',
    provider: '',
    mode: 'normal',
    favorite: false,
    tags: [],
    qaReport: null,
    recommended: false,
    agentRecommendation: '',
    autoRetry: null,
    nextSuggestions: [],
    cloudShareUrl: '',
    cloudDeleteUrl: '',
    cloudSavedAt: '',
    cloudPromptPublic: false,
    cloudStorage: '',
    sourceRecordId: '',
    versionGroupId: 'history-id-1',
    versionNumber: 1,
    createdAt: 'normalized-date'
  });
});

test('normalizeRecord adds version, tags, favorite, and share defaults', () => {
  const Store = loadHistoryStore();
  const record = Store.normalizeRecord({
    image: 'data:image/png;base64,abc',
    prompt: '  a cat  ',
    tags: ['  cute ', '', 'cat'],
    favorite: true,
    cloudShareUrl: ' https://example.com/share/abc ',
    cloudDeleteUrl: ' https://example.com/gallery/abc/delete?deleteToken=secret ',
    cloudSavedAt: ' 2026-07-07T00:00:00.000Z ',
    cloudPromptPublic: true,
    cloudStorage: ' R2 / R2 JSON ',
    sourceRecordId: ' parent-1 ',
    versionGroupId: '',
    versionNumber: 3
  }, () => 'record-1');

  assert.equal(record.id, 'record-1');
  assert.equal(record.favorite, true);
  assert.deepEqual(plain(record.tags), ['cute', 'cat']);
  assert.equal(record.cloudShareUrl, 'https://example.com/share/abc');
  assert.equal(record.cloudDeleteUrl, 'https://example.com/gallery/abc/delete?deleteToken=secret');
  assert.equal(record.cloudSavedAt, '2026-07-07T00:00:00.000Z');
  assert.equal(record.cloudPromptPublic, true);
  assert.equal(record.cloudStorage, 'R2 / R2 JSON');
  assert.equal(record.sourceRecordId, 'parent-1');
  assert.equal(record.versionGroupId, 'record-1');
  assert.equal(record.versionNumber, 3);
});

test('normalizeRecord supports GenerationRecord field aliases', () => {
  const Store = loadHistoryStore();
  const record = Store.normalizeRecord({
    id: 'generation-record',
    userPrompt: '中文原始需求',
    expandedPrompt: '補完整的中文畫面',
    providerPrompt: 'English FLUX prompt',
    negativePrompt: 'bad hands',
    imageUrl: 'https://example.com/image.png',
    model: 'quality',
    width: 1344,
    height: 768,
    mode: 'agent'
  });

  assert.equal(record.prompt, '中文原始需求');
  assert.equal(record.userPrompt, '中文原始需求');
  assert.equal(record.expandedPrompt, '補完整的中文畫面');
  assert.equal(record.avoid, 'bad hands');
  assert.equal(record.negativePrompt, 'bad hands');
  assert.equal(record.image, 'https://example.com/image.png');
  assert.equal(record.imageUrl, 'https://example.com/image.png');
  assert.equal(record.localImageData, '');
  assert.equal(record.width, 1344);
  assert.equal(record.height, 768);
  assert.equal(record.mode, 'agent');
});

test('normalizeRecord preserves agent QA metadata and next suggestions', () => {
  const Store = loadHistoryStore();
  const record = Store.normalizeRecord({
    image: 'data:image/png;base64,abc',
    prompt: '一隻柴犬',
    width: '1344',
    height: '768',
    provider: 'demo',
    mode: 'agent',
    recommended: true,
    agentRecommendation: '推薦最佳圖：第 2 張',
    qaReport: {
      imageId: 'variation-2',
      promptMatchScore: '88',
      compositionScore: 82,
      visualQualityScore: 79,
      textAccuracyScore: null,
      detectedIssues: ['Demo 圖'],
      recommendation: 'keep',
      reason: '構圖清楚'
    },
    autoRetry: { maxRetries: 1, attempted: false, reason: '成本保護', action: 'manual_retry', message: '需手動重試' },
    nextSuggestions: [{ id: 'brighter', label: '讓背景更亮' }]
  }, () => 'agent-record');

  assert.equal(record.mode, 'agent');
  assert.equal(record.width, 1344);
  assert.equal(record.height, 768);
  assert.equal(record.provider, 'demo');
  assert.equal(record.recommended, true);
  assert.equal(record.qaReport.promptMatchScore, 88);
  assert.deepEqual(plain(record.qaReport.detectedIssues), ['Demo 圖']);
  assert.equal(record.autoRetry.action, 'manual_retry');
  assert.deepEqual(plain(record.nextSuggestions), [{ id: 'brighter', label: '讓背景更亮' }]);
});

test('normalizeRecord rejects partial and decimal version numbers', () => {
  const Store = loadHistoryStore();

  assert.equal(Store.normalizeRecord({
    image: 'data:image/png;base64,abc',
    prompt: 'a cat',
    versionNumber: '2abc'
  }, () => 'partial-version').versionNumber, 1);

  assert.equal(Store.normalizeRecord({
    image: 'data:image/png;base64,abc',
    prompt: 'a cat',
    versionNumber: '2.9'
  }, () => 'decimal-version').versionNumber, 1);

  assert.equal(Store.normalizeRecord({
    image: 'data:image/png;base64,abc',
    prompt: 'a cat',
    versionNumber: '3'
  }, () => 'integer-version').versionNumber, 3);
});

test('createVersionRecord links to the parent version group and increments version', () => {
  const Store = loadHistoryStore();
  const parent = Store.normalizeRecord({
    id: 'parent-1',
    image: 'data:image/png;base64,parent',
    prompt: 'a cat',
    versionGroupId: 'group-1',
    versionNumber: 2
  });
  const records = [
    parent,
    Store.normalizeRecord({
      id: 'existing-v3',
      image: 'data:image/png;base64,v3',
      prompt: 'a cinematic cat',
      versionGroupId: 'group-1',
      versionNumber: 3
    })
  ];

  const version = Store.createVersionRecord(records, parent, {
    image: 'data:image/png;base64,new',
    prompt: 'a realistic cat'
  }, () => 'new-version');

  assert.equal(version.id, 'new-version');
  assert.equal(version.sourceRecordId, 'parent-1');
  assert.equal(version.versionGroupId, 'group-1');
  assert.equal(version.versionNumber, 4);
});

test('findVersionGroup returns records in version order', () => {
  const Store = loadHistoryStore();
  const records = [
    Store.normalizeRecord({ id: 'v2', image: 'data:image/png;base64,2', prompt: 'two', versionGroupId: 'g1', versionNumber: 2 }),
    Store.normalizeRecord({ id: 'other', image: 'data:image/png;base64,o', prompt: 'other', versionGroupId: 'g2', versionNumber: 1 }),
    Store.normalizeRecord({ id: 'v1', image: 'data:image/png;base64,1', prompt: 'one', versionGroupId: 'g1', versionNumber: 1 })
  ];

  assert.deepEqual(plain(Store.findVersionGroup(records, records[0]).map((record) => record.id)), ['v1', 'v2']);
});

test('findVersionGroup uses id as deterministic final tie-break', () => {
  const Store = loadHistoryStore();
  const records = [
    Store.normalizeRecord({ id: 'same-b', image: 'data:image/png;base64,b', prompt: 'b', versionGroupId: 'g1', versionNumber: 1, createdAt: '2026-06-25T00:00:00.000Z' }),
    Store.normalizeRecord({ id: 'same-a', image: 'data:image/png;base64,a', prompt: 'a', versionGroupId: 'g1', versionNumber: 1, createdAt: '2026-06-25T00:00:00.000Z' })
  ];

  assert.deepEqual(plain(Store.findVersionGroup(records, records[0]).map((record) => record.id)), ['same-a', 'same-b']);
});

test('updateRecordTags and toggleFavorite update only the target record', () => {
  const Store = loadHistoryStore();
  const records = [
    Store.normalizeRecord({ id: 'a', image: 'data:image/png;base64,a', prompt: 'a' }),
    Store.normalizeRecord({ id: 'b', image: 'data:image/png;base64,b', prompt: 'b' })
  ];

  const tagged = Store.updateRecordTags(records, 'a', 'cat, cute,,  product ');
  assert.deepEqual(plain(tagged[0].tags), ['cat', 'cute', 'product']);
  assert.deepEqual(plain(tagged[1].tags), []);

  const favorited = Store.toggleFavorite(tagged, 'b');
  assert.equal(favorited[0].favorite, false);
  assert.equal(favorited[1].favorite, true);
});

test('updateRecord persists cloud share and delete links for the target record', () => {
  const Store = loadHistoryStore();
  const records = [
    Store.normalizeRecord({ id: 'a', image: 'data:image/png;base64,a', prompt: 'a' }),
    Store.normalizeRecord({ id: 'b', image: 'data:image/png;base64,b', prompt: 'b' })
  ];

  const updated = Store.updateRecord(records, 'a', {
    cloudShareUrl: 'https://example.com/share/a',
    cloudDeleteUrl: 'https://example.com/gallery/a/delete?deleteToken=secret',
    cloudSavedAt: '2026-07-07T00:00:00.000Z',
    cloudPromptPublic: true,
    cloudStorage: 'R2 / R2 JSON'
  });

  assert.equal(updated[0].cloudShareUrl, 'https://example.com/share/a');
  assert.equal(updated[0].cloudDeleteUrl, 'https://example.com/gallery/a/delete?deleteToken=secret');
  assert.equal(updated[0].cloudSavedAt, '2026-07-07T00:00:00.000Z');
  assert.equal(updated[0].cloudPromptPublic, true);
  assert.equal(updated[0].cloudStorage, 'R2 / R2 JSON');
  assert.equal(updated[1].cloudShareUrl, '');
  assert.equal(updated[1].cloudDeleteUrl, '');
});

test('normalizeRecord rejects missing image or prompt', () => {
  const store = loadHistoryStore();

  assert.throws(
    () => store.normalizeRecord({ image: '   ', prompt: '有提示詞' }, () => 'id-1'),
    /缺少圖片資料/
  );
  assert.throws(
    () => store.normalizeRecord({ image: 'data:image/png;base64,abc', prompt: '  ' }, () => 'id-1'),
    /缺少提示詞/
  );
});

test('addRecord prepends records and limits list to MAX_RECORDS', () => {
  const store = loadHistoryStore();
  const existing = [];
  let i;

  for (i = 0; i < store.MAX_RECORDS; i += 1) {
    existing.push(makeRawRecord(i));
  }

  const result = store.addRecord(existing, {
    image: 'data:image/png;base64,new',
    prompt: '最新提示詞'
  }, () => 'newest-id');

  assert.equal(result.length, store.MAX_RECORDS);
  assert.equal(result[0].id, 'newest-id');
  assert.equal(result[0].prompt, '最新提示詞');
  assert.equal(result[result.length - 1].id, 'record-' + String(store.MAX_RECORDS - 2));
  assert.equal(existing.length, store.MAX_RECORDS);
});

test('parseRecords migrates legacy arrays and versioned collections', () => {
  const store = loadHistoryStore();
  const legacy = store.parseRecords(JSON.stringify([makeRawRecord(1)]));
  const collection = store.parseRecords(JSON.stringify({
    schema: store.COLLECTION_SCHEMA,
    version: store.COLLECTION_VERSION,
    records: [makeRawRecord(2)]
  }));

  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].schemaVersion, 2);
  assert.equal(collection.length, 1);
  assert.equal(collection[0].id, 'record-2');
  assert.deepEqual(plain(store.parseRecords(JSON.stringify({
    schema: store.COLLECTION_SCHEMA,
    version: 999,
    records: [makeRawRecord(3)]
  }))), []);
});

test('loadRecords returns [] when storage is missing, unavailable, or invalid', () => {
  const store = loadHistoryStore();

  assert.deepEqual(plain(store.loadRecords(null)), []);
  assert.deepEqual(plain(store.loadRecords({ getItem() { throw new Error('unavailable'); } })), []);
  assert.deepEqual(plain(store.loadRecords(createFakeStorage('{not-json'))), []);
  assert.deepEqual(plain(store.loadRecords(createFakeStorage(JSON.stringify({ id: 'not-array' })))), []);
});

test('saveRecords writes normalized JSON to storage key', () => {
  const store = loadHistoryStore();
  const storage = createFakeStorage(null);
  const result = store.saveRecords([
    {
      id: ' save-me ',
      image: ' data:image/png;base64,saved ',
      prompt: ' 儲存提示詞 ',
      model: '',
      size: ''
    }
  ], storage);

  assert.deepEqual(plain(result), [{
    id: 'save-me',
    schemaVersion: 2,
    userPrompt: '儲存提示詞',
    expandedPrompt: '',
    image: 'data:image/png;base64,saved',
    thumbnail: 'data:image/png;base64,saved',
    prompt: '儲存提示詞',
    providerPrompt: '儲存提示詞',
    negativePrompt: '',
    avoid: '',
    model: 'schnell',
    size: 'square',
    steps: null,
    cfgScale: null,
    seed: 0,
    width: 0,
    height: 0,
    imageUrl: '',
    localImageData: 'data:image/png;base64,saved',
    provider: '',
    mode: 'normal',
    favorite: false,
    tags: [],
    qaReport: null,
    recommended: false,
    agentRecommendation: '',
    autoRetry: null,
    nextSuggestions: [],
    cloudShareUrl: '',
    cloudDeleteUrl: '',
    cloudSavedAt: '',
    cloudPromptPublic: false,
    cloudStorage: '',
    sourceRecordId: '',
    versionGroupId: 'save-me',
    versionNumber: 1,
    createdAt: result[0].createdAt
  }]);
  assert.equal(storage.calls.setItem.length, 1);
  assert.equal(storage.calls.setItem[0][0], store.STORAGE_KEY);
  assert.equal(JSON.parse(storage.calls.setItem[0][1]).schema, store.COLLECTION_SCHEMA);
  assert.equal(JSON.parse(storage.calls.setItem[0][1]).version, store.COLLECTION_VERSION);
  assert.deepEqual(JSON.parse(storage.calls.setItem[0][1]).records, plain(result));
});

test('saveRecords drops oldest records on quota failure and does not throw', () => {
  const store = loadHistoryStore();
  const attempts = [];
  const storage = {
    setItem(key, value) {
      const parsed = JSON.parse(value);
      attempts.push({ key, length: parsed.records.length });
      if (parsed.records.length > 2) {
        throw new Error('quota exceeded');
      }
    }
  };
  const records = [makeRawRecord(1), makeRawRecord(2), makeRawRecord(3), makeRawRecord(4)];
  let result;

  assert.doesNotThrow(() => {
    result = store.saveRecords(records, storage);
  });

  assert.deepEqual(attempts.map((attempt) => attempt.length), [4, 3, 2]);
  assert.deepEqual(plain(result.map((record) => record.id)), ['record-1', 'record-2']);
  assert.deepEqual(records.map((record) => record.id), ['record-1', 'record-2', 'record-3', 'record-4']);
});

test('deleteRecords removes a selected batch and keeps the rest', () => {
  const store = loadHistoryStore();
  const records = [makeRawRecord(1), makeRawRecord(2), makeRawRecord(3), makeRawRecord(4)];
  const result = store.deleteRecords(records, ['record-2', 'record-4']);

  assert.deepEqual(plain(result.map((record) => record.id)), ['record-1', 'record-3']);
});

test('deleteRecord removes target and preserves others', () => {
  const store = loadHistoryStore();
  const records = [makeRawRecord(1), makeRawRecord(2), makeRawRecord(3)];
  const snapshot = plain(records);
  const result = store.deleteRecord(records, ' record-2 ');

  assert.deepEqual(plain(result.map((record) => record.id)), ['record-1', 'record-3']);
  assert.equal(result[0].prompt, snapshot[0].prompt);
  assert.equal(result[1].prompt, snapshot[2].prompt);
  assert.deepEqual(plain(records), snapshot);
});

test('clearRecords calls removeItem and returns []', () => {
  const store = loadHistoryStore();
  const storage = createFakeStorage(null);

  assert.deepEqual(plain(store.clearRecords(storage)), []);
  assert.deepEqual(storage.calls.removeItem, [store.STORAGE_KEY]);
});

test('source avoids ES6-only finite helpers for ES5 compatibility', () => {
  const source = readHistoryStoreSource();

  assert.doesNotMatch(source, /Number\.isFinite/);
  assert.doesNotMatch(source, /Number\.isSafeInteger/);
  assert.doesNotMatch(source, /=>/);
  assert.doesNotMatch(source, /\?\./);
});
