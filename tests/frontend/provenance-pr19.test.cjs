// PR #19's receipt behaviors, exercised against main's newer schema-1 API.
// Inspector results here are synthetic and do not establish real signer trust.
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '../../app/static');
const firstImage = 'data:image/png;base64,aGVsbG8=';
const otherImage = 'data:image/png;base64,d29ybGQ=';

function fixture(overrides = {}) {
  return { id: 'record-1', image: firstImage, prompt: 'private prompt', providerPrompt: 'private provider prompt',
    provider: 'demo', model: 'schnell', size: 'square', seed: 7, createdAt: '2026-09-07T00:00:00.000Z', ...overrides };
}

function load(includeWall = false) {
  const listeners = {};
  const saved = new Map();
  const document = {
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    getElementById() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement() { return { addEventListener() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }; },
    dispatchEvent(event) { return (listeners[event.type] || []).map(handler => handler(event)); },
  };
  const context = vm.createContext({ console, crypto: webcrypto, document, Blob, TextEncoder, TextDecoder,
    Uint8Array, ArrayBuffer, URL, AbortController, atob, btoa, Date, Math, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    localStorage: { getItem(key) { return saved.get(key) || null; }, setItem(key, value) { saved.set(key, value); }, removeItem(key) { saved.delete(key); } },
    fetch: async () => { throw new Error('offline synthetic fixture'); },
  });
  context.globalThis = context;
  for (const file of ['provenance.js', 'history-store.js', ...(includeWall ? ['history-wall.js'] : [])]) {
    vm.runInContext(fs.readFileSync(path.join(staticRoot, file), 'utf8'), context, { filename: file });
  }
  return { context, api: context.ImageProvenance, store: context.ImageHistoryStore, listeners };
}

test('buildReceipt records hashes, settings, and edit lineage without prompt text', async () => {
  const { api } = load();
  const parent = fixture({ id: 'parent-1' });
  parent.provenance = await api.createReceipt(parent);
  const child = fixture({ id: 'child-1', image: otherImage, sourceRecordId: parent.id, seed: 8 });
  const receipt = await api.createReceipt(child, { parent, operation: 'edit', inputs: [{
    original_sha256: parent.provenance.output_sha256, submitted_sha256: parent.provenance.output_sha256,
    credential_status: 'unsupported', transform: 'none',
  }] });
  assert.match(parent.provenance.output_sha256, /^[a-f0-9]{64}$/);
  assert.match(parent.provenance.prompt_sha256, /^[a-f0-9]{64}$/);
  assert.match(parent.provenance.receipt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.settings.mode, 'edit');
  assert.equal(receipt.source_record_ids[0], 'parent-1');
  assert.equal(receipt.inputs[0].original_sha256, parent.provenance.output_sha256);
  assert.equal(receipt.parent_receipt_sha256, parent.provenance.receipt_sha256);
  assert.doesNotMatch(JSON.stringify(receipt), /private prompt|private provider prompt/);
});

test('verifyRecord detects output tampering and keeps credential status separate', async () => {
  const { api } = load();
  const record = fixture();
  record.provenance = await api.createReceipt(record);
  const valid = await api.verifyReceipt(record);
  const tampered = await api.verifyReceipt({ ...record, image: otherImage });
  assert.equal(valid.status, 'hash_verified');
  assert.equal(valid.credential_status, 'unsupported');
  assert.equal(tampered.status, 'modified');
  assert.equal(tampered.credential_status, 'invalid');
});

test('credential statuses stay explicit and invalid values fail closed', async () => {
  const { api } = load();
  for (const status of ['verified', 'present_untrusted', 'invalid', 'absent', 'unknown_after_transform', 'unsupported']) {
    assert.equal(api.normalizeReceipt({ receipt_schema_version: 1, credential: { status } }).credential.status, status);
  }
  assert.equal(api.normalizeReceipt({ receipt_schema_version: 1, credential: { status: 'human_made' } }).credential.status, 'unsupported');
  const transformed = await api.inspectCredentials(new Blob(['synthetic']), { transformed: true, inspect: async () => ({ status: 'absent' }) });
  assert.equal(transformed.status, 'unknown_after_transform');
});

