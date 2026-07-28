// Optional vision QA for generated images. Fails open: generation must not fail
// only because quality inspection is unavailable.
//
// Runs on the NVIDIA VLM, sharing the NVIDIA_API_KEY generation already needs, so
// QA consumes no separate paid quota. The API is OpenAI-compatible and has no
// responseSchema, so the field names live in the prompt and missing ones are
// absorbed by normalizeVisionQa rather than rejected.

function envFlag(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

// The 5s fallback is far too short for a real image - measured median 8.4s and
// slowest 17.0s through the Worker, with a tail run at 38s. Set
// VISION_QA_TIMEOUT_MS; this cap silently clamps it, so raise both together.
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

function normalizeVisionQa(data) {
  const issues = Array.isArray(data.detectedIssues) ? data.detectedIssues : [];
  let recommendation = String(data.recommendation || 'edit').trim().toLowerCase();
  if (!['keep', 'retry', 'edit'].includes(recommendation)) recommendation = 'edit';
  const result = {
    provider: 'nvidia',
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

// json_object guarantees valid JSON but not which fields, so the names must be
// spelled out here. Without them the model returns valid-but-different JSON and
// normalizeVisionQa silently fills in its fallbacks (70/70/70, no issues) — a
// success that inspected nothing.
function buildVisionUserText(prompt) {
  const base = '請以繁體中文評估這張 AI 生成圖片是否符合提示詞。只回 JSON，不要加註解。分數 0-100。請特別檢查：主體是否存在、構圖是否平衡、畫質是否清晰、手指/臉部是否異常、是否有文字亂碼、浮水印、主體缺失、尺寸用途不適合。';
  const fields =
    '\n\n只回下面這個 JSON 物件，欄位一個都不能少：' +
    '{"promptMatchScore": 整數 0-100, "compositionScore": 整數 0-100, ' +
    '"visualQualityScore": 整數 0-100, "textAccuracyScore": 整數 0-100（畫面沒有文字就給 100）, ' +
    '"detectedIssues": 字串陣列（沒發現問題就給 []）, ' +
    '"recommendation": "keep" 或 "retry" 或 "edit", "reason": 一句繁體中文說明}';
  return `${base}${fields}\n\n提示詞：\n${String(prompt || '').slice(0, 4000)}`;
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
        { type: 'text', text: buildVisionUserText(prompt) },
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
  return normalizeVisionQa(parseJsonObject(text));
}

export async function maybeRunVisionQa(image, prompt, env) {
  if (!envFlag(env && env.VISION_QA_ENABLED)) return null;
  if (!String((env && env.NVIDIA_API_KEY) || '').trim()) return null;
  const telemetry = { attempts: 0 };
  try {
    return withVisionAttempts(await runNvidiaVisionQa(image, prompt, env, telemetry), telemetry.attempts);
  } catch (e) {
    return withVisionAttempts({
      provider: 'nvidia',
      available: false,
      code: 'vision_qa_failed',
      message: '視覺 QA 暫時不可用，已保留本機 QAReport',
      detail: String((e && e.message) || e).slice(0, 160),
    }, telemetry.attempts);
  }
}
