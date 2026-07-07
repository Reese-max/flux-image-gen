// HTTP plumbing: error type, JSON responses, bounded body reads, request-id,
// client-error sanitization, and the optional edge rate limiter.
import { MAX_JSON_BYTES } from "./constants.js";

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

export function turnstileConfig(env) {
  const required = envFlag(env && env.TURNSTILE_REQUIRED);
  return {
    required,
    siteKey: required ? String((env && env.TURNSTILE_SITE_KEY) || "").trim() : "",
  };
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
      }
    );
    data = await response.json();
  } catch {
    return new HttpError("真人驗證服務暫時不可用，請稍後再試", 503, "turnstile_unavailable");
  }

  if (response.status >= 500) {
    return new HttpError("真人驗證服務暫時不可用，請稍後再試", 503, "turnstile_unavailable");
  }
  if (!data || data.success !== true) {
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

// Optional edge rate limiting. Active only when a Cloudflare Rate Limiting binding
// named GENERATE_RATE_LIMITER is configured in wrangler.toml; otherwise this is a
// no-op so local dev and un-provisioned deploys keep working. Rate limiting must
// never fail the request itself, so any binding error is ignored.
export async function checkRateLimit(request, limiter) {
  if (!limiter || typeof limiter.limit !== "function") return null;
  const key = request.headers.get("cf-connecting-ip") || "anonymous";
  let outcome;
  try {
    outcome = await limiter.limit({ key });
  } catch {
    return null;
  }
  if (outcome && outcome.success === false) {
    return json({ error: "叫用太頻繁，請稍後再試", code: "rate_limited", retry_after: 60 }, 429);
  }
  return null;
}
