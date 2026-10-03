import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import worker from '../src/index.js';

// Every case stays offline, including regressions in health/static handling.
const originalNetworkFetch = globalThis.fetch;
let unexpectedNetworkCalls = 0;
beforeEach(() => {
  unexpectedNetworkCalls = 0;
  globalThis.fetch = async () => {
    unexpectedNetworkCalls++;
    throw new Error('unexpected network call in offline preview test');
  };
});
afterEach(() => {
  globalThis.fetch = originalNetworkFetch;
  assert.equal(unexpectedNetworkCalls, 0);
});

function previewEnv(extra = {}) {
  const calls = { network: 0, ai: 0, limiter: 0, read: 0, write: 0, assets: 0 };
  const env = {
    PREVIEW_READ_ONLY: 'true',
    ENVIRONMENT: 'production',
    TURNSTILE_REQUIRED: 'true',
    TURNSTILE_SECRET_KEY: 'offline-test-challenge-secret',
    NVIDIA_API_KEY: 'offline-test-provider-key',
    GEMINI_API_KEY: 'offline-test-provider-key',
    VISION_QA_ENABLED: 'true',
    POLLINATIONS_FALLBACK_ENABLED: 'true',
    GALLERY_TOKEN_SECRET: 'offline-test-gallery-secret',
    GALLERY_ADMIN_TOKEN: 'offline-test-admin-token',
    AI: { async run() { calls.ai++; return { image: 'not-an-image' }; } },
    GENERATE_RATE_LIMITER: { async limit() { calls.limiter++; return { success: true }; } },
    IMAGE_BUCKET: {
      async put() { calls.write++; },
      async delete() { calls.write++; },
      async get() { calls.read++; return null; },
      async list() { calls.read++; return { objects: [] }; },
    },
    ASSETS: { async fetch(request) {
      calls.assets++;
      return new Response(request.method === 'HEAD' ? null : 'offline static asset', {
        headers: { 'content-type': 'text/html', etag: 'test-asset' },
      });
    } },
    ...extra,
  };
  return { env, calls };
}

async function withOfflineNetwork(run) {
  const originalFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async () => {
    network++;
    return new Response(JSON.stringify({
      success: false,
      candidates: [{ content: { parts: [{ text: 'a detailed photograph of a red cup' }] } }],
    }), { headers: { 'content-type': 'application/json' } });
  };
  try { await run(() => network); } finally { globalThis.fetch = originalFetch; }
}

function assertUntouched(calls, network) {
  assert.deepEqual({ ...calls, network }, {
    network: 0, ai: 0, limiter: 0, read: 0, write: 0, assets: 0,
  });
}

const blockedRequests = [
  ['POST', '/prompt/transform'], ['POST', '/prompt/complete'], ['POST', '/prompt/enhance'],
  ['POST', '/generate'], ['POST', '/generate/batch'], ['POST', '/edit'],
  ['POST', '/gallery'], ['DELETE', '/gallery/image-id'],
  ['GET', '/gallery/image-id/delete?deleteToken=offline-token'],
  ['GET', '/gallery/image-id'], ['GET', '/share/image-id'],
  ['GET', '/api/gallery'], ['GET', '/api/usage'],
  ['POST', '/client-error'], ['POST', '/api/health'], ['POST', '/'],
  ['PUT', '/static/app.js'], ['PATCH', '/'], ['DELETE', '/'],
  ['GET', '/future-provider-route'], ['HEAD', '/api/gallery'],
];

