// Cloudflare Worker entry: serves the static SPA and routes the JSON API.
// Request handlers live here; pure helpers are split into sibling modules
// (constants / http / prompt / image / gallery). Mirrors the Python backend.
import { GALLERY_EXT, GALLERY_META_PREFIX, GALLERY_PREFIX, GEMINI_COMPLETE_DEFAULT_MODEL, GEMINI_DEFAULT_MODEL, MAX_ENHANCE_EFFECT_LENGTH, MAX_ENHANCE_PROMPT_LENGTH, MAX_GALLERY_JSON_BYTES, MAX_TRANSFORM_SOURCE_LENGTH, MODEL_ENDPOINTS, SIZE_MAP, WORKERS_AI_EDIT_MODEL } from "./constants.js";
import {
  HttpError,
  checkRateLimit,
  httpErrorJson,
  json,
  makeRequestId,
  readJsonPayload,
  sanitizeClientErrorReport,
  turnstileConfig,
  verifyTurnstileToken,
} from "./http.js";
import { completePlainPrompt, enhancePrompt, geminiTransformPrompt, normalizeStyle, resolveStyle, transformPlainPrompt } from "./prompt.js";
import { assertPromptAllowedForGeneration } from "./moderation.js";
import {
  editImage,
  generateOneImage,
  getNvidiaApiKey,
  randomImageSeed,
  validateBatchCount,
  validateCustomDimension,
  validateEditImages,
  validateCfgScale,
  validatePrompt,
  validateSeed,
  validateSteps,
} from "./image.js";
import { decodeImageDataUrl, hashGalleryDeleteToken, issueGalleryDeleteToken, issueGalleryToken, sanitizeGalleryMeta, verifyGalleryDeleteTokenHash, verifyGalleryToken } from "./gallery.js";
import { buildUsageSummary, recordUsageEvent, resetUsageMetrics } from "./usage.js";
import { maybeRunVisionQa } from "./vision.js";

function elapsedMs(started) {
  return Math.max(0, Math.round(Date.now() - started));
}

function generationUsageTarget(env, model) {
  if (model === "schnell" && env && env.AI && typeof env.AI.run === "function") {
    return { provider: "workers-ai", model };
  }
  if (getNvidiaApiKey(env)) {
    return { provider: "nvidia", model: model === "schnell" ? "dev" : model };
  }
  return { provider: "demo", model };
}

