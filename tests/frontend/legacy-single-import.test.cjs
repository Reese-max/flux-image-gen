const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function store() {
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/static/history-store.js'), 'utf8'), context);
  return context.ImageHistoryStore;
}

function record(extra = {}) {
  return { id: 'legacy-one', image: 'data:image/png;base64,aGVsbG8=', prompt: 'synthetic cat',
    providerPrompt: 'a cat', negativePrompt: 'blur', seed: 23, provenance: null, ...extra };
}

test('receipt-less single export roundtrips without fabricating a receipt', () => {
  const restored = store().parseRecords(JSON.stringify(record()));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].negativePrompt, 'blur');
  assert.equal(restored[0].seed, 23);
  assert.equal(restored[0].provenance, undefined);
});

test('single artwork import rejects remote or malformed image data and unknown fields', () => {
  const parser = store();
  const invalid = [
    { image: 'https://untrusted.example/image.png' },
    { image: 'javascript:alert(1)' },
    { image: 'data:text/html;base64,PGh0bWw+' },
    { image: 'data:image/png;base64,!!!!' },
    { imageUrl: 'https://untrusted.example/image.png' },
    { thumbnail: 'https://untrusted.example/image.png' },
    { unexpectedCapability: 'synthetic' },
    { cloudDeleteUrl: 'https://outside.invalid/delete?token=synthetic-value' },
    { cloudDeleteUrl: '/gallery/example/delete?deleteToken=synthetic-value' },
    { cloudShareUrl: 'https://outside.invalid/share?token=synthetic-value' },
  ];
  for (const extra of invalid) {
    for (const provenance of [null, { receipt_schema_version: 1 }]) {
      assert.equal(parser.parseRecords(JSON.stringify(record({ ...extra, provenance }))).length, 0);
    }
  }
});

test('single artwork import rejects prototype keys even when a receipt is claimed', () => {
  const parser = store();
  for (const unsafe of [
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
    '{"provenance":{"receipt_schema_version":1,"settings":{"__proto__":{"polluted":true}}}}',
  ]) {
    const payload = record();
    const input = JSON.parse(unsafe);
    for (const key of Object.keys(input)) Object.defineProperty(payload, key, { value: input[key], enumerable: true });
    assert.equal(parser.parseRecords(JSON.stringify(payload)).length, 0);
  }
  assert.equal({}.polluted, undefined);
});

test('single artwork import rejects images over the 32 MiB encoded bound', () => {
  const tooLarge = 'data:image/png;base64,' + 'A'.repeat(32 * 1024 * 1024 + 4);
  assert.equal(store().parseRecords(JSON.stringify(record({ image: tooLarge, provenance: {} }))).length, 0);
});

test('existing versioned collection behavior remains compatible', () => {
  const parser = store();
  const payload = { schema: parser.COLLECTION_SCHEMA, version: parser.COLLECTION_VERSION,
    records: [record({ cloudDeleteUrl: '/gallery/example/delete?deleteToken=synthetic-value' })] };
  const restored = parser.parseRecords(JSON.stringify(payload));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].cloudDeleteUrl, payload.records[0].cloudDeleteUrl);
});
