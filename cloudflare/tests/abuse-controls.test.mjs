import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRateLimit } from '../src/http.js';
import worker from '../src/index.js';

const routes = ['/generate', '/generate/batch', '/edit', '/prompt/transform', '/prompt/complete', '/prompt/enhance'];

function requestFor(route, extra = {}) {
  const payload = { prompt: 'a red cat', source: 'a red cat', effect: 'cinematic', count: 2, turnstileToken: 'test-token', ...extra };
  if (route === '/edit') {
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) form.set(key, String(value));
    form.append('images', new Blob(['test-image'], { type: 'image/png' }), 'test.png');
    return new Request(`https://worker.test${route}`, { method: 'POST', body: form });
  }
  return new Request(`https://worker.test${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
}

function productionEnv(t, extra = {}) {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('dependency unavailable'); });
  const ai = t.mock.fn(async () => { throw new Error('provider must not run'); });
  return {
    env: {
      ENVIRONMENT: 'production', NVIDIA_API_KEY: 'test-nvidia', GEMINI_API_KEY: 'test-gemini', AI: { run: ai },
      TURNSTILE_REQUIRED: 'true', TURNSTILE_SITE_KEY: 'test-site', TURNSTILE_SECRET_KEY: 'test-secret',
      ...extra,
    },
    fetch, ai,
  };
}

for (const mode of [undefined, '', 'staging', 'prod', 'production']) {
  test(`limiter failure is closed outside explicit development/test mode: ${JSON.stringify(mode)}`, async () => {
    for (const limiter of [undefined, {}, { limit() { throw new Error('unavailable'); } }]) {
      const response = await checkRateLimit(requestFor('/generate'), limiter, { ENVIRONMENT: mode });
      assert.equal(response?.status, 503);
    }
  });
}

for (const mode of ['development', 'test', ' DEVELOPMENT ']) {
  test(`explicit ${mode} mode permits unavailable local limiter`, async () => {
    for (const limiter of [undefined, { limit() { throw new Error('unavailable'); } }]) {
      assert.equal(await checkRateLimit(requestFor('/generate'), limiter, { ENVIRONMENT: mode }), null);
    }
  });
}

for (const outcome of [undefined, null, {}, { success: 'true' }, { success: 1 }]) {
  test(`production rejects malformed limiter result: ${JSON.stringify(outcome)}`, async () => {
    const response = await checkRateLimit(requestFor('/generate'), { limit: async () => outcome }, { ENVIRONMENT: 'production' });
    assert.equal(response?.status, 503);
    assert.equal((await response.json()).code, 'rate_limiter_error');
  });
}

for (const route of routes) {
  for (const [failure, limiter, code, status] of [
    ['missing', undefined, 'rate_limiter_unavailable', 503],
    ['throwing', { limit() { throw new Error('unavailable'); } }, 'rate_limiter_error', 503],
    ['malformed', { limit: async () => ({}) }, 'rate_limiter_error', 503],
    ['exhausted', { limit: async () => ({ success: false }) }, 'rate_limited', 429],
  ]) {
    test(`${route} rejects ${failure} limiter before any provider or Turnstile call`, async (t) => {
      const { env, fetch, ai } = productionEnv(t, { GENERATE_RATE_LIMITER: limiter });
      const log = t.mock.method(console, 'log', () => {});
      // Combined dependency failure must still stop at the first gate.
      delete env.TURNSTILE_SECRET_KEY;
      const response = await worker.fetch(requestFor(route), env);
      assert.equal(response.status, status);
      assert.equal((await response.json()).code, code);
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(ai.mock.callCount(), 0);
      const usage = log.mock.calls.map((call) => JSON.parse(call.arguments[0])).find((entry) => entry.event === 'usage_event').usage;
      assert.equal(usage.statusCode, status);
      assert.equal(usage.errorCode, code);
    });
  }
}

for (const route of routes) {
  for (const missing of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']) {
    test(`${route} rejects missing ${missing} before verification or provider access`, async (t) => {
      const { env, fetch, ai } = productionEnv(t, { GENERATE_RATE_LIMITER: { limit: async () => ({ success: true }) } });
      env[missing] = ' ';
      const response = await worker.fetch(requestFor(route), env);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'turnstile_unconfigured');
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(ai.mock.callCount(), 0);
    });
  }
  test(`${route} rejects unavailable Turnstile before provider access`, async (t) => {
    const { env, fetch, ai } = productionEnv(t, { GENERATE_RATE_LIMITER: { limit: async () => ({ success: true }) } });
    const response = await worker.fetch(requestFor(route), env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'turnstile_unavailable');
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(ai.mock.callCount(), 0);
  });
  test(`${route} rejects a missing Turnstile token before provider access`, async (t) => {
    const { env, fetch, ai } = productionEnv(t, { GENERATE_RATE_LIMITER: { limit: async () => ({ success: true }) } });
    const response = await worker.fetch(requestFor(route, { turnstileToken: '' }), env);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'turnstile_required');
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(ai.mock.callCount(), 0);
  });
}

test('concurrent repeated requests cannot bypass unavailable production dependencies', async (t) => {
  const { env, fetch, ai } = productionEnv(t);
  const responses = await Promise.all(Array.from({ length: 4 }, () => routes).flat().map((route) => worker.fetch(requestFor(route), env)));
  assert.ok(responses.every((response) => response.status === 503));
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(ai.mock.callCount(), 0);
});

for (const route of routes.slice(3)) {
  test(`${route} verifies Turnstile before the authorized Gemini call`, async (t) => {
    const { env, fetch } = productionEnv(t, { GENERATE_RATE_LIMITER: { limit: async () => ({ success: true }) } });
    fetch.mock.mockImplementation(async (url) => new Response(JSON.stringify(
      String(url).includes('/siteverify')
        ? { success: true, action: 'turnstile-spin-v1' }
        : { candidates: [{ content: { parts: [{ text: route === '/prompt/complete'
          ? '一隻橘貓坐在木桌上，陽光透過窗戶照亮柔軟的毛髮，畫面溫馨而細膩'
          : 'A red cat resting on a wooden table in warm sunlight, cinematic lighting, detailed photography.' }] } }] },
    ), { headers: { 'content-type': 'application/json' } }));
    const response = await worker.fetch(requestFor(route), env);
    assert.equal(response.status, 200);
    assert.equal(fetch.mock.callCount(), 2);
    assert.match(String(fetch.mock.calls[0].arguments[0]), /\/siteverify$/);
    assert.match(String(fetch.mock.calls[1].arguments[0]), /generativelanguage/);
  });
}
