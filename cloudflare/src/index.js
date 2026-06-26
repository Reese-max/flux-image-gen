// Cloudflare Worker: serves the static SPA and proxies /generate to NVIDIA NIM FLUX.
// Faithful port of app/image_service.py (incl. the CONTENT_FILTERED guard).

const SIZE_MAP = {
  square: [1024, 1024],
  landscape: [1344, 768],
  portrait: [768, 1344],
};

const MODEL_ENDPOINTS = {
  schnell: "black-forest-labs/flux.1-schnell",
  dev: "black-forest-labs/flux.1-dev",
};

const MAX_JSON_BYTES = 64 * 1024;
const MAX_PROMPT_LENGTH = 900;
const MAX_SEED = 2147483647;
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const SUPPORTED_STYLES = new Set(["auto", "cute", "cinematic", "realistic", "anime", "product"]);

const PHRASE_RULES = Object.freeze([
  { keywords: ["台北", "臺北", "夜市"], phrase: "Taipei night market" },
  { keywords: ["下雨", "雨天", "雨", "街景"], phrase: "rainy street scene" },
  { keywords: ["柴犬"], phrase: "Shiba Inu" },
  { keywords: ["貓", "猫"], phrase: "cat" },
  { keywords: ["狗", "犬"], phrase: "dog" },
  { keywords: ["月球", "月亮", "月面"], phrase: "on the moon" },
  { keywords: ["拉麵", "拉面"], phrase: "eating ramen" },
  { keywords: ["可愛", "萌", "療癒"], phrase: "adorable" },
  { keywords: ["紅色", "紅"], phrase: "red" },
  { keywords: ["白色", "白"], phrase: "white" },
  { keywords: ["黑色", "黑"], phrase: "black" },
  { keywords: ["藍色", "藍"], phrase: "blue" },
  { keywords: ["綠色", "綠"], phrase: "green" },
  { keywords: ["黃色", "黃"], phrase: "yellow" },
  { keywords: ["杯子", "杯"], phrase: "cup" },
  { keywords: ["木桌", "木桌上"], phrase: "wooden table" },
  { keywords: ["桌上", "桌子", "桌面"], phrase: "tabletop" },
  { keywords: ["陽光", "日光", "自然光"], phrase: "sunlight" },
]);

const TRANSLATED_CHINESE_TERMS = Object.freeze(
  PHRASE_RULES.flatMap((rule) => rule.keywords).sort((a, b) => b.length - a.length)
);

const CHINESE_FILLER_TERMS = Object.freeze([
  "旁邊",
  "附近",
  "放在",
  "放置",
  "正在",
  "風格",
  "一點",
  "一個",
  "一隻",
  "一張",
  "一片",
  "一位",
  "一名",
  "幫我",
  "請",
  "生成",
  "圖片",
  "照片",
  "場景",
  "上",
  "下",
  "裡",
  "中",
  "旁",
  "的",
  "在",
  "有",
  "和",
  "與",
  "並",
  "要",
  "吃",
  "個",
  "隻",
  "張",
  "片",
  "位",
  "名",
]);

const STYLE_MODIFIERS = Object.freeze({
  cute: ["adorable", "soft rounded shapes", "warm pastel colors"],
  cinematic: ["cinematic lighting", "film still", "dramatic atmosphere", "shallow depth of field"],
  realistic: ["photorealistic", "natural lighting", "realistic textures"],
  anime: ["anime style", "expressive character design", "vibrant colors"],
  product: ["studio product photography", "clean background", "commercial lighting"],
  auto: ["clean composition"],
});

