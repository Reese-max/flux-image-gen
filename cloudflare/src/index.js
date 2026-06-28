// Cloudflare Worker: serves the static SPA and proxies /generate to NVIDIA NIM FLUX.
// Prompt-transform constants come from the single source of truth shared with the
// Python backend (app/prompt_llm.py): shared/prompt-constants.json. esbuild inlines it.
import sharedConstants from "../../shared/prompt-constants.json" with { type: "json" };
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
const MAX_TRANSFORM_SOURCE_LENGTH = 2000;
const MAX_GALLERY_IMAGE_BYTES = 5 * 1024 * 1024;
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
const GEMINI_DEFAULT_MODEL = sharedConstants.geminiDefaultModel;
const GEMINI_DEFAULT_BASE_URL = sharedConstants.geminiDefaultBaseUrl;
const GEMINI_MAX_ATTEMPTS = sharedConstants.geminiMaxAttempts;
const GEMINI_RETRYABLE_STATUS = new Set(sharedConstants.geminiRetryableStatus);
const GEMINI_SYSTEM_INSTRUCTION = sharedConstants.systemInstruction;
const GEMINI_RESPONSE_SCHEMA = sharedConstants.responseSchema;
const GEMINI_STYLE_HINTS = sharedConstants.styleHints;

// Image generation retry policy — mirrors app/image_service.py. Retry transient
// failures (network / 5xx); 429 is surfaced immediately so the client honours retry_after.
const IMAGE_MAX_ATTEMPTS = 2;
const RETRYABLE_IMAGE_STATUS = new Set([500, 502, 503, 504]);
const IMAGE_RETRY_BACKOFF_MS = 500;
const MAX_BATCH_COUNT = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // Stream the body with a real byte counter. Trusting Content-Length lets a
  // client omit the header (or lie) and bypass the size cap entirely.
  if (!request.body) {
    throw new HttpError("請求格式錯誤", 400, "bad_request");
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new HttpError("請求內容太大", 413, "payload_too_large");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError("請求讀取失敗", 400, "bad_request");
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined));
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

// Optional edge rate limiting for /generate. Active only when a Cloudflare
// Rate Limiting binding named GENERATE_RATE_LIMITER is configured in wrangler.toml;
// otherwise this is a no-op so local dev and un-provisioned deploys keep working.
// Rate limiting must never fail the request itself, so any binding error is ignored.
async function checkRateLimit(request, limiter) {
  if (!limiter || typeof limiter.limit !== "function") return null;
  const key = request.headers.get("cf-connecting-ip") || "anonymous";
  let outcome;
  try {
    outcome = await limiter.limit({ key });
  } catch {
    return null;
  }
  if (outcome && outcome.success === false) {
    return json({ error: "叫用太頻繁，請稍後再試", code: "rate_limited", retry_after: 60 }, 429);
  }
  return null;
}

function httpErrorJson(e) {
  const body = { error: e.message, code: e.code };
  if (e.retry_after != null) body.retry_after = e.retry_after;
  return json(body, e.status);
}

// Generate ONE image. Returns a plain result object, or throws HttpError on a
// provider/validation failure. Shared by /generate and /generate/batch.
async function generateOneImage(env, { prompt, model, size, seed }) {
  const [width, height] = SIZE_MAP[size];
  const key = getNvidiaApiKey(env);
  if (!key) {
    return { image: makeDemoImageDataUrl(), provider: "demo", model, width, height, seed };
  }

  const base = (env.NVIDIA_BASE_URL || "https://ai.api.nvidia.com/v1/genai").replace(/\/+$/, "");
  const endpoint = `${base}/${MODEL_ENDPOINTS[model]}`;
  const body = { prompt, width, height, seed };
  if (model === "dev") {
    body.cfg_scale = 5;
    body.steps = 30;
  }

  let resp = null;
  let lastError = null;
  for (let attempt = 0; attempt < IMAGE_MAX_ATTEMPTS; attempt++) {
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
      resp = null;
      lastError = new HttpError(`NVIDIA 連線失敗：${e}`, 502, "network_error");
    }
    if (resp && !RETRYABLE_IMAGE_STATUS.has(resp.status)) {
      break;
    }
    if (resp) {
      let msg;
      try {
        const d = await resp.json();
        msg = d.error || d.message || `NVIDIA HTTP ${resp.status}`;
      } catch {
        msg = `NVIDIA HTTP ${resp.status}`;
      }
      lastError = new HttpError(msg, resp.status, "nvidia_error");
    }
    if (attempt + 1 >= IMAGE_MAX_ATTEMPTS) {
      throw lastError;
    }
    await sleep(IMAGE_RETRY_BACKOFF_MS * (attempt + 1));
  }

  if (resp.status === 429) {
    const ra = parseInt(resp.headers.get("retry-after") || "", 10);
    const err = new HttpError("叫用太頻繁，請稍後再試", 429, "rate_limited");
    if (!Number.isNaN(ra)) err.retry_after = Math.max(1, ra);
    throw err;
  }
  if (resp.status >= 400) {
    let msg;
    try {
      const d = await resp.json();
      msg = d.error || d.message || (d.detail ? `NVIDIA HTTP ${resp.status}: ${d.detail}` : `NVIDIA HTTP ${resp.status}`);
    } catch {
      msg = (await readLimitedText(resp, 300)) || `NVIDIA HTTP ${resp.status}`;
    }
    throw new HttpError(msg, resp.status, "nvidia_error");
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new HttpError("NVIDIA 回應格式不正確", 502, "bad_provider_response");
  }
  if (isContentFiltered(data)) {
    throw new HttpError("此描述觸發 NVIDIA 內容安全過濾，無法生成圖片，請換個描述再試", 422, "content_filtered");
  }
  const image = extractImage(data);
  return { image, provider: "nvidia", model, width, height, seed };
}

