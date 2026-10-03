const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const scriptPath = path.resolve(__dirname, '../../app/static/history-store.js');

function readHistoryStoreSource() {
  return fs.readFileSync(scriptPath, 'utf8');
}

function loadHistoryStore(options = {}) {
  const source = readHistoryStoreSource();
  const context = vm.createContext({ console, URL: options.withoutUrl ? undefined : URL, atob: (value) => Buffer.from(value, 'base64').toString('binary') });
  const provenancePath = path.resolve(__dirname, '../../app/static/provenance.js');
  if (!options.withoutProvenance) {
    vm.runInContext(fs.readFileSync(provenancePath, 'utf8'), context, { filename: provenancePath });
  }

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
    image: '  ' + SHA_PNG + '  ',
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
  assert.ok(record.provenanceReceipt);
  assert.ok(record.outputSha256);
  const expected = plain(Object.assign({}, record, { createdAt: 'normalized-date' }));
  assert.equal(expected.id, 'history-id-1');
  assert.equal(expected.schemaVersion, 2);
  assert.equal(expected.userPrompt, '一隻太空貓');
  assert.equal(expected.model, 'schnell');
  assert.equal(expected.size, 'square');
  assert.equal(expected.versionGroupId, 'history-id-1');
  assert.equal(expected.versionNumber, 1);
  assert.equal(expected.provenanceReceipt.receiptSchemaVersion, 1);
  assert.equal(expected.provenanceReceipt.recordId, 'history-id-1');
  assert.equal(expected.provenanceReceipt.provider, '');
  assert.equal(expected.provenanceReceipt.model, 'schnell');
  assert.equal(expected.provenanceReceipt.lineage.versionGroupId, 'history-id-1');
  assert.equal(expected.provenanceReceipt.lineage.versionNumber, 1);
  assert.equal(expected.provenanceReceipt.credentialStatus, 'absent');
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
      image: ' ' + SHA_PNG + ' ',
      prompt: ' 儲存提示詞 ',
      model: '',
      size: ''
    }
  ], storage);

  assert.equal(result.length, 1);
  assert.ok(result[0].provenanceReceipt);
  assert.ok(result[0].outputSha256);
  const expected = plain(result[0]);
  assert.equal(expected.id, 'save-me');
  assert.equal(expected.schemaVersion, 2);
  assert.equal(expected.userPrompt, '儲存提示詞');
  assert.equal(expected.model, 'schnell');
  assert.equal(expected.size, 'square');
  assert.equal(expected.versionGroupId, 'save-me');
  assert.equal(expected.versionNumber, 1);
  assert.equal(expected.provenanceReceipt.receiptSchemaVersion, 1);
  assert.equal(expected.provenanceReceipt.recordId, 'save-me');
  assert.equal(expected.provenanceReceipt.provider, '');
  assert.equal(expected.provenanceReceipt.model, 'schnell');
  assert.equal(expected.provenanceReceipt.lineage.versionGroupId, 'save-me');
  assert.equal(expected.provenanceReceipt.lineage.versionNumber, 1);
  assert.equal(expected.provenanceReceipt.credentialStatus, 'absent');
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

test('normalizeRecord creates a ProvenanceReceipt with required fields', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({
    id: 'prov-1',
    image: 'data:image/png;base64,testimage',
    prompt: 'a test cat',
    model: 'dev',
    size: 'square',
    seed: 12345,
    provider: 'nvidia',
    steps: 30,
    cfgScale: 5,
    width: 1024,
    height: 1024
  });

  assert.ok(record.provenanceReceipt, 'record should have provenanceReceipt');
  const receipt = record.provenanceReceipt;
  assert.equal(receipt.receiptSchemaVersion, 1);
  assert.equal(receipt.recordId, 'prov-1');
  assert.ok(receipt.outputSha256, 'should have output SHA-256');
  assert.ok(/^[a-f0-9]{64}$/i.test(receipt.outputSha256), 'outputSha256 should be hex 64 chars');
  assert.equal(receipt.provider, 'nvidia');
  assert.equal(receipt.model, 'dev');
  assert.equal(receipt.seed, 12345);
  assert.equal(receipt.size, 'square');
  assert.equal(receipt.steps, 30);
  assert.equal(receipt.cfgScale, 5);
  assert.ok(receipt.createdAt, 'should have createdAt');
  assert.ok(receipt.appVersion, 'should have appVersion');
  assert.ok(receipt.lineage, 'should have lineage');
  assert.equal(receipt.lineage.parentReceiptHash, null);
  assert.equal(receipt.lineage.versionGroupId, 'prov-1');
  assert.equal(receipt.lineage.versionNumber, 1);
  assert.ok(!receipt.userPromptHash || typeof receipt.userPromptHash === 'string', 'userPromptHash should be string if present');
});

