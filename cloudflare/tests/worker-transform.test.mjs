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

test('auto style detection picks the expected style from expanded keywords', () => {
  const cases = [
    { source: '卡哇伊的吉祥物娃娃', style: 'cute', modifier: /adorable/ },
    { source: '霓虹招牌的巷子逆光', style: 'cinematic', modifier: /cinematic lighting/ },
    { source: '日系插畫的少女', style: 'anime', modifier: /anime style/ },
    { source: '白底商品主圖去背', style: 'product', modifier: /studio product photography/ },
    { source: '超寫實真人肖像', style: 'realistic', modifier: /photorealistic/ },
  ];

  for (const item of cases) {
    const result = transformPlainPrompt(item.source);
    assert.equal(result.style, item.style, item.source);
    assert.match(result.prompt, item.modifier, item.source);
  }
});

test('auto style detection follows priority order and defaults to auto', () => {
  // cute is evaluated before cinematic, so a mixed description keeps cute.
  assert.equal(transformPlainPrompt('電影感的可愛柴犬').style, 'cute');
  assert.equal(transformPlainPrompt('一個紅色杯子放在木桌上').style, 'auto');
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

test('POST /prompt/complete uses Gemma Chinese completion model', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = '';
  let providerPayload;
  globalThis.fetch = async (url, init) => {
    calledUrl = String(url);
    providerPayload = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"prompt": "一位年輕女生站在夜晚雨中的街道，濕潤柏油路反射霓虹燈光，畫面具有電影感。"}',
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    const response = await worker.fetch(
      jsonRequest('/prompt/complete', { source: '女生雨中', style: 'cinematic' }),
      fakeEnv({ GEMINI_API_KEY: 'test-key' })
    );
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.provider, 'gemini');
    assert.equal(data.source, '女生雨中');
    assert.match(data.prompt, /霓虹燈/);
    assert.match(calledUrl, /gemma-4-26b-a4b-it:generateContent/);
    assert.match(providerPayload.system_instruction.parts[0].text, /繁體中文/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /prompt/complete validates blank source', async () => {
  const response = await worker.fetch(jsonRequest('/prompt/complete', { source: '   ' }), fakeEnv());
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.code, 'bad_request');
});

test('POST /prompt/complete unwraps nested JSON prompt strings from Gemma', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"prompt": "{\\"prompt\\": \\"一位女生站在雨中的霓虹街道。\\"}"}',
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  try {
    const response = await worker.fetch(
      jsonRequest('/prompt/complete', { source: '女生雨中', style: 'cinematic' }),
      fakeEnv({ GEMINI_API_KEY: 'test-key' })
    );
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.prompt, '一位女生站在雨中的霓虹街道。');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /prompt/complete requires Gemini key', async () => {
  const response = await worker.fetch(jsonRequest('/prompt/complete', { source: '一隻貓' }), fakeEnv());
  const data = await response.json();

  assert.equal(response.status, 503);
  assert.equal(data.code, 'missing_api_key');
});

test('POST /prompt/enhance requires Gemini key', async () => {
  const response = await worker.fetch(
    jsonRequest('/prompt/enhance', { prompt: 'a cat on a windowsill', effect: '更夢幻' }),
    fakeEnv()
  );
  const data = await response.json();

  assert.equal(response.status, 503);
  assert.equal(data.code, 'missing_api_key');
});

test('POST /prompt/enhance validates blank prompt and blank effect', async () => {
  const blankPrompt = await worker.fetch(
    jsonRequest('/prompt/enhance', { prompt: '   ', effect: '更夢幻' }),
    fakeEnv({ GEMINI_API_KEY: 'test-key' })
  );
  assert.equal(blankPrompt.status, 400);
  assert.equal((await blankPrompt.json()).code, 'bad_request');

  const blankEffect = await worker.fetch(
    jsonRequest('/prompt/enhance', { prompt: 'a cat', effect: '   ' }),
    fakeEnv({ GEMINI_API_KEY: 'test-key' })
  );
  assert.equal(blankEffect.status, 400);
  assert.equal((await blankEffect.json()).code, 'bad_request');
});

