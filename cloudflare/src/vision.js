// Optional vision QA for generated images. Fails open: generation must not fail
// only because quality inspection is unavailable.
//
// Two backends. NVIDIA (default) reuses the same NVIDIA_API_KEY as generation, so
// enabling QA needs no extra credential; Gemini stays available via
// VISION_QA_PROVIDER=gemini. Only the request shape differs — NVIDIA speaks the
// OpenAI-compatible chat/completions API and has no responseSchema, so missing
// fields are absorbed by normalizeVisionQa rather than rejected.

const VISION_QA_SCHEMA = {
  type: 'OBJECT',
  properties: {
    promptMatchScore: { type: 'NUMBER' },
    compositionScore: { type: 'NUMBER' },
    visualQualityScore: { type: 'NUMBER' },
    textAccuracyScore: { type: 'NUMBER' },
    detectedIssues: { type: 'ARRAY', items: { type: 'STRING' } },
    recommendation: { type: 'STRING', enum: ['keep', 'retry', 'edit'] },
    reason: { type: 'STRING' },
  },
  required: ['promptMatchScore', 'compositionScore', 'visualQualityScore', 'detectedIssues', 'recommendation', 'reason'],
};

function envFlag(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

// 5s 是為 Gemini flash 調的。NVIDIA 的 VLM 慢得多（透過 Worker 實測中位 8.4s、
// 最慢 17.0s，直接打 API 則到 23s），上限放寬到 60s 讓 VISION_QA_PROVIDER=nvidia
// 有餘裕；預設值不動，Gemini 用不到那麼久。
// 這個上限會靜默夾住 VISION_QA_TIMEOUT_MS——調高那個設定前要先確認這裡夠大。
function visionTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(250, Math.min(60000, Math.round(parsed)));
}

function withVisionAttempts(result, attempts) {
  Object.defineProperty(result, 'providerAttempts', {
    value: Math.max(0, Math.round(Number(attempts) || 0)),
    configurable: true,
  });
  return result;
}

function parseGeminiText(data) {
  const feedback = (data && data.promptFeedback) || {};
  if (feedback.blockReason) throw new Error(`vision qa blocked: ${feedback.blockReason}`);
  const candidates = (data && data.candidates) || [];
  const parts = candidates.length ? (((candidates[0] || {}).content || {}).parts || []) : [];
  return parts.map((part) => (part && part.text) || '').join('').trim();
}

function parseJsonObject(raw) {
  let text = String(raw || '').trim();
  if (text.startsWith('```')) text = text.split(/\r?\n/).filter((line) => !line.trim().startsWith('```')).join('\n').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('vision qa returned invalid JSON');
    return JSON.parse(text.slice(start, end + 1));
  }
}

function score(value, fallback = 70) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, number));
}

function normalizeVisionQa(data, provider = 'gemini') {
  const issues = Array.isArray(data.detectedIssues) ? data.detectedIssues : [];
  let recommendation = String(data.recommendation || 'edit').trim().toLowerCase();
  if (!['keep', 'retry', 'edit'].includes(recommendation)) recommendation = 'edit';
  const result = {
    provider,
    available: true,
    promptMatchScore: score(data.promptMatchScore),
    compositionScore: score(data.compositionScore),
    visualQualityScore: score(data.visualQualityScore),
    detectedIssues: issues.map((issue) => String(issue || '').trim().slice(0, 120)).filter(Boolean).slice(0, 8),
    recommendation,
    reason: String(data.reason || '已完成視覺 QA').trim().slice(0, 220),
  };
  if (data.textAccuracyScore != null) result.textAccuracyScore = score(data.textAccuracyScore);
  return result;
}

function extractInlineImage(image) {
  const match = String(image || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) throw new Error('vision qa requires a data URL image');
  const b64 = match[2].replace(/\s+/g, '');
  if (b64.length > 7000000) throw new Error('vision qa image is too large');
  return { mimeType: match[1], data: b64 };
}

// Gemini pins the fields via responseSchema; NVIDIA only has json_object, so the
// field names must be spelled out in the prompt. Without them the model returns
// valid-but-different JSON and normalizeVisionQa silently fills in its fallbacks
// (70/70/70, no issues) — a success that inspected nothing.
const VISION_QA_FIELD_HINT =
  '\n\n只回下面這個 JSON 物件，欄位一個都不能少：' +
  '{"promptMatchScore": 整數 0-100, "compositionScore": 整數 0-100, ' +
  '"visualQualityScore": 整數 0-100, "textAccuracyScore": 整數 0-100（畫面沒有文字就給 100）, ' +
  '"detectedIssues": 字串陣列（沒發現問題就給 []）, ' +
  '"recommendation": "keep" 或 "retry" 或 "edit", "reason": 一句繁體中文說明}';