test('normalizeRecord for AI edit includes source image hashes', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({
    id: 'edit-1',
    image: 'data:image/png;base64,editedimage',
    prompt: 'edit the cat',
    model: '@cf/black-forest-labs/flux-2-klein-4b',
    size: 'square',
    seed: 54321,
    provider: 'workers-ai',
    sourceRecordId: 'parent-1',
    versionGroupId: 'group-1',
    versionNumber: 2,
    recordAction: 'edit',
    sourceImageHashes: ['a'.repeat(64), 'b'.repeat(64)]
  });

  assert.ok(record.provenanceReceipt);
  const receipt = record.provenanceReceipt;
  assert.deepEqual(plain(receipt.sourceImageHashes), ['a'.repeat(64), 'b'.repeat(64)]);
  assert.equal(receipt.lineage.parentReceiptHash, null);
  assert.deepEqual(plain(record.provenance.sourceRecordIds), ['parent-1']);
  assert.equal(receipt.lineage.versionGroupId, 'group-1');
  assert.equal(receipt.lineage.versionNumber, 2);
});

test('createVersionRecord creates new receipt pointing to parent receipt hash', () => {
  const store = loadHistoryStore();
  const parent = store.normalizeRecord({
    id: 'parent-1',
    image: 'data:image/png;base64,parent',
    prompt: 'a cat',
    versionGroupId: 'group-1',
    versionNumber: 1
  });
  const records = [
    parent,
    store.normalizeRecord({
      id: 'existing-v2',
      image: 'data:image/png;base64,v2',
      prompt: 'a cinematic cat',
      versionGroupId: 'group-1',
      versionNumber: 2
    })
  ];

  const version = store.createVersionRecord(records, parent, {
    image: 'data:image/png;base64,new',
    prompt: 'a realistic cat'
  }, () => 'new-version');

  assert.ok(version.provenanceReceipt);
  const receipt = version.provenanceReceipt;
  assert.equal(receipt.lineage.parentReceiptHash, parent.provenanceReceipt.receiptHash);
  assert.equal(receipt.lineage.versionGroupId, 'group-1');
  assert.equal(receipt.lineage.versionNumber, 3);
  assert.notEqual(receipt.outputSha256, parent.provenanceReceipt.outputSha256);
});

test('verifyReceiptHash detects output tampering', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({
    id: 'tamper-1',
    image: 'data:image/png;base64,original',
    prompt: 'a cat'
  });

  const originalHash = record.provenanceReceipt.outputSha256;
  const tamperedRecord = { ...record, image: 'data:image/png;base64,tampered' };
  const tamperedHash = store.computeOutputSha256 ? store.computeOutputSha256(tamperedRecord.image) : null;

  assert.ok(store.verifyReceiptHash);
  assert.equal(store.verifyReceiptHash(record), true, 'original should verify');
  assert.equal(store.verifyReceiptHash(tamperedRecord), false, 'tampered should not verify');
});

test('parseCredentialStatus returns expected status values', () => {
  const store = loadHistoryStore();

  assert.equal(store.parseCredentialStatus(null), 'absent');
  assert.equal(store.parseCredentialStatus({}), 'absent');
  assert.equal(store.parseCredentialStatus({ hasC2PA: true, valid: true }), 'present_untrusted');
  assert.equal(store.parseCredentialStatus({ hasC2PA: true, valid: false }), 'invalid');
  assert.equal(store.parseCredentialStatus({ hasC2PA: true, valid: null, transformApplied: true }), 'unknown_after_transform');
  assert.equal(store.parseCredentialStatus({ hasC2PA: false, providerDeclared: true }), 'absent');
  assert.equal(store.parseCredentialStatus({ unsupported: true }), 'unsupported');
});

test('exportRecordCollection roundtrips provenanceReceipt schema', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({
    id: 'export-1',
    image: 'data:image/png;base64,export',
    prompt: 'export test',
    model: 'dev',
    provider: 'nvidia'
  });

  const exported = store.exportRecordCollection([record]);
  const parsed = store.parseRecords(JSON.stringify(exported));

  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].provenanceReceipt);
  assert.equal(parsed[0].provenanceReceipt.receiptSchemaVersion, 1);
  assert.equal(parsed[0].provenanceReceipt.recordId, 'export-1');
  assert.equal(parsed[0].provenanceReceipt.outputSha256, record.provenanceReceipt.outputSha256);
});

test('private prompt mode keeps provider/model/hash/status but not full prompt in receipt', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({
    id: 'private-1',
    image: 'data:image/png;base64,private',
    prompt: 'my secret prompt that should not leak',
    providerPrompt: 'english secret prompt',
    model: 'dev',
    provider: 'nvidia',
    cloudPromptPublic: false
  });

  assert.ok(record.provenanceReceipt);
  const receipt = record.provenanceReceipt;
  assert.ok(receipt.provider);
  assert.ok(receipt.model);
  assert.ok(receipt.outputSha256);
  assert.ok(!receipt.userPrompt || receipt.userPrompt.length === 0 || receipt.userPromptHash);
  if (receipt.userPromptHash) {
    assert.ok(/^[a-f0-9]{64}$/i.test(receipt.userPromptHash));
  }
});

