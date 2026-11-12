import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import worker from '../src/index.js';
import { galleryEnabled, issueGalleryToken } from '../src/gallery.js';
import { galleryDisabledInToml, requiredProductionSecrets, validateReadinessInputs } from '../scripts/check-deploy-readiness.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const env = (extra = {}) => ({
  ENVIRONMENT: 'development', TURNSTILE_REQUIRED: 'false', GALLERY_TOKEN_SECRET: 'test-secret',
  GENERATE_RATE_LIMITER: { limit: async () => ({ success: true }) }, ASSETS: { fetch: () => new Response('') }, ...extra,
});
const post = (path, body) => new Request(`https://x.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('galleryEnabled defaults to on and only "false" turns it off', () => {
  assert.equal(galleryEnabled({}), true);
  assert.equal(galleryEnabled({ GALLERY_ENABLED: 'true' }), true);
  assert.equal(galleryEnabled({ GALLERY_ENABLED: ' FALSE ' }), false);
});

test('with the gallery off, /generate issues no save token and POST /gallery is a 404', async () => {
  assert.equal(await issueGalleryToken(env({ GALLERY_ENABLED: 'false' }), PNG), undefined);
  assert.equal(typeof (await issueGalleryToken(env(), PNG)), 'string');
  const gen = await (await worker.fetch(post('/generate', { prompt: 'a red apple', model: 'dev', size: 'square', seed: 1 }), env({ GALLERY_ENABLED: 'false' }))).json();
  assert.equal(gen.galleryToken, undefined);
  const res = await worker.fetch(post('/gallery', { image: PNG, meta: {} }), env({ GALLERY_ENABLED: 'false' }));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'gallery_disabled');
  const health = await (await worker.fetch(new Request('https://x.test/health'), env({ GALLERY_ENABLED: 'false' }))).json();
  assert.equal(health.galleryEnabled, false);
});

const LIMITER = '\n[[ratelimits]]\nname = "GENERATE_RATE_LIMITER"\nnamespace_id = "1001"\nsimple = { limit = 10, period = 60 }\n';
const TOML = (gallery) => `[vars]\nENVIRONMENT = "production"\nTURNSTILE_REQUIRED = "true"\nTURNSTILE_SITE_KEY = "0x_site"\n${gallery}${LIMITER}`;
const secrets = (names) => JSON.stringify(names.map((name) => ({ name, type: 'secret_text' })));

test('readiness drops only the gallery secrets when GALLERY_ENABLED is "false"', () => {
  assert.equal(galleryDisabledInToml(TOML('GALLERY_ENABLED = "false"\n')), true);
  assert.equal(galleryDisabledInToml(TOML('')), false);
  assert.deepEqual(requiredProductionSecrets(TOML('GALLERY_ENABLED = "false"\n')), ['TURNSTILE_SECRET_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY']);
  assert.doesNotThrow(() => validateReadinessInputs({ gitStatus: '', secretListOutput: secrets(['TURNSTILE_SECRET_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY']), wranglerTomlContent: TOML('GALLERY_ENABLED = "false"\n') }));
  // Turnstile is still required with the gallery off.
  assert.throws(() => validateReadinessInputs({ gitStatus: '', secretListOutput: secrets(['NVIDIA_API_KEY', 'GEMINI_API_KEY']), wranglerTomlContent: TOML('GALLERY_ENABLED = "false"\n') }), /Missing required production secrets: TURNSTILE_SECRET_KEY$/);
  // With the gallery on (default), both gallery secrets are still required.
  assert.throws(() => validateReadinessInputs({ gitStatus: '', secretListOutput: secrets(['TURNSTILE_SECRET_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY']), wranglerTomlContent: TOML('') }), /GALLERY_TOKEN_SECRET, GALLERY_ADMIN_TOKEN/);
});

test('the tracked wrangler.toml keeps the gallery off', async () => {
  const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.equal(galleryDisabledInToml(toml), true);
});
