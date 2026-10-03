const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const provenancePath = path.resolve(__dirname, '../../app/static/provenance.js');
const storePath = path.resolve(__dirname, '../../app/static/history-store.js');

function readProvenanceSource() {
  return fs.readFileSync(provenancePath, 'utf8');
}

function loadProvenance(extra) {
  const context = vm.createContext(
    Object.assign(
      {
        console,
        atob(b64) {
          return Buffer.from(b64, 'base64').toString('binary');
        },
        btoa(bin) {
          return Buffer.from(bin, 'binary').toString('base64');
        }
      },
      extra || {}
    )
  );
  vm.runInContext(readProvenanceSource(), context, { filename: provenancePath });
  assert.ok(context.ImageProvenance, 'ImageProvenance should be exposed on globalThis');
  return context.ImageProvenance;
}

function loadStoreWithProvenance() {
  const context = vm.createContext({
    console,
    atob(b64) {
      return Buffer.from(b64, 'base64').toString('binary');
    },
    Date
  });
  vm.runInContext(readProvenanceSource(), context, { filename: provenancePath });
  vm.runInContext(fs.readFileSync(storePath, 'utf8'), context, { filename: storePath });
  return { P: context.ImageProvenance, Store: context.ImageHistoryStore };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---- fixtures --------------------------------------------------------------

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG_URL = 'data:image/png;base64,' + TINY_PNG_B64;

function pngChunk(tag, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), payload]);
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}

function pngBytes(extraChunks) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const idat = pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0])));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, ...(extraChunks || []), idat, iend]);
}

function pngWithC2pa() {
  return pngBytes([pngChunk('caBX', Buffer.from('c2pa-manifest-store-bytes'))]);
}

function pngTruncatedCabx() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const declared = Buffer.alloc(4);
  declared.writeUInt32BE(0x1000);
  const corrupt = Buffer.concat([declared, Buffer.from('caBX'), Buffer.from('short')]);
  const idat = pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0])));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, corrupt, idat, iend]);
}