test('sensitive URLs and tokens never enter receipt or export', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({
    id: 'secret-1',
    image: 'data:image/png;base64,secret',
    prompt: 'test',
    cloudShareUrl: 'https://example.com/share?token=secret123',
    cloudDeleteUrl: 'https://example.com/delete?token=secret456',
    provider: 'nvidia'
  });

  const receipt = record.provenanceReceipt;
  const exported = store.exportRecordCollection([record]);
  const exportedStr = JSON.stringify(exported);

  assert.ok(!exportedStr.includes('secret123'), 'share token should not be in export');
  assert.ok(!exportedStr.includes('secret456'), 'delete token should not be in export');
  assert.ok(!JSON.stringify(receipt).includes('secret123'), 'share token should not be in receipt');
  assert.ok(!JSON.stringify(receipt).includes('secret456'), 'delete token should not be in receipt');
});

test('source avoids ES6-only finite helpers for ES5 compatibility', () => {
  const source = readHistoryStoreSource();

  assert.doesNotMatch(source, /Number\.isFinite/);
  assert.doesNotMatch(source, /Number\.isSafeInteger/);
  assert.doesNotMatch(source, /=>/);
  assert.doesNotMatch(source, /\?\./);
});

const SHA_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('history output hashes are SHA-256 of decoded image bytes', () => {
  const store = loadHistoryStore();
  const bytes = Buffer.from(SHA_PNG.split(',')[1], 'base64');
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  const record = store.normalizeRecord({ id: 'real-hash', image: SHA_PNG, prompt: 'synthetic fixture' });
  assert.equal(store.computeOutputSha256(SHA_PNG), expected);
  assert.equal(record.provenanceReceipt.outputSha256, expected);
  assert.equal(record.provenance.outputSha256, expected);
  assert.equal(store.verifyReceiptHash(record), true);
});

test('remote image URLs do not fabricate an output digest', () => {
  const store = loadHistoryStore();
  assert.equal(store.computeOutputSha256('https://example.invalid/image.png'), '');
  const record = store.normalizeRecord({ id: 'remote-hash', image: 'https://example.invalid/image.png', prompt: 'fixture' });
  assert.equal(record.provenance.outputHashStatus, 'remote_url');
  assert.equal(store.verifyReceiptHash(record), false);
});

test('credential booleans cannot mint a verified trust status', () => {
  const store = loadHistoryStore();
  assert.equal(store.parseCredentialStatus({ hasC2PA: true, valid: true }), 'present_untrusted');
  const record = store.normalizeRecord({ id: 'claimed-verified', image: SHA_PNG, prompt: 'fixture' });
  record.provenance.credentialStatus = 'verified';
  const restored = store.normalizeRecord(record);
  assert.notEqual(restored.provenance.credentialStatus, 'verified');
  assert.notEqual(restored.provenanceReceipt.credentialStatus, 'verified');
});

test('importing a tampered receipt does not reseal it as valid', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({ id: 'tampered-metadata', image: SHA_PNG, prompt: 'fixture' });
  record.provenance.seed += 1;
  const restored = store.normalizeRecord(record);
  assert.equal(store.verifyReceiptHash(restored), false);
});

test('missing provenance support preserves history without fabricated hashes', () => {
  const context = vm.createContext({ console });
  vm.runInContext(readHistoryStoreSource(), context, { filename: scriptPath });
  const record = context.ImageHistoryStore.normalizeRecord({ id: 'module-missing', image: SHA_PNG, prompt: 'fixture' });
  assert.equal(record.image, SHA_PNG);
  assert.equal(record.provenance, null);
  assert.equal(record.outputSha256, '');
});

test('a receipt bound to another record is not resealed as valid', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({ id: 'original-binding', image: SHA_PNG, prompt: 'fixture' });
  record.id = 'different-binding';
  const restored = store.normalizeRecord(record);
  assert.equal(store.verifyReceiptHash(restored), false);
});

test('a malformed imported receipt remains unavailable', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({ id: 'invalid-receipt', image: SHA_PNG, prompt: 'fixture', provenance: { schemaVersion: 99 } });
  assert.equal(record.image, SHA_PNG);
  assert.equal(record.provenance, null);
  assert.equal(store.verifyReceiptHash(record), false);
});