// --- Gemini (Gemma) LLM prompt transform: mirrors app/prompt_llm.py ---
const GEMINI_DEFAULT_MODEL = "gemma-4-31b-it";
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MAX_ATTEMPTS = 2;
const GEMINI_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const GEMINI_SYSTEM_INSTRUCTION =
  "You are an expert prompt engineer for the FLUX.1 text-to-image model. FLUX.1 is " +
  "driven by a T5 text encoder and renders best from rich, natural-language " +
  "descriptions, not keyword lists.\n" +
  "Your job: rewrite the user's casual description (usually Traditional Chinese) " +
  "into ONE polished English image prompt that FLUX.1 can render beautifully.\n" +
  "How to write it:\n" +
  "- Use flowing natural language (one to three sentences), never a comma-separated " +
  "tag dump.\n" +
  "- Cover, in this order and only when relevant: the main subject and what it is " +
  "doing; the setting/environment and key background elements; lighting and time of " +
  "day; colour palette and mood; the art medium or render style (e.g. photograph, " +
  "oil painting, 3D render, anime cel, watercolour); and for photographic looks, " +
  "concrete camera detail (lens, depth of field, angle).\n" +
  "- Name the visual medium explicitly so the model commits to a coherent look.\n" +
  "- Faithfully preserve every concrete detail the user gave (subject, count, " +
  "colours, objects, place, time of day). Enrich with fitting detail, but never " +
  "contradict or drop what they asked for.\n" +
  "- Translate every non-English word into natural, idiomatic English. EXCEPTION: " +
  "if the user clearly wants specific words to appear in the image (a sign, label, " +
  "banner or title), keep that exact text verbatim in double quotes, e.g. a neon " +
  'sign reading "營業中". Do not translate or romanise such on-image text.\n' +
  "- Do not add on-image text, captions, logos or watermarks that the user did not " +
  "ask for. Keep it under 600 characters.\n" +
  "- Do NOT restate these rules, and do NOT show any reasoning, labels, or " +
  "alternatives.\n" +
  'Return ONLY a JSON object of the form {"prompt": "<the english prompt>"}.\n' +
  "Example input: 一隻可愛的橘貓在窗台上看夕陽\n" +
  'Example output: {"prompt": "A heartwarming photograph of an adorable orange ' +
  "tabby cat perched on a wooden windowsill, gazing out at a glowing golden " +
  "sunset, warm rim light catching its soft fur, cozy and serene atmosphere, shot " +
  'on a 50mm lens with a gentle shallow depth of field, highly detailed"}';

const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  properties: { prompt: { type: "string" } },
  required: ["prompt"],
};

const GEMINI_STYLE_HINTS = {
  auto: "Choose the most fitting visual style for the described scene.",
  cute: "Style: adorable, soft rounded shapes, warm pastel colours, gentle and cozy.",
  cinematic:
    "Style: cinematic film still, dramatic lighting, atmospheric mood, shallow depth of field.",
  realistic: "Style: photorealistic, natural lighting, true-to-life textures and detail.",
  anime: "Style: anime illustration, expressive character design, vibrant clean colours.",
  product:
    "Style: studio product photography, clean seamless background, crisp commercial lighting.",
};

function buildGeminiUserText(source, style) {
  const hint = GEMINI_STYLE_HINTS[style] || GEMINI_STYLE_HINTS.auto;
  return `${hint}\n\nDescription:\n${String(source).trim()}`;
}

function stripWrapping(text) {
  let cleaned = String(text || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .split("\n")
      .filter((line) => !line.trim().startsWith("```"))
      .join("\n")
      .trim();
  }
  if (
    cleaned.length >= 2 &&
    cleaned[0] === cleaned[cleaned.length - 1] &&
    (cleaned[0] === '"' || cleaned[0] === "'")
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

function tryParsePromptJson(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && typeof parsed.prompt === "string" && parsed.prompt.trim()) {
      return parsed.prompt.trim();
    }
  } catch {
    // not valid JSON
  }
  return null;
}

function extractPromptText(rawText) {
  const cleaned = stripWrapping(rawText);

  const found = tryParsePromptJson(cleaned);
  if (found) return found;

  // The model sometimes wraps the JSON in a code fence or adds stray text;
  // try the {...} substring before giving up.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const fromSub = tryParsePromptJson(cleaned.slice(start, end + 1));
    if (fromSub) return fromSub;
  }

  return cleaned;
}

function parseGeminiResponse(data) {
  const feedback = (data && data.promptFeedback) || {};
  if (feedback.blockReason) throw new Error(`gemini blocked: ${feedback.blockReason}`);
  const candidates = (data && data.candidates) || [];
  if (!candidates.length) throw new Error("gemini returned no candidates");
  const parts = ((candidates[0] && candidates[0].content) || {}).parts || [];
  const raw = parts.map((p) => (p && p.text) || "").join("").trim();
  let text = extractPromptText(raw);
  if (!text) throw new Error("gemini returned empty text");
  if (text.length > MAX_PROMPT_LENGTH) {
    text = text.slice(0, MAX_PROMPT_LENGTH).replace(/[ ,]+$/g, "");
  }
  return text;
}

