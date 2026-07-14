// Edge usage/cost metrics for the public Worker. The store is intentionally
// prompt-free: no prompt text, image bytes, or secrets are persisted in metrics.
const usageByDate = new Map();
const USAGE_PREFIX = "usage-events/";
const USAGE_LIST_LIMIT = 1000;

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
  if ((route.startsWith("prompt_") || route === "vision_qa") && provider.startsWith("gemini")) {
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

function usageBucket(env) {
  const bucket = env && env.IMAGE_BUCKET;
  return bucket && typeof bucket.put === "function" && typeof bucket.list === "function" ? bucket : null;
}

function usageObjectKey(date) {
  const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  return `${USAGE_PREFIX}${date}/${Date.now().toString().padStart(13, "0")}-${id}`;
}

function usageMetadata(payload) {
  const metadata = {};
  for (const [key, value] of Object.entries(payload)) metadata[key] = String(value == null ? "" : value);
  return metadata;
}

function usageEventFromMetadata(metadata) {
  if (!metadata || !metadata.date) return null;
  return {
    date: metadata.date,
    checkedAt: metadata.checkedAt || "",
    route: metadata.route || "unknown",
    outcome: metadata.outcome === "success" ? "success" : "error",
    statusCode: Number(metadata.statusCode || 0),
    errorCode: metadata.errorCode || "",
    provider: metadata.provider || "unknown",
    model: metadata.model || "unknown",
    imageCount: Math.max(0, Number(metadata.imageCount || 0)),
    durationMs: Math.max(0, Number(metadata.durationMs || 0)),
    estimatedCostUsd: Math.max(0, Number(metadata.estimatedCostUsd || 0)),
    attempt: Math.max(0, Number(metadata.attempt || 0)),
    batchIndex: metadata.batchIndex === "" ? null : Number(metadata.batchIndex),
  };
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

  const bucket = usageBucket(env);
  const hasBucketBinding = Boolean(env && env.IMAGE_BUCKET);
  if (hasBucketBinding) {
    try {
      if (!bucket) throw new Error("IMAGE_BUCKET does not support put/list");
      await bucket.put(usageObjectKey(date), "", { customMetadata: usageMetadata(payload) });
    } catch (error) {
      console.error(JSON.stringify({ event: "usage_persist_failed", error: String(error) }));
    }
  } else {
    if (!usageByDate.has(date)) usageByDate.set(date, []);
    usageByDate.get(date).push(payload);
  }
  console.log(JSON.stringify({ event: "usage_event", usage: payload }));
  return payload;
}

export async function buildUsageSummary(env, dateValue) {
  const date = parseDateKey(dateValue);
  const bucket = usageBucket(env);
  const hasBucketBinding = Boolean(env && env.IMAGE_BUCKET);
  let events = usageByDate.get(date) || [];
  let truncated = false;
  if (hasBucketBinding) {
    try {
      if (!bucket) throw new Error("IMAGE_BUCKET does not support put/list");
      // ponytail: one metadata-only R2 page is the low-traffic ceiling. Move to
      // Analytics Engine when truncation becomes normal instead of growing this reader.
      const listed = await bucket.list({
        prefix: `${USAGE_PREFIX}${date}/`,
        limit: USAGE_LIST_LIMIT,
        include: ["customMetadata"],
      });
      events = (listed.objects || [])
        .map((object) => usageEventFromMetadata(object.customMetadata))
        .filter(Boolean);
      truncated = Boolean(listed.truncated);
    } catch (error) {
      const unavailable = new Error("用量資料暫時無法讀取");
      unavailable.status = 503;
      unavailable.code = "usage_unavailable";
      throw unavailable;
    }
  }
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
  if (truncated) {
    alerts.push({
      code: "usage_event_list_truncated",
      message: "今日用量事件超過低流量摘要上限，數字可能不完整",
      threshold: USAGE_LIST_LIMIT,
      actual: events.length,
    });
  }

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
    storage: hasBucketBinding ? "r2" : "memory-test-fallback",
    partial: truncated,
    updatedAt: new Date().toISOString(),
  };
}

export function resetUsageMetrics() {
  usageByDate.clear();
}