test('POST /prompt/enhance rewrites the prompt via Gemini and echoes the effect', async () => {
  const originalFetch = globalThis.fetch;
  let userText = '';
  globalThis.fetch = async (_url, init) => {
    userText = JSON.parse(init.body).contents[0].parts[0].text;
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"prompt": "a dreamy misty cat on a windowsill"}' }] } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    const response = await worker.fetch(
      jsonRequest('/prompt/enhance', { prompt: 'a cat on a windowsill', effect: '更夢幻' }),
      fakeEnv({ GEMINI_API_KEY: 'test-key' })
    );
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.provider, 'gemini');
    assert.equal(data.prompt, 'a dreamy misty cat on a windowsill');
    assert.equal(data.effect, '更夢幻');
    assert.match(userText, /Requested effect/);
    assert.match(userText, /a cat on a windowsill/);
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
    assert.deepEqual(healthData.providers, []);
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

test('GET /health reports workers-ai when only the AI binding is present', async () => {
  const response = await worker.fetch(
    new Request('https://example.test/health'),
    fakeEnv({ AI: { run() {} } })
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.provider, 'workers-ai');
  assert.deepEqual(data.providers, ['workers-ai']);
});

test('GET /health lists both providers when NVIDIA key and AI binding are present', async () => {
  const response = await worker.fetch(
    new Request('https://example.test/health'),
    fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: { run() {} } })
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.provider, 'nvidia');
  assert.deepEqual(data.providers, ['nvidia', 'workers-ai']);
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
    '/static/prompt-pack.js',
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
      return { body: entry.value, httpMetadata: entry.options?.httpMetadata };
    },
  };
}

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test('POST /gallery returns 503 when no R2 bucket is bound', async () => {
  const response = await worker.fetch(
    jsonRequest('/gallery', { image: TINY_PNG_DATA_URL }),
    fakeEnv()
  );
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.code, 'gallery_disabled');
});

test('POST /gallery stores the image and GET /gallery/:id round-trips it', async () => {
  const bucket = fakeBucket();

  const saveResponse = await worker.fetch(
    jsonRequest('/gallery', { image: TINY_PNG_DATA_URL, meta: { prompt: 'a cat', seed: 7 } }),
    fakeEnv({ IMAGE_BUCKET: bucket })
  );
  const saved = await saveResponse.json();
  assert.equal(saveResponse.status, 201);
  assert.match(saved.id, /\.png$/);
  assert.equal(saved.url, `/gallery/${saved.id}`);
  assert.equal(bucket.store.size, 1);

  const getResponse = await worker.fetch(
    new Request(`https://example.test/gallery/${saved.id}`, { method: 'GET' }),
    fakeEnv({ IMAGE_BUCKET: bucket })
  );
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await getResponse.arrayBuffer());
  assert.ok(bytes.length > 0);
});

test('POST /gallery requires a valid token when GALLERY_TOKEN_SECRET is set', async () => {
  const bucket = fakeBucket();
  const env = fakeEnv({ IMAGE_BUCKET: bucket, GALLERY_TOKEN_SECRET: 'test-secret' });

  const noToken = await worker.fetch(jsonRequest('/gallery', { image: TINY_PNG_DATA_URL }), env);
  assert.equal(noToken.status, 401);
  assert.equal((await noToken.json()).code, 'unauthorized');

  const badToken = await worker.fetch(
    new Request('https://example.test/gallery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gallery-Token': `${Date.now()}.deadbeef` },
      body: JSON.stringify({ image: TINY_PNG_DATA_URL }),
    }),
    env
  );
  assert.equal(badToken.status, 401);

  // A token minted by /generate (demo path, no NVIDIA key needed) is accepted.
  const gen = await worker.fetch(jsonRequest('/generate', { prompt: 'a cat' }), env);
  const genData = await gen.json();
  assert.equal(typeof genData.galleryToken, 'string');

  const withToken = await worker.fetch(
    new Request('https://example.test/gallery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gallery-Token': genData.galleryToken },
      body: JSON.stringify({ image: TINY_PNG_DATA_URL }),
    }),
    env
  );
  assert.equal(withToken.status, 201);
  assert.equal(bucket.store.size, 1);
});

