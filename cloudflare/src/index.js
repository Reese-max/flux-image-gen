// Cloudflare Worker entry: serves the static SPA and routes the JSON API.
// Request handlers live here; pure helpers are split into sibling modules
// (constants / http / prompt / image). Mirrors the Python backend.
import { GEMINI_COMPLETE_DEFAULT_MODEL, GEMINI_DEFAULT_MODEL, MAX_ENHANCE_EFFECT_LENGTH, MAX_ENHANCE_PROMPT_LENGTH, MAX_TRANSFORM_SOURCE_LENGTH, MODEL_ENDPOINTS, SIZE_MAP, WORKERS_AI_EDIT_MODEL } from "./constants.js";
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
import { completePlainPrompt, enhancePrompt, geminiTransformPrompt, normalizeStyle, resolveGeminiKeys, resolveStyle, transformPlainPrompt } from "./prompt.js";
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
  const hasGemini = resolveGeminiKeys(env).length > 0;
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
    provider: visionQa.provider || "nvidia",
    model: String((env && env.NVIDIA_VISION_MODEL) || "meta/llama-3.2-90b-vision-instruct"),
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

function requireUsageAdmin(request, env) {
  const expected = env && env.USAGE_ADMIN_TOKEN;
  if (!expected) {
    return json({ error: "站長用量摘要尚未啟用", code: "admin_usage_disabled" }, 503);
  }
  const provided = request.headers.get("x-usage-admin-token") || "";
  return constantTimeStringEqual(expected, provided)
    ? null
    : json({ error: "未授權", code: "unauthorized" }, 401);
}

function buildHealthResponse(env) {
  const hasNvidia = Boolean(getNvidiaApiKey(env));
  const hasWorkersAI = Boolean(env.AI);
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
    visionQa: String((env && env.VISION_QA_ENABLED) || "").trim().toLowerCase() === "true",
    // QA 實際跑得起來才回後端名稱；空字串＝沒啟用或缺 NVIDIA_API_KEY。
    visionQaProvider:
      String((env && env.VISION_QA_ENABLED) || "").trim().toLowerCase() === "true"
        && !!String((env && env.NVIDIA_API_KEY) || "").trim()
        ? "nvidia"
        : "",
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
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
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
    return json(result);
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
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
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
    const response = { images, errors, partial: errors.length > 0 };
    return json(response);
  } catch (e) {
    if (e instanceof HttpError) {
      return httpErrorJson(e);
    }
    throw e;
  }
}

async function handleEdit(request, env) {
  const started = Date.now();
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
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

async function handlePromptTransform(request, env) {
  const route = "prompt_transform";
  const started = Date.now();
  // Each call can hit the Gemini API (separate paid quota); throttle like /generate.
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
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
  if (resolveGeminiKeys(env).length) {
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
    const provider = resolveGeminiKeys(env).length ? "gemini" : "unknown";
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
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
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
    const provider = resolveGeminiKeys(env).length ? "gemini" : "unknown";
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
  const limited = await checkRateLimit(request, env.GENERATE_RATE_LIMITER);
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
      : resolveGeminiKeys(env).length ? "gemini" : "unknown";
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
      const adminError = requireUsageAdmin(request, env);
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
    if (
      url.pathname === "/gallery"
      || url.pathname.startsWith("/gallery/")
      || url.pathname.startsWith("/share/")
      || url.pathname === "/api/gallery"
    ) {
      return json({ error: "找不到資源", code: "not_found" }, 404);
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
    if (url.pathname === "/client-error" && request.method === "POST") {
      return handleClientError(request);
    }
    // Anything else: static assets (index.html, /static/*).
    return env.ASSETS.fetch(request);
  },
};

export { resetUsageMetrics };