test('canonical receipt status and hash survive JSON reload', async () => {
  const { api } = load();
  const record = fixture();
  const receipt = await api.createReceipt(record);
  const reloaded = JSON.parse(JSON.stringify(receipt));
  assert.equal(api.normalizeReceipt(reloaded).receipt_sha256, receipt.receipt_sha256);
  assert.equal(api.normalizeReceipt(reloaded).credential.status, 'unsupported');
  assert.equal((await api.verifyReceipt({ ...record, provenance: reloaded })).status, 'hash_verified');
});

test('JSON marker and copied validator result cannot mint trust', async () => {
  const { api } = load();
  const record = fixture();
  const forged = { status: 'verified', __flux_c2pa_validation_v1: true };
  record.provenance = await api.createReceipt(record, { inspect: async () => forged });
  const copied = JSON.parse(JSON.stringify(record.provenance));
  assert.equal(Object.prototype.hasOwnProperty.call(copied.credential, '__flux_c2pa_validation_v1'), false);
  // Verification re-inspects the current bytes: no inspector means unsupported.
  assert.equal((await api.verifyReceipt({ ...record, provenance: copied })).credential_status, 'unsupported');
  const publicReceipt = await api.publicProvenance(copied, new Blob(['hello']));
  assert.equal(publicReceipt.credential_status, 'present_untrusted');
});

test('copy-share text uses current verification instead of an imported marker', () => {
  const { context } = load(true);
  const record = fixture({ provenance: { receipt_schema_version: 1, credential: { status: 'verified' },
    __flux_c2pa_validation_v1: true } });
  const share = context.ImageHistoryWall.buildShareText(record, true);
  assert.match(share, /Content Credentials：尚未驗證/);
  assert.doesNotMatch(share, /Content Credentials：已驗證|private prompt|private provider prompt/);
});

test('validator trust is private and bound to the exact image bytes', async () => {
  const { api, context } = load();
  const observed = [];
  context.C2paInspector = { async inspect(blob) {
    const data = Buffer.from(await blob.arrayBuffer()).toString('utf8');
    observed.push(data);
    return { status: data === 'hello' ? 'verified' : 'unsupported' };
  } };
  const record = fixture();
  record.provenance = await api.createReceipt(record);
  assert.equal((await api.verifyReceipt(record)).credential_status, 'verified');
  const wrong = await api.verifyReceipt({ ...record, image: otherImage });
  assert.equal(wrong.status, 'modified');
  assert.notEqual(wrong.credential_status, 'verified');
  assert.deepEqual(observed, ['hello', 'hello', 'world']);
});

test('history export/import roundtrip keeps only the versioned receipt allowlist', async () => {
  const { api, store } = load();
  const record = fixture();
  record.provenance = await api.createReceipt(record);
  record.provenance.secret = 'synthetic-secret';
  const normalized = store.normalizeRecord(record);
  const roundTrip = store.parseRecords(JSON.stringify(store.exportRecordCollection([normalized])));
  assert.equal(roundTrip.length, 1);
  assert.equal(roundTrip[0].provenance.receipt_schema_version, 1);
  assert.equal(roundTrip[0].provenance.record_id, record.id);
  assert.equal(roundTrip[0].provenance.output_sha256, record.provenance.output_sha256);
  assert.doesNotMatch(JSON.stringify(roundTrip[0].provenance), /synthetic-secret|private prompt/);
});

test('history event queue persists receipts for id-less batch results', async () => {
  const { store, listeners } = load(true);
  const emit = listeners['imagegen:generated'][0];
  const first = fixture({ id: undefined, image: firstImage, seed: 1 });
  const second = fixture({ id: undefined, image: otherImage, seed: 2 });
  const pending = [emit({ detail: first }), emit({ detail: second })];
  await Promise.all(pending);
  const saved = store.loadRecords();
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].id, saved[1].id);
  assert.match(saved[0].provenance.output_sha256, /^[a-f0-9]{64}$/);
  assert.match(saved[1].provenance.output_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(saved[0].provenance.output_sha256, saved[1].provenance.output_sha256);
});
