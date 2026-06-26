import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import worker, { transformPlainPrompt } from '../src/index.js';

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

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

async function collectRelativeFiles(rootUrl, prefix = '') {
  const entries = await readdir(new URL(prefix, rootUrl), { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await collectRelativeFiles(rootUrl, `${relativePath}/`));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function sha256(fileUrl) {
  return createHash('sha256').update(await readFile(fileUrl)).digest('hex');
}

test('transformPlainPrompt ports the FastAPI rule-based transformer', () => {
  const result = transformPlainPrompt('一個紅色杯子放在木桌上，旁邊有陽光', 'realistic');

  assert.equal(result.provider, 'rule_based');
  assert.equal(CJK_PATTERN.test(result.prompt), false);
  assert.match(result.prompt, /red/);
  assert.match(result.prompt, /cup/);
  assert.match(result.prompt, /wooden table/);
  assert.match(result.prompt, /sunlight/);
  assert.match(result.prompt, /photorealistic/);
});

test('unknown Chinese prompt falls back to generic English with warning', () => {
  const result = transformPlainPrompt('神秘的咕嚕咕嚕魔法場景');

  assert.equal(CJK_PATTERN.test(result.prompt), false);
  assert.match(result.prompt, /imaginative visual scene/);
  assert.ok(result.warnings.some((warning) => warning.includes('部分詞彙未能精準翻譯')));
});

test('POST /prompt/transform returns the frontend contract', async () => {
  const response = await worker.fetch(
    jsonRequest('/prompt/transform', { source: '一隻可愛柴犬在月球上吃拉麵', style: 'auto' }),
    fakeEnv()
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.provider, 'rule_based');
  assert.match(data.prompt, /Shiba Inu/);
  assert.match(data.prompt, /moon/);
  assert.match(data.prompt, /ramen/);
  assert.equal(Object.hasOwn(data, 'warnings'), true);
});

test('POST /prompt/transform validates blank source', async () => {
  const response = await worker.fetch(jsonRequest('/prompt/transform', { source: '   ' }), fakeEnv());
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.code, 'bad_request');
});

test('POST /prompt/transform uses Gemini when GEMINI_API_KEY is set', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: '{"prompt": "a serene mountain at dawn"}' }] } },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  try {
    const response = await worker.fetch(
      jsonRequest('/prompt/transform', { source: '清晨的山', style: 'auto' }),
      fakeEnv({ GEMINI_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'gemini');
    assert.equal(data.prompt, 'a serene mountain at dawn');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /prompt/transform unwraps a fenced JSON envelope from Gemini', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: '```json\n{\n  "prompt": "a quiet lake at dawn"\n}\n```' }] } },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  try {
    const response = await worker.fetch(
      jsonRequest('/prompt/transform', { source: '清晨的湖', style: 'auto' }),
      fakeEnv({ GEMINI_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(data.provider, 'gemini');
    assert.equal(data.prompt, 'a quiet lake at dawn');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /prompt/transform falls back to rule-based when Gemini fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    const response = await worker.fetch(
      jsonRequest('/prompt/transform', { source: '一隻貓', style: 'auto' }),
      fakeEnv({ GEMINI_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'rule_based');
    assert.match(data.prompt, /cat/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate still validates empty prompt before provider access', async () => {
  const response = await worker.fetch(jsonRequest('/generate', { prompt: '   ' }), fakeEnv());
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.code, 'bad_request');
});

test('POST /generate returns demo image when NVIDIA key is missing', async () => {
  const originalFetch = globalThis.fetch;
  let providerCalled = false;
  globalThis.fetch = async function () {
    providerCalled = true;
    throw new Error('provider should not be called');
  };

  try {
    const health = await worker.fetch(new Request('https://example.test/health'), fakeEnv());
    const healthData = await health.json();
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 12345 }),
      fakeEnv()
    );
    const data = await response.json();

    assert.equal(health.status, 200);
    assert.equal(healthData.provider, 'demo');
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'demo');
    assert.equal(data.model, 'schnell');
    assert.equal(data.width, 1024);
    assert.equal(data.height, 1024);
    assert.equal(data.seed, 12345);
    assert.equal(typeof data.image, 'string');
    assert.equal(data.image.startsWith('data:image/'), true);
    assert.equal(providerCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate forwards explicit seed to NVIDIA and returns it', async () => {
  const originalFetch = globalThis.fetch;
  let providerPayload;

  globalThis.fetch = async function (_url, init) {
    providerPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 12345 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(providerPayload.seed, 12345);
    assert.deepEqual(Object.keys(providerPayload).sort(), ['height', 'prompt', 'seed', 'width']);
    assert.equal(data.seed, 12345);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate defaults missing null and empty seed to 0', async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    { name: 'missing', body: { prompt: 'a cat', model: 'schnell', size: 'square' } },
    { name: 'null', body: { prompt: 'a cat', model: 'schnell', size: 'square', seed: null } },
    { name: 'empty string', body: { prompt: 'a cat', model: 'schnell', size: 'square', seed: '' } },
  ];
  let providerPayload;

  globalThis.fetch = async function (_url, init) {
    providerPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    for (const item of cases) {
      const response = await worker.fetch(jsonRequest('/generate', item.body), fakeEnv({ NVIDIA_API_KEY: 'test-key' }));
      const data = await response.json();
      assert.equal(response.status, 200, item.name);
      assert.equal(providerPayload.seed, 0, item.name);
      assert.equal(data.seed, 0, item.name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate accepts seed boundary values', async () => {
  const originalFetch = globalThis.fetch;
  const seeds = [0, 2147483647];
  let providerPayload;

  globalThis.fetch = async function (_url, init) {
    providerPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    for (const seed of seeds) {
      const response = await worker.fetch(
        jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed }),
        fakeEnv({ NVIDIA_API_KEY: 'test-key' })
      );
      const data = await response.json();
      assert.equal(response.status, 200, `seed ${seed}`);
      assert.equal(providerPayload.seed, seed, `seed ${seed}`);
      assert.equal(data.seed, seed, `seed ${seed}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate rejects invalid seed before provider access', async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;

  globalThis.fetch = async function () {
    providerCalls += 1;
    throw new Error('provider should not be called for invalid seed');
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: -1 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.code, 'bad_request');
    assert.match(data.error, /seed 必須是 0 到 2147483647 之間的整數/);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate rejects non-integer seed values', async () => {
  const originalFetch = globalThis.fetch;
  const invalidSeeds = ['123', 1.5, true, 2147483648];
  let providerCalls = 0;

  globalThis.fetch = async function () {
    providerCalls += 1;
    throw new Error('provider should not be called for invalid seed');
  };

  try {
    for (const seed of invalidSeeds) {
      const response = await worker.fetch(
        jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed }),
        fakeEnv({ NVIDIA_API_KEY: 'test-key' })
      );
      const data = await response.json();
      assert.equal(response.status, 400, `seed ${String(seed)}`);
      assert.equal(data.code, 'bad_request', `seed ${String(seed)}`);
      assert.match(data.error, /seed 必須是 0 到 2147483647 之間的整數/, `seed ${String(seed)}`);
    }
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare static shell includes synced feature scripts and modals', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const expectedScripts = [
    '/static/generation-settings.js',
    '/static/prompt-enhancer.js',
    '/static/failure-advice.js',
    '/static/app.js',
    '/static/prompt-transform.js',
    '/static/idea-store.js',
    '/static/idea-cards.js',
    '/static/history-store.js',
    '/static/history-wall.js',
    '/static/tutorial.js',
  ];
  const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((match) => match[1]);

  assert.match(html, /id="plainPrompt"/);
  assert.match(html, /id="seed"/);
  assert.match(html, /id="avoid"/);
  assert.match(html, /id="customIdeaGrid"/);
  assert.match(html, /id="historyGrid"/);
  assert.match(html, /id="resultActions"/);
  assert.match(html, /id="copySettings"/);
  assert.match(html, /id="regenerate"/);
  assert.match(html, /id="tutorialModal"/);
  assert.match(html, /<link rel="stylesheet" href="\/static\/styles\.css">/);
  assert.deepEqual(new Set(scriptSrcs), new Set(expectedScripts));
  assert.ok(scriptSrcs.indexOf('/static/generation-settings.js') < scriptSrcs.indexOf('/static/app.js'));
});

test('Cloudflare static shell includes v1.4 workspace and PWA assets', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const manifest = await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
  const serviceWorker = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');

  assert.match(html, /id="historyDetailModal"/);
  assert.match(html, /id="promptEnhancer"/);
  assert.match(html, /id="historySearch"/);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /src="\/static\/prompt-enhancer\.js"/);
  assert.match(html, /src="\/static\/failure-advice\.js"/);
  assert.match(manifest, /AI 圖片產生器/);
  assert.match(serviceWorker, /CACHE_NAME/);
});

test('Cloudflare static assets stay byte-for-byte synced with FastAPI static assets', async () => {
  const appStaticRoot = new URL('../../app/static/', import.meta.url);
  const cloudflareStaticRoot = new URL('../public/static/', import.meta.url);
  const rootAssets = ['index.html', 'manifest.webmanifest', 'service-worker.js'];
  const appStaticFiles = (await collectRelativeFiles(appStaticRoot)).filter((file) => !rootAssets.includes(file));
  const cloudflareStaticFiles = await collectRelativeFiles(cloudflareStaticRoot);

  assert.deepEqual(cloudflareStaticFiles, appStaticFiles);

  for (const relativePath of cloudflareStaticFiles) {
    assert.equal(
      await sha256(new URL(relativePath, cloudflareStaticRoot)),
      await sha256(new URL(relativePath, appStaticRoot)),
      `${relativePath} should match app/static`
    );
  }

  for (const asset of rootAssets) {
    assert.equal(
      await sha256(new URL(`../public/${asset}`, import.meta.url)),
      await sha256(new URL(`../../app/static/${asset}`, import.meta.url)),
      `${asset} should match app/static`
    );
  }
});

test('Cloudflare deploy wrapper is wired and normalizes known Wrangler success output', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const deployScript = await readFile(new URL('../scripts/deploy.mjs', import.meta.url), 'utf8');

  assert.equal(packageJson.scripts.deploy, 'node scripts/deploy.mjs');
  assert.equal(packageJson.scripts['deploy:dry-run'], 'node scripts/deploy.mjs --dry-run');
  assert.equal(packageJson.scripts['qa:browser:install'], 'playwright install chromium');
  assert.equal(packageJson.scripts['qa:browser'], 'node ../tests/e2e/cloudflare-v14-qa.mjs');
  assert.equal(packageJson.devDependencies.playwright, '^1.61.1');
  assert.match(deployScript, /hasSuccessfulDeployOutput/);
  assert.match(deployScript, /Current Version ID/);
  assert.match(deployScript, /Deployed\\s\+flux-image-gen\\s\+triggers/);
  assert.match(deployScript, /Normalizing exit code to 0/);
});


test('POST /client-error accepts sanitized frontend error reports and emits request id', async () => {
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    const response = await worker.fetch(
      jsonRequest('/client-error', {
        message: 'boom'.repeat(1000),
        stack: 'Error: boom\n    at https://example.test/static/app.js:1:1',
        url: 'https://example.test/?prompt=secret',
        userAgent: 'qa-browser',
        extra: 'ignore-me',
      }),
      fakeEnv()
    );

    assert.equal(response.status, 204);
    assert.match(response.headers.get('x-request-id'), /^req_/);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /client_error/);
    assert.match(logs[0], /qa-browser/);
    assert.doesNotMatch(logs[0], /ignore-me/);
    assert.ok(logs[0].length < 2500);
  } finally {
    console.warn = originalWarn;
  }
});

test('Cloudflare package exposes repeatable performance QA scripts', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const perfScript = await readFile(new URL('../../tests/e2e/cloudflare-perf-qa.mjs', import.meta.url), 'utf8');

  assert.equal(packageJson.scripts['qa:perf'], 'node ../tests/e2e/cloudflare-perf-qa.mjs');
  assert.match(perfScript, /largest-contentful-paint/);
  assert.match(perfScript, /layout-shift/);
  assert.match(perfScript, /transferSize/);
  assert.match(perfScript, /response\.body\(\)/);
});

test('POST /generate retries a transient 5xx then succeeds', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async function () {
    calls += 1;
    if (calls === 1) {
      return new Response('upstream unavailable', { status: 503 });
    }
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(data.provider, 'nvidia');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate surfaces the error after exhausting retries on 5xx', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async function () {
    calls += 1;
    return new Response(JSON.stringify({ error: 'overloaded' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 503);
    assert.equal(calls, 2);
    assert.equal(data.code, 'nvidia_error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate returns 429 when the rate limiter rejects the request', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async function () {
    fetchCalls += 1;
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
      fakeEnv({
        NVIDIA_API_KEY: 'test-key',
        GENERATE_RATE_LIMITER: { limit: async () => ({ success: false }) },
      })
    );
    const data = await response.json();
    assert.equal(response.status, 429);
    assert.equal(data.code, 'rate_limited');
    assert.equal(fetchCalls, 0, 'must not call the provider when rate limited');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate proceeds when the rate limiter allows the request', async () => {
  const originalFetch = globalThis.fetch;
  let limiterKey;
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
      fakeEnv({
        NVIDIA_API_KEY: 'test-key',
        GENERATE_RATE_LIMITER: {
          limit: async ({ key }) => {
            limiterKey = key;
            return { success: true };
          },
        },
      })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'nvidia');
    assert.equal(limiterKey, 'anonymous');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate/batch returns an images array of the requested count', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async function () {
    fetchCalls += 1;
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 3 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.images.length, 3);
    assert.equal(fetchCalls, 3);
    for (const item of data.images) {
      assert.equal(item.provider, 'nvidia');
      assert.equal(typeof item.seed, 'number');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate/batch returns demo images when no NVIDIA key is set', async () => {
  const response = await worker.fetch(
    jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 2 }),
    fakeEnv()
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.images.length, 2);
  assert.equal(data.images[0].provider, 'demo');
});

test('POST /generate/batch rejects an out-of-range count', async () => {
  const response = await worker.fetch(
    jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 9 }),
    fakeEnv({ NVIDIA_API_KEY: 'test-key' })
  );
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.equal(data.code, 'bad_request');
  assert.match(data.error, /count/);
});

test('POST /generate maps a CONTENT_FILTERED placeholder to a 422 error', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ artifacts: [{ finishReason: 'CONTENT_FILTERED' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'something blocked', model: 'schnell', size: 'square' }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 422);
    assert.equal(data.code, 'content_filtered');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
