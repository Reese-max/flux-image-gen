import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { sanitizeGalleryMeta } from '../src/gallery.js';
import { buildOutputProvenance, inspectCredentialBytes } from '../src/provenance.js';
import worker from '../src/index.js';

const TEST_GALLERY_SECRET = 'test-gallery-secret';
// 有效的 1x1 PNG（IHDR/IDAT/IEND 完整）。worker-transform 測試裡另一個
// TINY_PNG_DATA_URL 是截斷版，本檔刻意用完整 fixture 才能拿到 absent。
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_B64, 'base64');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

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

function pngWithC2pa() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const idat = pngChunk('IDAT', Buffer.from([0x78, 0x01, 0x01, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, pngChunk('caBX', Buffer.from('c2pa-manifest-store')), idat, iend]);
}

function jsonRequest(path, body) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fakeEnv(extra = {}) {
  return {
    ASSETS: {
      fetch() {
        return new Response('asset fallback', { status: 200 });
      },
    },
    ...extra,
  };
}

function fakeBucket() {
  const store = new Map();
  return {
    store,
    async put(key, value, options) {
      store.set(key, { value, options });
    },
    async get(key) {
      if (!store.has(key)) return null;
      const entry = store.get(key);
      return {
        body: entry.value,
        httpMetadata: entry.options?.httpMetadata,
        customMetadata: entry.options?.customMetadata,
      };
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options = {}) {
      const prefix = options.prefix || '';
      const limit = options.limit || 1000;
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = options.cursor ? Math.max(0, Number(options.cursor)) : 0;
      const selected = keys.slice(start, start + limit);
      const next = start + selected.length;
      return {
        objects: selected.map((key) => ({ key })),
        truncated: next < keys.length,
        cursor: next < keys.length ? String(next) : undefined,
      };
    },
  };
}

function signedGalleryRequest(body, secret = TEST_GALLERY_SECRET) {
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret).update(timestamp).digest('hex');
  return new Request('https://example.test/gallery', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gallery-Token': `${timestamp}.${signature}`,
    },
    body: JSON.stringify(body),
  });
}

function galleryEnv(bucket, extra = {}) {
  return fakeEnv({ IMAGE_BUCKET: bucket, GALLERY_TOKEN_SECRET: TEST_GALLERY_SECRET, ...extra });
}

// --- credential inspection ---------------------------------------------------

test('inspectCredentialBytes classifies PNG credential states honestly', () => {
  assert.equal(inspectCredentialBytes(TINY_PNG_BYTES).status, 'absent');
  const withC2pa = inspectCredentialBytes(pngWithC2pa());
  assert.equal(withC2pa.status, 'present_untrusted');
  assert.ok(withC2pa.signals.includes('c2pa-manifest'));
  assert.equal(inspectCredentialBytes(Buffer.from('not an image')).status, 'unsupported');
});

test('inspectCredentialBytes never claims verified', () => {
  assert.notEqual(inspectCredentialBytes(pngWithC2pa()).status, 'verified');
});

test('buildOutputProvenance attests exact output bytes', async () => {
  const block = await buildOutputProvenance(TINY_PNG_DATA_URL, [sha256(Buffer.from('input'))]);
  assert.equal(block.outputSha256, sha256(TINY_PNG_BYTES));
  assert.equal(block.outputHashStatus, 'sha256');
  assert.equal(block.credentialStatus, 'absent');
  assert.equal(block.format, 'png');
  assert.equal(block.inspection, 'structural');
  assert.deepEqual(block.inputImageHashes, [sha256(Buffer.from('input'))]);
});

test('buildOutputProvenance drops malformed input hashes', async () => {
  const block = await buildOutputProvenance(TINY_PNG_DATA_URL, ['not-hex', sha256(Buffer.from('a'))]);
  assert.deepEqual(block.inputImageHashes, [sha256(Buffer.from('a'))]);
});

// --- HTTP surface ------------------------------------------------------------

test('POST /generate returns server provenance attestation for the output bytes', async () => {
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: '一隻可愛的柯基', model: 'schnell', size: 'square' }),
    fakeEnv()
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.provenance, 'generate response should carry provenance');
  assert.equal(typeof data.provenance.outputSha256, 'string');
  assert.match(data.provenance.outputSha256, /^[0-9a-f]{64}$/);
  assert.ok(['absent', 'present_untrusted', 'invalid', 'unsupported'].includes(data.provenance.credentialStatus));
  assert.notEqual(data.provenance.credentialStatus, 'verified');
});

test('POST /generate/batch attaches per-image provenance', async () => {
  const response = await worker.fetch(
    jsonRequest('/generate/batch', { prompt: '一排盆栽', model: 'schnell', size: 'square', count: 2 }),
    fakeEnv()
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.images.length, 2);
  for (const image of data.images) {
    assert.ok(image.provenance);
    assert.match(image.provenance.outputSha256, /^[0-9a-f]{64}$/);
  }
});