test('POST /gallery accepts a realistic-size image larger than the generic 64KB JSON cap', async () => {
  const bucket = fakeBucket();
  // ~150KB of valid base64 (no interior padding) — matches a real 1024×1024
  // generation, which the old shared 64KB readJsonPayload cap rejected.
  const bigImage = 'data:image/png;base64,' + 'QUJD'.repeat(38400);

  const response = await worker.fetch(
    jsonRequest('/gallery', { image: bigImage, meta: { prompt: 'big qa image' } }),
    fakeEnv({ IMAGE_BUCKET: bucket })
  );
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.match(data.id, /\.png$/);
  assert.equal(bucket.store.size, 1);
});

test('GET /gallery/:id returns 404 for an unknown id', async () => {
  const response = await worker.fetch(
    new Request('https://example.test/gallery/does-not-exist.png', { method: 'GET' }),
    fakeEnv({ IMAGE_BUCKET: fakeBucket() })
  );
  const data = await response.json();
  assert.equal(response.status, 404);
  assert.equal(data.code, 'not_found');
});

test('POST /gallery rejects a non-data-URL image', async () => {
  const response = await worker.fetch(
    jsonRequest('/gallery', { image: 'https://example.test/not-allowed.png' }),
    fakeEnv({ IMAGE_BUCKET: fakeBucket() })
  );
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.equal(data.code, 'bad_request');
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

function fakeAi(result) {
  const calls = [];
  // Pass an array to script one outcome per call (e.g. fail once, then succeed).
  const queue = Array.isArray(result) ? [...result] : null;
  return {
    calls,
    async run(model, args) {
      // Reconstruct the multipart form the worker sent so tests can assert on fields.
      const req = new Request('https://fake.test', {
        method: 'POST',
        headers: { 'content-type': args.multipart.contentType },
        body: args.multipart.body,
        // Node's fetch Request requires duplex for stream bodies (workerd does not).
        duplex: 'half',
      });
      const form = await req.formData();
      calls.push({ model, fields: Object.fromEntries(form.entries()) });
      const outcome = queue ? queue.shift() : result;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

test('POST /generate model=schnell uses Workers AI with size and a real seed', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'landscape', seed: 0 }),
    fakeEnv({ AI: ai, NVIDIA_API_KEY: 'test-key' })
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.provider, 'workers-ai');
  assert.equal(data.width, 1344);
  assert.equal(data.height, 768);
  assert.ok(data.seed >= 1, 'seed 0 must be replaced with a real random seed');
  assert.match(data.image, /^data:image\/png;base64,/);
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, '@cf/black-forest-labs/flux-2-klein-4b');
  assert.equal(ai.calls[0].fields.prompt, 'a cat');
  assert.equal(ai.calls[0].fields.width, '1344');
  assert.equal(ai.calls[0].fields.height, '768');
  assert.equal(String(data.seed), ai.calls[0].fields.seed);
});

test('POST /generate model=schnell keeps an explicit seed on Workers AI', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 12345 }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(data.seed, 12345);
  assert.equal(ai.calls[0].fields.seed, '12345');
});

test('POST /generate model=schnell maps a Workers AI failure to a clean 502', async () => {
  const ai = fakeAi(new Error('model overloaded: internal binding rpc detail'));
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(response.status, 502);
  assert.equal(data.code, 'workers_ai_error');
  // The raw provider error must stay server-side, not leak to the client.
  assert.ok(!data.error.includes('internal binding rpc detail'), 'raw error must not leak');
  assert.equal(ai.calls.length, 2, 'a transient failure should be retried once');
});