async function geminiTransformPrompt(source, style, env) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) throw new Error("missing GEMINI_API_KEY");

  const model = env.GEMINI_PROMPT_MODEL || GEMINI_DEFAULT_MODEL;
  const base = (env.GEMINI_BASE_URL || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/models/${model}:generateContent`;
  const payload = {
    system_instruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: buildGeminiUserText(source, style) }] }],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
      responseSchema: GEMINI_RESPONSE_SCHEMA,
    },
  };

  let lastError;
  for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      lastError = new Error(`gemini network error: ${e}`);
      continue;
    }
    if (GEMINI_RETRYABLE_STATUS.has(resp.status)) {
      lastError = new Error(`gemini returned HTTP ${resp.status}`);
      continue;
    }
    if (resp.status !== 200) throw new Error(`gemini returned HTTP ${resp.status}`);

    let data;
    try {
      data = await resp.json();
    } catch {
      throw new Error("gemini returned non-JSON response");
    }
    return parseGeminiResponse(data);
  }
  throw lastError || new Error("gemini request failed");
}

function makeRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return `req_${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // fall through to compact non-cryptographic fallback
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function json(body, status = 200, requestId = makeRequestId()) {
  return new Response(JSON.stringify({ ...body, requestId }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      "x-content-type-options": "nosniff",
    },
  });
}

function textLimit(value, limit = 500) {
  const text = String(value || "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function safePath(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.origin}${url.pathname}`;
  } catch {
    return textLimit(value, 300);
  }
}

function sanitizeClientErrorReport(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    type: textLimit(source.type || "client_error", 80),
    message: textLimit(source.message, 500),
    stack: textLimit(source.stack, 900),
    source: textLimit(source.source, 300),
    url: safePath(source.url),
    line: Number.isFinite(source.line) ? source.line : null,
    column: Number.isFinite(source.column) ? source.column : null,
    requestId: textLimit(source.requestId, 120),
    userAgent: textLimit(source.userAgent, 300),
  };
}

async function handleClientError(request) {
  const requestId = makeRequestId();
  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status, requestId);
    throw e;
  }

  const report = sanitizeClientErrorReport(payload);
  console.warn(JSON.stringify({ event: "client_error", requestId, report }));
  return new Response(null, {
    status: 204,
    headers: {
      "x-request-id": requestId,
      "x-content-type-options": "nosniff",
    },
  });
}

class HttpError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validatePrompt(prompt) {
  const cleaned = String(prompt || "").split(/\s+/).filter(Boolean).join(" ");
  if (!cleaned) throw new HttpError("請先輸入描述文字", 400, "bad_request");
  if (cleaned.length > 10000) throw new HttpError("描述文字太長，請縮短到 10000 字以內", 400, "bad_request");
  return cleaned;
}

function validateSeed(seed) {
  if (seed === undefined || seed === null || seed === "") return 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new HttpError("seed 必須是 0 到 2147483647 之間的整數", 400, "bad_request");
  }
  return seed;
}

async function readJsonPayload(request) {
  const header = request.headers.get("content-length");
  const contentLength = header ? Number(header) : 0;
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw new HttpError("請求內容太大", 413, "payload_too_large");
  }
  try {
    return await request.json();
  } catch {
    throw new HttpError("請求格式錯誤", 400, "bad_request");
  }
}

async function readLimitedText(response, maxBytes = 512) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;

      if (value.byteLength > remaining) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    return "";
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function normalizeStyle(style) {
  const key = String(style || "auto").trim().toLowerCase();
  return SUPPORTED_STYLES.has(key) ? key : "auto";
}

function resolveStyle(sourceText, style) {
  if (style !== "auto") return style;
  if (["可愛", "萌", "療癒"].some((keyword) => sourceText.includes(keyword))) return "cute";
  if (["電影", "鏡頭", "夜景", "街景"].some((keyword) => sourceText.includes(keyword))) return "cinematic";
  if (["動畫", "動漫", "二次元"].some((keyword) => sourceText.includes(keyword))) return "anime";
  if (["商品", "產品", "包裝"].some((keyword) => sourceText.includes(keyword))) return "product";
  if (["寫實", "真實", "照片"].some((keyword) => sourceText.includes(keyword))) return "realistic";
  return "auto";
}

