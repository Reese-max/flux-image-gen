// Image generation: NVIDIA FLUX call with transient retry, provider-response
// image extraction, and request validators. Faithful port of app/image_service.py
// (incl. the CONTENT_FILTERED guard).
import {
  IMAGE_FETCH_TIMEOUT_MS,
  IMAGE_MAX_ATTEMPTS,
  IMAGE_RETRY_BACKOFF_MS,
  MAX_BATCH_COUNT,
  MAX_EDIT_IMAGES,
  MAX_EDIT_IMAGE_BYTES,
  MAX_SEED,
  MODEL_ENDPOINTS,
  RETRYABLE_IMAGE_STATUS,
  SIZE_MAP,
  WORKERS_AI_EDIT_MODEL,
  WORKERS_AI_FETCH_TIMEOUT_MS,
  WORKERS_AI_FAST_MODEL,
  sleep,
} from "./constants.js";
import { HttpError, readLimitedText } from "./http.js";

function withProviderAttempts(target, attempts) {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return target;
  Object.defineProperty(target, "providerAttempts", {
    value: Math.max(0, Math.round(Number(attempts) || 0)),
    configurable: true,
  });
  return target;
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

// Like detectMimeFromBase64 but returns null when the bytes are not a known
// image signature (or fail to decode). Used to gate the provider's direct
// { image } fast path so a non-image token isn't wrapped into a broken data URL
// and reported as success (mirrors Python's strict base64.b64decode + sniff).
function detectImageMimeStrict(b64) {
  let bytes;
  try {
    const bin = atob(b64.slice(0, 16));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return null;
}

// Sniff intrinsic pixel dimensions from an image header (PNG/GIF/JPEG). Returns
// { width, height } or null for formats we don't parse (fail open — CF handles).
// Used to enforce the FLUX.2 klein <512x512 input contract server-side, matching
// the Python backend's _resize_for_edit (the Worker runtime has no image lib).
function readImageDimensions(u8) {
  if (!u8 || u8.length < 24) return null;
  // PNG: 8-byte signature, then IHDR with width@16 / height@20 (big-endian).
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    const width = (u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19];
    const height = (u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23];
    return { width: width >>> 0, height: height >>> 0 };
  }
  // GIF: 'GIF8', then width@6 / height@8 (little-endian).
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) {
    return { width: u8[6] | (u8[7] << 8), height: u8[8] | (u8[9] << 8) };
  }
  // JPEG: FFD8, then walk marker segments to the SOF frame header.
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < u8.length) {
      if (u8[offset] !== 0xff) { offset++; continue; }
      const marker = u8[offset + 1];
      // SOF0..SOF15 carry the frame size, except DHT(C4)/JPG(C8)/DAC(CC) and RSTn/SOI/EOI.
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (u8[offset + 5] << 8) | u8[offset + 6];
        const width = (u8[offset + 7] << 8) | u8[offset + 8];
        return { width, height };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = (u8[offset + 2] << 8) | u8[offset + 3];
      if (segmentLength < 2) return null;
      offset += 2 + segmentLength;
    }
  }
  return null;
}

function decodeBase64ToBytes(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function inspectGeneratedImage(image, expectedWidth, expectedHeight) {
  const issues = [];
  let score = 100;
  const result = {
    checked: false,
    mime: null,
    byteSize: null,
    width: null,
    height: null,
    expectedWidth,
    expectedHeight,
    issues,
    visualQualityScore: score,
  };
  if (typeof image !== "string" || !image) {
    issues.push("圖片資料為空");
    result.visualQualityScore = 0;
    return result;
  }
  if (image.startsWith("http://") || image.startsWith("https://")) {
    issues.push("遠端圖片 URL 未做內嵌品質檢查");
    result.visualQualityScore = 82;
    return result;
  }
  const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) {
    issues.push("圖片格式不是可檢查的 data URL");
    result.visualQualityScore = 45;
    return result;
  }
  result.checked = true;
  result.mime = match[1];
  let bytes;
  try {
    bytes = decodeBase64ToBytes(match[2]);
  } catch {
    issues.push("圖片 base64 無法解碼");
    result.visualQualityScore = 20;
    return result;
  }
  result.byteSize = bytes.length;
  if (bytes.length < 256) {
    issues.push("圖片資料過小，可能是損壞或佔位圖");
    score -= 35;
  }
  const dims = readImageDimensions(bytes);
  if (dims) {
    result.width = dims.width;
    result.height = dims.height;
    if (dims.width !== expectedWidth || dims.height !== expectedHeight) {
      issues.push(`圖片實際尺寸 ${dims.width}×${dims.height} 與要求 ${expectedWidth}×${expectedHeight} 不一致`);
      score -= 18;
    }
  } else {
    issues.push("無法讀取圖片實際尺寸");
    score -= 15;
  }
  result.visualQualityScore = Math.max(0, Math.min(100, score));
  return result;
}

