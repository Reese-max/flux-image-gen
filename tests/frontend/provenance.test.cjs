const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const provenancePath = path.resolve(__dirname, '../../app/static/provenance.js');
const historyStorePath = path.resolve(__dirname, '../../app/static/history-store.js');
const historyWallPath = path.resolve(__dirname, '../../app/static/history-wall.js');

test('C2PA WASM survives Git content filters byte-for-byte', () => {
  const cwd = path.resolve(__dirname, '../..');
  for (const file of ['app/static/c2pa_bg.wasm', 'cloudflare/public/static/c2pa_bg.wasm']) {
    const hash = (args) => execFileSync('git', ['hash-object', ...args, file], { cwd, encoding: 'utf8' }).trim();
    assert.equal(hash(['--path=' + file]), hash(['--no-filters']), file + ' must not undergo newline conversion');
    assert.equal(WebAssembly.validate(fs.readFileSync(path.join(cwd, file))), true);
  }
});

function loadScripts(includeHistoryStore) {
  const context = vm.createContext({
    console,
    crypto,
    TextEncoder,
    Uint8Array,
    Blob,
    Promise,
    atob,
    btoa,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(provenancePath, 'utf8'), context, { filename: provenancePath });
  if (includeHistoryStore) {
    vm.runInContext(fs.readFileSync(historyStorePath, 'utf8'), context, { filename: historyStorePath });
  }
  return context;
}

function loadHistoryWallScripts() {
  const context = loadScripts(true);
  context.document = {
    addEventListener() {},
    getElementById() { return null; },
  };
  vm.runInContext(fs.readFileSync(historyWallPath, 'utf8'), context, { filename: historyWallPath });
  return context;
}

test('buildReceipt records hashes, settings, and edit lineage without prompt text', async () => {
  const context = loadScripts(false);
  const helper = context.ProvenanceReceipt;
  const parent = await helper.buildReceipt({
    id: 'parent-1',
    image: 'data:image/png;base64,aGVsbG8=',
    prompt: 'a private prompt',
    providerPrompt: 'private provider prompt',
    provider: 'demo',
    model: 'schnell',
    size: 'square',
    seed: 7,
    versionGroupId: 'group-1',
    versionNumber: 1,
    createdAt: '2026-09-07T00:00:00.000Z',
  });

  const child = await helper.buildReceipt({
    id: 'child-1',
    image: 'data:image/png;base64,d29ybGQ=',
    prompt: 'another private prompt',
    providerPrompt: 'another private provider prompt',
    provider: 'workers-ai',
    model: 'klein',
    size: 'edit',
    operation: 'edit',
    sourceRecordId: 'parent-1',
    inputImageSha256: [parent.output_sha256],
    versionGroupId: 'group-1',
    versionNumber: 2,
    createdAt: '2026-09-07T00:01:00.000Z',
  }, { provenanceReceipt: parent });

  assert.match(parent.output_sha256, /^[a-f0-9]{64}$/);
  assert.match(parent.prompt_sha256, /^[a-f0-9]{64}$/);
  assert.match(parent.receipt_hash, /^[a-f0-9]{64}$/);
  assert.equal(parent.credential_status, 'unsupported');
  assert.equal(Object.prototype.hasOwnProperty.call(parent, 'prompt'), false);
  assert.equal(child.operation, 'edit');
  assert.equal(child.source_record_ids[0], 'parent-1');
  assert.deepEqual(Array.from(child.input_image_hashes), [parent.output_sha256]);
  assert.equal(child.parent_receipt_hash, parent.receipt_hash);
  assert.equal(child.credential_status, 'unknown_after_transform');
  assert.equal(child.transform.credential_effect, 'unknown_after_transform');
});

test('verifyRecord detects output tampering and keeps credential status separate', async () => {
  const context = loadScripts(false);
  const helper = context.ProvenanceReceipt;
  const record = {
    id: 'record-1',
    image: 'data:image/png;base64,aGVsbG8=',
    prompt: 'a cat',
    providerPrompt: 'a cat',
    operation: 'generate',
  };
  record.provenanceReceipt = await helper.buildReceipt(record);

  const valid = await helper.verifyRecord(record);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.credential_status, 'unsupported');
  assert.equal(valid.output_hash_valid, true);
  assert.equal(valid.receipt_hash_valid, true);

  const tampered = Object.assign({}, record, { image: 'data:image/png;base64,d29ybGQ=' });
  const modified = await helper.verifyRecord(tampered);
  assert.equal(modified.status, 'modified');
  assert.equal(modified.output_hash_valid, false);
});

