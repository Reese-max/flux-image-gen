// Edge usage/cost metrics for the public Worker. The store is intentionally
// prompt-free: no prompt text, image bytes, or secrets are persisted in metrics.
const usageByDate = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateKey(value) {
  const raw = String(value || todayKey()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("date 必須使用 YYYY-MM-DD");
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error("date 必須使用 YYYY-MM-DD");
  }
  return raw;
}

function estimatedCostUsd(env, event, imageCount) {
  const provider = String((event && event.provider) || "").toLowerCase();
  const route = String((event && event.route) || "");
  const attempts = Math.max(0, Number((event && event.attempt) || 0));
  // Priced per request, not per image - these routes call an LLM and produce no
  // image. Keyed on route alone: gating on provider mispriced vision QA as a
  // generated image the moment it moved off Gemini.
  if (route.startsWith("prompt_") || route === "vision_qa") {
    const perRequest = Number(env && env.USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST != null
      ? env.USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST
      : 0);
    return Number.isFinite(perRequest) && perRequest >= 0
      ? Math.round(perRequest * attempts * 1_000_000) / 1_000_000
      : 0;
  }
  if (provider === "demo" || (imageCount <= 0 && attempts <= 0)) return 0;
  const perImage = Number(env && env.USAGE_ESTIMATED_COST_USD_PER_IMAGE != null ? env.USAGE_ESTIMATED_COST_USD_PER_IMAGE : 0.003);
  if (!Number.isFinite(perImage) || perImage < 0) return 0;
  // A started provider call may still be billed after timeout/error. Use attempts
  // as a conservative floor; validation and challenge failures keep attempt=0.
  return Math.round(perImage * Math.max(imageCount, attempts) * 1_000_000) / 1_000_000;
}

function bucketIncrement(bucket, key, event) {
  const safeKey = key || "unknown";
  if (!bucket[safeKey]) {
    bucket[safeKey] = { requests: 0, successes: 0, failures: 0, images: 0, attempts: 0, estimatedCostUsd: 0 };
  }
  const item = bucket[safeKey];
  item.requests += 1;
  if (event.outcome === "success") item.successes += 1;
  else item.failures += 1;
  item.images += event.imageCount || 0;
  item.attempts += event.attempt || 0;
  item.estimatedCostUsd = Math.round((item.estimatedCostUsd + (event.estimatedCostUsd || 0)) * 1_000_000) / 1_000_000;
}

export async function recordUsageEvent(env, _request, event) {
  const outcome = event && event.outcome === "success" ? "success" : "error";
  const imageCount = outcome === "success" ? Math.max(0, Number(event.imageCount || 0)) : 0;
  const date = todayKey();
  const payload = {
    date,
    checkedAt: new Date().toISOString(),
    route: String((event && event.route) || "unknown"),
    outcome,
    statusCode: Number((event && event.statusCode) || (outcome === "success" ? 200 : 500)),
    errorCode: String((event && event.errorCode) || ""),
    provider: String((event && event.provider) || "unknown"),
    model: String((event && event.model) || "unknown"),
    imageCount,
    durationMs: Math.max(0, Math.round(Number((event && event.durationMs) || 0))),
    estimatedCostUsd: estimatedCostUsd(env, event, imageCount),
    attempt: Math.max(0, Math.round(Number((event && event.attempt) || 0))),
    batchIndex: event && Number.isInteger(event.batchIndex) ? event.batchIndex : "",
  };

  if (!usageByDate.has(date)) usageByDate.set(date, []);
  usageByDate.get(date).push(payload);
  console.log(JSON.stringify({ event: "usage_event", usage: payload }));
  return payload;
}

export async function buildUsageSummary(env, dateValue) {
  const date = parseDateKey(dateValue);
  const events = usageByDate.get(date) || [];
  const byModel = {};
  const byProvider = {};
  const byRoute = {};
  const byErrorCode = {};
  let successes = 0;
  let failures = 0;
  let generatedImages = 0;
  let estimatedCostUsdTotal = 0;
  let durationTotal = 0;
  let totalAttempts = 0;

  for (const event of events) {
    if (event.outcome === "success") successes += 1;
    else failures += 1;
    generatedImages += event.outcome === "success" ? event.imageCount || 0 : 0;
    estimatedCostUsdTotal += event.estimatedCostUsd || 0;
    durationTotal += event.durationMs || 0;
    totalAttempts += event.attempt || 0;
    bucketIncrement(byModel, event.model, event);
    bucketIncrement(byProvider, event.provider, event);
    bucketIncrement(byRoute, event.route, event);
    if (event.errorCode) byErrorCode[event.errorCode] = (byErrorCode[event.errorCode] || 0) + 1;
  }

  const total = events.length;
  const threshold = Number(env && env.USAGE_ALERT_DAILY_GENERATIONS != null ? env.USAGE_ALERT_DAILY_GENERATIONS : 1000);
  const alerts = [];
  if (Number.isFinite(threshold) && threshold > 0 && generatedImages >= threshold) {
    alerts.push({
      code: "daily_generation_threshold",
      message: "今日生成量已達提醒門檻",
      threshold,
      actual: generatedImages,
    });
  }
  alerts.push({
    code: "usage_memory_only",
    message: "用量只暫存在目前 Worker 執行個體，重新部署或執行個體更新後會歸零",
  });
  return {
    date,
    totalRequests: total,
    successRequests: successes,
    failedRequests: failures,
    generatedImages,
    totalAttempts,
    estimatedCostUsd: Math.round(estimatedCostUsdTotal * 1_000_000) / 1_000_000,
    errorRate: total ? Math.round((failures / total) * 10000) / 10000 : 0,
    averageGenerationMs: total ? Math.round(durationTotal / total) : 0,
    byModel,
    byProvider,
    byRoute,
    byErrorCode,
    alerts,
    storage: "memory",
    partial: true,
    updatedAt: new Date().toISOString(),
  };
}

export function resetUsageMetrics() {
  usageByDate.clear();
}