function extractImage(data, providerLabel = "NVIDIA") {
  const candidate = findImageCandidate(data);
  if (!candidate) throw new HttpError(`${providerLabel} 回應中找不到圖片資料`, 502, "bad_provider_response");
  if (candidate.startsWith("data:image/") || candidate.startsWith("http://") || candidate.startsWith("https://")) {
    return candidate;
  }
  return `data:${detectMimeFromBase64(candidate)};base64,` + candidate;
}

// Workers AI has no artifacts/finishReason on the error path; a flagged prompt
// surfaces as a thrown AiError whose message mentions the safety filter.
function isWorkersAiContentFilterError(e) {
  return /nsfw|content[ _-]?(safety|filter|moderat)|flagged/i.test(String((e && e.message) || e));
}

function makeDemoImageDataUrl() {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
}

export function getNvidiaApiKey(env) {
  return String((env && env.NVIDIA_API_KEY) || "").trim();
}

export function validatePrompt(prompt) {
  const cleaned = String(prompt || "").split(/\s+/).filter(Boolean).join(" ");
  if (!cleaned) throw new HttpError("請先輸入描述文字", 400, "bad_request");
  if (cleaned.length > 10000) throw new HttpError("描述文字太長，請縮短到 10000 字以內", 400, "bad_request");
  return cleaned;
}

export function validateSeed(seed) {
  if (seed === undefined || seed === null || seed === "") return 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new HttpError("seed 必須是 0 到 2147483647 之間的整數", 400, "bad_request");
  }
  return seed;
}

export function validateBatchCount(count) {
  if (count === undefined || count === null) return 1;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_BATCH_COUNT) {
    throw new HttpError(`count 必須是 1 到 ${MAX_BATCH_COUNT} 之間的整數`, 400, "bad_request");
  }
  return count;
}

export function validateCustomDimension(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 256 || n > 1920 || n % 64 !== 0) {
    throw new HttpError("自訂尺寸寬高必須是 256 到 1920 之間，且為 64 的倍數", 400, "bad_request");
  }
  return n;
}

export function randomImageSeed() {
  return Math.floor(Math.random() * MAX_SEED) + 1;
}

// One AI.run attempt. AI.run cannot be cancelled, so callers must not replay it.
function runWorkersAiOnce(env, { prompt, width, height, seed }) {
  // klein takes multipart form input even for a text-only prompt.
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(width));
  form.append("height", String(height));
  form.append("seed", String(seed));
  const formResponse = new Response(form);
  return env.AI.run(WORKERS_AI_FAST_MODEL, {
    multipart: {
      body: formResponse.body,
      contentType: formResponse.headers.get("content-type"),
    },
  });
}