test('POST /generate model=schnell retries once and succeeds on Workers AI', async () => {
  const ai = fakeAi([new Error('model overloaded'), { image: 'iVBORw0KGgo=' }]);
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 42 }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.provider, 'workers-ai');
  assert.equal(data.seed, 42);
  assert.equal(ai.calls.length, 2);
  // Streams cannot be replayed: the retry must rebuild the multipart form.
  assert.equal(ai.calls[1].fields.prompt, 'a cat');
  assert.equal(ai.calls[1].fields.seed, '42');
});

test('POST /generate model=schnell extracts alternate Workers AI response shapes', async () => {
  const longB64 = 'iVBORw0KGgoAAAANSUhEUg'.repeat(6);
  const ai = fakeAi({ images: [longB64] });
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 7 }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.provider, 'workers-ai');
  assert.match(data.image, /^data:image\/png;base64,/);
});

test('POST /generate model=schnell maps a Workers AI safety rejection to 422 without retry', async () => {
  const ai = fakeAi(new Error('InferenceUpstreamError: NSFW content detected in prompt'));
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(response.status, 422);
  assert.equal(data.code, 'content_filtered');
  assert.equal(ai.calls.length, 1, 'a deterministic safety rejection must not be retried');
});

test('POST /generate model=schnell maps a CONTENT_FILTERED artifact from Workers AI to 422', async () => {
  const ai = fakeAi({ artifacts: [{ finishReason: 'CONTENT_FILTERED', base64: 'iVBORw0KGgo=' }] });
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(response.status, 422);
  assert.equal(data.code, 'content_filtered');
});

test('POST /generate model=schnell maps a Workers AI timeout to a clean 504', async () => {
  const ai = fakeAi(Object.assign(new Error('hang'), { name: 'TimeoutError' }));
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(response.status, 504);
  assert.equal(data.code, 'timeout');
});

test('POST /generate/batch model=schnell runs every image on Workers AI', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 3 }),
    fakeEnv({ AI: ai, NVIDIA_API_KEY: 'test-key' })
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.images.length, 3);
  assert.equal(ai.calls.length, 3);
  for (const item of data.images) {
    assert.equal(item.provider, 'workers-ai');
    assert.ok(item.seed >= 1, 'batch variation seeds must be real random seeds');
  }
  // Each call must carry the seed it reported back (reproducibility contract).
  const sentSeeds = ai.calls.map((c) => c.fields.seed).sort();
  const returnedSeeds = data.images.map((i) => String(i.seed)).sort();
  assert.deepEqual(sentSeeds, returnedSeeds);
});

test('POST /generate/batch model=schnell keeps the explicit seed on the first image', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 2, seed: 777 }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.images[0].seed, 777);
  assert.ok(data.images[1].seed >= 1);
});

test('POST /generate model=dev still uses NVIDIA even when Workers AI is bound', async () => {
  const originalFetch = globalThis.fetch;
  let nvidiaCalled = false;
  globalThis.fetch = async function () {
    nvidiaCalled = true;
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const ai = fakeAi({ image: 'should-not-be-used' });

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'dev', size: 'square', seed: 1 }),
      fakeEnv({ AI: ai, NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'nvidia');
    assert.equal(nvidiaCalled, true);
    assert.equal(ai.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate maps an upstream fetch timeout to a clean 504 timeout error', async () => {
  const originalFetch = globalThis.fetch;
  let sawSignal = false;
  globalThis.fetch = async (_url, init) => {
    sawSignal = Boolean(init && init.signal);
    throw new DOMException('The operation timed out.', 'TimeoutError');
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 504);
    assert.equal(data.code, 'timeout');
    assert.match(data.error, /逾時/);
    assert.equal(sawSignal, true, 'fetch must be called with an AbortSignal');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate surfaces a clean nvidia_error when a 4xx body is not JSON', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('Payment Required - upgrade your plan', {
      status: 402,
      headers: { 'Content-Type': 'text/plain' },
    });

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 402);
    assert.equal(data.code, 'nvidia_error');
    assert.match(data.error, /Payment Required/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