async function handleGenerate(request, env) {
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
  if (limited) return limited;

  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    throw e;
  }

  let prompt, model, size, seed;
  try {
    prompt = validatePrompt(payload.prompt);
    seed = validateSeed(payload.seed);
    model = payload.model || "schnell";
    if (!MODEL_ENDPOINTS[model]) throw new HttpError("不支援的模型", 400, "bad_request");
    size = payload.size || "square";
    if (!SIZE_MAP[size]) throw new HttpError("不支援的尺寸", 400, "bad_request");
  } catch (e) {
    if (e instanceof HttpError) return httpErrorJson(e);
    throw e;
  }

  try {
    const result = await generateOneImage(env, { prompt, model, size, seed });
    const galleryToken = await issueGalleryToken(env);
    return json(galleryToken ? { ...result, galleryToken } : result);
  } catch (e) {
    if (e instanceof HttpError) return httpErrorJson(e);
    throw e;
  }
}

function validateBatchCount(count) {
  if (count === undefined || count === null) return 1;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_BATCH_COUNT) {
    throw new HttpError(`count 必須是 1 到 ${MAX_BATCH_COUNT} 之間的整數`, 400, "bad_request");
  }
  return count;
}

function randomImageSeed() {
  return Math.floor(Math.random() * MAX_SEED) + 1;
}

async function handleGenerateBatch(request, env) {
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
  if (limited) return limited;

  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) return httpErrorJson(e);
    throw e;
  }

  let prompt, model, size, seed, count, hasExplicitSeed;
  try {
    prompt = validatePrompt(payload.prompt);
    seed = validateSeed(payload.seed);
    hasExplicitSeed = payload.seed !== undefined && payload.seed !== null && payload.seed !== "";
    model = payload.model || "schnell";
    if (!MODEL_ENDPOINTS[model]) throw new HttpError("不支援的模型", 400, "bad_request");
    size = payload.size || "square";
    if (!SIZE_MAP[size]) throw new HttpError("不支援的尺寸", 400, "bad_request");
    count = validateBatchCount(payload.count);
  } catch (e) {
    if (e instanceof HttpError) return httpErrorJson(e);
    throw e;
  }

  try {
    // The variations are independent network calls; run them concurrently so a
    // 4-image batch costs one round-trip of latency instead of four.
    const tasks = [];
    for (let index = 0; index < count; index++) {
      const variationSeed = index === 0 && hasExplicitSeed ? seed : randomImageSeed();
      tasks.push(generateOneImage(env, { prompt, model, size, seed: variationSeed }));
    }
    const images = await Promise.all(tasks);
    const galleryToken = await issueGalleryToken(env);
    return json(galleryToken ? { images, galleryToken } : { images });
  } catch (e) {
    if (e instanceof HttpError) return httpErrorJson(e);
    throw e;
  }
}

// --- Optional R2-backed cloud gallery ---
// Active only when an R2 bucket binding named IMAGE_BUCKET is configured in
// wrangler.toml; otherwise the endpoints return 503 so the app keeps working
// device-locally. Lets users persist a chosen image and fetch it from any device.
const GALLERY_PREFIX = "gallery/";
const GALLERY_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function decodeImageDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) throw new HttpError("image 必須是 base64 data URL", 400, "bad_request");
  const contentType = match[1];
  if (!GALLERY_EXT[contentType]) throw new HttpError("不支援的圖片格式", 400, "bad_request");
  // base64 expands the payload ~4/3; reject before allocating so a single POST
  // can't push an oversized object into R2 or burn Worker CPU decoding it.
  if (match[2].length > Math.ceil(MAX_GALLERY_IMAGE_BYTES * 4 / 3)) {
    throw new HttpError("圖片太大（上限 5MB）", 413, "payload_too_large");
  }
  let binary;
  try {
    binary = atob(match[2]);
  } catch {
    throw new HttpError("圖片資料格式不正確", 400, "bad_request");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { contentType, bytes };
}

