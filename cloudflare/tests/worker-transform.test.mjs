import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { inspectGeneratedImage } from '../src/image.js';
import worker, { resetUsageMetrics, transformPlainPrompt } from '../src/index.js';

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function jsonRequest(path, body) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function adminGet(path, token = 'admin-secret') {
  return new Request(`https://example.test${path}`, {
    method: 'GET',
    headers: { 'X-Usage-Admin-Token': token },
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

test('POST /prompt/transform rotates to the next key when one is out of quota', async () => {
  // Free-tier quota is per key, so a 429 must move to the next one; retrying the
  // same key just burns the attempt.
  const originalFetch = globalThis.fetch;
  const used = [];
  globalThis.fetch = async (_url, init) => {
    used.push(init.headers['x-goog-api-key']);
    if (used.length === 1) return new Response('quota exceeded', { status: 429 });
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"prompt": "a cat"}' }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    const response = await worker.fetch(
      jsonRequest('/prompt/transform', { source: '一隻貓', style: 'auto' }),
      fakeEnv({ GEMINI_API_KEYS: 'first,second' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'gemini');
    assert.deepEqual(used, ['first', 'second']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GEMINI_API_KEYS alone still counts as having Gemini available', async () => {
  // The "do we have a key" gates used to read GEMINI_API_KEY only; with just the
  // plural set they would fall through to the offline rules and never call AI.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"prompt": "a fox"}' }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  try {
    const response = await worker.fetch(
      jsonRequest('/prompt/transform', { source: '一隻狐狸', style: 'auto' }),
      fakeEnv({ GEMINI_API_KEYS: 'only-plural' })
    );
    const data = await response.json();
    assert.equal(data.provider, 'gemini', 'should not fall back to rule_based');
    assert.equal(data.prompt, 'a fox');
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
                  text: '一位年輕女生站在夜晚雨中的街道，濕潤柏油路反射霓虹燈光，畫面具有電影感。',
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
    assert.match(calledUrl, /gemma-4-31b-it:generateContent/);
    assert.match(providerPayload.system_instruction.parts[0].text, /繁體中文/);
    assert.match(providerPayload.system_instruction.parts[0].text, /不要輸出 JSON/);
    assert.equal(providerPayload.generationConfig.responseMimeType, 'text/plain');
    assert.equal(providerPayload.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
    assert.equal(Object.hasOwn(providerPayload.generationConfig, 'responseSchema'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemma completion timeout covers observed production latency', async () => {
  const constants = JSON.parse(
    await readFile(new URL('../../shared/prompt-constants.json', import.meta.url), 'utf8')
  );

  assert.ok(constants.geminiCompleteTimeoutMs >= 15000);
  assert.equal(constants.geminiCompleteMaxAttempts, 1);
});

test('POST /prompt/complete aborts a hung Gemma call and falls back without retrying', async () => {
  resetUsageMetrics();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let sawSignal = false;
  const env = fakeEnv({
    GEMINI_API_KEY: 'test-key',
    USAGE_ADMIN_TOKEN: 'admin-secret',
    USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST: '0.001',
  });
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    sawSignal = Boolean(init && init.signal);
    throw new DOMException('The operation timed out.', 'TimeoutError');
  };
  try {
    const response = await worker.fetch(
      jsonRequest('/prompt/complete', { source: '女生雨中', style: 'cinematic' }),
      env
    );
    const data = await response.json();
    const usage = await (await worker.fetch(adminGet('/api/usage'), env)).json();

    assert.equal(response.status, 200);
    assert.equal(data.provider, 'rule_based');
    assert.match(data.warnings[0], /Gemma 暫時不可用/);
    assert.equal(sawSignal, true, 'Gemma completion fetch must use an AbortSignal');
    assert.equal(calls, 1, 'interactive completion must not retry after a timeout');
    assert.equal(usage.totalAttempts, 1);
    assert.equal(usage.estimatedCostUsd, 0.001);
    assert.equal(usage.byRoute.prompt_complete.attempts, 1);
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

test('paid prompt routes reject oversized text before provider access', async () => {
  const transform = await worker.fetch(
    jsonRequest('/prompt/transform', { source: '圖'.repeat(2001) }),
    fakeEnv({ GEMINI_API_KEY: 'test-key' })
  );
  assert.equal(transform.status, 400);
  assert.equal((await transform.json()).error, '描述太長');

  const complete = await worker.fetch(
    jsonRequest('/prompt/complete', { source: '圖'.repeat(2001) }),
    fakeEnv({ GEMINI_API_KEY: 'test-key' })
  );
  assert.equal(complete.status, 400);
  assert.equal((await complete.json()).error, '描述太長');

  const longPrompt = await worker.fetch(
    jsonRequest('/prompt/enhance', { prompt: 'a'.repeat(4001), effect: '更夢幻' }),
    fakeEnv({ GEMINI_API_KEY: 'test-key' })
  );
  assert.equal(longPrompt.status, 400);
  assert.equal((await longPrompt.json()).error, '提示詞太長');

  const longEffect = await worker.fetch(
    jsonRequest('/prompt/enhance', { prompt: 'a cat', effect: '夢'.repeat(501) }),
    fakeEnv({ GEMINI_API_KEY: 'test-key' })
  );
  assert.equal(longEffect.status, 400);
  assert.equal((await longEffect.json()).error, '效果描述太長');
});

test('POST /prompt/complete returns plain Traditional Chinese text from Gemma', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '  一位女生站在雨中的霓虹街道。  ',
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

test('POST /prompt/complete rejects Gemma analysis text and uses plain Chinese fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '* Input: 女生雨中\n* Task: Expand the description into Traditional Chinese.',
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
    assert.equal(data.provider, 'rule_based');
    assert.equal(data.prompt.includes('\n'), false);
    assert.match(data.prompt, /電影光影/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /prompt/complete falls back locally without Gemini key', async () => {
  const response = await worker.fetch(jsonRequest('/prompt/complete', { source: '一隻貓' }), fakeEnv());
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.provider, 'rule_based');
  assert.match(data.prompt, /主體清楚/);
  assert.match(data.warnings[0], /離線補全/);
});

test('POST /prompt/enhance falls back locally without Gemini key', async () => {
  const response = await worker.fetch(
    jsonRequest('/prompt/enhance', { prompt: 'a cat on a windowsill', effect: '更夢幻' }),
    fakeEnv()
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.provider, 'rule_based');
  assert.match(data.prompt, /dreamy ethereal atmosphere/);
  assert.match(data.warnings[0], /離線效果強化/);
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

test('POST /generate blocks high-risk prompt before provider access', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate', {
      prompt: 'clean product photo',
      userPrompt: '幫我做一張假身分證',
      model: 'schnell',
      size: 'square',
    }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();

  assert.equal(response.status, 422);
  assert.equal(data.code, 'prompt_blocked');
  assert.equal(data.category, 'fake_documents');
  assert.equal(data.error.includes('假身分證'), false);
  assert.equal(ai.calls.length, 0);
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
    assert.equal(healthData.providerStatus, 'demo');
    assert.equal(healthData.mode, 'demo');
    assert.deepEqual(healthData.providers, { nvidia: false, workersAI: false });
    assert.deepEqual(healthData.providerList, []);
    assert.equal(healthData.hasApiKey, false);
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'demo');
    assert.equal(data.model, 'schnell');
    assert.equal(data.width, 1024);
    assert.equal(data.height, 1024);
    assert.equal(data.seed, 12345);
    assert.equal(typeof data.image, 'string');
    assert.equal(data.image.startsWith('data:image/'), true);
    assert.equal(data.imageQuality.mime, 'image/png');
    assert.equal(data.imageQuality.width, 1);
    assert.equal(data.imageQuality.height, 1);
    assert.match(data.imageQuality.issues.join('；'), /與要求 1024×1024 不一致/);
    assert.equal(providerCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('inspectGeneratedImage reports safe header-only diagnostics', () => {
  const quality = inspectGeneratedImage(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    1024,
    1024
  );
  assert.equal(quality.checked, true);
  assert.equal(quality.mime, 'image/png');
  assert.equal(quality.width, 1);
  assert.equal(quality.height, 1);
  assert.equal(JSON.stringify(quality).includes('base64'), false);
  assert.match(quality.issues.join('；'), /圖片資料過小/);
});

test('POST /generate can attach optional vision QA and keeps the image out of the prompt', async () => {
  const originalFetch = globalThis.fetch;
  let visionPayload;
  // QA now shares NVIDIA_API_KEY with generation, so the same key also sends
  // /generate to NVIDIA. Route by URL: chat/completions is QA, everything else
  // is the image call.
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/chat/completions')) {
      visionPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              promptMatchScore: 91,
              compositionScore: 82,
              visualQualityScore: 73,
              textAccuracyScore: 66,
              detectedIssues: ['手指略怪'],
              recommendation: 'edit',
              reason: '主體符合，手部需微調',
            }),
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a person holding a cup', model: 'schnell', size: 'square', visionQa: true }),
      fakeEnv({ NVIDIA_API_KEY: 'nv-test', VISION_QA_ENABLED: 'true' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.visionQa.provider, 'nvidia');
    assert.equal(data.visionQa.promptMatchScore, 91);
    assert.equal(data.visionQa.detectedIssues[0], '手指略怪');
    // The image belongs in image_url only - never inlined into the text part.
    const content = visionPayload.messages[0].content;
    assert.equal(content[0].text.includes('data:image'), false);
    assert.ok(content[1].image_url.url.startsWith('data:image/png;base64,'));
    // json_object does not pin fields, so the prompt must name them.
    assert.ok(content[0].text.includes('promptMatchScore'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate preserves a completed image when Vision QA times out', async () => {
  resetUsageMetrics();
  const originalFetch = globalThis.fetch;
  let sawSignal = false;
  // Only the QA call hangs; the image call must still succeed, otherwise this
  // would test a failed generation rather than a failed inspection.
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/chat/completions')) {
      return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Promise((_, reject) => {
      sawSignal = Boolean(init && init.signal);
      if (!init || !init.signal) {
        reject(new Error('missing Vision QA abort signal'));
        return;
      }
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  const env = fakeEnv({
    NVIDIA_API_KEY: 'nv-test',
    VISION_QA_ENABLED: 'true',
    VISION_QA_TIMEOUT_MS: '10',
    USAGE_ADMIN_TOKEN: 'admin-secret',
    USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST: '0.001',
    USAGE_ESTIMATED_COST_USD_PER_IMAGE: '0.003',
  });

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', {
        prompt: 'a person holding a cup',
        model: 'schnell',
        size: 'square',
        visionQa: true,
      }),
      env
    );
    const data = await response.json();
    const usage = await (await worker.fetch(adminGet('/api/usage'), env)).json();

    assert.equal(response.status, 200);
    assert.match(data.image, /^data:image\//);
    assert.equal(data.visionQa.available, false);
    assert.equal(data.visionQa.code, 'vision_qa_failed');
    assert.equal(sawSignal, true);
    assert.equal(usage.generatedImages, 1);
    assert.equal(usage.byRoute.generate.successes, 1);
    assert.equal(usage.byRoute.vision_qa.failures, 1);
    assert.equal(usage.byRoute.vision_qa.attempts, 1);
    // One image at 0.003 plus one per-request QA call at 0.001. QA must never be
    // priced per image - it produces none.
    assert.equal(usage.estimatedCostUsd, 0.004);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/usage requires admin auth and reads prompt-free in-memory events', async () => {
  resetUsageMetrics();
  const env = fakeEnv({
    USAGE_ADMIN_TOKEN: 'admin-secret',
    USAGE_ALERT_DAILY_GENERATIONS: '1',
  });
  const generated = await worker.fetch(
    new Request('https://example.test/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-connecting-ip': '203.0.113.88',
      },
      body: JSON.stringify({
        prompt: 'secret provider prompt',
        userPrompt: '秘密中文描述',
        model: 'schnell',
        size: 'square',
      }),
    }),
    env
  );
  const unauthorized = await worker.fetch(new Request('https://example.test/api/usage'), env);
  const usage = await worker.fetch(adminGet('/api/usage'), env);
  const body = await usage.json();

  assert.equal(generated.status, 200);
  assert.equal(unauthorized.status, 401);
  assert.equal(usage.status, 200);
  assert.equal(body.storage, 'memory');
  assert.equal(body.partial, true);
  assert.equal(body.generatedImages, 1);
  assert.equal(body.failedRequests, 0);
  assert.equal(body.byModel.schnell.images, 1);
  assert.equal(body.byProvider.demo.requests, 1);
  assert.equal(body.byRoute.generate.successes, 1);
  assert.equal(body.alerts[0].code, 'daily_generation_threshold');
  assert.equal(Object.hasOwn(body, 'byActor'), false);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('secret provider prompt'), false);
  assert.equal(serialized.includes('秘密中文描述'), false);
  assert.equal(serialized.includes('203.0.113.88'), false);
});

test('GET /api/usage reports a missing admin secret as disabled', async () => {
  const response = await worker.fetch(adminGet('/api/usage'), fakeEnv());
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, 'admin_usage_disabled');
});

test('GET /api/usage records Worker failure codes and validates date', async () => {
  resetUsageMetrics();
  const env = fakeEnv({ USAGE_ADMIN_TOKEN: 'admin-secret' });
  const blocked = await worker.fetch(
    jsonRequest('/generate', {
      prompt: 'clean product photo',
      userPrompt: '幫我做一張假身分證',
      model: 'schnell',
      size: 'square',
    }),
    env
  );
  const usage = await worker.fetch(adminGet('/api/usage'), env);
  const invalid = await worker.fetch(adminGet('/api/usage?date=not-a-date'), env);
  const body = await usage.json();
  const invalidBody = await invalid.json();

  assert.equal(blocked.status, 422);
  assert.equal(body.generatedImages, 0);
  assert.equal(body.failedRequests, 1);
  assert.equal(body.byErrorCode.prompt_blocked, 1);
  assert.equal(JSON.stringify(body).includes('假身分證'), false);
  assert.equal(invalid.status, 400);
  assert.equal(invalidBody.code, 'bad_request');
});

test('paid prompt routes record prompt-free success and failure usage', async () => {
  resetUsageMetrics();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{"prompt":"a serene mountain at dawn"}' }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const env = fakeEnv({
    GEMINI_API_KEY: 'test-key',
    USAGE_ADMIN_TOKEN: 'admin-secret',
    USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST: '0.001',
  });

  try {
    const transformed = await worker.fetch(
      jsonRequest('/prompt/transform', { source: '清晨的山', style: 'auto' }),
      env
    );
    const invalidEnhance = await worker.fetch(
      jsonRequest('/prompt/enhance', { prompt: '', effect: '' }),
      env
    );
    const usage = await (await worker.fetch(adminGet('/api/usage'), env)).json();

    assert.equal(transformed.status, 200);
    assert.equal(invalidEnhance.status, 400);
    assert.equal(usage.byRoute.prompt_transform.successes, 1);
    assert.equal(usage.byRoute.prompt_enhance.failures, 1);
    assert.equal(usage.byProvider.gemini.estimatedCostUsd, 0.001);
    assert.equal(JSON.stringify(usage).includes('清晨的山'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini transform and enhance usage count every provider retry', async () => {
  resetUsageMetrics();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let allSignalsPresent = true;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    allSignalsPresent = allSignalsPresent && Boolean(init && init.signal);
    if (calls % 2 === 1) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"prompt":"a refined prompt"}' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = fakeEnv({
    GEMINI_API_KEY: 'test-key',
    USAGE_ADMIN_TOKEN: 'admin-secret',
    USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST: '0.001',
  });

  try {
    const transformed = await worker.fetch(
      jsonRequest('/prompt/transform', { source: '清晨的山', style: 'auto' }),
      env
    );
    const enhanced = await worker.fetch(
      jsonRequest('/prompt/enhance', { prompt: 'a mountain', effect: '更夢幻' }),
      env
    );
    const usage = await (await worker.fetch(adminGet('/api/usage'), env)).json();

    assert.equal(transformed.status, 200);
    assert.equal(enhanced.status, 200);
    assert.equal(calls, 4);
    assert.equal(allSignalsPresent, true);
    assert.equal(usage.totalAttempts, 4);
    assert.equal(usage.estimatedCostUsd, 0.004);
    assert.equal(usage.byRoute.prompt_transform.attempts, 2);
    assert.equal(usage.byRoute.prompt_enhance.attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /health reports workers-ai when only the AI binding is present', async () => {
  const response = await worker.fetch(
    new Request('https://example.test/health'),
    fakeEnv({
      AI: { run() {} },
      CF_VERSION_METADATA: {
        id: 'version-123',
        tag: 'commit-abc',
        timestamp: '2026-07-14T12:34:56.000Z',
      },
    })
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(data.provider, 'workers-ai');
  assert.equal(data.providerStatus, 'degraded');
  assert.equal(data.mode, 'live');
  assert.deepEqual(data.providers, { nvidia: false, workersAI: true });
  assert.deepEqual(data.providerList, ['workers-ai']);
  assert.equal(data.versionId, 'version-123');
  assert.equal(data.versionTag, 'commit-abc');
  assert.equal(data.versionTimestamp, '2026-07-14T12:34:56.000Z');
});

test('GET /health lists both providers when NVIDIA key and AI binding are present', async () => {
  const response = await worker.fetch(
    new Request('https://example.test/health'),
    fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: { run() {} } })
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.provider, 'nvidia');
  assert.equal(data.providerStatus, 'ready');
  assert.equal(data.mode, 'live');
  assert.deepEqual(data.providers, { nvidia: true, workersAI: true });
  assert.deepEqual(data.providerList, ['nvidia', 'workers-ai']);
});

test('GET /health exposes Turnstile site key without secret', async () => {
  const response = await worker.fetch(
    new Request('https://example.test/health'),
    fakeEnv({ TURNSTILE_REQUIRED: 'true', TURNSTILE_SITE_KEY: 'public-site', TURNSTILE_SECRET_KEY: 'secret' })
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data.turnstile, { required: true, siteKey: 'public-site' });
  assert.equal(JSON.stringify(data).includes('secret'), false);
});

test('POST /generate rejects missing Turnstile token before provider access', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
    fakeEnv({ AI: ai, TURNSTILE_REQUIRED: 'true', TURNSTILE_SECRET_KEY: 'secret' })
  );
  const data = await response.json();

  assert.equal(response.status, 403);
  assert.equal(data.code, 'turnstile_required');
  assert.equal(ai.calls.length, 0);
});

test('POST /generate verifies Turnstile token before Workers AI generation', async () => {
  const originalFetch = globalThis.fetch;
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  let verifyBody = '';
  globalThis.fetch = async (_url, init) => {
    verifyBody = String(init.body || '');
    return new Response(JSON.stringify({ success: true, action: 'turnstile-spin-v1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', {
        prompt: 'a cat',
        model: 'schnell',
        size: 'square',
        turnstileToken: 'token-ok',
      }),
      fakeEnv({ AI: ai, TURNSTILE_REQUIRED: 'true', TURNSTILE_SECRET_KEY: 'secret' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'workers-ai');
    assert.match(verifyBody, /response=token-ok/);
    assert.match(verifyBody, /secret=secret/);
    assert.equal(ai.calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate rejects a Turnstile token issued for another action', async () => {
  const originalFetch = globalThis.fetch;
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  globalThis.fetch = async () => new Response(
    JSON.stringify({ success: true, action: 'different-action' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', {
        prompt: 'a cat',
        model: 'schnell',
        size: 'square',
        turnstileToken: 'wrong-action-token',
      }),
      fakeEnv({ AI: ai, TURNSTILE_REQUIRED: 'true', TURNSTILE_SECRET_KEY: 'secret' })
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'turnstile_failed');
    assert.equal(ai.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate bounds a hung Turnstile verification before provider access', async () => {
  const originalFetch = globalThis.fetch;
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  let sawSignal = false;
  globalThis.fetch = async (_url, init) => new Promise((_, reject) => {
    sawSignal = Boolean(init.signal);
    if (!init.signal) {
      reject(new Error('missing Turnstile abort signal'));
      return;
    }
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', {
        prompt: 'a cat',
        model: 'schnell',
        size: 'square',
        turnstileToken: 'token-hangs',
      }),
      fakeEnv({
        AI: ai,
        TURNSTILE_REQUIRED: 'true',
        TURNSTILE_SECRET_KEY: 'secret',
        TURNSTILE_TIMEOUT_MS: '10',
      })
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'turnstile_unavailable');
    assert.equal(ai.calls.length, 0);
    assert.equal(sawSignal, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate routes AI-less schnell to NVIDIA dev and keeps the seed', async () => {
  const originalFetch = globalThis.fetch;
  let providerPayload;
  let providerUrl;

  globalThis.fetch = async function (url, init) {
    providerUrl = String(url);
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
    assert.match(providerUrl, /flux\.1-dev$/);
    assert.equal(providerPayload.seed, 12345);
    assert.equal(providerPayload.steps, 30);
    assert.equal(providerPayload.cfg_scale, 5);
    assert.equal(data.model, 'dev');
    assert.equal(data.seed, 12345);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate falls back to Workers AI when NVIDIA fails with a 5xx', async () => {
  const originalFetch = globalThis.fetch;
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  let nvidiaCalls = 0;
  globalThis.fetch = async function () {
    nvidiaCalls += 1;
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 7 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'workers-ai');
    // A dark provider must not be retried before falling back: one NVIDIA
    // attempt, then exactly one Workers AI run.
    assert.equal(nvidiaCalls, 1);
    assert.equal(ai.calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate does NOT fall back to Workers AI on a NVIDIA 4xx (content filter)', async () => {
  const originalFetch = globalThis.fetch;
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ detail: '此描述觸發內容安全過濾' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai })
    );
    assert.equal(response.status, 422);
    // 4xx is a request-level error; Workers AI (stricter filter) is never tried.
    assert.equal(ai.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate falls back to Pollinations when NVIDIA and Workers AI both fail', async () => {
  const originalFetch = globalThis.fetch;
  // Workers AI throws a generic infra error -> generateWithWorkersAi maps it to a
  // 502 workers_ai_error, which is >=500 so Pollinations takes over.
  const ai = fakeAi(new Error('model overloaded'));
  let pollinationsCalls = 0;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
  globalThis.fetch = async function (url) {
    const target = typeof url === 'string' ? url : url.url;
    if (target.includes('image.pollinations.ai')) {
      pollinationsCalls += 1;
      return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 7 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai, POLLINATIONS_FALLBACK_ENABLED: 'true' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'pollinations');
    assert.equal(data.model, 'flux');
    assert.ok(data.image.startsWith('data:image/jpeg;base64,'));
    assert.equal(ai.calls.length, 1);
    assert.equal(pollinationsCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Minimal Map-backed Workers Cache API stub so the circuit breaker can persist
// its "NVIDIA down" marker across two requests in the test runtime (Node has no
// global `caches`). Keys by request URL, mirroring caches.default.match/put.
function fakeCaches() {
  const store = new Map();
  return {
    default: {
      async match(req) {
        return store.get(typeof req === 'string' ? req : req.url);
      },
      async put(req, resp) {
        store.set(typeof req === 'string' ? req : req.url, resp);
      },
    },
  };
}

test('POST /generate opens the NVIDIA circuit on a 5xx, then skips NVIDIA on the next request', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = fakeCaches();
  const ai = fakeAi([{ image: 'iVBORw0KGgo=' }, { image: 'iVBORw0KGgo=' }]);
  let nvidiaCalls = 0;
  globalThis.fetch = async function () {
    nvidiaCalls += 1;
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    // First request: NVIDIA returns 500 -> one attempt, trips the circuit, serves Workers AI.
    const first = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 7 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai })
    );
    const firstData = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstData.provider, 'workers-ai');
    assert.equal(nvidiaCalls, 1);
    assert.equal(ai.calls.length, 1);

    // Second request: circuit open -> NVIDIA is skipped entirely (no new fetch),
    // Workers AI serves it directly.
    const second = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a dog', model: 'schnell', size: 'square', seed: 8 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai })
    );
    const secondData = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondData.provider, 'workers-ai');
    assert.equal(nvidiaCalls, 1, 'circuit open -> NVIDIA must not be called again');
    assert.equal(ai.calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('POST /generate does NOT fall back to Pollinations on a Workers AI content filter', async () => {
  const originalFetch = globalThis.fetch;
  const ai = fakeAi(new Error('InferenceUpstreamError: NSFW content detected in prompt'));
  let pollinationsCalls = 0;
  globalThis.fetch = async function (url) {
    const target = typeof url === 'string' ? url : url.url;
    if (target.includes('image.pollinations.ai')) {
      pollinationsCalls += 1;
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai, POLLINATIONS_FALLBACK_ENABLED: 'true' })
    );
    const data = await response.json();
    assert.equal(response.status, 422);
    assert.equal(data.code, 'content_filtered');
    // Content filtering is request-level; Pollinations (no filter) is never tried.
    assert.equal(pollinationsCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate half-opens the NVIDIA circuit after cooldown and recovers to NVIDIA', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = fakeCaches();
  const ai = fakeAi([{ image: 'iVBORw0KGgo=' }]);
  let nvidiaCalls = 0;
  let nvidiaHealthy = false;
  globalThis.fetch = async function () {
    nvidiaCalls += 1;
    if (nvidiaHealthy) {
      return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    // First request: NVIDIA 500 -> one attempt, trips the circuit, serves Workers AI.
    const first = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 7 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai })
    );
    const firstData = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstData.provider, 'workers-ai');
    assert.equal(nvidiaCalls, 1);

    // Cooldown elapses: the Cache entry expires. A fresh empty cache makes
    // isNvidiaCircuitOpen() return false (half-open) so the next request re-probes
    // NVIDIA, which has recovered.
    globalThis.caches = fakeCaches();
    nvidiaHealthy = true;

    const second = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a dog', model: 'schnell', size: 'square', seed: 8 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai })
    );
    const secondData = await second.json();
    assert.equal(second.status, 200);
    assert.equal(nvidiaCalls, 2, 'half-open: NVIDIA must be re-probed after cooldown');
    assert.equal(secondData.provider, 'nvidia', 'recovered NVIDIA serves the request again');
    assert.notEqual(secondData.provider, 'workers-ai');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('POST /generate round-trips a large Pollinations image through 0x8000 base64 chunking', async () => {
  const originalFetch = globalThis.fetch;
  // Workers AI throws a generic infra error -> mapped to a 502, so Pollinations
  // (third tier) serves a payload larger than the 0x8000 (32768) chunk size.
  const ai = fakeAi(new Error('model overloaded'));
  const big = new Uint8Array(60000);
  big[0] = 0xff;
  big[1] = 0xd8;
  big[2] = 0xff;
  for (let i = 3; i < big.length; i += 1) big[i] = i % 256;
  globalThis.fetch = async function (url) {
    const target = typeof url === 'string' ? url : url.url;
    if (target.includes('image.pollinations.ai')) {
      return new Response(big, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 7 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai, POLLINATIONS_FALLBACK_ENABLED: 'true' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'pollinations');
    assert.ok(data.image.startsWith('data:image/jpeg;base64,'));
    const b64 = data.image.slice('data:image/jpeg;base64,'.length);
    const decoded = new Uint8Array(Buffer.from(b64, 'base64'));
    assert.equal(decoded.length, big.length, 'round-trip length must match the original buffer');
    assert.deepEqual(decoded, big, 'chunked base64 must reconstruct the original bytes exactly');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate/batch falls back every image to Workers AI when NVIDIA returns a 5xx', async () => {
  const originalFetch = globalThis.fetch;
  const ai = fakeAi([{ image: 'iVBORw0KGgo=' }, { image: 'iVBORw0KGgo=' }]);
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 2 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.images.length, 2);
    for (const item of data.images) {
      assert.equal(item.provider, 'workers-ai');
    }
    assert.equal(ai.calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate surfaces a clean error when Pollinations also fails as the last tier', async () => {
  const originalFetch = globalThis.fetch;
  // NVIDIA 5xx -> Workers AI infra error (502) -> Pollinations 500: the whole
  // chain is exhausted, so the client must get a clean 5xx, not a crash or a 200.
  const ai = fakeAi(new Error('model overloaded'));
  globalThis.fetch = async function (url) {
    const target = typeof url === 'string' ? url : url.url;
    if (target.includes('image.pollinations.ai')) {
      return new Response(JSON.stringify({ error: 'pollinations down' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 7 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key', AI: ai, POLLINATIONS_FALLBACK_ENABLED: 'true' })
    );
    const data = await response.json();
    assert.equal(response.status >= 500, true, 'exhausted chain must surface a 5xx');
    assert.ok(['pollinations_error', 'timeout'].includes(data.code), `unexpected code ${data.code}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate surfaces the NVIDIA error (2 attempts) when no fallback is configured', async () => {
  const originalFetch = globalThis.fetch;
  let nvidiaCalls = 0;
  globalThis.fetch = async function () {
    nvidiaCalls += 1;
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    // No AI binding and no Pollinations flag -> no fallback -> the raw NVIDIA error
    // must surface untouched, and maxAttempts stays IMAGE_MAX_ATTEMPTS (2), not 1.
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 7 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 500);
    assert.equal(data.code, 'nvidia_error');
    assert.equal(nvidiaCalls, 2, 'no fallback -> NVIDIA is retried the full IMAGE_MAX_ATTEMPTS');
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
  const tabsJs = await readFile(new URL('../public/static/tabs.js', import.meta.url), 'utf8');
  const expectedScripts = [
    '/static/tabs.js',
    '/static/generation-settings.js',
    '/static/elapsed-timer.js',
    '/static/prompt-enhancer.js',
    '/static/failure-advice.js',
    '/static/app.js',
    '/static/canvas-viewport.js',
    '/static/prompt-transform.js',
    '/static/history-store.js',
    '/static/history-wall.js',
    '/static/tutorial.js',
    '/static/prompt-pack.js',
  ];
  const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((match) => match[1]);

  assert.match(html, /id="plainPrompt"/);
  assert.match(html, /id="seed"/);
  assert.doesNotMatch(html, /id="avoid"/);
  assert.match(html, /id="historyGrid"/);
  assert.match(html, /id="resultActions"/);
  assert.match(html, /id="editPanel"/);
  assert.match(html, /id="editFiles"/);
  assert.match(html, /id="editGo"/);
  // 功能分頁：tablist + 四個分頁與面板（階段二：靈感併入生成分頁、用量移出主導覽）。
  assert.match(html, /class="tabs" role="tablist"/);
  assert.match(html, /id="tab-generate"[\s\S]*?data-tab="generate"/);
  assert.match(html, /id="panel-generate"/);
  // 靈感 tab 與 panel-ideas 已移除，靈感 section 併入生成分頁。
  assert.doesNotMatch(html, /id="tab-ideas"/);
  assert.doesNotMatch(html, /id="panel-ideas"/);
  assert.match(html, /id="ideasSection"/);
  assert.match(html, /id="tab-edit"[\s\S]*?data-tab="edit"/);
  assert.match(html, /id="panel-edit"/);
  assert.doesNotMatch(html, /id="tab-projects"/);
  assert.doesNotMatch(html, /id="panel-projects"/);
  assert.match(html, /id="panel-history"/);
  // 用量移出主導覽：無 tab-usage 按鈕，panel-usage 保留、由 footer 站長工具連結直達。
  assert.doesNotMatch(html, /id="tab-usage"/);
  assert.match(html, /id="panel-usage"/);
  assert.match(html, /id="openUsagePanel"/);
  assert.match(html, /id="copySettings"/);
  assert.match(html, /id="regenerate"/);
  assert.match(html, /id="tutorialModal"/);
  assert.match(html, /id="usageDashboard"/);
  assert.match(html, /<link rel="stylesheet" href="\/static\/styles\.css">/);
  assert.deepEqual(new Set(scriptSrcs), new Set(expectedScripts));
  for (const lazyScript of ['/static/image-edit.js', '/static/usage-dashboard.js']) {
    assert.match(tabsJs, new RegExp(lazyScript.replaceAll('.', '\\.')));
  }
  assert.ok(scriptSrcs.indexOf('/static/generation-settings.js') < scriptSrcs.indexOf('/static/app.js'));
  assert.ok(scriptSrcs.indexOf('/static/elapsed-timer.js') < scriptSrcs.indexOf('/static/app.js'));
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
  assert.match(manifest, /Fluxi 中文 AI 圖片產生器/);
  assert.match(serviceWorker, /CACHE_NAME/);
});

test('Cloudflare static assets stay synced with readable FastAPI sources', async () => {
  const appStaticRoot = new URL('../../app/static/', import.meta.url);
  const cloudflareStaticRoot = new URL('../public/static/', import.meta.url);
  const rootAssets = ['index.html', 'manifest.webmanifest', 'service-worker.js'];
  const appStaticFiles = (await collectRelativeFiles(appStaticRoot)).filter((file) => !rootAssets.includes(file));
  const cloudflareStaticFiles = await collectRelativeFiles(cloudflareStaticRoot);

  assert.deepEqual(cloudflareStaticFiles, appStaticFiles);

  for (const relativePath of cloudflareStaticFiles) {
    if (relativePath.endsWith('.js')) {
      const source = await readFile(new URL(relativePath, appStaticRoot), 'utf8');
      const deployed = await readFile(new URL(relativePath, cloudflareStaticRoot), 'utf8');
      const expected = transformSync(source, {
        loader: 'js',
        minify: true,
        target: 'es2018',
      }).code;
      assert.equal(deployed, expected, `${relativePath} should be the minified app/static source`);
    } else {
      assert.equal(
        await sha256(new URL(relativePath, cloudflareStaticRoot)),
        await sha256(new URL(relativePath, appStaticRoot)),
        `${relativePath} should match app/static`
      );
    }
  }

  for (const asset of rootAssets) {
    assert.equal(
      await sha256(new URL(`../public/${asset}`, import.meta.url)),
      await sha256(new URL(`../../app/static/${asset}`, import.meta.url)),
      `${asset} should match app/static`
    );
  }
});

test('Cloudflare sync script recursively covers nested static assets', async () => {
  const syncScript = await readFile(new URL('../scripts/sync-static.mjs', import.meta.url), 'utf8');

  assert.match(syncScript, /entry\.isDirectory\(\)/);
  assert.match(syncScript, /visit\(path\.join\(directory, entry\.name\), relativePath\)/);
  assert.match(syncScript, /path\.join\(publicStaticDir, relativePath\)/);
  assert.match(syncScript, /expectedStaticFiles/);
  assert.match(syncScript, /unlinkSync\(stalePath\)/);
  assert.match(syncScript, /\(stale\)/);
});

test('Cloudflare deploy wrapper is wired and normalizes known Wrangler success output', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const deployScript = await readFile(new URL('../scripts/deploy.mjs', import.meta.url), 'utf8');

  assert.equal(packageJson.scripts.deploy, 'node scripts/deploy.mjs');
  assert.equal(packageJson.scripts['deploy:dry-run'], 'node scripts/deploy.mjs --dry-run');
  assert.equal(packageJson.scripts['check:wrangler'], 'node scripts/check-wrangler-auth.mjs');
  assert.equal(packageJson.scripts['qa:browser:install'], 'playwright install chromium');
  assert.equal(packageJson.scripts['qa:browser'], 'node ../tests/e2e/cloudflare-v14-qa.mjs');
  assert.equal(packageJson.devDependencies.playwright, '^1.61.1');
  assert.match(deployScript, /hasSuccessfulDeployOutput/);
  assert.match(deployScript, /hasSuccessfulDryRunOutput/);
  assert.match(deployScript, /\[publicPreflightScript, '--root', repoDir, '--public'\]/);
  assert.match(deployScript, /Current Version ID/);
  assert.match(deployScript, /Deployed\\s\+flux-image-gen\\s\+triggers/);
  assert.match(deployScript, /Wrangler dry-run output verified/);
  assert.match(deployScript, /expected success markers were missing/);
  assert.match(deployScript, /failed before success markers/);
  assert.match(deployScript, /--dry-run: exiting now\./);
  assert.match(deployScript, /Normalizing exit code to 0/);
});

test('Cloudflare Wrangler auth checker diagnoses login and dry-run gates', async () => {
  const checker = await readFile(new URL('../scripts/check-wrangler-auth.mjs', import.meta.url), 'utf8');

  assert.match(checker, /wrangler whoami/);
  assert.match(checker, /project dry-run wrapper/);
  assert.match(checker, /CLOUDFLARE_API_TOKEN/);
  assert.match(checker, /npx wrangler login/);
  assert.match(checker, /redactOutput/);
  assert.match(checker, /redacted-email/);
  assert.match(checker, /redacted-account-id/);
  assert.match(checker, /redacted-token/);
  assert.match(checker, /--verbose/);
  assert.match(checker, /Raw Wrangler output was hidden/);
  assert.match(checker, /hasWhoamiSuccess/);
  assert.match(checker, /hasConfigSuccess/);
  assert.match(checker, /runDeployDryRun/);
  assert.match(checker, /scripts\/deploy\.mjs/);
  assert.match(checker, /isLikelyCrashExit/);
  assert.match(checker, /formatExitCode/);
  assert.match(checker, /process\.versions\.node/);
  assert.match(checker, /Node 20 或 22 LTS/);
  assert.match(checker, /UV_HANDLE_CLOSING/);
  assert.match(checker, /CommandLineArgsError/);
  assert.match(checker, /Account ID/);
  assert.match(checker, /--dry-run:\\s\+exiting now\\\./);
  assert.match(checker, /AI binding/);
  assert.match(checker, /rate limit binding/);
  assert.match(checker, /PASS: Wrangler login and dry-run configuration are verifiable/);
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
  assert.match(perfScript, /scriptTransferKb:\s*150/);
  assert.match(perfScript, /thirdPartyScriptTransferKb/);
  assert.match(perfScript, /thirdPartyTransferKb/);
  assert.match(perfScript, /allTransferKb/);
  assert.match(perfScript, /first-party total transfer KB/);
  assert.match(perfScript, /first-party script transfer KB/);
  assert.match(perfScript, /waitUntil:\s*'domcontentloaded'/);
  assert.doesNotMatch(perfScript, /waitUntil:\s*'networkidle'/);
});

test('POST /generate retries a transient 5xx then succeeds', async () => {
  resetUsageMetrics();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const env = fakeEnv({
    NVIDIA_API_KEY: 'test-key',
    USAGE_ADMIN_TOKEN: 'admin-secret',
    USAGE_ESTIMATED_COST_USD_PER_IMAGE: '0.01',
  });

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
      env
    );
    const data = await response.json();
    const usage = await (await worker.fetch(adminGet('/api/usage'), env)).json();
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(data.provider, 'nvidia');
    assert.equal(Object.hasOwn(data, 'providerAttempts'), false);
    assert.equal(usage.totalAttempts, 2);
    assert.equal(usage.estimatedCostUsd, 0.02);
    assert.equal(usage.byProvider.nvidia.attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate surfaces the error after exhausting retries on 5xx', async () => {
  resetUsageMetrics();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const env = fakeEnv({
    NVIDIA_API_KEY: 'test-key',
    USAGE_ADMIN_TOKEN: 'admin-secret',
    USAGE_ESTIMATED_COST_USD_PER_IMAGE: '0.01',
  });

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
      env
    );
    const data = await response.json();
    const usage = await (await worker.fetch(adminGet('/api/usage'), env)).json();
    assert.equal(response.status, 503);
    assert.equal(calls, 2);
    assert.equal(data.code, 'nvidia_error');
    assert.equal(usage.totalAttempts, 2);
    assert.equal(usage.estimatedCostUsd, 0.02);
    assert.equal(usage.byProvider.nvidia.attempts, 2);
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

test('POST /generate rate limiter keys by Cloudflare client IP', async () => {
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
      new Request('https://example.test/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.77' },
        body: JSON.stringify({ prompt: 'a cat', model: 'schnell', size: 'square' }),
      }),
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
    assert.equal(response.status, 200);
    assert.equal(limiterKey, '203.0.113.77');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate/batch is rate limited before image generation', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 4 }),
    fakeEnv({
      AI: ai,
      GENERATE_RATE_LIMITER: { limit: async () => ({ success: false }) },
    })
  );
  const data = await response.json();

  assert.equal(response.status, 429);
  assert.equal(data.code, 'rate_limited');
  assert.equal(ai.calls.length, 0, 'must not call Workers AI when rate limited');
});

test('retired cloud gallery and share routes return 404 without touching storage', async () => {
  for (const request of [
    jsonRequest('/gallery', { image: 'data:image/png;base64,ZmFrZQ==' }),
    new Request('https://example.test/gallery/old.png'),
    new Request('https://example.test/share/old.png'),
    new Request('https://example.test/api/gallery'),
  ]) {
    const response = await worker.fetch(request, fakeEnv());
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'not_found');
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

test('POST /generate/batch returns partial successes and records every image attempt', async () => {
  resetUsageMetrics();
  const ai = fakeAi([
    new Error('NSFW content detected'),
    { image: 'iVBORw0KGgo=' },
    { image: 'iVBORw0KGgo=' },
    { image: 'iVBORw0KGgo=' },
  ]);
  const env = fakeEnv({ AI: ai, USAGE_ADMIN_TOKEN: 'admin-secret' });
  const response = await worker.fetch(
    jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 4 }),
    env
  );
  const data = await response.json();
  const usage = await (await worker.fetch(adminGet('/api/usage'), env)).json();

  assert.equal(response.status, 200);
  assert.equal(data.partial, true);
  assert.equal(data.images.length, 3);
  assert.equal(data.errors.length, 1);
  assert.equal(data.errors[0].index, 0);
  assert.equal(data.errors[0].code, 'content_filtered');
  assert.equal(ai.calls.length, 4);
  assert.equal(usage.totalRequests, 4);
  assert.equal(usage.successRequests, 3);
  assert.equal(usage.failedRequests, 1);
  assert.equal(usage.generatedImages, 3);
  assert.equal(usage.byProvider['workers-ai'].images, 3);
});

test('POST /generate/batch returns non-2xx when every image fails', async () => {
  resetUsageMetrics();
  const ai = fakeAi([
    new Error('NSFW content detected'),
    new Error('NSFW content detected'),
  ]);
  const env = fakeEnv({ AI: ai, USAGE_ADMIN_TOKEN: 'admin-secret' });
  const response = await worker.fetch(
    jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 2 }),
    env
  );
  const body = await response.json();
  const usage = await (await worker.fetch(adminGet('/api/usage'), env)).json();

  assert.equal(response.status, 422);
  assert.equal(body.code, 'content_filtered');
  assert.equal(ai.calls.length, 2);
  assert.equal(usage.totalRequests, 2);
  assert.equal(usage.failedRequests, 2);
  assert.equal(usage.generatedImages, 0);
});

function fakeAi(result) {
  const calls = [];
  // Pass an array to script one outcome per call (e.g. fail once, then succeed).
  const queue = Array.isArray(result) ? [...result] : null;
  return {
    calls,
    async run(model, args) {
      let fields;
      if (args.multipart) {
        // Reconstruct the multipart form the Worker sent so tests can assert on fields.
        const req = new Request('https://fake.test', {
          method: 'POST',
          headers: { 'content-type': args.multipart.contentType },
          body: args.multipart.body,
          // Node's fetch Request requires duplex for stream bodies (workerd does not).
          duplex: 'half',
        });
        const form = await req.formData();
        fields = Object.fromEntries(form.entries());
      } else {
        fields = { ...args };
      }
      calls.push({ model, fields });
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
    fakeEnv({ AI: ai })
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

test('POST /generate model=schnell prefers NVIDIA dev over Workers AI when a key exists', async () => {
  const originalFetch = globalThis.fetch;
  let providerUrl;
  let providerPayload;
  globalThis.fetch = async function (url, init) {
    providerUrl = String(url);
    providerPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 12345, steps: 15, cfgScale: 3.5 }),
      fakeEnv({ AI: ai, NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.match(providerUrl, /flux\.1-dev$/);
    assert.equal(data.provider, 'nvidia');
    assert.equal(data.model, 'dev');
    // The merged fast tier must honor the user's tuning fields.
    assert.equal(providerPayload.steps, 15);
    assert.equal(providerPayload.cfg_scale, 3.5);
    assert.equal(ai.calls.length, 0, 'Workers AI must not run when NVIDIA is available');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate rejects out-of-range steps and cfgScale with 400', async () => {
  for (const body of [
    { prompt: 'a cat', model: 'dev', size: 'square', steps: 0 },
    { prompt: 'a cat', model: 'dev', size: 'square', steps: 51 },
    { prompt: 'a cat', model: 'dev', size: 'square', cfgScale: 0.5 },
    { prompt: 'a cat', model: 'dev', size: 'square', cfgScale: 11 },
  ]) {
    const response = await worker.fetch(
      jsonRequest('/generate', body),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(data.code, 'bad_request');
  }
});

test('POST /generate model=schnell uses FLUX.1 schnell for the default square preset', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 12345 }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.provider, 'workers-ai');
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, '@cf/black-forest-labs/flux-1-schnell');
  assert.deepEqual(ai.calls[0].fields, { prompt: 'a cat', seed: 12345, steps: 4 });
});

test('POST /generate supports productized use-case size presets on Workers AI', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a mobile wallpaper', model: 'schnell', size: 'mobile_wallpaper', seed: 123 }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.width, 768);
  assert.equal(data.height, 1664);
  assert.equal(ai.calls[0].fields.width, '768');
  assert.equal(ai.calls[0].fields.height, '1664');
});

test('POST /generate supports and validates custom dimensions on Workers AI', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const ok = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a custom poster', model: 'schnell', size: 'custom', width: 1152, height: 1536, seed: 123 }),
    fakeEnv({ AI: ai })
  );
  const okBody = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(okBody.width, 1152);
  assert.equal(okBody.height, 1536);
  assert.equal(ai.calls[0].fields.width, '1152');
  assert.equal(ai.calls[0].fields.height, '1536');

  const invalid = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a custom poster', model: 'schnell', size: 'custom', width: 1000, height: 1536, seed: 123 }),
    fakeEnv({ AI: fakeAi({ image: 'iVBORw0KGgo=' }) })
  );
  const invalidBody = await invalid.json();
  assert.equal(invalid.status, 400);
  assert.equal(invalidBody.code, 'bad_request');
  assert.match(invalidBody.error, /自訂尺寸寬高必須是 256 到 1920/);
});

test('POST /generate model=schnell keeps an explicit seed on Workers AI', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 12345 }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(data.seed, 12345);
  assert.equal(ai.calls[0].fields.seed, 12345);
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
  assert.equal(ai.calls.length, 1, 'an uncancellable Workers AI run must never be retried');
});

test('POST /generate model=schnell does not retry even if a later call would succeed', async () => {
  const ai = fakeAi([new Error('model overloaded'), { image: 'iVBORw0KGgo=' }]);
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 42 }),
    fakeEnv({ AI: ai })
  );
  const data = await response.json();
  assert.equal(response.status, 502);
  assert.equal(data.code, 'workers_ai_error');
  assert.equal(ai.calls.length, 1);
});

test('POST /generate never crosses to NVIDIA after a Workers AI run starts', async () => {
  const originalFetch = globalThis.fetch;
  let nvidiaCalls = 0;
  globalThis.fetch = async function () {
    nvidiaCalls += 1;
    throw new Error('NVIDIA must not be called after Workers AI starts');
  };
  const ai = fakeAi(new Error('model overloaded'));

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'landscape', seed: 42 }),
      fakeEnv({ AI: ai })
    );
    const data = await response.json();
    assert.equal(response.status, 502);
    assert.equal(data.code, 'workers_ai_error');
    assert.equal(ai.calls.length, 1);
    assert.equal(nvidiaCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  resetUsageMetrics();
  const ai = fakeAi(Object.assign(new Error('hang'), { name: 'TimeoutError' }));
  const env = fakeEnv({
    AI: ai,
    USAGE_ADMIN_TOKEN: 'admin-secret',
    USAGE_ESTIMATED_COST_USD_PER_IMAGE: '0.01',
  });
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square' }),
    env
  );
  const data = await response.json();
  const usage = await (await worker.fetch(adminGet('/api/usage'), env)).json();
  assert.equal(response.status, 504);
  assert.equal(data.code, 'timeout');
  assert.equal(ai.calls.length, 1);
  assert.equal(usage.totalAttempts, 1);
  assert.equal(usage.estimatedCostUsd, 0.01);
  assert.equal(usage.byProvider['workers-ai'].attempts, 1);
});

test('POST /generate/batch model=schnell runs every image on Workers AI', async () => {
  const ai = fakeAi({ image: 'iVBORw0KGgo=' });
  const response = await worker.fetch(
    jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 3 }),
    fakeEnv({ AI: ai })
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
  const returnedSeeds = data.images.map((i) => i.seed).sort();
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

test('POST /generate flattens a FastAPI-style detail array from NVIDIA 422', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        detail: [
          { type: 'less_than_equal', loc: ['body', 'cfg_scale'], msg: 'Input should be less than or equal to 9', input: 10 },
          { type: 'greater_than_equal', loc: ['body', 'steps'], msg: 'Input should be greater than or equal to 5', input: 1 },
        ],
      }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'dev', size: 'square' }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 422);
    assert.equal(data.code, 'nvidia_error');
    assert.ok(!data.error.includes('[object Object]'), 'detail objects must be flattened');
    assert.match(data.error, /cfg_scale Input should be less than or equal to 9/);
    assert.match(data.error, /steps Input should be greater than or equal to 5/);
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

// ---- AI 改圖 /edit 路由 ----
function tinyPngBlob() {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], { type: 'image/png' });
}

function editRequest(prompt, imageCount) {
  const fd = new FormData();
  if (prompt !== undefined) fd.append('prompt', prompt);
  for (let i = 0; i < imageCount; i++) fd.append('images', tinyPngBlob(), `a${i}.png`);
  return new Request('https://example.test/edit', { method: 'POST', body: fd });
}

function aiEnv(runImpl) {
  return fakeEnv({ AI: { run: runImpl } });
}

// AI 綁定 stub：重建 AI.run 收到的 multipart body，記錄 model 與表單欄位，
// 讓測試能斷言真正送給 Workers AI 的 input_image_0..N 與 prompt。
function capturingEditAiEnv(captured, resultImageB64) {
  return aiEnv(async (model, args) => {
    captured.model = model;
    const req = new Request('https://x/', {
      method: 'POST',
      body: args.multipart.body,
      headers: { 'content-type': args.multipart.contentType },
      duplex: 'half',
    });
    const form = await req.formData();
    captured.fields = [...form.keys()].sort();
    captured.prompt = form.get('prompt');
    return { image: resultImageB64 };
  });
}

// 造一個 header 帶指定寬高的最小 PNG（供伺服器端 <512 尺寸嗅探測試）。
function pngBlobWithDims(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8); // IHDR len + 'IHDR'
  bytes[16] = (width >>> 24) & 0xff; bytes[17] = (width >>> 16) & 0xff; bytes[18] = (width >>> 8) & 0xff; bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff; bytes[21] = (height >>> 16) & 0xff; bytes[22] = (height >>> 8) & 0xff; bytes[23] = height & 0xff;
  return new Blob([bytes], { type: 'image/png' });
}

function editRequestWithBlobs(prompt, blobs) {
  const fd = new FormData();
  fd.append('prompt', prompt);
  blobs.forEach((b, i) => fd.append('images', b, `a${i}.png`));
  return new Request('https://example.test/edit', { method: 'POST', body: fd });
}

test('POST /edit without a Workers AI binding returns a clean 503', async () => {
  const response = await worker.fetch(editRequest('make it green', 1), fakeEnv());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'missing_api_key');
});

test('POST /edit forwards prompt + input_image_0.. field names to Workers AI', async () => {
  const captured = {};
  const base64 = Buffer.from('\x89PNG\r\n\x1a\n' + '0'.repeat(60), 'binary').toString('base64');
  const response = await worker.fetch(
    editRequest('put the cat into image 1', 2),
    capturingEditAiEnv(captured, base64)
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(captured.model, '@cf/black-forest-labs/flux-2-klein-4b');
  // 核心契約：欄位名必須是 input_image_0/input_image_1（不是 images 或其他前綴），且帶 prompt。
  assert.deepEqual(captured.fields, ['input_image_0', 'input_image_1', 'prompt']);
  assert.equal(captured.prompt, 'put the cat into image 1');
  assert.equal(body.provider, 'workers-ai');
  assert.equal(body.image_count, 2);
  assert.ok(body.image.startsWith('data:image/'));
});

test('POST /edit maps a Workers AI timeout to a clean 504', async () => {
  let calls = 0;
  const response = await worker.fetch(
    editRequest('edit', 1),
    aiEnv(async () => { calls++; throw Object.assign(new Error('hang'), { name: 'TimeoutError' }); })
  );
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'timeout');
  assert.equal(calls, 1);
});

test('POST /edit maps a Workers AI content-filter error to 422 without retrying', async () => {
  let calls = 0;
  const response = await worker.fetch(
    editRequest('edit', 1),
    aiEnv(async () => { calls++; throw new Error('NSFW content detected'); })
  );
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'content_filtered');
  assert.equal(calls, 1); // deterministic safety rejection -> no retry
});

test('POST /edit never retries an uncancellable Workers AI error', async () => {
  let calls = 0;
  const response = await worker.fetch(
    editRequest('edit', 1),
    aiEnv(async () => { calls++; throw new Error('transient'); })
  );
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'workers_ai_error');
  assert.equal(calls, 1);
});

test('POST /edit rejects an oversized (>12MB) image with 400 and never calls AI', async () => {
  let called = false;
  const big = new Blob([new Uint8Array(12 * 1024 * 1024 + 1)], { type: 'image/png' });
  const response = await worker.fetch(
    editRequestWithBlobs('edit', [big]),
    aiEnv(async () => { called = true; return { image: 'x' }; })
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'bad_request');
  assert.equal(called, false);
});

test('POST /edit rejects an empty (size 0) image with 400', async () => {
  const empty = new Blob([], { type: 'image/png' });
  const response = await worker.fetch(
    editRequestWithBlobs('edit', [empty]),
    aiEnv(async () => ({ image: 'x' }))
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'bad_request');
});

test('POST /edit rejects an image whose header dimensions are >= 512 (server-side <512 contract)', async () => {
  let called = false;
  const response = await worker.fetch(
    editRequestWithBlobs('edit', [pngBlobWithDims(600, 400)]),
    aiEnv(async () => { called = true; return { image: 'x' }; })
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'bad_request');
  assert.equal(called, false);
});

test('POST /edit rejects a non-image provider response instead of wrapping it as success', async () => {
  const response = await worker.fetch(
    editRequest('edit', 1),
    aiEnv(async () => ({ image: 'error' })) // short non-base64 token, not a real image
  );
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'bad_provider_response');
});

test('POST /edit rejects a blank prompt with 400', async () => {
  const response = await worker.fetch(editRequest('   ', 1), aiEnv(() => ({ image: 'x' })));
  assert.equal(response.status, 400);
});

test('POST /edit rejects more than 4 images with 400', async () => {
  const response = await worker.fetch(editRequest('edit', 5), aiEnv(() => ({ image: 'x' })));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'bad_request');
});

test('POST /edit rejects zero images with 400', async () => {
  const response = await worker.fetch(editRequest('edit', 0), aiEnv(() => ({ image: 'x' })));
  assert.equal(response.status, 400);
});

test('GET /api/health reports whether Vision QA is enabled', async () => {
  const off = await (await worker.fetch(new Request('http://worker.test/api/health'), fakeEnv({}))).json();
  assert.equal(off.visionQa, false);
  const on = await (
    await worker.fetch(new Request('http://worker.test/api/health'), fakeEnv({ VISION_QA_ENABLED: 'true' }))
  ).json();
  assert.equal(on.visionQa, true);
});