test('credential statuses stay explicit and invalid values fail closed', () => {
  const helper = loadScripts(false).ProvenanceReceipt;
  const statuses = ['verified', 'present_untrusted', 'invalid', 'absent', 'unknown_after_transform', 'unsupported'];
  statuses.forEach((status) => {
    const receipt = helper.normalizeReceipt({ record_id: 'record-' + status, operation: 'generate', receipt_schema_version: 2, credential_status: status });
    assert.equal(receipt.credential_status, status);
    assert.equal(receipt.credential_claim_status, status);
  });
  assert.equal(helper.normalizeReceipt({ record_id: 'record-invalid', operation: 'generate', credential_status: 'human_made' }).credential_status, 'unsupported');
  assert.equal(helper.normalizeReceipt({ record_id: 'edit-invalid', operation: 'edit', credential_status: 'human_made' }).credential_status, 'unknown_after_transform');
});

test('canonical receipt status and hash survive JSON reload', async () => {
  const context = loadScripts(false);
  const helper = context.ProvenanceReceipt;
  const record = {
    id: 'reload-record',
    image: 'data:image/png;base64,aGVsbG8=',
    prompt: 'reload fixture',
    providerPrompt: 'reload fixture',
    provider: 'demo',
  };
  const receipt = await helper.buildReceipt(record);
  const reloaded = JSON.parse(JSON.stringify(receipt));
  const normalized = helper.normalizeReceipt(reloaded);
  const verification = await helper.verifyRecord({ ...record, provenanceReceipt: reloaded });

  assert.equal(receipt.credential_status, 'unsupported');
  assert.equal(normalized.credential_status, 'unsupported');
  assert.equal(verification.status, 'valid');
  assert.equal(verification.receipt_hash_valid, true);
  assert.equal(verification.output_hash_valid, true);
});

test('JSON marker and copied validator result cannot mint trust', async () => {
  const context = loadScripts(false);
  const helper = context.ProvenanceReceipt;
  const record = {
    id: 'forged-marker-record',
    image: 'data:image/png;base64,aGVsbG8=',
    prompt: 'forged marker fixture',
    providerPrompt: 'forged marker fixture',
    provider: 'demo',
  };
  const forged = { status: 'verified', __flux_c2pa_validation_v1: true };
  const receipt = await helper.buildReceipt(record, null, forged);
  const copied = { ...forged };
  const copiedReceipt = await helper.buildReceipt({ ...record, id: 'copied-result' }, null, copied);

  assert.equal(receipt.credential_status, 'unsupported');
  assert.equal(copiedReceipt.credential_status, 'unsupported');
  assert.equal(Object.prototype.hasOwnProperty.call(receipt, '__flux_c2pa_validation_v1'), false);
});

test('copy-share text uses current verification instead of an imported marker', async () => {
  const context = loadHistoryWallScripts();
  const helper = context.ProvenanceReceipt;
  const record = {
    id: 'forged-share-record',
    image: 'data:image/png;base64,aGVsbG8=',
    prompt: 'private prompt',
    providerPrompt: 'private provider prompt',
    provenanceReceipt: {
      record_id: 'forged-share-record',
      receipt_schema_version: 2,
      credential_status: 'verified',
      __flux_c2pa_validation_v1: true,
    },
  };
  const share = context.ImageHistoryWall.buildShareText(record, true);

  assert.match(share, /Content Credentials：尚未支援檢查/);
  assert.doesNotMatch(share, /Content Credentials：已驗證/);
  assert.doesNotMatch(share, /private prompt/);
});

