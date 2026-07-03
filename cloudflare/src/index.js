// Cloudflare Worker entry: serves the static SPA and routes the JSON API.
// Request handlers live here; pure helpers are split into sibling modules
// (constants / http / prompt / image / gallery). Mirrors the Python backend.
import { GALLERY_EXT, GALLERY_PREFIX, MAX_GALLERY_JSON_BYTES, MAX_TRANSFORM_SOURCE_LENGTH, MODEL_ENDPOINTS, SIZE_MAP } from "./constants.js";
import {
  HttpError,
  checkRateLimit,
  httpErrorJson,
  json,
  makeRequestId,
  readJsonPayload,
  sanitizeClientErrorReport,
} from "./http.js";
import { completePlainPrompt, enhancePrompt, geminiTransformPrompt, normalizeStyle, resolveStyle, transformPlainPrompt } from "./prompt.js";
import {
  generateOneImage,
  getNvidiaApiKey,
  randomImageSeed,
  validateBatchCount,
  validatePrompt,
  validateSeed,
} from "./image.js";
import { decodeImageDataUrl, issueGalleryToken, sanitizeGalleryMeta, verifyGalleryToken } from "./gallery.js";

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
    // The image travels as a base64 data URL, so this endpoint needs a much
    // larger JSON cap than the generic 64KB (which rejects every real image).
    payload = await readJsonPayload(request, MAX_GALLERY_JSON_BYTES);
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

async function handlePromptComplete(request, env) {
  // Gemma completion can consume paid quota; throttle like /prompt/transform.
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

  try {
    const result = await completePlainPrompt(source, payload.style, env);
    return json({
      source: result.source,
      prompt: result.prompt,
      provider: result.provider,
      warnings: result.warnings,
    });
  } catch (e) {
    if (e instanceof HttpError) return httpErrorJson(e);
    console.error(JSON.stringify({ event: "gemini_complete_failed", error: String(e) }));
    return json({ error: "Gemma 中文補全失敗，請稍後再試", code: "prompt_complete_failed" }, 502);
  }
}

async function handlePromptEnhance(request, env) {
  // Effect optimisation hits Gemini; throttle like /prompt/transform.
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
  if (limited) return limited;

  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    throw e;
  }

  try {
    const result = await enhancePrompt(payload.prompt, payload.effect, env);
    return json({ prompt: result.prompt, provider: result.provider, effect: result.effect });
  } catch (e) {
    if (e instanceof HttpError) return httpErrorJson(e);
    console.error(JSON.stringify({ event: "gemini_enhance_failed", error: String(e) }));
    return json({ error: "效果優化失敗，請稍後再試", code: "prompt_enhance_failed" }, 502);
  }
}

export { completePlainPrompt, enhancePrompt, transformPlainPrompt };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const providers = [];
      if (getNvidiaApiKey(env)) providers.push("nvidia");
      if (env.AI) providers.push("workers-ai");
      return json({ status: "ok", provider: providers[0] || "demo", providers });
    }
    if (url.pathname === "/prompt/transform" && request.method === "POST") {
      return handlePromptTransform(request, env);
    }
    if (url.pathname === "/prompt/complete" && request.method === "POST") {
      return handlePromptComplete(request, env);
    }
    if (url.pathname === "/prompt/enhance" && request.method === "POST") {
      return handlePromptEnhance(request, env);
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
