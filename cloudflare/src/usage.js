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

async function sha256Hex(value) {
  try {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(16).padStart(8, "0");
  }
}

async function actorHashFromRequest(request) {
  const forwarded = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
  const raw = String(forwarded).split(",")[0].trim() || "anonymous";
  const digest = await sha256Hex(raw);
  return `ip:${digest.slice(0, 16)}`;
}

function estimatedCostUsd(env, provider, imageCount) {
  if (imageCount <= 0 || String(provider || "").toLowerCase() === "demo") return 0;
  const perImage = Number(env && env.USAGE_ESTIMATED_COST_USD_PER_IMAGE != null ? env.USAGE_ESTIMATED_COST_USD_PER_IMAGE : 0.003);
  if (!Number.isFinite(perImage) || perImage < 0) return 0;
  return Math.round(perImage * imageCount * 1_000_000) / 1_000_000;
}

function bucketIncrement(bucket, key, event) {
  const safeKey = key || "unknown";
  if (!bucket[safeKey]) {
    bucket[safeKey] = { requests: 0, successes: 0, failures: 0, images: 0, estimatedCostUsd: 0 };
  }
  const item = bucket[safeKey];
  item.requests += 1;
  if (event.outcome === "success") item.successes += 1;
  else item.failures += 1;
  item.images += event.imageCount || 0;
  item.estimatedCostUsd = Math.round((item.estimatedCostUsd + (event.estimatedCostUsd || 0)) * 1_000_000) / 1_000_000;
}

export async function recordUsageEvent(env, request, event) {
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
    estimatedCostUsd: estimatedCostUsd(env, event && event.provider, imageCount),
    actorHash: await actorHashFromRequest(request),
  };

  if (!usageByDate.has(date)) usageByDate.set(date, []);
  usageByDate.get(date).push(payload);
  console.log(JSON.stringify({ event: "usage_event", usage: payload }));
  return payload;
}

export function buildUsageSummary(env, dateValue) {
  const date = parseDateKey(dateValue);
  const events = usageByDate.get(date) || [];
  const byModel = {};
  const byProvider = {};
  const byRoute = {};
  const byActor = {};
  const byErrorCode = {};
  let successes = 0;
  let failures = 0;
  let generatedImages = 0;
  let estimatedCostUsdTotal = 0;
  let durationTotal = 0;

  for (const event of events) {
    if (event.outcome === "success") successes += 1;
    else failures += 1;
    generatedImages += event.outcome === "success" ? event.imageCount || 0 : 0;
    estimatedCostUsdTotal += event.estimatedCostUsd || 0;
    durationTotal += event.durationMs || 0;
    bucketIncrement(byModel, event.model, event);
    bucketIncrement(byProvider, event.provider, event);
    bucketIncrement(byRoute, event.route, event);
    bucketIncrement(byActor, event.actorHash, event);
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

  return {
    date,
    totalRequests: total,
    successRequests: successes,
    failedRequests: failures,
    generatedImages,
    estimatedCostUsd: Math.round(estimatedCostUsdTotal * 1_000_000) / 1_000_000,
    errorRate: total ? Math.round((failures / total) * 10000) / 10000 : 0,
    averageGenerationMs: total ? Math.round(durationTotal / total) : 0,
    byModel,
    byProvider,
    byRoute,
    byActor,
    byErrorCode,
    alerts,
    updatedAt: new Date().toISOString(),
  };
}

export function resetUsageMetrics() {
  usageByDate.clear();
}