function sanitizeGalleryMeta(meta) {
  const out = {};
  if (meta && typeof meta === "object") {
    for (const field of ["prompt", "model", "size", "seed"]) {
      if (meta[field] !== undefined && meta[field] !== null) {
        out[field] = String(meta[field]).slice(0, 500);
      }
    }
  }
  return out;
}

// --- Gallery save authorization (optional HMAC token) ---
// When env.GALLERY_TOKEN_SECRET is set, /generate(/batch) hand out a short-lived
// signed token that POST /gallery requires, so the cloud gallery can only be
// written to right after a real generation — not by anonymous bulk writers.
// Without the secret (local dev / tests) enforcement is disabled and saves stay open.
const GALLERY_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function issueGalleryToken(env) {
  const secret = env && env.GALLERY_TOKEN_SECRET;
  if (!secret) return undefined;
  const ts = Date.now().toString();
  return `${ts}.${await hmacHex(secret, ts)}`;
}

async function verifyGalleryToken(env, token) {
  const secret = env && env.GALLERY_TOKEN_SECRET;
  if (!secret) return true; // enforcement disabled
  if (typeof token !== "string" || token.indexOf(".") === -1) return false;
  const dot = token.indexOf(".");
  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const now = Date.now();
  if (now - tsNum > GALLERY_TOKEN_TTL_MS || tsNum > now + 60000) return false;
  const expected = await hmacHex(secret, ts);
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handleGallerySave(request, env) {
  const bucket = env.IMAGE_BUCKET;
  if (!bucket || typeof bucket.put !== "function") {
    return json({ error: "雲端圖庫尚未啟用", code: "gallery_disabled" }, 503);
  }
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
  if (limited) return limited;

  if (!(await verifyGalleryToken(env, request.headers.get("x-gallery-token")))) {
    return json({ error: "儲存授權無效或已過期，請重新生成圖片再儲存", code: "unauthorized" }, 401);
  }

  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) return httpErrorJson(e);
    throw e;
  }

  let decoded;
  try {
    decoded = decodeImageDataUrl(payload.image);
  } catch (e) {
    if (e instanceof HttpError) return httpErrorJson(e);
    throw e;
  }

  const id = `${crypto.randomUUID()}.${GALLERY_EXT[decoded.contentType]}`;
  await bucket.put(`${GALLERY_PREFIX}${id}`, decoded.bytes, {
    httpMetadata: { contentType: decoded.contentType },
    customMetadata: sanitizeGalleryMeta(payload.meta),
  });
  return json({ id, url: `/gallery/${id}` }, 201);
}

async function handleGalleryGet(env, id) {
  const bucket = env.IMAGE_BUCKET;
  if (!bucket || typeof bucket.get !== "function") {
    return json({ error: "雲端圖庫尚未啟用", code: "gallery_disabled" }, 503);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return json({ error: "找不到圖片", code: "not_found" }, 404);
  }
  const object = await bucket.get(`${GALLERY_PREFIX}${id}`);
  if (!object) {
    return json({ error: "找不到圖片", code: "not_found" }, 404);
  }
  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { status: 200, headers });
}

async function handlePromptTransform(request, env) {
  // Each call can hit the Gemini API (separate paid quota); throttle like /generate.
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
  if (limited) return limited;

  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    throw e;
  }

  const source = String(payload.source || "").trim();
  if (!source) return json({ error: "請先輸入白話描述", code: "bad_request" }, 400);
  if (source.length > MAX_TRANSFORM_SOURCE_LENGTH) {
    return json({ error: "描述太長", code: "bad_request" }, 400);
  }

  // LLM-first: try Gemini when a key is configured, then gracefully fall back.
  if (String((env && env.GEMINI_API_KEY) || "").trim()) {
    try {
      const resolvedStyle = resolveStyle(source, normalizeStyle(payload.style));
      const prompt = await geminiTransformPrompt(source, resolvedStyle, env);
      return json({ source, prompt, provider: "gemini", warnings: [] });
    } catch (geminiErr) {
      console.error(JSON.stringify({ event: "gemini_transform_failed", error: String(geminiErr) }));
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
    if (url.pathname === "/generate/batch" && request.method === "POST") {
      return handleGenerateBatch(request, env);
    }
    if (url.pathname === "/gallery" && request.method === "POST") {
      return handleGallerySave(request, env);
    }
    if (url.pathname.startsWith("/gallery/") && request.method === "GET") {
      let galleryId;
      try {
        galleryId = decodeURIComponent(url.pathname.slice("/gallery/".length));
      } catch {
        return json({ error: "找不到圖片", code: "not_found" }, 404);
      }
      return handleGalleryGet(env, galleryId);
    }
    if (url.pathname === "/client-error" && request.method === "POST") {
      return handleClientError(request);
    }
    // Anything else: static assets (index.html, /static/*).
    return env.ASSETS.fetch(request);
  },
};
