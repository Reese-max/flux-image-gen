const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const provenancePath = path.resolve(__dirname, '../../app/static/provenance.js');
const historyStorePath = path.resolve(__dirname, '../../app/static/history-store.js');
const historyWallPath = path.resolve(__dirname, '../../app/static/history-wall.js');

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
