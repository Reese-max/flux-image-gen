import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRateLimit, isProductionMode } from '../src/http.js';
import worker from '../src/index.js';
const req = (ip) => new Request('https://unit.invalid/generate', { headers: ip ? { 'cf-connecting-ip': ip } : {} });
// Fail-closed only guards what there is to protect: a provider key must be
// present for the missing/broken limiter to become a 503 in production.
const PROD = { ENVIRONMENT: 'production', NVIDIA_API_KEY: 'test-provider-key' };

test('production environment detection is explicit', () => {
  assert.equal(isProductionMode({ ENVIRONMENT: 'production' }), true);
  assert.equal(isProductionMode({ ENVIRONMENT: 'Production' }), true);
  assert.equal(isProductionMode({}), false);
});
test('production missing limiter fails closed', async () => {
  const r = await checkRateLimit(req('203.0.113.1'), undefined, PROD);
  assert.equal(r.status, 503); assert.equal((await r.json()).code, 'rate_limiter_unavailable');
});
test('production limiter exception fails closed', async () => {
  const r = await checkRateLimit(req('203.0.113.1'), { async limit() { throw new Error('fixture'); } }, PROD);
  assert.equal(r.status, 503); assert.equal((await r.json()).code, 'rate_limiter_error');
});
test('production malformed limiter result fails closed', async () => {
  const r = await checkRateLimit(req('203.0.113.1'), { async limit() { return {}; } }, PROD);
  assert.equal(r.status, 503); assert.equal((await r.json()).code, 'rate_limiter_error');
});
test('production without provider keys passes through (nothing to protect)', async () => {
  assert.equal(await checkRateLimit(req(), undefined, { ENVIRONMENT: 'production' }), null);
});
test('development missing limiter retains explicit non-production behavior', async () => {
  assert.equal(await checkRateLimit(req(), undefined, { ENVIRONMENT: 'development' }), null);
});
test('durable limiter rejection remains 429', async () => {
  const r = await checkRateLimit(req('203.0.113.1'), { limit:async()=>({success:false}) }, PROD);
  assert.equal(r.status,429); const data=await r.json(); assert.equal(data.code,'rate_limited'); assert.equal(data.retry_after,60);
});
test('successful production limiter permits request', async () => {
  assert.equal(await checkRateLimit(req('203.0.113.1'), { limit:async()=>({success:true}) }, PROD), null);
});

const PAID_ROUTES = [
  '/generate',
  '/generate/batch',
  '/edit',
  '/prompt/transform',
  '/prompt/complete',
  '/prompt/enhance',
];

function paidRequest(path, payload = {}) {
  return new Request(`https://unit.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const LIMITER_FAILURES = [
  { name: 'missing', binding: undefined, code: 'rate_limiter_unavailable' },
  { name: 'rejects asynchronously', binding: { async limit() { throw new Error('fixture'); } }, code: 'rate_limiter_error' },
];

for (const path of PAID_ROUTES) {
  for (const failure of LIMITER_FAILURES) {
    test(`${path} blocks before provider access when production limiter ${failure.name}`, async () => {
      let providerCalls = 0;
      const usage = [];
      const env = {
        ...PROD,
        GEMINI_API_KEY: 'test-gemini-key',
        AI: { run() { providerCalls += 1; } },
        GENERATE_RATE_LIMITER: failure.binding,
        IMAGE_BUCKET: {
          put(_key, _body, options) { usage.push(options.customMetadata); },
          list() { return { objects: [] }; },
        },
      };
      const response = await worker.fetch(paidRequest(path), env);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, failure.code);
      assert.equal(providerCalls, 0);
      assert.equal(usage.length, 1);
      assert.equal(usage[0].statusCode, '503');
      assert.equal(usage[0].errorCode, failure.code);
    });
  }
}

test('combined production limiter and Turnstile outages block before verification or provider access', async () => {
  let providerCalls = 0;
  const env = {
    ...PROD,
    TURNSTILE_REQUIRED: 'true',
    TURNSTILE_SITE_KEY: 'test-site-key',
    TURNSTILE_SECRET_KEY: 'test-secret-key',
    GENERATE_RATE_LIMITER: { async limit() { throw new Error('fixture outage'); } },
    AI: { run() { providerCalls += 1; } },
  };
  const response = await worker.fetch(paidRequest('/generate'), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'rate_limiter_error');
  assert.equal(providerCalls, 0);
});

const generatePayload = {
  prompt: 'a red cat on a table',
  model: 'schnell',
  size: 'square',
  turnstileToken: 'test-token',
};

for (const missing of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']) {
  test(`required Turnstile blocks generation when ${missing} is missing`, async () => {
    let providerCalls = 0;
    const env = {
      ...PROD,
      TURNSTILE_REQUIRED: 'true',
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: 'test-secret-key',
      GENERATE_RATE_LIMITER: { async limit() { return { success: true }; } },
      AI: { run() { providerCalls += 1; } },
    };
    delete env[missing];
    const response = await worker.fetch(paidRequest('/generate', generatePayload), env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'turnstile_unconfigured');
    assert.equal(providerCalls, 0);
  });
}

test('Turnstile verification outage blocks generation before provider access', async () => {
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fixture outage'); };
  try {
    const env = {
      ...PROD,
      TURNSTILE_REQUIRED: 'true',
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: 'test-secret-key',
      GENERATE_RATE_LIMITER: { async limit() { return { success: true }; } },
      AI: { run() { providerCalls += 1; } },
    };
    const response = await worker.fetch(paidRequest('/generate', generatePayload), env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'turnstile_unavailable');
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