// The "fast" tier runs on Workers AI (FLUX.2 klein 4B) — NVIDIA's hosted
// flux.1-schnell accepts requests but never responds (2026-07 outage).
// Kept behind an env.AI check so tests and AI-less deploys fall back to NVIDIA.
// The wait is bounded for the client, but the uncancellable provider run is never retried.
async function generateWithWorkersAi(env, { prompt, model, width, height, seed }) {
  // UI contract: seed 0 (or blank) means "random variation". klein treats every
  // seed literally, so 0 would pin the output; substitute a real random seed
  // and return it for reproducibility.
  const effectiveSeed = seed === 0 ? randomImageSeed() : seed;

  // AI.run cannot be cancelled. Retrying or crossing providers after it starts
  // can bill twice while the timed-out run keeps executing, so one request gets
  // exactly one Workers AI run.
  let data;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("workers ai timeout"), { name: "TimeoutError" })),
      WORKERS_AI_FETCH_TIMEOUT_MS
    );
  });
  try {
    const run = runWorkersAiOnce(env, { prompt, width, height, seed: effectiveSeed });
    run.catch(() => {}); // the loser of the race must not become an unhandled rejection
    data = await Promise.race([run, timeout]);
  } catch (e) {
    console.error("Workers AI 生圖失敗（attempt 1/1）", e);
    if (isWorkersAiContentFilterError(e)) {
      throw new HttpError("此描述觸發 Workers AI 內容安全過濾，無法生成圖片，請換個描述再試", 422, "content_filtered");
    }
    throw e && (e.name === "TimeoutError" || e.name === "AbortError")
      ? new HttpError("Workers AI 產圖逾時，請稍後再試", 504, "timeout")
      : new HttpError("Workers AI 生圖失敗，請稍後再試", 502, "workers_ai_error");
  } finally {
    clearTimeout(timer);
  }

  if (isContentFiltered(data)) {
    throw new HttpError("此描述觸發 Workers AI 內容安全過濾，無法生成圖片，請換個描述再試", 422, "content_filtered");
  }
  // Documented binding shape is { image: "<base64>" }; short images fail the
  // shared length heuristic, so keep this direct path before extractImage.
  const direct = data && typeof data.image === "string" ? data.image.trim() : "";
  const directMime = direct && isValidBase64(direct) ? detectImageMimeStrict(direct) : null;
  const image = directMime ? `data:${directMime};base64,` + direct : extractImage(data, "Workers AI");
  return {
    image,
    provider: "workers-ai",
    model,
    width,
    height,
    seed: effectiveSeed,
    imageQuality: inspectGeneratedImage(image, width, height),
  };
}

async function generateWithNvidia(env, { prompt, model, width, height, seed }, { provider = "nvidia" } = {}) {
  const key = getNvidiaApiKey(env);
  const base = (env.NVIDIA_BASE_URL || "https://ai.api.nvidia.com/v1/genai").replace(/\/+$/, "");
  const endpoint = `${base}/${MODEL_ENDPOINTS[model]}`;
  const body = { prompt, width, height, seed };
  if (model === "dev") {
    body.cfg_scale = 5;
    body.steps = 30;
  }

  let resp = null;
  let lastError = null;
  let providerAttempts = 0;
  for (let attempt = 0; attempt < IMAGE_MAX_ATTEMPTS; attempt++) {
    try {
      providerAttempts += 1;
      resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      resp = null;
      lastError =
        e && (e.name === "TimeoutError" || e.name === "AbortError")
          ? new HttpError("NVIDIA 產圖逾時，請稍後再試", 504, "timeout")
          : new HttpError(`NVIDIA 連線失敗：${e}`, 502, "network_error");
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
      throw withProviderAttempts(lastError, providerAttempts);
    }
    await sleep(IMAGE_RETRY_BACKOFF_MS * (attempt + 1));
  }

  if (resp.status === 429) {
    const ra = parseInt(resp.headers.get("retry-after") || "", 10);
    const err = new HttpError("叫用太頻繁，請稍後再試", 429, "rate_limited");
    if (!Number.isNaN(ra)) err.retry_after = Math.max(1, ra);
    throw withProviderAttempts(err, providerAttempts);
  }
  if (resp.status >= 400) {
    // Read the body ONCE as text, then try JSON. resp.json() followed by another
    // body read throws "body already used" and turned NVIDIA errors into 1101s.
    let msg = `NVIDIA HTTP ${resp.status}`;
    let raw = "";
    try {
      raw = (await readLimitedText(resp, 300)).trim();
    } catch {
      // keep the generic message
    }
    if (raw) {
      try {
        const d = JSON.parse(raw);
        msg = d.error || d.message || (d.detail ? `NVIDIA HTTP ${resp.status}: ${d.detail}` : msg);
      } catch {
        msg = raw;
      }
    }
    throw withProviderAttempts(new HttpError(msg, resp.status, "nvidia_error"), providerAttempts);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw withProviderAttempts(new HttpError("NVIDIA 回應格式不正確", 502, "bad_provider_response"), providerAttempts);
  }
  if (isContentFiltered(data)) {
    throw withProviderAttempts(
      new HttpError("此描述觸發 NVIDIA 內容安全過濾，無法生成圖片，請換個描述再試", 422, "content_filtered"),
      providerAttempts
    );
  }
  let image;
  try {
    image = extractImage(data);
  } catch (error) {
    throw withProviderAttempts(error, providerAttempts);
  }
  return withProviderAttempts(
    { image, provider, model, width, height, seed, imageQuality: inspectGeneratedImage(image, width, height) },
    providerAttempts
  );
}

