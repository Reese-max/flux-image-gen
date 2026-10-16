import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import worker from '../src/index.js';
import { issueGalleryToken } from '../src/gallery.js';
import '../../app/static/provenance.js';

globalThis.crypto ||= webcrypto;
const api = globalThis.ImageProvenance;
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
function bucket() {
  const objects = new Map();
  return { objects, async put(key, value, options) { objects.set(key, { value, ...options }); },
    async get(key) { const item = objects.get(key); return item && { body: item.value, httpMetadata: item.httpMetadata, text: async () => item.value }; } };
}
async function setup() {
  const storage = bucket();
  const env = { IMAGE_BUCKET: storage, GALLERY_TOKEN_SECRET: 'local-fixture-signing-only' };
  const token = await issueGalleryToken(env);
  const record = { id: 'local-id', image, prompt: 'never publish this prompt', provider: 'workers-ai', model: 'schnell',
    size: 'square', seed: 42, createdAt: '2026-10-17T00:00:00.000Z' };
  record.provenance = await api.createReceipt(record, { inspect: async () => ({ status: 'verified' }) });
  const save = provenance => worker.fetch(new Request('https://example.test/gallery', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gallery-token': token },
    body: JSON.stringify({ image, meta: { prompt: record.prompt, provider: record.provider,
      model: record.model, provenance, token: 'never-publish-token' } }) }), env);
  return { storage, env, record, save };
}

test('R2/share preserve original bytes, store checked public hashes, and never publish private metadata or asserted trust', async () => {
  const { storage, env, record, save } = await setup();
  const response = await save(record.provenance);
  assert.equal(response.status, 201);
  const saved = await response.json();
  const stored = JSON.parse(storage.objects.get(`gallery-meta/${saved.id}.json`).value);
  assert.equal(stored.metadata.provenance.output_sha256, record.provenance.output_sha256);
  assert.equal(stored.metadata.provenance.receipt_sha256, record.provenance.receipt_sha256);
  assert.equal(stored.metadata.provenance.credential_status, 'present_untrusted');
  assert.equal(storage.objects.get(`gallery/${saved.id}`).customMetadata.outputSha256, record.provenance.output_sha256);
  assert.doesNotMatch(JSON.stringify(stored.metadata), /never publish|never-publish-token|prompt_sha256/);
  const download = await worker.fetch(new Request(`https://example.test${saved.url}`), env);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(image.split(',')[1], 'base64'));
  const page = await worker.fetch(new Request(`https://example.test${saved.shareUrl}`), env);
  const html = await page.text();
  assert.match(html, /來源與驗證/);
  assert.match(html, new RegExp(record.provenance.output_sha256));
  assert.doesNotMatch(html, /never publish|never-publish-token|local-fixture-signing-only/);
});

test('gallery rejects altered receipt/output hashes before writing R2; existing auth gate remains first', async () => {
  const { storage, record, save, env } = await setup();
  const tampered = { ...record.provenance, output_sha256: '0'.repeat(64) };
  const response = await save(tampered);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_provenance');
  assert.equal(storage.objects.size, 0);
  const unauthorized = await worker.fetch(new Request('https://example.test/gallery', { method: 'POST', body: '{invalid json' }), env);
  assert.equal(unauthorized.status, 401);
});

test('public gallery metadata strips capability URL queries and credential-like text', async () => {
  const { sanitizeGalleryMeta } = await import('../src/gallery.js');
  const meta = sanitizeGalleryMeta({ promptPublic: true, prompt: 'cat api_key=do-not-copy',
    title: 'https://example.test/file?token=do-not-copy', model: 'model', token: 'do-not-copy' });
  assert.doesNotMatch(JSON.stringify(meta), /do-not-copy/);
});

test('provider results report effective model and settings rather than UI aliases or requested tuning', async () => {
  const { generateOneImage } = await import('../src/image.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ artifacts: [{ base64: image.split(',')[1] }] }));
  try {
    for (const tuning of [{}, { steps: 45, cfgScale: 7.5 }]) {
      const result = await generateOneImage({ NVIDIA_API_KEY: 'fixture-only' }, { prompt: 'cat', model: 'dev', size: 'square', seed: 42, ...tuning });
      assert.match(result.providerProvenance.model_id, /flux\.1-dev$/);
      assert.equal(result.providerProvenance.steps, tuning.steps ?? 30);
      assert.equal(result.providerProvenance.cfg_scale, tuning.cfgScale ?? 5);
    }
    for (const [size, suffix, steps] of [['square', 'flux-1-schnell', 4], ['landscape', 'flux-2-klein-4b', null]]) {
      const result = await generateOneImage({ AI: { run: async () => ({ image: image.split(',')[1] }) } }, { prompt: 'cat', model: 'schnell', size, seed: 42 });
      assert.ok(result.providerProvenance.model_id.endsWith(suffix));
      assert.equal(result.providerProvenance.steps, steps);
      assert.equal(result.providerProvenance.cfg_scale, null);
    }
  } finally { globalThis.fetch = originalFetch; }
});