function jpegBytes(segments) {
  const parts = [Buffer.from([0xff, 0xd8])];
  (segments || []).forEach(function (seg) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(seg.payload.length + 2);
    parts.push(Buffer.from([0xff, seg.marker]), len, seg.payload);
  });
  parts.push(Buffer.from([0xff, 0xdb]), Buffer.from([0, 4]), Buffer.from([0, 0]));
  parts.push(Buffer.from([0xff, 0xda]), Buffer.from([0, 6]), Buffer.from([0, 0, 0, 0]));
  parts.push(Buffer.from([0x11, 0x22]), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function jpegWithC2pa() {
  return jpegBytes([{ marker: 0xeb, payload: Buffer.from('JP\x00\x00\x00\x0cjumburn:c2pa:fixture-claim') }]);
}

function jpegWithXmp() {
  const xmp = Buffer.from(
    "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description iptc:DigitalSourceType='trainedAlgorithmicMedia'/></x:xmpmeta>"
  );
  return jpegBytes([{ marker: 0xe1, payload: xmp }]);
}

function dataUrl(mime, buf) {
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeRecord(overrides) {
  return Object.assign(
    {
      id: 'rec-1',
      image: TINY_PNG_URL,
      thumbnail: TINY_PNG_URL,
      prompt: '一隻太空貓',
      userPrompt: '一隻太空貓',
      providerPrompt: 'a space cat',
      provider: 'workers-ai',
      model: 'schnell',
      seed: 42,
      size: 'square',
      steps: 4,
      cfgScale: null,
      mode: 'normal',
      width: 1024,
      height: 1024,
      versionGroupId: 'rec-1',
      versionNumber: 1,
      sourceRecordId: '',
      createdAt: '2026-09-30T00:00:00.000Z'
    },
    overrides || {}
  );
}

// ---- hashing / credential inspection ---------------------------------------

test('sha256Text and sha256Bytes match node crypto', () => {
  const P = loadProvenance();
  assert.equal(P.sha256Text('一隻太空貓'), sha256(Buffer.from('一隻太空貓', 'utf8')));
  assert.equal(P.sha256Bytes(new Uint8Array([1, 2, 3, 255])), sha256(Buffer.from([1, 2, 3, 255])));
  assert.equal(P.sha256Text(''), sha256(Buffer.alloc(0)));
});

test('inspectCredential classifies absent / present / invalid / unsupported', () => {
  const P = loadProvenance();

  const plainPng = P.inspectCredential(TINY_PNG_URL);
  assert.equal(plainPng.status, 'absent');
  assert.equal(plainPng.format, 'png');

  const cabx = P.inspectCredential(dataUrl('image/png', pngWithC2pa()));
  assert.equal(cabx.status, 'present_untrusted');
  assert.ok(cabx.signals.indexOf('c2pa-manifest') !== -1);

  const xmpPng = P.inspectCredential(
    dataUrl('image/png', pngBytes([pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\x00urn:c2pa:x'))]))
  );
  assert.equal(xmpPng.status, 'present_untrusted');

  const corrupt = P.inspectCredential(dataUrl('image/png', pngTruncatedCabx()));
  assert.equal(corrupt.status, 'invalid');

  const jpg = P.inspectCredential(dataUrl('image/jpeg', jpegWithC2pa()));
  assert.equal(jpg.status, 'present_untrusted');
  assert.equal(jpg.format, 'jpeg');

  const jxmp = P.inspectCredential(dataUrl('image/jpeg', jpegWithXmp()));
  assert.equal(jxmp.status, 'present_untrusted');
  assert.ok(jxmp.signals.indexOf('xmp-provenance') !== -1);

  const cleanJpg = P.inspectCredential(dataUrl('image/jpeg', jpegBytes([])));
  assert.equal(cleanJpg.status, 'absent');

  assert.equal(P.inspectCredential('https://example.com/x.png').status, 'unsupported');
  assert.equal(P.inspectCredential('not an image').status, 'unsupported');
});

test('inspectCredential never reports verified without trust chain', () => {
  const P = loadProvenance();
  [pngWithC2pa(), jpegWithC2pa(), jpegWithXmp()].forEach(function (buf) {
    assert.notEqual(P.inspectCredential(dataUrl('image/png', buf)).status, 'verified');
  });
});

// ---- receipt contract ------------------------------------------------------

test('buildReceipt records schema fields and hashes image bytes', () => {
  const P = loadProvenance();
  const receipt = P.buildReceipt(makeRecord(), { appVersion: 'v-test' });

  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.recordId, 'rec-1');
  assert.equal(receipt.action, 'generate');
  assert.equal(receipt.provider, 'workers-ai');
  assert.equal(receipt.model, 'schnell');
  assert.equal(receipt.seed, 42);
  assert.equal(receipt.size, 'square');
  assert.equal(receipt.steps, 4);
  assert.equal(receipt.mode, 'normal');
  assert.equal(receipt.createdAt, '2026-09-30T00:00:00.000Z');
  assert.equal(receipt.appVersion, 'v-test');
  assert.equal(receipt.outputSha256, sha256(Buffer.from(TINY_PNG_B64, 'base64')));
  assert.equal(receipt.outputHashStatus, 'sha256');
  assert.equal(receipt.promptSha256, sha256(Buffer.from('一隻太空貓', 'utf8')));
  assert.equal(receipt.promptPublic, false);
  assert.equal(receipt.credentialStatus, 'absent');
  assert.equal(receipt.parentReceiptHash, '');
  assert.deepEqual(plain(receipt.sourceRecordIds), []);
  assert.equal(receipt.receiptHash, P.computeReceiptHash(receipt));
  assert.equal(P.verifyReceiptHash(receipt), true);
});

test('buildReceipt never embeds prompt text or secrets', () => {
  const P = loadProvenance();
  const receipt = P.buildReceipt(
    makeRecord({
      providerProvenance: {
        outputSha256: 'ab'.repeat(32),
        credentialStatus: 'absent',
        apiKey: 'sk-leak',
        turnstileToken: 'tok',
        deleteToken: 'del'
      }
    })
  );
  const blob = JSON.stringify(receipt);
  assert.ok(blob.indexOf('一隻太空貓') === -1);
  assert.ok(blob.indexOf('a space cat') === -1);
  ['apiKey', 'turnstileToken', 'deleteToken', 'secret', 'password', 'sk-leak'].forEach(function (bad) {
    assert.ok(blob.indexOf(bad) === -1, 'receipt must not contain ' + bad);
  });
  assert.equal(receipt.providerFields.server.outputSha256, 'ab'.repeat(32));
});

test('verifyOutput detects tampering and stays honest on remote images', () => {
  const P = loadProvenance();
  const receipt = P.buildReceipt(makeRecord());
  assert.equal(P.verifyOutput(receipt, TINY_PNG_URL), 'match');
  assert.equal(P.verifyOutput(receipt, dataUrl('image/png', pngWithC2pa())), 'mismatch');
  assert.equal(P.verifyOutput(receipt, 'https://example.com/x.png'), 'unavailable');
  assert.equal(P.verifyOutput(null, TINY_PNG_URL), 'unavailable');

  const remote = P.buildReceipt(makeRecord({ image: 'https://example.com/x.png', imageUrl: 'https://example.com/x.png' }));
  assert.equal(remote.outputSha256, '');
  assert.equal(remote.outputHashStatus, 'remote_url');
});

test('regenerate receipt chains to parent without mutating it', () => {
  const P = loadProvenance();
  const parent = P.buildReceipt(makeRecord(), { appVersion: 'v-test' });
  const child = P.buildReceipt(
    makeRecord({ id: 'rec-2', sourceRecordId: 'rec-1', versionNumber: 2, image: dataUrl('image/png', pngBytes([])) }),
    { action: 'regenerate', parentReceipt: parent, appVersion: 'v-test' }
  );
  assert.equal(child.action, 'regenerate');
  assert.deepEqual(plain(child.sourceRecordIds), ['rec-1']);
  assert.equal(child.parentReceiptHash, parent.receiptHash);
  assert.notEqual(child.receiptHash, parent.receiptHash);
  assert.equal(parent.parentReceiptHash, '');
});

test('edit receipt records input hashes with unknown_after_transform', () => {
  const P = loadProvenance();
  const hashes = [sha256(Buffer.from('a')), sha256(Buffer.from('b'))];
  const receipt = P.buildReceipt(makeRecord({ recordAction: 'edit', editInputHashes: hashes }), { action: 'edit' });
  assert.equal(receipt.action, 'edit');
  assert.deepEqual(
    plain(receipt.inputs.map(function (i) {
      return i.sha256;
    })),
    hashes
  );
  receipt.inputs.forEach(function (entry) {
    assert.equal(entry.credentialStatus, 'unknown_after_transform');
    assert.equal(entry.transform, 'canvas-resize-png');
  });
});

test('recordTransform invalidates credential status honestly', () => {
  const P = loadProvenance();
  const receipt = P.buildReceipt(makeRecord({ image: dataUrl('image/png', pngWithC2pa()) }));
  assert.equal(receipt.credentialStatus, 'present_untrusted');
  const updated = P.recordTransform(receipt, 'client-reencode-jpeg');
  assert.equal(updated.credentialStatus, 'unknown_after_transform');
  assert.ok(updated.transforms.indexOf('client-reencode-jpeg') !== -1);
  assert.notEqual(updated.receiptHash, receipt.receiptHash);
});

test('normalizeReceipt roundtrips and detects tamper', () => {
  const P = loadProvenance();
  const receipt = P.buildReceipt(makeRecord(), { appVersion: 'v-test' });
  const normalized = P.normalizeReceipt(JSON.parse(JSON.stringify(receipt)));
  assert.deepEqual(plain(normalized), plain(receipt));
  assert.equal(P.verifyReceiptHash(normalized), true);

  const tampered = JSON.parse(JSON.stringify(receipt));
  tampered.provider = 'evil';
  assert.equal(P.verifyReceiptHash(P.normalizeReceipt(tampered)), false);
  assert.equal(P.normalizeReceipt('nope'), null);
  assert.equal(P.normalizeReceipt({ foo: 'bar' }), null);
});

test('publicReceipt applies the share allowlist', () => {
  const P = loadProvenance();
  const receipt = P.buildReceipt(makeRecord(), { appVersion: 'v-test' });
  const pub = P.publicReceipt(receipt);
  const blob = JSON.stringify(pub);
  ['promptSha256', 'promptPublic', 'inputs', 'providerFields'].forEach(function (field) {
    assert.ok(blob.indexOf(field) === -1, 'public receipt must not contain ' + field);
  });
  ['receiptHash', 'outputSha256', 'credentialStatus', 'provider', 'model', 'action', 'appVersion'].forEach(function (
    field
  ) {
    assert.ok(field in pub, 'public receipt should carry ' + field);
  });
  assert.equal(P.publicReceipt(null), null);
});

test('describeCredentialStatus never frames absent as non-AI', () => {
  const P = loadProvenance();
  const absent = P.describeCredentialStatus('absent');
  assert.ok(absent.indexOf('不代表') !== -1);
  assert.notEqual(P.describeCredentialStatus('absent'), P.describeCredentialStatus('invalid'));
  assert.notEqual(P.describeCredentialStatus('absent'), P.describeCredentialStatus('unknown_after_transform'));
});

// ---- cross-runtime receiptHash pin -----------------------------------------

const PINNED_RECEIPT_HASH = 'd124aa58706da03a74f4b83a54b5d57c3afc984fa831256c6dee5a61332fe8c5';

test('computeReceiptHash matches the Python twin on an identical receipt', () => {
  const P = loadProvenance();
  const receipt = {
    schemaVersion: 1,
    recordId: 'pin-fixture-1',
    action: 'generate',
    createdAt: '2026-09-30T00:00:00.000Z',
    appVersion: 'v1.4.0',
    provider: 'nvidia',
    model: 'dev',
    providerModelRevision: '',
    seed: 7,
    size: 'square',
    steps: 30,
    cfgScale: 4.0, // JSON.stringify emits 4 — Python canonicalizes 4.0 the same
    mode: 'normal',
    promptSha256: sha256('a lighthouse'),
    promptPublic: false,
    outputSha256: sha256(Buffer.from('fake-png-bytes')),
    outputHashStatus: 'sha256',
    sourceRecordIds: [],
    inputs: [],
    parentReceiptHash: '',
    versionGroupId: 'grp-1',
    versionNumber: 2,
    credentialStatus: 'absent',
    credentialSignals: [],
    credentialFormat: 'png',
    transforms: [],
    providerFields: { server: {} },
    receiptHash: '',
  };
  assert.equal(P.computeReceiptHash(receipt), PINNED_RECEIPT_HASH);
  // literals built outside the module realm must hash identically
  assert.equal(P.computeReceiptHash(JSON.parse(JSON.stringify(receipt))), PINNED_RECEIPT_HASH);
});

test('recordTransform with empty transform name is a no-op', () => {
  const P = loadProvenance();
  const receipt = P.buildReceipt(makeRecord(), { appVersion: 'v-test' });
  assert.deepEqual(plain(P.recordTransform(receipt, '')), plain(receipt));
});

test('inspectCredential accepts JPEG fill bytes without marking invalid', () => {
  const P = loadProvenance();
  const jfif = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x0a]),
    Buffer.from('JFIF\x00\x01\x01\x00\x00'),
  ]);
  const padded = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0x01]),
    jfif,
    Buffer.from([0xff, 0xda, 0x00, 0x08]),
    Buffer.from('DATA'),
    Buffer.from([0xff, 0xd9]),
  ]);
  const report = P.inspectCredential(new Uint8Array(padded));
  assert.equal(report.format, 'jpeg');
  assert.equal(report.status, 'absent');
});