function containsCjk(text) {
  return CJK_PATTERN.test(text);
}

function hasUntranslatedCjk(sourceText) {
  if (!containsCjk(sourceText)) return false;

  let remaining = sourceText;
  for (const term of TRANSLATED_CHINESE_TERMS.concat(CHINESE_FILLER_TERMS)) {
    remaining = remaining.split(term).join("");
  }
  return containsCjk(remaining);
}

function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function fallbackCorePhrase(sourceText) {
  if (containsCjk(sourceText) || Array.from(sourceText).some((char) => char.charCodeAt(0) > 127)) {
    return "imaginative visual scene";
  }
  return sourceText;
}

function extractCorePhrases(sourceText) {
  const phrases = [];
  for (const rule of PHRASE_RULES) {
    if (rule.keywords.some((keyword) => sourceText.includes(keyword))) {
      phrases.push(rule.phrase);
    }
  }
  if (!phrases.length) {
    phrases.push(fallbackCorePhrase(sourceText));
  }
  return dedupe(phrases);
}

function buildWarnings(sourceText) {
  const warnings = [];
  if (sourceText.length <= 2) {
    warnings.push("描述較短");
  }
  if (hasUntranslatedCjk(sourceText)) {
    warnings.push("部分詞彙未能精準翻譯，已使用通用英文描述補足");
  }
  return warnings;
}

function transformPlainPrompt(source, style = "auto") {
  const sourceText = String(source || "").trim();
  if (!sourceText) {
    throw new HttpError("請先輸入白話描述", 400, "bad_request");
  }

  const normalizedStyle = normalizeStyle(style);
  const resolvedStyle = resolveStyle(sourceText, normalizedStyle);
  const corePhrases = extractCorePhrases(sourceText);
  const warnings = buildWarnings(sourceText);
  const modifiers = STYLE_MODIFIERS[resolvedStyle] || STYLE_MODIFIERS.auto;
  const promptParts = dedupe(corePhrases.concat(modifiers, ["highly detailed"]));
  let prompt = promptParts.join(", ");

  if (prompt.length > MAX_PROMPT_LENGTH) {
    prompt = prompt.slice(0, MAX_PROMPT_LENGTH).replace(/[ ,]+$/g, "");
  }

  return {
    source: sourceText,
    prompt,
    provider: "rule_based",
    warnings,
    style: resolvedStyle,
  };
}

// NVIDIA may return HTTP 200 + a black placeholder with finishReason CONTENT_FILTERED.
function isContentFiltered(data) {
  const arts = data && data.artifacts;
  if (!Array.isArray(arts)) return false;
  return arts.some((a) => {
    const r = a && (a.finishReason || a.finish_reason);
    return typeof r === "string" && r.trim().toUpperCase() === "CONTENT_FILTERED";
  });
}

function looksLikeImageString(v) {
  if (typeof v !== "string") return false;
  if (v.startsWith("data:image/") || v.startsWith("http://") || v.startsWith("https://")) return true;
  const c = v.trim();
  if (c.length <= 80) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(c.slice(0, 120));
}

function isValidBase64(v) {
  if (typeof v !== "string") return false;
  const c = v.trim();
  return c.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(c);
}

function findImageCandidate(data) {
  if (typeof data === "string") return looksLikeImageString(data) ? data : null;
  if (Array.isArray(data)) {
    for (const it of data) {
      const f = findImageCandidate(it);
      if (f) return f;
    }
    return null;
  }
  if (!data || typeof data !== "object") return null;
  for (const k of ["base64", "b64_json"]) {
    if (typeof data[k] === "string" && isValidBase64(data[k])) return data[k];
  }
  for (const k of ["image", "url", "image_url"]) {
    if (typeof data[k] === "string" && looksLikeImageString(data[k])) return data[k];
  }
  for (const k of ["artifacts", "images", "data", "output"]) {
    const f = findImageCandidate(data[k]);
    if (f) return f;
  }
  return null;
}