function buildVisionUserText(prompt, fieldHint = false) {
  const base = '請以繁體中文評估這張 AI 生成圖片是否符合提示詞。只回 JSON，不要加註解。分數 0-100。請特別檢查：主體是否存在、構圖是否平衡、畫質是否清晰、手指/臉部是否異常、是否有文字亂碼、浮水印、主體缺失、尺寸用途不適合。';
  return `${base}${fieldHint ? VISION_QA_FIELD_HINT : ''}\n\n提示詞：\n${String(prompt || '').slice(0, 4000)}`;
}

// Config wins, but a backend without its key steps aside for the other one.
// '' means neither is usable.
export function resolveVisionProvider(env) {
  const requested = String((env && env.VISION_QA_PROVIDER) || 'nvidia').trim().toLowerCase();
  const hasNvidia = !!String((env && env.NVIDIA_API_KEY) || '').trim();
  const hasGemini = !!String((env && env.GEMINI_API_KEY) || '').trim();
  if (requested === 'gemini' && hasGemini) return 'gemini';
  if (requested === 'nvidia' && hasNvidia) return 'nvidia';
  if (hasNvidia) return 'nvidia';
  if (hasGemini) return 'gemini';
  return '';
}

function parseOpenAiText(data) {
  const choices = (data && data.choices) || [];
  if (!choices.length) throw new Error('vision qa returned no choices');
  const content = ((choices[0] || {}).message || {}).content;
  // Some NIM models return content as an array of parts instead of a string.
  if (Array.isArray(content)) {
    return content.map((part) => (part && part.text) || '').join('').trim();
  }
  return String(content || '').trim();
}

async function runNvidiaVisionQa(image, prompt, env, telemetry) {
  const apiKey = String((env && env.NVIDIA_API_KEY) || '').trim();
  if (!apiKey) throw new Error('missing NVIDIA_API_KEY');
  const inline = extractInlineImage(image);
  const model = String((env && env.NVIDIA_VISION_MODEL) || 'meta/llama-3.2-90b-vision-instruct').trim();
  const base = String((env && env.NVIDIA_CHAT_BASE_URL) || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: buildVisionUserText(prompt, true) },
        { type: 'image_url', image_url: { url: `data:${inline.mimeType};base64,${inline.data}` } },
      ],
    }],
    max_tokens: 700,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };
  telemetry.attempts = 1;
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(visionTimeoutMs(env && env.VISION_QA_TIMEOUT_MS)),
  });
  if (response.status !== 200) throw new Error(`vision qa returned HTTP ${response.status}`);
  const text = parseOpenAiText(await response.json());
  return normalizeVisionQa(parseJsonObject(text), 'nvidia');
}

async function runGeminiVisionQa(image, prompt, env, telemetry) {
  const apiKey = String((env && env.GEMINI_API_KEY) || '').trim();
  if (!apiKey) throw new Error('missing GEMINI_API_KEY');
  const inline = extractInlineImage(image);
  const model = String((env && env.GEMINI_VISION_MODEL) || 'gemini-2.5-flash').trim();
  const base = String((env && env.GEMINI_BASE_URL) || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const url = `${base}/models/${model}:generateContent`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: buildVisionUserText(prompt) }, { inline_data: { mime_type: inline.mimeType, data: inline.data } }] }],
    // maxOutputTokens is shared between thinking and output on thinking models.
    // Measured: gemini-2.5-flash spends ~669 thinking tokens on a busy image,
    // leaving 16 for the JSON, which comes back cut in half (MAX_TOKENS). Scoring
    // is structured work, so thinking is off; 2048 is the net if a model ignores
    // thinkingConfig.
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
      responseSchema: VISION_QA_SCHEMA,
    },
  };
  telemetry.attempts = 1;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(visionTimeoutMs(env && env.VISION_QA_TIMEOUT_MS)),
  });
  if (response.status !== 200) throw new Error(`vision qa returned HTTP ${response.status}`);
  const text = parseGeminiText(await response.json());
  return normalizeVisionQa(parseJsonObject(text), 'gemini');
}

export async function maybeRunVisionQa(image, prompt, env) {
  if (!envFlag(env && env.VISION_QA_ENABLED)) return null;
  const provider = resolveVisionProvider(env);
  if (!provider) return null;
  const telemetry = { attempts: 0 };
  try {
    const run = provider === 'nvidia' ? runNvidiaVisionQa : runGeminiVisionQa;
    return withVisionAttempts(await run(image, prompt, env, telemetry), telemetry.attempts);
  } catch (e) {
    return withVisionAttempts({
      provider,
      available: false,
      code: 'vision_qa_failed',
      message: '視覺 QA 暫時不可用，已保留本機 QAReport',
      detail: String((e && e.message) || e).slice(0, 160),
    }, telemetry.attempts);
  }
}