test('POST /edit returns output provenance plus input image hashes', async () => {
  const editedPng = pngWithC2pa();
  const editedDataUrl = `data:image/png;base64,${editedPng.toString('base64')}`;
  const env = fakeEnv({
    AI: {
      async run() {
        return { image: editedPng.toString('base64') };
      },
    },
  });
  const form = new FormData();
  form.append('prompt', '把背景換成雨夜');
  form.append('images', new Blob([TINY_PNG_BYTES], { type: 'image/png' }), 'a.png');

  const response = await worker.fetch(
    new Request('https://example.test/edit', { method: 'POST', body: form }),
    env
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.provenance);
  // editImage embeds the provider base64 back into a data URL — hash must match
  // the exact output bytes the server produced.
  const expected = sha256(Buffer.from(editedDataUrl.split(',')[1], 'base64'));
  assert.equal(data.provenance.outputSha256, expected);
  assert.equal(data.provenance.credentialStatus, 'present_untrusted');
  assert.deepEqual(data.provenance.inputImageHashes, [sha256(TINY_PNG_BYTES)]);
});

// --- gallery meta allowlist ---------------------------------------------------

test('sanitizeGalleryMeta keeps allowlisted provenance fields and drops secrets', () => {
  const meta = sanitizeGalleryMeta({
    outputSha256: sha256(Buffer.from('out')),
    receiptHash: sha256(Buffer.from('receipt')),
    credentialStatus: 'present_untrusted',
    sourceAction: 'edit',
    appVersion: 'v1.4.0',
    deleteToken: 'secret-token',
    turnstileToken: 'tok',
    apiKey: 'sk-x',
    prompt: 'private prompt',
  });
  assert.equal(meta.outputSha256, sha256(Buffer.from('out')));
  assert.equal(meta.receiptHash, sha256(Buffer.from('receipt')));
  assert.equal(meta.credentialStatus, 'present_untrusted');
  assert.equal(meta.sourceAction, 'edit');
  assert.equal(meta.appVersion, 'v1.4.0');
  const blob = JSON.stringify(meta);
  for (const bad of ['deleteToken', 'turnstileToken', 'apiKey', 'secret-token', 'private prompt']) {
    assert.equal(blob.includes(bad), false, `meta must not contain ${bad}`);
  }
  // prompt only survives when explicitly public — and provenance never carries it
  assert.equal(meta.prompt, undefined);
});

test('sanitizeGalleryMeta rejects malformed hashes and unknown enum values', () => {
  const meta = sanitizeGalleryMeta({
    outputSha256: 'not-a-hash',
    receiptHash: 'xyz',
    credentialStatus: 'totally_made_up',
    sourceAction: 'evil',
  });
  assert.equal(meta.outputSha256, undefined);
  assert.equal(meta.receiptHash, undefined);
  assert.equal(meta.credentialStatus, undefined);
  assert.equal(meta.sourceAction, undefined);
});

test('sanitizeGalleryMeta never accepts client-minted verified status', () => {
  // No code path performs trust-chain validation, so "verified" must be
  // uninjectable into share pages via gallery metadata.
  const meta = sanitizeGalleryMeta({ credentialStatus: 'verified' });
  assert.equal(meta.credentialStatus, undefined);
});

test('GET /share/:id renders allowlisted provenance chips only', async () => {
  const bucket = fakeBucket();
  const saved = await (
    await worker.fetch(
      signedGalleryRequest({
        image: TINY_PNG_DATA_URL,
        meta: {
          title: '有來源的作品',
          outputSha256: sha256(TINY_PNG_BYTES),
          receiptHash: sha256(Buffer.from('receipt')),
          credentialStatus: 'absent',
          sourceAction: 'generate',
          appVersion: 'v1.4.0',
          prompt: 'private prompt must never render',
        },
      }),
      galleryEnv(bucket)
    )
  ).json();

  const share = await worker.fetch(
    new Request(`https://example.test/share/${saved.id}`, { method: 'GET' }),
    galleryEnv(bucket)
  );
  const html = await share.text();
  assert.equal(share.status, 200);
  assert.match(html, /來源與驗證/);
  assert.match(html, /輸出 SHA-256/);
  assert.match(html, /不代表非 AI/);
  assert.equal(html.includes('private prompt must never render'), false);
  assert.equal(html.includes('deleteToken'), false);
});

test('GET /share/:id omits the provenance section when no fields were stored', async () => {
  const bucket = fakeBucket();
  const saved = await (
    await worker.fetch(
      signedGalleryRequest({ image: TINY_PNG_DATA_URL, meta: { title: '普通作品' } }),
      galleryEnv(bucket)
    )
  ).json();
  const share = await worker.fetch(
    new Request(`https://example.test/share/${saved.id}`, { method: 'GET' }),
    galleryEnv(bucket)
  );
  const html = await share.text();
  assert.equal(share.status, 200);
  assert.equal(html.includes('來源與驗證'), false);
});