// Generate ONE image. Returns a plain result object, or throws HttpError on a
// provider/validation failure. Shared by /generate and /generate/batch.
export async function generateOneImage(env, { prompt, model, size, width, height, seed }) {
  if (size === "custom") {
    width = validateCustomDimension(width);
    height = validateCustomDimension(height);
  } else {
    [width, height] = SIZE_MAP[size];
  }
  if (model === "schnell" && env && env.AI && typeof env.AI.run === "function") {
    return generateWithWorkersAi(env, { prompt, model, width, height, seed });
  }
  const key = getNvidiaApiKey(env);
  if (!key) {
    const image = makeDemoImageDataUrl();
    return { image, provider: "demo", model, width, height, seed, imageQuality: inspectGeneratedImage(image, width, height) };
  }
  if (model === "schnell") {
    return generateWithNvidia(env, { prompt, model: "dev", width, height, seed });
  }
  return generateWithNvidia(env, { prompt, model, width, height, seed });
}

export function validateEditImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_EDIT_IMAGES) {
    throw new HttpError(`請上傳 1 到 ${MAX_EDIT_IMAGES} 張圖片`, 400, "bad_request");
  }
  for (const img of images) {
    if (!img || typeof img.size !== "number" || img.size <= 0) {
      throw new HttpError("上傳的圖片是空的或格式錯誤", 400, "bad_request");
    }
    if (img.size > MAX_EDIT_IMAGE_BYTES) {
      throw new HttpError(`單張圖片不可超過 ${Math.floor(MAX_EDIT_IMAGE_BYTES / (1024 * 1024))}MB`, 400, "bad_request");
    }
  }
  return images;
}

// AI 改圖：把 1-4 張使用者上傳圖 + 文字指令送到 Workers AI FLUX.2 klein
// (multipart input_image_0..3)。前端已把每張縮到 < 512x512。回 { image: base64 }。
export async function editImage(env, { prompt, images }) {
  if (!env || !env.AI || typeof env.AI.run !== "function") {
    throw new HttpError("AI 改圖尚未啟用（缺少 Workers AI 綁定）", 503, "missing_api_key");
  }
  validateEditImages(images);

  // Enforce the FLUX.2 klein <512x512 input contract server-side (parity with the
  // Python backend's _resize_for_edit), so a non-browser caller that skipped the
  // client-side canvas resize can't relay oversized images. Unknown formats fail
  // open (CF handles them). Checked once, before the provider call.
  for (const blob of images) {
    const dims = readImageDimensions(new Uint8Array(await blob.arrayBuffer()));
    if (dims && (dims.width >= 512 || dims.height >= 512)) {
      throw new HttpError("單張圖片尺寸須小於 512x512，請先縮圖再上傳", 400, "bad_request");
    }
  }

  let data;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("workers ai timeout"), { name: "TimeoutError" })),
      IMAGE_FETCH_TIMEOUT_MS
    );
  });
  try {
    const form = new FormData();
    form.append("prompt", prompt);
    images.forEach((blob, i) => form.append(`input_image_${i}`, blob, `input_image_${i}.png`));
    const formResponse = new Response(form);
    const run = env.AI.run(WORKERS_AI_EDIT_MODEL, {
      multipart: { body: formResponse.body, contentType: formResponse.headers.get("content-type") },
    });
    run.catch(() => {}); // the loser of the race must not become an unhandled rejection
    data = await Promise.race([run, timeout]);
  } catch (e) {
    console.error("Workers AI 改圖失敗（attempt 1/1）", e);
    if (isWorkersAiContentFilterError(e)) {
      throw new HttpError("此描述或圖片觸發 Workers AI 內容安全過濾，請換個描述或圖片再試", 422, "content_filtered");
    }
    throw e && (e.name === "TimeoutError" || e.name === "AbortError")
      ? new HttpError("AI 改圖逾時，請稍後再試", 504, "timeout")
      : new HttpError("AI 改圖失敗，請稍後再試", 502, "workers_ai_error");
  } finally {
    clearTimeout(timer);
  }

  const direct = data && typeof data.image === "string" ? data.image.trim() : "";
  const directMime = direct && isValidBase64(direct) ? detectImageMimeStrict(direct) : null;
  const image = directMime ? `data:${directMime};base64,` + direct : extractImage(data, "Workers AI");
  return { image, provider: "workers-ai", model: WORKERS_AI_EDIT_MODEL, image_count: images.length };
}