test('hashImage accepts raw byte arrays like inspectCredential', async () => {
  const P = loadProvenance();
  const raw = new Uint8Array(Buffer.from(TINY_PNG_B64, 'base64'));
  const result = P.hashImage(raw);
  if (result && typeof result.then === 'function') {
    const resolved = await result;
    assert.equal(resolved.status, 'sha256');
    assert.equal(resolved.sha256, sha256(Buffer.from(raw)));
  } else {
    assert.equal(result.status, 'sha256');
    assert.equal(result.sha256, sha256(Buffer.from(raw)));
  }
});

// ---- history-store integration ---------------------------------------------

test('addRecord attaches a provenance receipt to new records', () => {
  const { Store } = loadStoreWithProvenance();
  const records = Store.addRecord([], makeRecord(), () => 'rec-1');
  assert.ok(records[0].provenance, 'new record should carry a provenance receipt');
  assert.equal(records[0].provenance.outputHashStatus, 'sha256');
  assert.equal(records[0].provenance.action, 'generate');
});

test('createVersionRecord produces a chained receipt', () => {
  const { Store, P } = loadStoreWithProvenance();
  const parent = Store.addRecord([], makeRecord({ id: 'parent-1' }), () => 'parent-1')[0];
  const child = Store.createVersionRecord(
    [parent],
    parent,
    makeRecord({ id: 'child-1', image: dataUrl('image/png', pngBytes([])) }),
    () => 'child-1'
  );
  assert.ok(child.provenance);
  assert.equal(child.provenance.action, 'regenerate');
  assert.equal(child.provenance.parentReceiptHash, parent.provenance.receiptHash);
  const saved = Store.addRecord([parent], child, () => 'child-1');
  assert.equal(saved[0].provenance.receiptHash, child.provenance.receiptHash);
  assert.equal(P.verifyOutput(saved[0].provenance, saved[0].image), 'match');
});

test('addRecord marks edit records with input hashes', () => {
  const { Store } = loadStoreWithProvenance();
  const hashes = [sha256(Buffer.from('input-1'))];
  const records = Store.addRecord(
    [],
    makeRecord({ recordAction: 'edit', editInputHashes: hashes }),
    () => 'edit-1'
  );
  assert.equal(records[0].provenance.action, 'edit');
  assert.equal(records[0].provenance.inputs[0].sha256, hashes[0]);
});

test('export/import roundtrip preserves the receipt', () => {
  const { Store } = loadStoreWithProvenance();
  const records = Store.addRecord([], makeRecord(), () => 'rec-1');
  const exported = Store.exportRecordCollection(records);
  const restored = Store.parseRecords(JSON.stringify(exported));
  assert.deepEqual(plain(restored[0].provenance), plain(records[0].provenance));
});

test('provenance.js stays ES5-compatible like sibling modules', () => {
  const source = readProvenanceSource();
  assert.doesNotMatch(source, /=>/);
  assert.doesNotMatch(source, /\?\./);
  assert.doesNotMatch(source, /Number\.isFinite/);
});
