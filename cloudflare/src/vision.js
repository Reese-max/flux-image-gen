// Optional Gemini vision QA for generated images. Fails open: generation must not
// fail only because quality inspection is unavailable.

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

function normalizeVisionQa(data) {
  const issues = Array.isArray(data.detectedIssues) ? data.detectedIssues : [];
  let recommendation = String(data.recommendation || 'edit').trim().toLowerCase();
  if (!['keep', 'retry', 'edit'].includes(recommendation)) recommendation = 'edit';
  const result = {
    provider: 'gemini',
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

async function runGeminiVisionQa(image, prompt, env) {
  const apiKey = String((env && env.GEMINI_API_KEY) || '').trim();
  if (!apiKey) throw new Error('missing GEMINI_API_KEY');
  const inline = extractInlineImage(image);
  const model = String((env && env.GEMINI_VISION_MODEL) || 'gemini-2.5-flash').trim();
  const base = String((env && env.GEMINI_BASE_URL) || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const url = `${base}/models/${model}:generateContent`;
  const userText = `請以繁體中文評估這張 AI 生成圖片是否符合提示詞。只回 JSON，不要加註解。分數 0-100。請特別檢查：主體是否存在、構圖是否平衡、畫質是否清晰、手指/臉部是否異常、是否有文字亂碼、浮水印、主體缺失、尺寸用途不適合。\n\n提示詞：\n${String(prompt || '').slice(0, 4000)}`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: userText }, { inline_data: { mime_type: inline.mimeType, data: inline.data } }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 700,
      responseMimeType: 'application/json',
      responseSchema: VISION_QA_SCHEMA,
    },
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.status !== 200) throw new Error(`vision qa returned HTTP ${response.status}`);
  const text = parseGeminiText(await response.json());
  return normalizeVisionQa(parseJsonObject(text));
}

export async function maybeRunVisionQa(image, prompt, env) {
  if (!envFlag(env && env.VISION_QA_ENABLED)) return null;
  if (!String((env && env.GEMINI_API_KEY) || '').trim()) return null;
  try {
    return await runGeminiVisionQa(image, prompt, env);
  } catch (e) {
    return {
      provider: 'gemini',
      available: false,
      code: 'vision_qa_failed',
      message: '視覺 QA 暫時不可用，已保留本機 QAReport',
      detail: String((e && e.message) || e).slice(0, 160),
    };
  }
}