test('private storage retains delete capability while exports remove credentials', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({ id: 'private-delete', image: SHA_PNG, prompt: 'fixture', cloudDeleteUrl: 'https://example.invalid/delete?token=fake-delete-capability' });
  let saved = '';
  const storage = { setItem: (_, value) => { saved = value; }, getItem: () => saved };
  store.saveRecords([record], storage);
  const restored = store.loadRecords(storage);
  assert.equal(restored[0].cloudDeleteUrl, record.cloudDeleteUrl);
  assert.ok(!JSON.stringify(store.exportRecordCollection(restored)).includes('fake-delete-capability'));
});

test('export URL filtering handles encoded and mixed-case credential names', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({ id: 'mixed-case-token', image: SHA_PNG, prompt: 'fixture', cloudShareUrl: 'https://example.invalid/share?%54oken=fake-encoded-capability&Access_Token=fake-access-capability&view=public#fake-fragment', cloudDeleteUrl: 'https://example.invalid/delete/fake-path-capability' });
  const exported = store.exportRecordCollection([record]);
  assert.equal(exported.records[0].cloudShareUrl, 'https://example.invalid/share?view=public');
  const text = JSON.stringify(exported);
  assert.ok(!text.includes('fake-encoded-capability'));
  assert.ok(!text.includes('fake-access-capability'));
  assert.ok(!text.includes('fake-fragment'));
  assert.ok(!text.includes('fake-path-capability'));
});

test('export URL fallback removes query credentials without URL support', () => {
  const store = loadHistoryStore({ withoutUrl: true });
  const record = store.normalizeRecord({ id: 'fallback-url', image: SHA_PNG, prompt: 'fixture', cloudShareUrl: 'https://example.invalid/share?token=fake-capability#fake-fragment' });
  assert.equal(store.exportRecordCollection([record]).records[0].cloudShareUrl, 'https://example.invalid/share');
});

test('invalid imported receipts stay invalid through repeated normalization and export', () => {
  const store = loadHistoryStore();
  let record = store.normalizeRecord({ id: 'repeat-invalid', image: SHA_PNG, prompt: 'fixture', provenance: { schemaVersion: 99 } });
  for (let i = 0; i < 3; i += 1) {
    record = store.normalizeRecord(record);
    assert.equal(store.verifyReceiptHash(record), false);
  }
  const restored = store.parseRecords(JSON.stringify(store.exportRecordCollection([record])))[0];
  assert.equal(store.verifyReceiptHash(restored), false);
  assert.equal(restored.provenance, null);
});

test('module failure preserves private imported receipt, inputs and tamper evidence', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({ id: 'missing-module-import', image: SHA_PNG, prompt: 'fixture', recordAction: 'edit', editInputHashes: ['a'.repeat(64)] });
  record.provenance.seed += 1;
  const original = plain(record.provenance);
  assert.equal(store.verifyReceiptHash(record), false);
  let saved = '';
  const storage = { setItem: (_, value) => { saved = value; }, getItem: () => saved };
  const missing = loadHistoryStore({ withoutProvenance: true });
  missing.saveRecords([record], storage);
  assert.deepEqual(JSON.parse(saved).records[0].provenance, original);
  const restored = store.loadRecords(storage)[0];
  assert.equal(restored.provenance.action, 'edit');
  assert.equal(restored.provenance.inputs.length, 1);
  assert.equal(restored.provenance.receiptHash, original.receiptHash);
  assert.equal(store.verifyReceiptHash(restored), false);
});

test('module failure cannot export unvalidated receipt claims or later mint a new receipt', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({ id: 'missing-module-export', image: SHA_PNG, prompt: 'fixture' });
  record.provenance.credentialStatus = 'verified';
  const missing = loadHistoryStore({ withoutProvenance: true });
  const exported = missing.exportRecordCollection([record]);
  assert.equal(exported.records[0].provenance, null);
  assert.ok(!JSON.stringify(exported).includes('verified'));
  const restored = store.parseRecords(JSON.stringify(exported))[0];
  assert.equal(store.verifyReceiptHash(restored), false);
});

test('imported input credential claims cannot mint verified trust', () => {
  const store = loadHistoryStore();
  const record = store.normalizeRecord({ id: 'verified-input', image: SHA_PNG, prompt: 'fixture', recordAction: 'edit', editInputHashes: ['a'.repeat(64)] });
  record.provenance.inputs[0].credentialStatus = 'verified';
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/static/provenance.js'), 'utf8'), context);
  record.provenance.receiptHash = context.ImageProvenance.computeReceiptHash(record.provenance);
  assert.equal(store.verifyReceiptHash(record), true);
  const restored = store.normalizeRecord(record);
  assert.notEqual(restored.provenance.inputs[0].credentialStatus, 'verified');
  assert.equal(store.verifyReceiptHash(restored), false);
  assert.notEqual(store.exportRecordCollection([restored]).records[0].provenance.inputs[0].credentialStatus, 'verified');
});
