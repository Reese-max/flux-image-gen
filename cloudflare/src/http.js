// HTTP plumbing: error type, JSON responses, bounded body reads, request-id,
// client-error sanitization, and the optional edge rate limiter.
import { MAX_JSON_BYTES } from "./constants.js";

const TURNSTILE_ACTION = "turnstile-spin-v1";

export class HttpError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function makeRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return `req_${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // fall through to compact non-cryptographic fallback
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function json(body, status = 200, requestId = makeRequestId()) {
  return new Response(JSON.stringify({ ...body, requestId }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      "x-content-type-options": "nosniff",
    },
  });
}

export function httpErrorJson(e) {
  const body = { error: e.message, code: e.code };
  if (e.retry_after != null) body.retry_after = e.retry_after;
  if (e.category != null) body.category = e.category;
  return json(body, e.status);
}

function envFlag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

/**
 * Return true when the Worker is running in an explicit production deployment.
 *
 * Production mode is opt-in via ENVIRONMENT="production". Only in production
 * does a missing / broken rate-limit binding trigger a fail-closed 503 rather
 * than a no-op pass-through.  Local dev and staging keep the existing
 * pass-through so tests and previews keep working without the binding.
 *
 * Why not auto-detect by Workers runtime signal? The runtime does not expose
 * a stable "I am the production deployment" flag accessible from JS.
 * Operator intent expressed through an env var is the correct mechanism.
 */
export function isProductionMode(env) {
  return String((env && env.ENVIRONMENT) || "").trim().toLowerCase() === "production";
}

/**
 * Return true when server-funded provider calls (NVIDIA / Workers AI / Gemini)
 * are reachable from this env. Used by fail-closed logic: when the operator
 * has live API keys, bypassing the rate limiter is a real cost/abuse risk.
 */
function hasProviderKeys(env) {
  if (!env) return false;
  if (String(env.NVIDIA_API_KEY || "").trim().length > 0) return true;
  if (env.AI && typeof env.AI.run === "function") return true;
  if (String(env.GEMINI_API_KEY || "").trim().length > 0) return true;
  return false;
}

export function turnstileConfig(env) {
  const required = envFlag(env && env.TURNSTILE_REQUIRED);
  return {
    required,
    siteKey: required ? String((env && env.TURNSTILE_SITE_KEY) || "").trim() : "",
  };
}

function turnstileTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(250, Math.min(15000, Math.round(parsed)));
}

export async function verifyTurnstileToken(token, request, env) {
  const config = turnstileConfig(env);
  if (!config.required) return null;

  const secret = String((env && env.TURNSTILE_SECRET_KEY) || "").trim();
  if (!secret) {
    return new HttpError("真人驗證尚未完成設定，請稍後再試", 503, "turnstile_unconfigured");
  }

  const cleanToken = String(token || "").trim();
  if (!cleanToken) {
    return new HttpError("請先完成人機驗證再生成圖片", 403, "turnstile_required");
  }

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", cleanToken);
  form.set("remoteip", request.headers.get("cf-connecting-ip") || "");

  let response;
  let data;
  try {
    response = await fetch(
      String((env && env.TURNSTILE_VERIFY_URL) || "https://challenges.cloudflare.com/turnstile/v0/siteverify"),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(turnstileTimeoutMs(env && env.TURNSTILE_TIMEOUT_MS)),
      }
    );
    data = await response.json();
  } catch {
    return new HttpError("真人驗證服務暫時不可用，請稍後再試", 503, "turnstile_unavailable");
  }

  if (response.status >= 500) {
    return new HttpError("真人驗證服務暫時不可用，請稍後再試", 503, "turnstile_unavailable");
  }
  if (!data || data.success !== true || data.action !== TURNSTILE_ACTION) {
    return new HttpError("真人驗證失敗，請重新驗證後再試", 403, "turnstile_failed");
  }
  return null;
}

export async function readJsonPayload(request, maxBytes = MAX_JSON_BYTES) {
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
      if (total > maxBytes) {
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

export async function readLimitedText(response, maxBytes = 512) {
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

export function sanitizeClientErrorReport(payload) {
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

// Edge rate limiting. Active when a Cloudflare Rate Limiting binding named
// GENERATE_RATE_LIMITER is configured in wrangler.toml.
//
// Fail-closed policy (production mode only):
//   When ENVIRONMENT="production" and provider API keys are present, a missing
//   or broken rate-limit binding returns 503 Service Unavailable instead of
//   silently allowing the request. This prevents server-funded workloads from
//   running without a hard request gate due to misconfiguration or binding failure.
//
// Pass-through (local dev / staging):
//   Without ENVIRONMENT="production", a missing limiter is still a no-op so
//   local development and un-provisioned preview deployments keep working.
export async function checkRateLimit(request, limiter, env) {
  const inProduction = isProductionMode(env);

  // Check if limiter binding is present.
  if (!limiter || typeof limiter.limit !== "function") {
    if (inProduction && hasProviderKeys(env)) {
      // Fail closed: binding is required in production to protect provider quota.
      return json(
        {
          error: "服務暫時維護中，請稍後再試",
          code: "rate_limiter_unavailable",
        },
        503,
      );
    }
    // Dev / staging: pass-through without the binding.
    return null;
  }

  const key = request.headers.get("cf-connecting-ip") || "anonymous";
  let outcome;
  try {
    outcome = await limiter.limit({ key });
  } catch {
    if (inProduction && hasProviderKeys(env)) {
      // Fail closed: binding error in production is treated as limiter unavailable.
      return json(
        {
          error: "服務暫時維護中，請稍後再試",
          code: "rate_limiter_error",
        },
        503,
      );
    }
    // Dev / staging: swallow binding errors.
    return null;
  }

  if (outcome && outcome.success === false) {
    return json({ error: "叫用太頻繁，請稍後再試", code: "rate_limited", retry_after: 60 }, 429);
  }
  return null;
}
