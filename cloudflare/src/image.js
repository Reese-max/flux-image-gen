// Image generation: NVIDIA FLUX call with transient retry, provider-response
// image extraction, and request validators. Faithful port of app/image_service.py
// (incl. the CONTENT_FILTERED guard).
import {
  IMAGE_FETCH_TIMEOUT_MS,
  IMAGE_MAX_ATTEMPTS,
  IMAGE_RETRY_BACKOFF_MS,
  MAX_BATCH_COUNT,
  MAX_SEED,
  MODEL_ENDPOINTS,
  RETRYABLE_IMAGE_STATUS,
  SIZE_MAP,
  WORKERS_AI_FAST_MODEL,
  sleep,
} from "./constants.js";
import { HttpError, readLimitedText } from "./http.js";

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

export function randomImageSeed() {
  return Math.floor(Math.random() * MAX_SEED) + 1;
}

// One AI.run attempt. The multipart body is a stream and cannot be replayed,
// so every retry must rebuild the form from scratch.
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
// Mirrors the NVIDIA path's availability contract: bounded wait + one retry.
async function generateWithWorkersAi(env, { prompt, model, width, height, seed }) {
  // UI contract: seed 0 (or blank) means "random variation". klein treats every
  // seed literally, so 0 would pin the output; substitute a real random seed
  // and return it for reproducibility.
  const effectiveSeed = seed === 0 ? randomImageSeed() : seed;

  let data;
  for (let attempt = 0; attempt < IMAGE_MAX_ATTEMPTS; attempt++) {
    // AI.run has no AbortSignal support, so race it against a clearable timer.
    // A lost run keeps executing in the background; the client still gets a
    // fast 504 instead of hanging until the edge kills the request.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error("workers ai timeout"), { name: "TimeoutError" })),
        IMAGE_FETCH_TIMEOUT_MS
      );
    });
    try {
      const run = runWorkersAiOnce(env, { prompt, width, height, seed: effectiveSeed });
      run.catch(() => {}); // the loser of the race must not become an unhandled rejection
      data = await Promise.race([run, timeout]);
      break;
    } catch (e) {
      // Details stay server-side; the client gets a stable, non-leaky message.
      console.error(`Workers AI 生圖失敗（attempt ${attempt + 1}/${IMAGE_MAX_ATTEMPTS}）`, e);
      const lastError =
        e && (e.name === "TimeoutError" || e.name === "AbortError")
          ? new HttpError("Workers AI 產圖逾時，請稍後再試", 504, "timeout")
          : new HttpError("Workers AI 生圖失敗，請稍後再試", 502, "workers_ai_error");
      if (attempt + 1 >= IMAGE_MAX_ATTEMPTS) throw lastError;
      await sleep(IMAGE_RETRY_BACKOFF_MS * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  const b64 = data && typeof data.image === "string" && data.image.trim() ? data.image.trim() : null;
  if (!b64) throw new HttpError("Workers AI 回應中找不到圖片資料", 502, "bad_provider_response");
  return {
    image: `data:${detectMimeFromBase64(b64)};base64,` + b64,
    provider: "workers-ai",
    model,
    width,
    height,
    seed: effectiveSeed,
  };
}

// Generate ONE image. Returns a plain result object, or throws HttpError on a
// provider/validation failure. Shared by /generate and /generate/batch.
export async function generateOneImage(env, { prompt, model, size, seed }) {
  const [width, height] = SIZE_MAP[size];
  if (model === "schnell" && env && env.AI && typeof env.AI.run === "function") {
    return generateWithWorkersAi(env, { prompt, model, width, height, seed });
  }
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
