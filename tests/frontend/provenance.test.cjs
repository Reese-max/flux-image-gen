const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { webcrypto, createHash } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
function load(extra = {}) {
  const context = vm.createContext({ crypto: webcrypto, Blob, TextEncoder, TextDecoder,
    Uint8Array, ArrayBuffer, atob, btoa, URL, console, setTimeout, clearTimeout, AbortController,
    fetch: async () => { throw new Error('offline'); },
    C2paInspector: { inspect: async () => ({ status: 'absent' }) }, ...extra });
  for (const file of ['provenance.js', 'history-store.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'app/static', file), 'utf8'), context);
  }
  return { api: context.ImageProvenance, store: context.ImageHistoryStore };
}
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const bytes = Buffer.from(image.split(',')[1], 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
function record(patch = {}) {
  return { id: 'record-1', image, prompt: 'private creative prompt', providerPrompt: 'private provider prompt',
    provider: 'workers-ai', model: 'schnell', size: 'square', seed: 42, steps: 4, cfgScale: 1,
    createdAt: '2026-10-17T00:00:00.000Z', versionGroupId: 'record-1', versionNumber: 1, ...patch };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('versioned receipt hashes the actual output and private prompts; only allowlisted metadata survives', async () => {
  const { api } = load();
  const item = record({ apiKey: 'do-not-copy', imageUrl: 'https://provider.example/a?token=do-not-copy',
    providerProvenance: { model_revision: 'revision-1', signedUrl: 'https://x/?key=do-not-copy', turnstileToken: 'do-not-copy' } });
  const receipt = await api.createReceipt(item, { buildVersion: 'local-fixture-build' });
  assert.equal(receipt.receipt_schema_version, 1);
  assert.equal(receipt.record_id, item.id);
  assert.equal(receipt.output_sha256, hash(bytes));
  assert.equal(receipt.prompt_sha256, hash(item.prompt));
  assert.equal(receipt.provider_prompt_sha256, hash(item.providerPrompt));
  assert.equal(receipt.provider, 'workers-ai');
  assert.equal(receipt.model, 'schnell');
  assert.deepEqual(plain(receipt.settings), { seed: 42, size: 'square', width: 0, height: 0, steps: 4, cfg: 1, mode: 'generate' });
  assert.equal(receipt.created_at, item.createdAt);
  assert.ok(receipt.app_version);
  assert.equal(receipt.build_version, 'local-fixture-build');
  assert.match(receipt.receipt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.provider_provenance.model_revision, 'revision-1');
  assert.equal(receipt.credential.status, 'absent');
  assert.doesNotMatch(JSON.stringify(receipt), /private|do-not-copy|https?:|token|apiKey/);
});

test('verification checks both output bytes and the receipt, including its record identity', async () => {
  const { api } = load();
  const item = record();
  item.provenance = await api.createReceipt(item);
  assert.equal((await api.verifyReceipt(item)).status, 'hash_verified');
  const tampered = { ...item, image: image.replace(/.$/, 'A') };
  assert.equal((await api.verifyReceipt(tampered)).status, 'modified');
  assert.equal((await api.verifyReceipt({ ...item, id: 'other' })).status, 'modified');
  const edited = plain(item);
  edited.provenance.settings.seed++;
  assert.equal((await api.verifyReceipt(edited)).status, 'modified');
});

test('edit receipts record original/submitted hashes, transforms and parent without changing the parent', async () => {
  const { api, store } = load();
  const parent = store.normalizeRecord(record());
  parent.provenance = await api.createReceipt(parent);
  const before = JSON.stringify(parent);
  const child = store.createVersionRecord([parent], parent, record({ id: 'child', operation: 'edit' }));
  const input = { original_sha256: parent.provenance.output_sha256, submitted_sha256: hash('resized'),
    credential_status: 'present_untrusted', transform: 'resize_reencode', filename: 'GPS-private.jpg', exif: { GPS: 'private' } };
  child.provenance = await api.createReceipt(child, { parent, inputs: [input], operation: 'edit' });
  assert.deepEqual(plain(child.provenance.source_record_ids), [parent.id]);
  assert.equal(child.provenance.parent_receipt_sha256, parent.provenance.receipt_sha256);
  assert.equal(child.provenance.version_group_id, parent.versionGroupId);
  assert.equal(child.provenance.version_number, 2);
  assert.equal(child.provenance.settings.mode, 'edit');
  assert.equal(child.provenance.inputs[0].credential_status, 'unknown_after_transform');
  assert.equal(child.provenance.inputs[0].original_credential_status, 'present_untrusted');
  assert.equal(child.provenance.credential.status, 'unknown_after_transform');
  assert.doesNotMatch(JSON.stringify(child.provenance), /GPS|private|exif|filename/);
  assert.equal(JSON.stringify(parent), before);
});

test('credential inspection distinguishes validated trust, untrusted, invalid, missing, unsupported and stripped', async () => {
  const { api } = load();
  const blob = new Blob([bytes], { type: 'image/png' });
  for (const state of ['verified', 'present_untrusted', 'invalid', 'absent', 'unsupported']) {
    const result = await api.inspectCredentials(blob, { inspect: async () => ({ status: state, codes: ['claimSignature.validated'], raw: 'do-not-copy' }) });
    assert.equal(result.status, state);
    assert.equal(result.raw, undefined);
  }
  assert.equal((await api.inspectCredentials(blob, { transformed: true, inspect: async () => ({ status: 'absent' }) })).status, 'unknown_after_transform');
  assert.equal((await api.inspectCredentials(blob, { inspect: async () => { throw new Error('secret URL'); } })).status, 'unsupported');
  assert.equal((await api.inspectCredentials(blob, { inspect: async () => ({ status: 'verified', codes: ['assertion.dataHash.mismatch'] }) })).status, 'invalid');
});

test('history storage and single artwork JSON import preserve receipt schema without regenerating it', async () => {
  const { api, store } = load();
  const item = record();
  item.provenance = await api.createReceipt(item);
  const normalized = store.normalizeRecord(item);
  const collection = store.exportRecordCollection([normalized]);
  assert.deepEqual(plain(store.parseRecords(JSON.stringify(collection))[0].provenance), plain(item.provenance));
  assert.deepEqual(plain(store.parseRecords(JSON.stringify(normalized))[0].provenance), plain(item.provenance));
  assert.equal(store.normalizeRecord(record()).provenance, undefined, 'legacy records are not given fabricated receipts');
});

test('artwork export defaults to private, removes capability URLs and tokens, and still roundtrips', async () => {
  const { api, store } = load();
  const item = record({ cloudDeleteUrl: '/gallery/x/delete?deleteToken=do-not-copy', cloudShareUrl: '/share/x?token=do-not-copy',
    imageUrl: 'https://provider.example/image?api_key=do-not-copy', turnstileToken: 'do-not-copy' });
  item.provenance = await api.createReceipt(item);
  const exported = api.exportArtwork(item);
  assert.doesNotMatch(JSON.stringify(exported), /private creative|private provider|do-not-copy|deleteToken|api_key|turnstileToken/);
  assert.deepEqual(plain(exported.provenance), plain(item.provenance));
  assert.equal((await api.verifyReceipt(store.parseRecords(JSON.stringify(exported))[0])).status, 'hash_verified');
  assert.equal(api.exportArtwork(item, { promptPublic: true }).prompt, item.prompt);
});

test('public projection rehashes bytes and never accepts a browser trust claim as server verification', async () => {
  const { api } = load();
  const item = record();
  item.provenance = await api.createReceipt(item, { inspect: async () => ({ status: 'verified' }) });
  const publicInfo = await api.publicProvenance(item.provenance, bytes);
  assert.equal(publicInfo.output_sha256, hash(bytes));
  assert.equal(publicInfo.receipt_sha256, item.provenance.receipt_sha256);
  assert.equal(publicInfo.credential_status, 'present_untrusted');
  assert.doesNotMatch(JSON.stringify(publicInfo), /prompt|secret|token|https?:/);
  await assert.rejects(api.publicProvenance(item.provenance, new Uint8Array([0])), /hash|receipt/i);
});

test('edit preparation records both inputs and emits a history-ready record without copying private metadata', async () => {
  const { api } = load();
  const context = vm.createContext({ ImageProvenance: api, crypto: webcrypto, Blob, FormData, Uint8Array });
  vm.runInContext(fs.readFileSync(path.join(root, 'app/static/image-edit.js'), 'utf8'), context);
  const prepared = await context.ImageEdit.prepareProvenanceInput(new Blob([bytes]), new Blob(['resized']));
  assert.equal(prepared.original_sha256, hash(bytes));
  assert.equal(prepared.submitted_sha256, hash('resized'));
  assert.equal(prepared.transform, 'resize_reencode');
  const item = context.ImageEdit.createHistoryRecord({ image, provider: 'workers-ai', model: '@cf/black-forest-labs/flux-2-klein-4b' }, 'edit privately', [prepared]);
  assert.equal(item.operation, 'edit');
  assert.equal(item.provider, 'workers-ai');
  assert.equal(item.provenanceInputs[0].original_sha256, hash(bytes));
  assert.ok(item.id);
  assert.ok(item.createdAt);
});

test('imported credential badges are revalidated rather than trusted from an unsigned receipt', async () => {
  const { api } = load();
  const item = record();
  item.provenance = await api.createReceipt(item, { inspect: async () => ({ status: 'verified' }) });
  const result = await api.verifyReceipt(item);
  assert.equal(result.status, 'hash_verified');
  assert.equal(result.credential_status, 'absent', 'the current validator, not imported metadata, controls the badge');
});

test('even explicitly public exports redact capability URLs and credential-like prompt fragments', () => {
  const { api } = load();
  const exported = api.exportArtwork(record({ prompt: 'photo https://example.test/image?token=do-not-copy api_key=do-not-copy',
    providerPrompt: 'TurnstileToken=do-not-copy' }), { promptPublic: true });
  assert.doesNotMatch(JSON.stringify(exported), /do-not-copy/);
});

test('credential-like identifiers cannot escape via allowlisted receipt or export fields', async () => {
  const { api } = load();
  for (const key of ['nvapi-' + 'A'.repeat(32), 'sk-proj-' + 'A'.repeat(32)]) {
    const item = record({ provider: key, model: key, providerProvenance: { model_revision: key } });
    item.provenance = await api.createReceipt(item);
    assert.doesNotMatch(JSON.stringify(item.provenance), new RegExp(key));
    assert.doesNotMatch(JSON.stringify(api.exportArtwork(item)), new RegExp(key));
    assert.doesNotMatch(JSON.stringify(await api.publicProvenance(item.provenance, bytes)), new RegExp(key));
  }
});

test('a hung credential inspector is bounded and cannot block an internal receipt', async () => {
  const { api } = load();
  const inspection = api.inspectCredentials(new Blob([bytes]), { inspect: () => new Promise(() => {}), timeoutMs: 10 });
  const result = await Promise.race([inspection, new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
  assert.equal(result.status, 'unsupported');
});

test('pending and inaccessible remote outputs remain auditable without inventing an output hash', async () => {
  const { api } = load();
  const item = record({ image: 'https://provider.example/image?token=never-export' });
  item.provenance = api.pendingReceipt(item);
  assert.equal(item.provenance.record_id, item.id);
  assert.equal(item.provenance.credential.status, 'unsupported');
  assert.equal((await api.verifyReceipt(item)).status, 'unavailable');
  item.provenance = await api.createReceipt(item);
  assert.equal(item.provenance.output_sha256, '');
  assert.equal(item.provenance.credential.status, 'unsupported');
  assert.doesNotMatch(JSON.stringify(api.exportArtwork(item)), /never-export|https:/);
});

test('readable provider URLs are converted losslessly to local bytes with no credentials or referrer', async () => {
  const { api } = load({ fetch: async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  } });
  const local = await api.resolveOutputImage('https://provider.example/image?token=private');
  assert.equal(local, image);
  assert.equal((await api.createReceipt(record({ image: local }))).output_sha256, hash(bytes));
});

test('receipt uses effective provider model/settings, keeping unknown defaults explicit', async () => {
  const { api } = load();
  const item = record({ steps: 45, cfgScale: 7.5,
    providerProvenance: { model_id: '@cf/black-forest-labs/flux-2-klein-4b', steps: null, cfg_scale: null } });
  const receipt = await api.createReceipt(item);
  assert.equal(receipt.model, '@cf/black-forest-labs/flux-2-klein-4b');
  assert.equal(receipt.settings.steps, null);
  assert.equal(receipt.settings.cfg, null);
  assert.equal(item.model, 'schnell', 'the UI alias remains usable for regeneration');
});