test('validator trust is private and bound to the exact image bytes', async () => {
  const context = loadScripts(false);
  const helper = context.ProvenanceReceipt;
  const signed = 'data:image/png;base64,aGVsbG8=';
  const other = 'data:image/png;base64,d29ybGQ=';
  context.FluxC2paWeb = {
    createC2pa: async () => ({
      reader: {
        fromBlob: async () => ({
          manifestStore: async () => ({
            validation_state: 'Valid',
            validation_status: [],
            validation_results: {
              activeManifest: {
                success: [{ code: 'signingCredential.trusted', url: 'urn:c2pa.signature' }],
                failure: [],
              },
            },
          }),
          free: async () => {},
        }),
      },
    }),
  };
  const validation = await helper.inspectCredential(signed, {
    settings: { verify: { verifyTrust: true }, cawgTrust: { verifyTrustList: false } },
  });
  const trusted = await helper.buildReceipt({
    id: 'trusted-exact', image: signed, prompt: 'trusted', providerPrompt: 'trusted', provider: 'demo',
  }, null, validation);
  const wrongImage = await helper.buildReceipt({
    id: 'trusted-wrong-image', image: other, prompt: 'trusted', providerPrompt: 'trusted', provider: 'demo',
  }, null, validation);
  const copied = await helper.buildReceipt({
    id: 'trusted-copied', image: signed, prompt: 'trusted', providerPrompt: 'trusted', provider: 'demo',
  }, null, JSON.parse(JSON.stringify(validation)));

  assert.equal(validation.status, 'verified');
  assert.equal(trusted.credential_status, 'verified');
  assert.equal(wrongImage.credential_status, 'unsupported');
  assert.equal(copied.credential_status, 'unsupported');
});