for (const [method, path] of blockedRequests) {
  test(`read-only preview blocks ${method} ${path} before every external binding`, async () => {
    await withOfflineNetwork(async (network) => {
      const { env, calls } = previewEnv();
      const response = await worker.fetch(new Request(`https://preview.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'X-Gallery-Admin-Token': 'offline-test-admin-token' },
        ...(!['GET', 'HEAD'].includes(method) ? { body: JSON.stringify({
          prompt: 'a red cup', source: 'a red cup', effect: 'cinematic',
          turnstileToken: 'invalid-challenge', visionQa: true,
        }) } : {}),
      }), env);
      assertUntouched(calls, network());
      assert.equal(response.status, 403);
      if (method === 'HEAD') assert.equal(await response.text(), '');
      else assert.equal((await response.json()).code, 'preview_read_only');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });
  });
}

test('read-only preview rejects bad captcha and absent, denied or broken limiters without usage writes', async () => {
  for (const limiter of [undefined, { async limit() { throw new Error('must not run'); } },
    { async limit() { return { success: false }; } }]) {
    await withOfflineNetwork(async (network) => {
      const { env, calls } = previewEnv({ GENERATE_RATE_LIMITER: limiter });
      const response = await worker.fetch(new Request('https://preview.test/generate', {
        method: 'POST', body: '{"prompt":"a cup","turnstileToken":"bad","visionQa":true}',
      }), env);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'preview_read_only');
      assertUntouched(calls, network());
    });
  }
});

test('read-only preview serves safe health GET and HEAD without advertising generation readiness', async () => {
  for (const path of ['/health', '/api/health']) {
    const { env, calls } = previewEnv({ PREVIEW_READ_ONLY: ' TRUE ' });
    const response = await worker.fetch(new Request(`https://preview.test${path}`), env);
    const health = await response.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.previewReadOnly, true);
    assert.equal(health.mode, 'demo');
    assert.equal(health.providerStatus, 'offline');
    assert.equal(health.storageAvailable, false);
    assert.equal(health.visionQa, false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const head = await worker.fetch(new Request(`https://preview.test${path}`, { method: 'HEAD' }), env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assertUntouched(calls, 0);
  }
});

test('read-only preview passes only explicit static GET and HEAD requests to ASSETS', async () => {
  for (const path of ['/', '/index.html', '/manifest.webmanifest', '/service-worker.js', '/static/app.js']) {
    for (const method of ['GET', 'HEAD']) {
      const { env, calls } = previewEnv();
      const response = await worker.fetch(new Request(`https://preview.test${path}`, { method }), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('etag'), 'test-asset');
      assert.equal(await response.text(), method === 'HEAD' ? '' : 'offline static asset');
      assert.deepEqual(calls, { network: 0, ai: 0, limiter: 0, read: 0, write: 0, assets: 1 });
    }
  }
});

test('read-only CORS preflights allow safe reads and reject provider or mutation requests', async () => {
  for (const [path, requestedMethod, status] of [
    ['/api/health', 'GET', 204], ['/static/app.js', 'HEAD', 204],
    ['/generate', 'POST', 403], ['/', 'POST', 403], ['/api/gallery', 'GET', 403],
  ]) {
    const { env, calls } = previewEnv();
    const response = await worker.fetch(new Request(`https://preview.test${path}`, {
      method: 'OPTIONS', headers: { origin: 'https://inspector.test', 'access-control-request-method': requestedMethod },
    }), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    if (status === 204) {
      assert.equal(response.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
      assert.equal(await response.text(), '');
    }
    assertUntouched(calls, 0);
  }
});

test('absent or false preview flag keeps existing development and production behavior', async () => {
  for (const environment of ['development', 'production']) {
    for (const flag of [undefined, 'false']) {
      const { env, calls } = previewEnv({ PREVIEW_READ_ONLY: flag, GEMINI_API_KEY: '',
        ENVIRONMENT: environment, NVIDIA_API_KEY: '', AI: undefined,
        TURNSTILE_REQUIRED: 'false', IMAGE_BUCKET: undefined });
      const response = await worker.fetch(new Request('https://preview.test/prompt/transform', {
        method: 'POST', body: '{"source":"a red cup"}',
      }), env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).provider, 'rule_based');
      const health = await (await worker.fetch(new Request('https://preview.test/health'), env)).json();
      assert.equal(health.previewReadOnly, undefined);
      assert.equal(calls.assets, 0);
    }
  }
});
