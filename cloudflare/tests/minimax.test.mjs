import assert from 'node:assert/strict';
import test from 'node:test';
import { generateOneImage, minimaxDimensions } from '../src/image.js';
import worker from '../src/index.js';

const FAKE_KEY = 'minimax-test-key-DO-NOT-LEAK';
const MINIMAX_URL = 'https://api.minimax.io/v1/image_generation';
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, ...new Array(120).fill(0)]).toString('base64');
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(120).fill(0)]).toString('base64');

const minimaxOk = () => new Response(JSON.stringify({
  id: 'img-test',
  base_resp: { status_code: 0, status_msg: 'success' },
  data: { image_base64: [JPEG_B64] },
  metadata: {},
}));

function stubFetch(responder) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => responder(String(url), init);
  return () => { globalThis.fetch = original; };
}

test('minimaxDimensions maps request sizes into the 512..2048 / %8 contract', () => {
  assert.deepEqual(minimaxDimensions(1024, 1024), [1024, 1024]);
  assert.deepEqual(minimaxDimensions(1344, 768), [1344, 768]);
  assert.deepEqual(minimaxDimensions(256, 384), [512, 768]);
  assert.deepEqual(minimaxDimensions(1920, 256), [2048, 512]);
});

test('minimax success returns base64 jpeg, reports sent dims, passes seed through', async () => {
  const sent = [];
  const restore = stubFetch(async (url, init) => {
    sent.push({ url, init });
    return minimaxOk();
  });
  try {
    const result = await generateOneImage(
      { MINIMAX_API_KEY: FAKE_KEY },
      { prompt: 'a cute corgi', model: 'schnell', size: 'square', seed: 12345 }
    );
    assert.equal(result.provider, 'minimax');
    assert.match(result.image, /^data:image\/jpeg;base64,/);
    assert.deepEqual([result.width, result.height], [1024, 1024]);
    assert.deepEqual(result.providerProvenance, { model_id: 'image-01', steps: null, cfg_scale: null });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, MINIMAX_URL);
    assert.equal(sent[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
    const body = JSON.parse(sent[0].init.body);
    assert.equal(body.model, 'image-01');
    assert.equal(body.response_format, 'base64');
    assert.equal(body.n, 1);
    assert.equal(body.seed, 12345);
  } finally { restore(); }
});

test('minimax maps landscape and small custom sizes to the sent dimensions', async () => {
  const bodies = [];
  const restore = stubFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return minimaxOk(); });
  try {
    let result = await generateOneImage({ MINIMAX_API_KEY: FAKE_KEY }, { prompt: 'x', model: 'dev', size: 'landscape' });
    assert.deepEqual([bodies.at(-1).width, bodies.at(-1).height], [1344, 768]);
    assert.deepEqual([result.width, result.height], [1344, 768]);
    result = await generateOneImage({ MINIMAX_API_KEY: FAKE_KEY }, { prompt: 'x', model: 'dev', size: 'custom', width: 256, height: 384 });
    assert.deepEqual([bodies.at(-1).width, bodies.at(-1).height], [512, 768]);
    assert.deepEqual([result.width, result.height], [512, 768]);
  } finally { restore(); }
});

test('minimax error mapping: rate limit, content filter, auth, infra, bad payload', async () => {
  const cases = [
    [200, { base_resp: { status_code: 1002 } }, 429, 'rate_limited'],
    [429, null, 429, 'rate_limited'],
    [200, { base_resp: { status_code: 1026 } }, 422, 'content_filtered'],
    [200, { base_resp: { status_code: 1027 } }, 422, 'content_filtered'],
    [200, { base_resp: { status_code: 1004 } }, 502, 'provider_auth_failed'],
    [200, { base_resp: { status_code: 2049 } }, 502, 'provider_auth_failed'],
    [200, { base_resp: { status_code: 9999 } }, 502, 'minimax_error'],
    [500, null, 502, 'minimax_error'],
    [503, { base_resp: { status_code: 0 } }, 502, 'minimax_error'],
    [200, 'not-json', 502, 'bad_provider_response'],
    [200, { base_resp: { status_code: 0 }, data: { image_base64: ['aGVsbG8gd29ybGQ='] } }, 502, 'bad_provider_response'],
    [200, { base_resp: { status_code: 0 } }, 502, 'bad_provider_response'],
    [200, { base_resp: { status_code: 0 }, data: {} }, 502, 'bad_provider_response'],
    [200, { base_resp: { status_code: 0 }, image_base64: [JPEG_B64] }, 502, 'bad_provider_response'],
  ];
  for (const [status, jsonBody, expectedStatus, expectedCode] of cases) {
    const restore = stubFetch(async () => (typeof jsonBody === 'string'
      ? new Response(jsonBody, { status })
      : new Response(jsonBody === null ? '' : JSON.stringify(jsonBody), { status })));
    try {
      await assert.rejects(
        generateOneImage({ MINIMAX_API_KEY: FAKE_KEY }, { prompt: 'x', model: 'schnell', size: 'square' }),
        (err) => {
          assert.equal(err.status, expectedStatus, `${status} ${JSON.stringify(jsonBody)}`);
          assert.equal(err.code, expectedCode);
          assert.doesNotMatch(String(err.message), new RegExp(FAKE_KEY));
          return true;
        }
      );
    } finally { restore(); }
  }
});

test('NVIDIA infra failure falls back to MiniMax (NVIDIA 500 -> MiniMax)', async () => {
  const urls = [];
  const restore = stubFetch(async (url) => {
    urls.push(url);
    if (url === MINIMAX_URL) return minimaxOk();
    return new Response(JSON.stringify({ error: 'nvidia down' }), { status: 500 });
  });
  try {
    const result = await generateOneImage(
      { NVIDIA_API_KEY: 'nvapi-fake', MINIMAX_API_KEY: FAKE_KEY },
      { prompt: 'x', model: 'dev', size: 'square' }
    );
    assert.equal(result.provider, 'minimax');
    assert.ok(urls.includes(MINIMAX_URL));
  } finally { restore(); }
});

test('MiniMax infra failure falls back to Workers AI (MiniMax 500 -> Workers AI)', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({ base_resp: { status_code: -1 } }), { status: 500 }));
  try {
    const result = await generateOneImage(
      { MINIMAX_API_KEY: FAKE_KEY, AI: { run: async () => ({ image: PNG_B64 }) } },
      { prompt: 'x', model: 'schnell', size: 'square' }
    );
    assert.equal(result.provider, 'workers-ai');
  } finally { restore(); }
});

test('minimax rate limit and content filter do not fall back', async () => {
  for (const code of [1002, 1026]) {
    let calls = 0;
    const restore = stubFetch(async () => { calls += 1; return new Response(JSON.stringify({ base_resp: { status_code: code } })); });
    try {
      await assert.rejects(
        generateOneImage(
          { MINIMAX_API_KEY: FAKE_KEY, AI: { run: async () => ({ image: PNG_B64 }) } },
          { prompt: 'x', model: 'schnell', size: 'square' }
        )
      );
      assert.equal(calls, 1);
    } finally { restore(); }
  }
});

test('/health lists minimax in providers and providerList when the key is set', async () => {
  const res = await worker.fetch(
    new Request('https://example.test/health'),
    { ENVIRONMENT: 'development', MINIMAX_API_KEY: FAKE_KEY }
  );
  const body = await res.json();
  assert.equal(body.providers.minimax, true);
  assert.ok(body.providerList.includes('minimax'));
  assert.equal(body.provider, 'minimax');
});