test('history export/import roundtrip keeps only the versioned receipt allowlist', async () => {
  const context = loadScripts(true);
  const helper = context.ProvenanceReceipt;
  const store = context.ImageHistoryStore;
  const raw = {
    id: 'record-1',
    image: 'data:image/png;base64,aGVsbG8=',
    prompt: 'private prompt',
    providerPrompt: 'private provider prompt',
    provenanceReceipt: await helper.buildReceipt({
      id: 'record-1',
      image: 'data:image/png;base64,aGVsbG8=',
      prompt: 'private prompt',
      providerPrompt: 'private provider prompt',
      provider: 'demo',
    }),
  };
  raw.provenanceReceipt.secret = 'should be dropped';
  const normalized = store.normalizeRecord(raw);
  const roundTrip = store.parseRecords(JSON.stringify(store.exportRecordCollection([normalized])));

  assert.equal(roundTrip.length, 1);
  assert.equal(roundTrip[0].provenanceReceipt.receipt_schema_version, 2);
  assert.equal(roundTrip[0].provenanceReceipt.record_id, 'record-1');
  assert.equal(Object.prototype.hasOwnProperty.call(roundTrip[0].provenanceReceipt, 'secret'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(roundTrip[0].provenanceReceipt, 'prompt'), false);
});

test('history event queue persists receipts for id-less batch results', async () => {
  const listeners = {};
  const saved = [];
  const storage = {
    getItem() { return null; },
    setItem(key, value) { saved.push({ key, value }); },
    removeItem() {},
  };
  const document = {
    addEventListener(type, handler) { listeners[type] = handler; },
    getElementById() { return null; },
    createElement() { return { addEventListener() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }; },
  };
  const context = vm.createContext({
    console,
    document,
    localStorage: storage,
    setTimeout,
    clearTimeout,
    crypto,
    TextEncoder,
    Uint8Array,
    Promise,
    atob,
    btoa,
    Date,
    Math,
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(provenancePath, 'utf8'), context, { filename: provenancePath });
  vm.runInContext(fs.readFileSync(historyStorePath, 'utf8'), context, { filename: historyStorePath });
  vm.runInContext(fs.readFileSync(historyWallPath, 'utf8'), context, { filename: historyWallPath });

  listeners['imagegen:generated']({ detail: {
    image: 'data:image/png;base64,aGVsbG8=',
    prompt: 'first batch prompt',
    providerPrompt: 'first batch prompt',
    provider: 'demo',
    model: 'schnell',
    size: 'square',
    seed: 1,
  } });
  listeners['imagegen:generated']({ detail: {
    image: 'data:image/png;base64,d29ybGQ=',
    prompt: 'second batch prompt',
    providerPrompt: 'second batch prompt',
    provider: 'demo',
    model: 'schnell',
    size: 'square',
    seed: 2,
  } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(saved.length, 2);
  const latest = JSON.parse(saved[saved.length - 1].value);
  assert.equal(latest.records.length, 2);
  assert.match(latest.records[0].provenanceReceipt.output_sha256, /^[a-f0-9]{64}$/);
  assert.match(latest.records[1].provenanceReceipt.output_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(latest.records[0].id, latest.records[1].id);
});

test('edit records cannot be regenerated as unrelated text-to-image work', () => {
  const listeners = {};
  const modal = { hidden: true, addEventListener() {} };
  const calls = { generated: 0, status: [] };
  const document = {
    addEventListener(type, handler) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    getElementById(id) {
      return id === 'historyDetailModal' ? modal : null;
    },
  };
  const context = vm.createContext({
    console,
    document,
    localStorage: {
      getItem() {
        return JSON.stringify([{
          id: 'edited-record',
          image: 'data:image/png;base64,aGVsbG8=',
          prompt: 'change the background',
          operation: 'edit',
          provenanceReceipt: {
            schema: 'ProvenanceReceipt',
            receipt_schema_version: 2,
            record_id: 'edited-record',
            operation: 'edit',
            credential_status: 'unknown_after_transform',
          },
        }]);
      },
      setItem() {},
    },
    ImageGenApp: {
      setStatus(message) { calls.status.push(message); },
      setGenerationSettings() { throw new Error('edit must not configure text-to-image'); },
      generate() { calls.generated += 1; },
    },
    showTab() { return true; },
    crypto,
    TextEncoder,
    Uint8Array,
    Blob,
    Promise,
    atob,
    btoa,
    Date,
    Math,
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(historyStorePath, 'utf8'), context, { filename: historyStorePath });
  vm.runInContext(fs.readFileSync(historyWallPath, 'utf8'), context, { filename: historyWallPath });
  (listeners.DOMContentLoaded || []).forEach((listener) => listener());

  const record = context.ImageHistoryStore.loadRecords()[0];
  context.ImageHistoryWall.openHistoryDetail(record);
  context.ImageHistoryWall.regenerateHistoryDetail();

  assert.equal(calls.generated, 0);
  assert.match(calls.status[0], /AI 編輯作品/);
});

test('history JSON export omits cloud links that contain deletion or query tokens', () => {
  const context = loadHistoryWallScripts();
  const sanitized = context.ImageHistoryWall.exportRecordForDownload({
    id: 'export-record',
    image: 'data:image/png;base64,aGVsbG8=',
    prompt: 'private prompt',
    cloudShareUrl: 'https://example.test/share/export-record?token=drop-me',
    cloudDeleteUrl: 'https://example.test/delete?deleteToken=drop-me',
  });

  assert.equal(sanitized.cloudShareUrl, '');
  assert.equal(sanitized.cloudDeleteUrl, '');
  assert.doesNotMatch(JSON.stringify(sanitized), /drop-me/);
});

test('history export rejects token-bearing image URLs and keeps safe local bytes', () => {
  const wall = loadHistoryWallScripts().ImageHistoryWall;
  const image = 'data:image/png;base64,aGVsbG8=';
  const privateUrl = 'https://example.test/image.png?access_token=synthetic-export-token';
  assert.equal(wall.exportRecordForDownload({ id: 'remote', image: privateUrl, prompt: 'cat' }), null);
  const exported = wall.exportRecordForDownload({
    id: 'local', image, prompt: 'cat', thumbnail: privateUrl, imageUrl: privateUrl,
    cloudShareUrl: 'https://example.test/share/local',
  });
  assert.equal(exported.image, image);
  assert.equal(exported.thumbnail, image);
  assert.equal(exported.imageUrl, '');
  assert.equal(exported.cloudShareUrl, '');
  assert.doesNotMatch(JSON.stringify(exported), /synthetic-export-token/);
  assert.doesNotMatch(wall.buildShareText({
    id: 'share', image, prompt: 'cat', cloudShareUrl: privateUrl,
  }, true), /synthetic-export-token/);
});

test('known transformations distinguish stripped credentials from an untouched absent manifest', async () => {
  const context = loadScripts(false);
  context.FluxC2paWeb = { createC2pa: async () => ({ reader: { fromBlob: async () => null } }) };
  const helper = context.ProvenanceReceipt;
  const image = 'data:image/png;base64,aGVsbG8=';
  const untouched = await helper.attachRecord({ id: 'untouched', image, prompt: 'cat' });
  const edited = await helper.attachRecord({ id: 'edited', image, prompt: 'cat', operation: 'edit' });
  const resized = await helper.attachRecord({
    id: 'resized', image, prompt: 'cat',
    transform: { kind: 'download_reencode', applied: true, credential_effect: 'unknown_after_transform' },
  });
  assert.equal(untouched.provenanceReceipt.credential_status, 'absent');
  for (const record of [edited, resized]) {
    assert.equal(record.provenanceReceipt.credential_status, 'unknown_after_transform');
    assert.equal((await helper.verifyRecord(record)).credential_status, 'unknown_after_transform');
  }
});

test('a stalled C2PA runtime cannot prevent attaching a receipt indefinitely', async () => {
  const context = loadScripts(false);
  let timeout;
  let cleared = false;
  let started;
  const startup = new Promise((resolve) => { started = resolve; });
  context.setTimeout = (callback, delay) => { assert.equal(delay, 10000); timeout = callback; return 1; };
  context.clearTimeout = () => { cleared = true; };
  context.FluxC2paWeb = { createC2pa: () => { started(); return new Promise(() => {}); } };
  const attached = context.ProvenanceReceipt.attachRecord({
    id: 'stalled', image: 'data:image/png;base64,aGVsbG8=', prompt: 'cat',
  });
  await startup;
  assert.equal(typeof timeout, 'function', 'credential inspection needs a bounded wait');
  timeout();
  const record = await attached;
  assert.equal(record.provenanceReceipt.credential_status, 'unsupported');
  assert.match(record.provenanceReceipt.output_sha256, /^[a-f0-9]{64}$/);
  assert.equal(cleared, true);
});

test('clearing history cancels earlier queued writes and keeps later generations', async () => {
  const context = loadScripts(true);
  const listeners = {};
  const clear = { addEventListener(type, handler) { this[type] = handler; } };
  let stored = JSON.stringify([{ id: 'older-record', image: 'data:image/png;base64,aGVsbG8=', prompt: 'older cat' }]);
  let release;
  let started;
  const attaching = new Promise((resolve) => { started = resolve; });
  context.localStorage = {
    getItem() { return stored; },
    setItem(key, value) { stored = value; },
    removeItem() { stored = null; },
  };
  context.document = {
    addEventListener(type, handler) { listeners[type] = handler; },
    getElementById(id) { return id === 'clearHistory' ? clear : null; },
  };
  context.ProvenanceReceipt.attachRecord = (record) => {
    if (record.id === 'pending-before-clear') {
      started();
      return new Promise((resolve) => { release = () => resolve(record); });
    }
    return Promise.resolve(record);
  };
  vm.runInContext(fs.readFileSync(historyWallPath, 'utf8'), context, { filename: historyWallPath });
  listeners.DOMContentLoaded();
  assert.equal(context.ImageHistoryStore.loadRecords()[0].id, 'older-record');
  const emit = (id) => listeners['imagegen:generated']({ detail: {
    id, image: 'data:image/png;base64,aGVsbG8=', prompt: 'cat',
  } });
  emit('pending-before-clear');
  emit('queued-before-clear');
  await attaching;
  clear.click();
  assert.equal(stored, null);
  release();
  emit('after-clear');
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(stored).records.map((record) => record.id), ['after-clear']);
});

test('new history records and receipts share the reserved creation timestamp', async () => {
  const context = loadScripts(true);
  let clock = 0;
  context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [Date.UTC(2026, 9, 17) + clock++])); }
  };
  const listeners = {};
  let save;
  const saved = new Promise((resolve) => { save = resolve; });
  context.localStorage = { getItem() { return null; }, setItem(key, value) { save(JSON.parse(value)); } };
  context.document = {
    addEventListener(type, handler) { listeners[type] = handler; },
    getElementById() { return null; },
  };
  vm.runInContext(fs.readFileSync(historyWallPath, 'utf8'), context, { filename: historyWallPath });
  listeners['imagegen:generated']({ detail: {
    id: 'timestamp-record', image: 'data:image/png;base64,aGVsbG8=', prompt: 'cat',
  } });
  const record = (await saved).records[0];
  assert.equal(record.createdAt, record.provenanceReceipt.created_at);
});