function providerAttemptCount(source, fallback = 0) {
  const raw = source && source.providerAttempts;
  const parsed = Number(raw == null ? fallback : raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : Math.max(0, fallback);
}

function promptUsageTarget(env, route, provider, attempts = 0) {
  const hasGemini = Boolean(String((env && env.GEMINI_API_KEY) || "").trim());
  const attemptedGemini = hasGemini && (provider === "gemini" || provider === "rule_based");
  const usageProvider = attemptedGemini && provider === "rule_based" ? "gemini-fallback" : provider;
  const model = usageProvider && usageProvider.startsWith("gemini")
    ? route === "prompt_complete"
      ? String((env && env.GEMINI_COMPLETE_MODEL) || GEMINI_COMPLETE_DEFAULT_MODEL)
      : String((env && env.GEMINI_PROMPT_MODEL) || GEMINI_DEFAULT_MODEL)
    : usageProvider === "rule_based" ? "rule-based" : "unknown";
  return {
    provider: usageProvider || "unknown",
    model,
    attempt: attemptedGemini ? Math.max(0, Math.round(Number(attempts) || 0)) : 0,
  };
}

async function recordPromptEvent(env, request, route, started, event) {
  await recordUsageEvent(env, request, {
    route,
    durationMs: elapsedMs(started),
    ...event,
  });
}

async function recordVisionQaEvent(env, request, started, visionQa) {
  if (!visionQa) return;
  await recordUsageEvent(env, request, {
    route: "vision_qa",
    outcome: visionQa.available ? "success" : "error",
    statusCode: visionQa.available ? 200 : 503,
    errorCode: visionQa.available ? "" : (visionQa.code || "vision_qa_failed"),
    provider: "gemini",
    model: String((env && env.GEMINI_VISION_MODEL) || "gemini-2.5-flash"),
    durationMs: elapsedMs(started),
    attempt: providerAttemptCount(visionQa),
  });
}

function constantTimeStringEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function buildHealthResponse(env) {
  const hasNvidia = Boolean(getNvidiaApiKey(env));
  const hasWorkersAI = Boolean(env.AI);
  const storageAvailable = Boolean(env.IMAGE_BUCKET && typeof env.IMAGE_BUCKET.put === "function");
  const versionId = env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id
    ? String(env.CF_VERSION_METADATA.id)
    : "";
  const versionTag = env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.tag
    ? String(env.CF_VERSION_METADATA.tag)
    : "";
  const versionTimestamp = env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.timestamp
    ? String(env.CF_VERSION_METADATA.timestamp)
    : "";
  let providerStatus = "demo";
  let mode = "demo";
  let message = "Demo 模式，不會真實出圖";

  if (hasNvidia || hasWorkersAI) {
    providerStatus = hasNvidia && hasWorkersAI ? "ready" : "degraded";
    mode = "live";
    message = providerStatus === "ready" ? "真實出圖可用" : "部分服務可用";
  }

  return {
    status: "ok",
    provider: hasNvidia ? "nvidia" : (hasWorkersAI ? "workers-ai" : "demo"),
    providerStatus,
    mode,
    providers: {
      nvidia: hasNvidia,
      workersAI: hasWorkersAI,
    },
    providerList: [
      ...(hasNvidia ? ["nvidia"] : []),
      ...(hasWorkersAI ? ["workers-ai"] : []),
    ],
    hasApiKey: hasNvidia || hasWorkersAI,
    storageAvailable,
    visionQa: String((env && env.VISION_QA_ENABLED) || "").trim().toLowerCase() === "true",
    turnstile: turnstileConfig(env),
    message,
    checkedAt: new Date().toISOString(),
    ...(versionId ? { versionId } : {}),
    ...(versionTag ? { versionTag } : {}),
    ...(versionTimestamp ? { versionTimestamp } : {}),
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

async function handleGenerate(request, env) {
  const started = Date.now();
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER, env);
  if (limited) {
    await recordUsageEvent(env, request, {
      route: "generate",
      outcome: "error",
      statusCode: 429,
      errorCode: "rate_limited",
      durationMs: elapsedMs(started),
    });
    return limited;
  }

  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordUsageEvent(env, request, {
        route: "generate",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        durationMs: elapsedMs(started),
      });
      return json({ error: e.message, code: e.code }, e.status);
    }
    throw e;
  }

  try {
    assertPromptAllowedForGeneration(payload.prompt, payload.userPrompt);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordUsageEvent(env, request, {
        route: "generate",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        provider: "blocked",
        model: payload.model || "unknown",
        durationMs: elapsedMs(started),
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  const turnstileError = await verifyTurnstileToken(payload.turnstileToken, request, env);
  if (turnstileError) {
    await recordUsageEvent(env, request, {
      route: "generate",
      outcome: "error",
      statusCode: turnstileError.status,
      errorCode: turnstileError.code,
      model: payload.model || "unknown",
      durationMs: elapsedMs(started),
    });
    return httpErrorJson(turnstileError);
  }

  let prompt, model, size, seed, width, height, steps, cfgScale;
  try {
    prompt = validatePrompt(payload.prompt);
    seed = validateSeed(payload.seed);
    model = payload.model || "schnell";
    if (!MODEL_ENDPOINTS[model]) throw new HttpError("不支援的模型", 400, "bad_request");
    size = payload.size || "square";
    if (size !== "custom" && !SIZE_MAP[size]) throw new HttpError("不支援的尺寸", 400, "bad_request");
    width = size === "custom" ? validateCustomDimension(payload.width) : payload.width;
    height = size === "custom" ? validateCustomDimension(payload.height) : payload.height;
    steps = validateSteps(payload.steps);
    cfgScale = validateCfgScale(payload.cfgScale);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordUsageEvent(env, request, {
        route: "generate",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        model: payload.model || "unknown",
        durationMs: elapsedMs(started),
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  try {
    const result = await generateOneImage(env, { prompt, model, size, width, height, seed, steps, cfgScale });
    // Persist the billable image immediately. Optional QA must never hide a
    // completed provider call or make the client retry the generation.
    await recordUsageEvent(env, request, {
      route: "generate",
      outcome: "success",
      statusCode: 200,
      provider: result.provider,
      model: result.model,
      imageCount: 1,
      durationMs: elapsedMs(started),
      attempt: providerAttemptCount(result, result.provider === "demo" ? 0 : 1),
    });
    if (payload.visionQa) {
      const qaStarted = Date.now();
      const visionQa = await maybeRunVisionQa(result.image, prompt, env);
      await recordVisionQaEvent(env, request, qaStarted, visionQa);
      if (visionQa) result.visionQa = visionQa;
    }
    const galleryToken = await issueGalleryToken(env);
    return json(galleryToken ? { ...result, galleryToken } : result);
  } catch (e) {
    if (e instanceof HttpError) {
      const target = generationUsageTarget(env, model);
      const fallbackAttempts = e.code !== "bad_request" && e.code !== "missing_api_key" && target.provider !== "demo" ? 1 : 0;
      const attempts = providerAttemptCount(e, fallbackAttempts);
      await recordUsageEvent(env, request, {
        route: "generate",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        provider: attempts > 0 ? target.provider : "unknown",
        model: target.model,
        durationMs: elapsedMs(started),
        attempt: attempts,
      });
      return httpErrorJson(e);
    }
    throw e;
  }
}

async function handleGenerateBatch(request, env) {
  const started = Date.now();
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER, env);
  if (limited) {
    await recordUsageEvent(env, request, {
      route: "generate_batch",
      outcome: "error",
      statusCode: 429,
      errorCode: "rate_limited",
      durationMs: elapsedMs(started),
    });
    return limited;
  }

  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordUsageEvent(env, request, {
        route: "generate_batch",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        durationMs: elapsedMs(started),
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  try {
    assertPromptAllowedForGeneration(payload.prompt, payload.userPrompt);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordUsageEvent(env, request, {
        route: "generate_batch",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        provider: "blocked",
        model: payload.model || "unknown",
        durationMs: elapsedMs(started),
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  const turnstileError = await verifyTurnstileToken(payload.turnstileToken, request, env);
  if (turnstileError) {
    await recordUsageEvent(env, request, {
      route: "generate_batch",
      outcome: "error",
      statusCode: turnstileError.status,
      errorCode: turnstileError.code,
      model: payload.model || "unknown",
      durationMs: elapsedMs(started),
    });
    return httpErrorJson(turnstileError);
  }

  let prompt, model, size, seed, count, hasExplicitSeed, width, height, steps, cfgScale;
  try {
    prompt = validatePrompt(payload.prompt);
    seed = validateSeed(payload.seed);
    hasExplicitSeed = payload.seed !== undefined && payload.seed !== null && payload.seed !== "";
    model = payload.model || "schnell";
    if (!MODEL_ENDPOINTS[model]) throw new HttpError("不支援的模型", 400, "bad_request");
    size = payload.size || "square";
    if (size !== "custom" && !SIZE_MAP[size]) throw new HttpError("不支援的尺寸", 400, "bad_request");
    width = size === "custom" ? validateCustomDimension(payload.width) : payload.width;
    height = size === "custom" ? validateCustomDimension(payload.height) : payload.height;
    count = validateBatchCount(payload.count);
    steps = validateSteps(payload.steps);
    cfgScale = validateCfgScale(payload.cfgScale);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordUsageEvent(env, request, {
        route: "generate_batch",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        model: payload.model || "unknown",
        durationMs: elapsedMs(started),
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  try {
    // The variations are independent network calls; run them concurrently so a
    // 4-image batch costs one round-trip of latency instead of four.
    const tasks = [];
    for (let index = 0; index < count; index++) {
      const variationSeed = index === 0 && hasExplicitSeed ? seed : randomImageSeed();
      tasks.push(generateOneImage(env, { prompt, model, size, width, height, seed: variationSeed, steps, cfgScale }));
    }
    const settled = await Promise.allSettled(tasks);
    const images = [];
    const errors = [];
    const target = generationUsageTarget(env, model);
    for (let index = 0; index < settled.length; index++) {
      const item = settled[index];
      if (item.status === "fulfilled") {
        images.push(item.value);
        await recordUsageEvent(env, request, {
          route: "generate_batch",
          outcome: "success",
          statusCode: 200,
          provider: item.value.provider,
          model: item.value.model,
          imageCount: 1,
          durationMs: elapsedMs(started),
          attempt: providerAttemptCount(item.value, item.value.provider === "demo" ? 0 : 1),
          batchIndex: index,
        });
      } else {
        const error = item.reason instanceof HttpError
          ? item.reason
          : new HttpError("圖片生成失敗，請稍後再試", 502, "generation_failed");
        const fallbackAttempts = error.code !== "bad_request" && error.code !== "missing_api_key" && target.provider !== "demo" ? 1 : 0;
        const attempts = providerAttemptCount(error, fallbackAttempts);
        errors.push({ index, error: error.message, code: error.code, status: error.status });
        await recordUsageEvent(env, request, {
          route: "generate_batch",
          outcome: "error",
          statusCode: error.status,
          errorCode: error.code,
          provider: attempts > 0 ? target.provider : "unknown",
          model: target.model,
          durationMs: elapsedMs(started),
          attempt: attempts,
          batchIndex: index,
        });
      }
    }
    if (!images.length) {
      const first = settled[0] && settled[0].status === "rejected" && settled[0].reason instanceof HttpError
        ? settled[0].reason
        : new HttpError("圖片生成失敗，請稍後再試", 502, "generation_failed");
      return httpErrorJson(first);
    }
    if (payload.visionQa) {
      for (const image of images) {
        const qaStarted = Date.now();
        const visionQa = await maybeRunVisionQa(image.image, prompt, env);
        await recordVisionQaEvent(env, request, qaStarted, visionQa);
        if (visionQa) image.visionQa = visionQa;
      }
    }
    const galleryToken = await issueGalleryToken(env);
    const response = { images, errors, partial: errors.length > 0 };
    return json(galleryToken ? { ...response, galleryToken } : response);
  } catch (e) {
    if (e instanceof HttpError) {
      return httpErrorJson(e);
    }
    throw e;
  }
}

async function handleEdit(request, env) {
  const started = Date.now();
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER, env);
  if (limited) {
    await recordUsageEvent(env, request, {
      route: "edit",
      outcome: "error",
      statusCode: 429,
      errorCode: "rate_limited",
      durationMs: elapsedMs(started),
    });
    return limited;
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    await recordUsageEvent(env, request, {
      route: "edit",
      outcome: "error",
      statusCode: 400,
      errorCode: "bad_request",
      durationMs: elapsedMs(started),
    });
    return json({ error: "上傳格式錯誤，請用 multipart/form-data", code: "bad_request" }, 400);
  }

  try {
    assertPromptAllowedForGeneration(form.get("prompt"));
  } catch (e) {
    if (e instanceof HttpError) {
      await recordUsageEvent(env, request, {
        route: "edit",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        provider: "blocked",
        model: "edit",
        durationMs: elapsedMs(started),
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  const turnstileError = await verifyTurnstileToken(form.get("turnstileToken"), request, env);
  if (turnstileError) {
    await recordUsageEvent(env, request, {
      route: "edit",
      outcome: "error",
      statusCode: turnstileError.status,
      errorCode: turnstileError.code,
      model: "edit",
      durationMs: elapsedMs(started),
    });
    return httpErrorJson(turnstileError);
  }

  let prompt, images;
  try {
    prompt = validatePrompt(form.get("prompt"));
    // Only keep real uploaded files (Blob-like with arrayBuffer); ignore stray text parts.
    images = form.getAll("images").filter((f) => f && typeof f.arrayBuffer === "function");
    validateEditImages(images);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordUsageEvent(env, request, {
        route: "edit",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        model: "edit",
        durationMs: elapsedMs(started),
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  try {
    const result = await editImage(env, { prompt, images });
    await recordUsageEvent(env, request, {
      route: "edit",
      outcome: "success",
      statusCode: 200,
      provider: result.provider,
      model: result.model,
      imageCount: 1,
      durationMs: elapsedMs(started),
      attempt: 1,
    });
    return json(result);
  } catch (e) {
    if (e instanceof HttpError) {
      const providerStarted = e.code !== "bad_request" && e.code !== "missing_api_key";
      await recordUsageEvent(env, request, {
        route: "edit",
        outcome: "error",
        statusCode: e.status,
        errorCode: e.code,
        provider: providerStarted ? "workers-ai" : "unknown",
        model: WORKERS_AI_EDIT_MODEL,
        durationMs: elapsedMs(started),
        attempt: providerStarted ? 1 : 0,
      });
      return httpErrorJson(e);
    }
    throw e;
  }
}

async function handleGallerySave(request, env) {
  const bucket = env.IMAGE_BUCKET;
  if (!bucket || typeof bucket.put !== "function") {
    return json({ error: "雲端圖庫尚未啟用", code: "gallery_disabled" }, 503);
  }
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER, env);
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
  const meta = sanitizeGalleryMeta(payload.meta);
  const deleteToken = issueGalleryDeleteToken();
  const deleteTokenHash = await hashGalleryDeleteToken(deleteToken);
  await bucket.put(`${GALLERY_PREFIX}${id}`, decoded.bytes, {
    httpMetadata: { contentType: decoded.contentType },
    customMetadata: {
      visibility: meta.visibility,
      promptPublic: meta.promptPublic,
      metadataKey: `${GALLERY_META_PREFIX}${id}.json`,
    },
  });
  await bucket.put(`${GALLERY_META_PREFIX}${id}.json`, JSON.stringify({
    id,
    imageKey: `${GALLERY_PREFIX}${id}`,
    visibility: meta.visibility,
    promptPublic: meta.promptPublic === "true",
    metadata: meta,
    deleteTokenHash,
    createdAt: new Date().toISOString(),
  }), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return json({
    id,
    url: `/gallery/${id}`,
    shareUrl: `/share/${id}`,
    deleteUrl: `/gallery/${id}/delete?deleteToken=${encodeURIComponent(deleteToken)}`,
    visibility: meta.visibility,
    promptPublic: meta.promptPublic === "true",
    storage: {
      image: "R2",
      metadata: "R2 JSON",
    },
  }, 201);
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

function requireGalleryAdmin(request, env, scope = "gallery") {
  const expected = env && env.GALLERY_ADMIN_TOKEN;
  const provided = request.headers.get("x-gallery-admin-token") || "";
  if (!expected) {
    return scope === "usage"
      ? json({ error: "站長用量查詢尚未啟用", code: "admin_usage_disabled" }, 503)
      : json({ error: "站長雲端圖庫列表尚未啟用", code: "admin_gallery_disabled" }, 503);
  }
  if (!constantTimeStringEqual(provided, expected)) {
    return json({ error: "站長圖庫授權無效", code: "unauthorized" }, 401);
  }
  return null;
}

async function readGalleryMetaObject(bucket, key) {
  const metaObject = await bucket.get(key);
  let payload = {};
  let id = key.slice(GALLERY_META_PREFIX.length).replace(/\.json$/, "");
  let metadata = {};
  if (!metaObject) { return null; }
  try {
    payload = JSON.parse(await new Response(metaObject.body).text());
  } catch {
    payload = {};
  }
  if (payload && typeof payload.id === "string") { id = payload.id; }
  if (payload && payload.metadata && typeof payload.metadata === "object") { metadata = payload.metadata; }
  return {
    id,
    imageUrl: `/gallery/${encodeURIComponent(id)}`,
    shareUrl: `/share/${encodeURIComponent(id)}`,
    visibility: payload.visibility === "public" ? "public" : "unlisted",
    promptPublic: payload.promptPublic === true,
    title: String(metadata.title || "Fluxi 雲端作品"),
    model: String(metadata.model || ""),
    size: String(metadata.size || ""),
    seed: String(metadata.seed || ""),
    mode: String(metadata.mode || "normal"),
    styleLabel: String(metadata.styleLabel || metadata.style || ""),
    useCaseLabel: String(metadata.useCaseLabel || metadata.useCase || ""),
    createdAt: String(payload.createdAt || ""),
    storage: {
      image: String(metadata.storage || "r2"),
      metadata: String(metadata.metadataStorage || "r2-json"),
    },
  };
}

async function handleGalleryAdminList(request, env) {
  const authError = requireGalleryAdmin(request, env);
  if (authError) return authError;
  const bucket = env.IMAGE_BUCKET;
  if (!bucket || typeof bucket.list !== "function" || typeof bucket.get !== "function") {
    return json({ error: "雲端圖庫列表需要 R2 list/get 綁定", code: "gallery_disabled" }, 503);
  }
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 50;
  const cursor = url.searchParams.get("cursor") || undefined;
  const listed = await bucket.list({ prefix: GALLERY_META_PREFIX, limit, cursor });
  const objects = Array.isArray(listed.objects) ? listed.objects : [];
  const items = [];
  for (const object of objects) {
    if (!object || typeof object.key !== "string" || !object.key.endsWith(".json")) continue;
    const item = await readGalleryMetaObject(bucket, object.key);
    if (item) items.push(item);
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
  return json({
    items,
    count: items.length,
    truncated: listed.truncated === true,
    cursor: listed.cursor || "",
    checkedAt: new Date().toISOString(),
  });
}

async function handleGalleryDelete(request, env, id) {
  const bucket = env.IMAGE_BUCKET;
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.delete !== "function") {
    return json({ error: "雲端圖庫尚未啟用", code: "gallery_disabled" }, 503);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return json({ error: "找不到圖片", code: "not_found" }, 404);
  }
  const metaKey = `${GALLERY_META_PREFIX}${id}.json`;
  const metaObject = await bucket.get(metaKey);
  if (!metaObject) {
    return json({ error: "找不到圖片", code: "not_found" }, 404);
  }

  let payload = {};
  try {
    payload = JSON.parse(await readR2Text(metaObject));
  } catch {
    payload = {};
  }
  const token = request.headers.get("x-gallery-delete-token") || new URL(request.url).searchParams.get("deleteToken") || "";
  if (!(await verifyGalleryDeleteTokenHash(payload.deleteTokenHash, token))) {
    return json({ error: "刪除授權無效，請使用儲存時提供的刪除連結", code: "unauthorized" }, 401);
  }

  const imageKey = typeof payload.imageKey === "string" ? payload.imageKey : `${GALLERY_PREFIX}${id}`;
  await bucket.delete(imageKey);
  await bucket.delete(metaKey);
  return json({ ok: true, deleted: true, id });
}

async function handleGalleryDeletePage(env, id, token) {
  const bucket = env.IMAGE_BUCKET;
  if (!bucket || typeof bucket.get !== "function") {
    return new Response("<!doctype html><title>雲端刪除尚未啟用</title><p>雲端圖庫尚未啟用。</p>", {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return new Response("<!doctype html><title>找不到作品</title><p>找不到作品。</p>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const metaObject = await bucket.get(`${GALLERY_META_PREFIX}${id}.json`);
  if (!metaObject) {
    return new Response("<!doctype html><title>找不到作品</title><p>找不到作品。</p>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readR2Text(metaObject));
  } catch {
    payload = {};
  }
  if (!(await verifyGalleryDeleteTokenHash(payload.deleteTokenHash, token || ""))) {
    return new Response("<!doctype html><title>刪除授權無效</title><p>刪除授權無效，請使用儲存時提供的刪除連結。</p>", {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const metadata = payload && payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const title = String(metadata.title || "Fluxi 雲端作品");
  const imageUrl = `/gallery/${encodeURIComponent(id)}`;
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>刪除雲端作品｜Fluxi</title>
  <style>body{margin:0;padding:32px;background:#0a0b0f;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:720px;margin:0 auto;display:grid;gap:18px}.card{border:1px solid rgba(248,113,113,.35);border-radius:20px;background:rgba(127,29,29,.18);padding:18px}img{max-width:100%;border-radius:18px;border:1px solid rgba(255,255,255,.14)}button,.button{border:1px solid rgba(248,113,113,.55);border-radius:999px;background:rgba(248,113,113,.14);color:#fee2e2;padding:10px 14px;cursor:pointer;text-decoration:none;display:inline-flex}a{color:#bef264}.status{min-height:22px;color:#cbd5e1}</style>
</head>
<body data-delete-token="${escapeHtml(token)}" data-gallery-id="${escapeHtml(id)}">
  <main>
    <h1>刪除雲端作品</h1>
    <img src="${escapeHtml(imageUrl)}" alt="準備刪除的雲端作品">
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <p>此操作會刪除 R2 圖片與 metadata，完成後分享頁與圖片連結都會失效。此動作無法復原。</p>
      <button id="confirmDelete" type="button">確認刪除雲端作品</button>
      <p id="deleteStatus" class="status" role="status" aria-live="polite"></p>
      <noscript>此刪除頁需要 JavaScript 才能送出 DELETE 請求。</noscript>
    </section>
    <a href="/">回到 Fluxi 中文 FLUX 圖片產生器</a>
  </main>
  <script>
  document.getElementById('confirmDelete').addEventListener('click', function(){
    var button = this;
    var status = document.getElementById('deleteStatus');
    button.disabled = true;
    status.textContent = '正在刪除雲端作品…';
    fetch('/gallery/' + encodeURIComponent(document.body.dataset.galleryId), {
      method: 'DELETE',
      headers: { 'X-Gallery-Delete-Token': document.body.dataset.deleteToken }
    }).then(function(response){
      return response.json().then(function(data){
        if(!response.ok){ throw new Error(data && data.error ? data.error : ('HTTP ' + response.status)); }
        status.textContent = '已刪除雲端作品。分享連結與圖片連結已失效。';
        button.textContent = '已刪除';
      });
    }, function(error){
      throw error;
    }).catch(function(error){
      button.disabled = false;
      status.textContent = '刪除失敗：' + error.message;
    });
  });
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shareTemplateUrl(prompt, metadata) {
  const params = new URLSearchParams();
  if (prompt) params.set("prompt", prompt);
  for (const field of ["model", "size", "style", "useCase"]) {
    if (metadata[field]) params.set(field, String(metadata[field]));
  }
  if (metadata.size === "custom") {
    if (metadata.width) params.set("width", String(metadata.width));
    if (metadata.height) params.set("height", String(metadata.height));
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function shareTemplateSummary(prompt, metadata, promptPublic) {
  const fields = [
    `模式：${String(metadata.mode || "normal") === "agent" ? "智慧體模式" : "一般模式"}`,
    `風格：${String(metadata.styleLabel || metadata.style || "未記錄")}`,
    `用途：${String(metadata.useCaseLabel || metadata.useCase || "未記錄")}`,
    `模型：${String(metadata.model || "未記錄")}`,
    `尺寸：${String(metadata.size || "未記錄")}${metadata.size === "custom" && metadata.width && metadata.height ? `（${metadata.width}×${metadata.height}）` : ""}`,
  ];
  if (promptPublic && prompt) fields.unshift(`Prompt：${prompt}`);
  return fields.join("\n");
}

async function readR2Text(object) {
  if (!object) return "";
  if (typeof object.text === "function") return object.text();
  if (typeof object.body === "string") return object.body;
  return new Response(object.body).text();
}

async function handleSharePage(env, id) {
  const bucket = env.IMAGE_BUCKET;
  if (!bucket || typeof bucket.get !== "function") {
    return new Response("<!doctype html><title>雲端分享尚未啟用</title><p>雲端分享尚未啟用。</p>", {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return new Response("<!doctype html><title>找不到作品</title><p>找不到作品。</p>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const image = await bucket.get(`${GALLERY_PREFIX}${id}`);
  const metaObject = await bucket.get(`${GALLERY_META_PREFIX}${id}.json`);
  if (!image || !metaObject) {
    return new Response("<!doctype html><title>找不到作品</title><p>找不到作品。</p>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readR2Text(metaObject));
  } catch {
    payload = {};
  }
  const metadata = payload && payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const promptPublic = payload.promptPublic === true;
  const prompt = promptPublic ? String(metadata.prompt || "") : "";
  const title = String(metadata.title || "Fluxi 作品分享");
  const model = String(metadata.model || "未記錄");
  const size = String(metadata.size || "未記錄");
  const seed = String(metadata.seed || "未記錄");
  const styleLabel = String(metadata.styleLabel || metadata.style || "未記錄");
  const useCaseLabel = String(metadata.useCaseLabel || metadata.useCase || "未記錄");
  const mode = String(metadata.mode || "normal") === "agent" ? "智慧體模式" : "一般模式";
  const imageUrl = `/gallery/${encodeURIComponent(id)}`;
  const robots = payload.visibility === "public" ? "index,follow" : "noindex,nofollow";
  const templateUrl = shareTemplateUrl(promptPublic ? prompt : "", metadata);
  const templateSummary = shareTemplateSummary(prompt, metadata, promptPublic);
  const regenerateLabel = promptPublic && prompt ? "用這個 prompt 再生成" : "套用公開設定再生成";
  const promptBlock = promptPublic && prompt
    ? `<pre>${escapeHtml(prompt)}</pre><button type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.querySelector('pre').textContent)">複製 prompt 模板</button>`
    : "<p>此作品未公開完整 prompt。</p><p>仍可套用公開設定（模型、尺寸、風格與用途），再自行補上中文描述。</p>";
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="${robots}">
  <title>${escapeHtml(title)}｜Fluxi 作品分享</title>
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="使用 Fluxi 中文 FLUX 圖片產生器建立的作品。">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <style>
    body{margin:0;padding:32px;background:#0a0b0f;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:960px;margin:0 auto;display:grid;gap:18px}
    img{max-width:100%;border-radius:24px;border:1px solid rgba(255,255,255,.14);background:#111827}
    .card{border:1px solid rgba(255,255,255,.14);border-radius:20px;background:rgba(255,255,255,.06);padding:18px}
    .meta{display:flex;flex-wrap:wrap;gap:8px;color:#cbd5e1}
    .meta span{border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:6px 10px}
    .actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    pre{white-space:pre-wrap;word-break:break-word;color:#d9f99d}
    button,.button{border:1px solid rgba(190,242,100,.45);border-radius:999px;background:rgba(190,242,100,.12);color:#ecfccb;padding:10px 14px;cursor:pointer;text-decoration:none;display:inline-flex}
    a{color:#bef264}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <img src="${escapeHtml(imageUrl)}" alt="分享的 AI 生成圖片">
    <section class="card">
      <h2>作品資訊</h2>
      <div class="meta">
        <span>模式：${escapeHtml(mode)}</span>
        <span>風格：${escapeHtml(styleLabel)}</span>
        <span>用途：${escapeHtml(useCaseLabel)}</span>
        <span>模型：${escapeHtml(model)}</span>
        <span>尺寸：${escapeHtml(size)}</span>
        <span>Seed：${escapeHtml(seed)}</span>
        <span>Prompt：${promptPublic ? "公開" : "隱藏"}</span>
      </div>
    </section>
    <section class="card">
      <h2>Prompt</h2>
      ${promptBlock}
    </section>
    <section class="actions">
      <a class="button" href="${escapeHtml(templateUrl)}">${escapeHtml(regenerateLabel)}</a>
      <button type="button" data-template="${escapeHtml(templateSummary)}" onclick="navigator.clipboard&&navigator.clipboard.writeText(this.dataset.template)">複製模板設定</button>
      <a href="/">回到 Fluxi 中文 FLUX 圖片產生器</a>
    </section>
  </main>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function handlePromptTransform(request, env) {
  const route = "prompt_transform";
  const started = Date.now();
  // Each call can hit the Gemini API (separate paid quota); throttle like /generate.
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER, env);
  if (limited) {
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: 429, errorCode: "rate_limited",
    });
    return limited;
  }

  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordPromptEvent(env, request, route, started, {
        outcome: "error", statusCode: e.status, errorCode: e.code,
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  const source = String(payload.source || "").trim();
  if (!source) {
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: 400, errorCode: "bad_request",
    });
    return json({ error: "請先輸入白話描述", code: "bad_request" }, 400);
  }
  if (source.length > MAX_TRANSFORM_SOURCE_LENGTH) {
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: 400, errorCode: "bad_request",
    });
    return json({ error: "描述太長", code: "bad_request" }, 400);
  }

  // LLM-first: try Gemini when a key is configured, then gracefully fall back.
  const providerTelemetry = { attempts: 0 };
  if (String((env && env.GEMINI_API_KEY) || "").trim()) {
    try {
      const resolvedStyle = resolveStyle(source, normalizeStyle(payload.style));
      const prompt = await geminiTransformPrompt(source, resolvedStyle, env, providerTelemetry);
      await recordPromptEvent(env, request, route, started, {
        outcome: "success", statusCode: 200,
        ...promptUsageTarget(env, route, "gemini", providerTelemetry.attempts),
      });
      return json({ source, prompt, provider: "gemini", warnings: [] });
    } catch (geminiErr) {
      console.error(JSON.stringify({ event: "gemini_transform_failed", error: String(geminiErr) }));
      // fall through to the offline rule-based engine
    }
  }

  try {
    const result = transformPlainPrompt(source, payload.style);
    await recordPromptEvent(env, request, route, started, {
      outcome: "success", statusCode: 200,
      ...promptUsageTarget(env, route, result.provider, providerTelemetry.attempts),
    });
    return json({
      source: result.source,
      prompt: result.prompt,
      provider: result.provider,
      warnings: result.warnings,
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    const code = e instanceof HttpError ? e.code : "bad_request";
    const provider = String((env && env.GEMINI_API_KEY) || "").trim() ? "gemini" : "unknown";
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: status, errorCode: code,
      ...promptUsageTarget(env, route, provider, providerTelemetry.attempts),
    });
    if (e instanceof HttpError) return httpErrorJson(e);
    return json({ error: String(e), code: "bad_request" }, 400);
  }
}

async function handlePromptComplete(request, env) {
  const route = "prompt_complete";
  const started = Date.now();
  // Gemma completion can consume paid quota; throttle like /prompt/transform.
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER, env);
  if (limited) {
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: 429, errorCode: "rate_limited",
    });
    return limited;
  }

  let payload;
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordPromptEvent(env, request, route, started, {
        outcome: "error", statusCode: e.status, errorCode: e.code,
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  const source = String(payload.source || "").trim();
  if (!source) {
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: 400, errorCode: "bad_request",
    });
    return json({ error: "請先輸入白話描述", code: "bad_request" }, 400);
  }
  if (source.length > MAX_TRANSFORM_SOURCE_LENGTH) {
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: 400, errorCode: "bad_request",
    });
    return json({ error: "描述太長", code: "bad_request" }, 400);
  }

  const providerTelemetry = { attempts: 0 };
  try {
    const result = await completePlainPrompt(source, payload.style, env, providerTelemetry);
    await recordPromptEvent(env, request, route, started, {
      outcome: "success", statusCode: 200,
      ...promptUsageTarget(env, route, result.provider, providerTelemetry.attempts),
    });
    return json({
      source: result.source,
      prompt: result.prompt,
      provider: result.provider,
      warnings: result.warnings,
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    const code = e instanceof HttpError ? e.code : "prompt_complete_failed";
    const provider = String((env && env.GEMINI_API_KEY) || "").trim() ? "gemini" : "unknown";
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: status, errorCode: code,
      ...promptUsageTarget(env, route, provider, providerTelemetry.attempts),
    });
    if (e instanceof HttpError) return httpErrorJson(e);
    console.error(JSON.stringify({ event: "gemini_complete_failed", error: String(e) }));
    return json({ error: "Gemma 中文補全失敗，請稍後再試", code: "prompt_complete_failed" }, 502);
  }
}

async function handlePromptEnhance(request, env) {
  const route = "prompt_enhance";
  const started = Date.now();
  // Effect optimisation hits Gemini; throttle like /prompt/transform.
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER, env);
  if (limited) {
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: 429, errorCode: "rate_limited",
    });
    return limited;
  }

  let payload;
  const providerTelemetry = { attempts: 0 };
  try {
    payload = await readJsonPayload(request);
  } catch (e) {
    if (e instanceof HttpError) {
      await recordPromptEvent(env, request, route, started, {
        outcome: "error", statusCode: e.status, errorCode: e.code,
      });
      return httpErrorJson(e);
    }
    throw e;
  }

  try {
    const prompt = String(payload.prompt || "").trim();
    const effect = String(payload.effect || "").trim();
    if (prompt.length > MAX_ENHANCE_PROMPT_LENGTH) {
      await recordPromptEvent(env, request, route, started, {
        outcome: "error", statusCode: 400, errorCode: "bad_request",
      });
      return json({ error: "提示詞太長", code: "bad_request" }, 400);
    }
    if (effect.length > MAX_ENHANCE_EFFECT_LENGTH) {
      await recordPromptEvent(env, request, route, started, {
        outcome: "error", statusCode: 400, errorCode: "bad_request",
      });
      return json({ error: "效果描述太長", code: "bad_request" }, 400);
    }
    const result = await enhancePrompt(payload.prompt, payload.effect, env, providerTelemetry);
    await recordPromptEvent(env, request, route, started, {
      outcome: "success", statusCode: 200,
      ...promptUsageTarget(env, route, result.provider, providerTelemetry.attempts),
    });
    return json({
      prompt: result.prompt,
      provider: result.provider,
      effect: result.effect,
      warnings: result.warnings || [],
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    const code = e instanceof HttpError ? e.code : "prompt_enhance_failed";
    const provider = e instanceof HttpError
      ? "unknown"
      : String((env && env.GEMINI_API_KEY) || "").trim() ? "gemini" : "unknown";
    await recordPromptEvent(env, request, route, started, {
      outcome: "error", statusCode: status, errorCode: code,
      ...promptUsageTarget(env, route, provider, providerTelemetry.attempts),
    });
    if (e instanceof HttpError) return httpErrorJson(e);
    console.error(JSON.stringify({ event: "gemini_enhance_failed", error: String(e) }));
    return json({ error: "效果優化失敗，請稍後再試", code: "prompt_enhance_failed" }, 502);
  }
}

export { completePlainPrompt, enhancePrompt, transformPlainPrompt };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      const response = json(buildHealthResponse(env));
      response.headers.set("cache-control", "no-store");
      return response;
    }
    if (url.pathname === "/api/usage" && request.method === "GET") {
      const adminError = requireGalleryAdmin(request, env, "usage");
      if (adminError) return adminError;
      try {
        return json(await buildUsageSummary(env, url.searchParams.get("date")));
      } catch (e) {
        return json(
          { error: e.message || "date 必須使用 YYYY-MM-DD", code: e.code || "bad_request" },
          e.status || 400
        );
      }
    }
    if (url.pathname === "/api/gallery" && request.method === "GET") {
      return handleGalleryAdminList(request, env);
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
    if (url.pathname === "/edit" && request.method === "POST") {
      return handleEdit(request, env);
    }
    if (url.pathname === "/gallery" && request.method === "POST") {
      return handleGallerySave(request, env);
    }
    if (url.pathname.startsWith("/gallery/") && url.pathname.endsWith("/delete") && request.method === "GET") {
      let galleryId;
      try {
        galleryId = decodeURIComponent(url.pathname.slice("/gallery/".length, -"/delete".length));
      } catch {
        return new Response("<!doctype html><title>找不到作品</title><p>找不到作品。</p>", {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return handleGalleryDeletePage(env, galleryId, url.searchParams.get("deleteToken") || "");
    }
    if (url.pathname.startsWith("/gallery/") && request.method === "DELETE") {
      let galleryId;
      try {
        galleryId = decodeURIComponent(url.pathname.slice("/gallery/".length));
      } catch {
        return json({ error: "找不到圖片", code: "not_found" }, 404);
      }
      return handleGalleryDelete(request, env, galleryId);
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
    if (url.pathname.startsWith("/share/") && request.method === "GET") {
      let shareId;
      try {
        shareId = decodeURIComponent(url.pathname.slice("/share/".length));
      } catch {
        return new Response("<!doctype html><title>找不到作品</title><p>找不到作品。</p>", {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return handleSharePage(env, shareId);
    }
    if (url.pathname === "/client-error" && request.method === "POST") {
      return handleClientError(request);
    }
    // Anything else: static assets (index.html, /static/*).
    return env.ASSETS.fetch(request);
  },
};

export { resetUsageMetrics };
