// Image generation: NVIDIA FLUX call with transient retry, provider-response
// image extraction, and request validators. Faithful port of app/image_service.py
// (incl. the CONTENT_FILTERED guard).
import {
  IMAGE_MAX_ATTEMPTS,
  IMAGE_RETRY_BACKOFF_MS,
  MAX_BATCH_COUNT,
  MAX_SEED,
  MODEL_ENDPOINTS,
  RETRYABLE_IMAGE_STATUS,
  SIZE_MAP,
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

// Generate ONE image. Returns a plain result object, or throws HttpError on a
// provider/validation failure. Shared by /generate and /generate/batch.
export async function generateOneImage(env, { prompt, model, size, seed }) {
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