function detectMimeFromBase64(b64) {
  // Decode only the first few bytes to sniff the signature.
  let bytes;
  try {
    const bin = atob(b64.slice(0, 16));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "image/png";
}

function extractImage(data) {
  const candidate = findImageCandidate(data);
  if (!candidate) throw new HttpError("NVIDIA 回應中找不到圖片資料", 502, "bad_provider_response");
  if (candidate.startsWith("data:image/") || candidate.startsWith("http://") || candidate.startsWith("https://")) {
    return candidate;
  }
  return `data:${detectMimeFromBase64(candidate)};base64,` + candidate;
}

function makeDemoImageDataUrl() {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
}

function getNvidiaApiKey(env) {
  return String((env && env.NVIDIA_API_KEY) || "").trim();
}

async function handleGenerate(request, env) {
  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    throw e;
  }

  let prompt, model, size, width, height, seed;
  try {
    prompt = validatePrompt(payload.prompt);
    seed = validateSeed(payload.seed);
    model = payload.model || "schnell";
    if (!MODEL_ENDPOINTS[model]) throw new HttpError("不支援的模型", 400, "bad_request");
    size = payload.size || "square";
    if (!SIZE_MAP[size]) throw new HttpError("不支援的尺寸", 400, "bad_request");
    [width, height] = SIZE_MAP[size];
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    throw e;
  }

  const key = getNvidiaApiKey(env);
  if (!key) {
    return json({ image: makeDemoImageDataUrl(), provider: "demo", model, width, height, seed });
  }

  const base = (env.NVIDIA_BASE_URL || "https://ai.api.nvidia.com/v1/genai").replace(/\/+$/, "");
  const endpoint = `${base}/${MODEL_ENDPOINTS[model]}`;
  const body = { prompt, width, height, seed };
  if (model === "dev") {
    body.cfg_scale = 5;
    body.steps = 30;
  }

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return json({ error: `NVIDIA 連線失敗：${e}`, code: "network_error" }, 502);
  }

  if (resp.status === 429) {
    const ra = parseInt(resp.headers.get("retry-after") || "", 10);
    const out = { error: "叫用太頻繁，請稍後再試", code: "rate_limited" };
    if (!Number.isNaN(ra)) out.retry_after = Math.max(1, ra);
    return json(out, 429);
  }
  if (resp.status >= 400) {
    let msg;
    try {
      const d = await resp.json();
      msg = d.error || d.message || (d.detail ? `NVIDIA HTTP ${resp.status}: ${d.detail}` : `NVIDIA HTTP ${resp.status}`);
    } catch {
      msg = (await readLimitedText(resp, 300)) || `NVIDIA HTTP ${resp.status}`;
    }
    return json({ error: msg, code: "nvidia_error" }, resp.status);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return json({ error: "NVIDIA 回應格式不正確", code: "bad_provider_response" }, 502);
  }

  if (isContentFiltered(data)) {
    return json(
      { error: "此描述觸發 NVIDIA 內容安全過濾，無法生成圖片，請換個描述再試", code: "content_filtered" },
      422
    );
  }

  let image;
  try {
    image = extractImage(data);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    return json({ error: String(e), code: "bad_provider_response" }, 502);
  }
  return json({ image, provider: "nvidia", model, width, height, seed });
}

async function handlePromptTransform(request, env) {
  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    throw e;
  }

  const source = String(payload.source || "").trim();
  if (!source) return json({ error: "請先輸入白話描述", code: "bad_request" }, 400);

  // LLM-first: try Gemini when a key is configured, then gracefully fall back.
  if (String((env && env.GEMINI_API_KEY) || "").trim()) {
    try {
      const resolvedStyle = resolveStyle(source, normalizeStyle(payload.style));
      const prompt = await geminiTransformPrompt(source, resolvedStyle, env);
      return json({ source, prompt, provider: "gemini", warnings: [] });
    } catch {
      // fall through to the offline rule-based engine
    }
  }

  try {
    const result = transformPlainPrompt(source, payload.style);
    return json({
      source: result.source,
      prompt: result.prompt,
      provider: result.provider,
      warnings: result.warnings,
    });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    return json({ error: String(e), code: "bad_request" }, 400);
  }
}

export { transformPlainPrompt };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ status: "ok", provider: getNvidiaApiKey(env) ? "nvidia" : "demo" });
    }
    if (url.pathname === "/prompt/transform" && request.method === "POST") {
      return handlePromptTransform(request, env);
    }
    if (url.pathname === "/generate" && request.method === "POST") {
      return handleGenerate(request, env);
    }
    if (url.pathname === "/client-error" && request.method === "POST") {
      return handleClientError(request);
    }
    // Anything else: static assets (index.html, /static/*).
    return env.ASSETS.fetch(request);
  },
};
