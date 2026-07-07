// Cloud gallery (R2) helpers: data-URL decoding, metadata sanitization,
// save authorization, and owner delete tokens.
import { GALLERY_EXT, GALLERY_TOKEN_TTL_MS, MAX_GALLERY_IMAGE_BYTES } from "./constants.js";
import { HttpError } from "./http.js";

export function decodeImageDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) throw new HttpError("image 必須是 base64 data URL", 400, "bad_request");
  const contentType = match[1];
  if (!GALLERY_EXT[contentType]) throw new HttpError("不支援的圖片格式", 400, "bad_request");
  // base64 expands the payload ~4/3; reject before allocating so a single POST
  // can't push an oversized object into R2 or burn Worker CPU decoding it.
  if (match[2].length > Math.ceil(MAX_GALLERY_IMAGE_BYTES * 4 / 3)) {
    throw new HttpError("圖片太大（上限 5MB）", 413, "payload_too_large");
  }
  let binary;
  try {
    binary = atob(match[2]);
  } catch {
    throw new HttpError("圖片資料格式不正確", 400, "bad_request");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { contentType, bytes };
}

export function sanitizeGalleryMeta(meta) {
  const out = {};
  if (meta && typeof meta === "object") {
    const promptPublic = meta.promptPublic === true || meta.promptPublic === "true";
    out.promptPublic = promptPublic ? "true" : "false";
    out.visibility = meta.visibility === "public" ? "public" : "unlisted";
    out.storage = "r2";
    out.metadataStorage = "r2-json";
    for (const field of ["title", "model", "size", "seed", "mode", "style", "styleLabel", "useCase", "useCaseLabel"]) {
      if (meta[field] !== undefined && meta[field] !== null) {
        out[field] = String(meta[field]).slice(0, 500);
      }
    }
    if (promptPublic && meta.prompt !== undefined && meta.prompt !== null) {
      out.prompt = String(meta.prompt).slice(0, 500);
    }
  }
  return out;
}

// --- Gallery save authorization (optional HMAC token) ---
// When env.GALLERY_TOKEN_SECRET is set, /generate(/batch) hand out a short-lived
// signed token that POST /gallery requires, so the cloud gallery can only be
// written to right after a real generation — not by anonymous bulk writers.
// Without the secret (local dev / tests) enforcement is disabled and saves stay open.
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(message) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(message || "")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function issueGalleryToken(env) {
  const secret = env && env.GALLERY_TOKEN_SECRET;
  if (!secret) return undefined;
  const ts = Date.now().toString();
  return `${ts}.${await hmacHex(secret, ts)}`;
}

export async function verifyGalleryToken(env, token) {
  const secret = env && env.GALLERY_TOKEN_SECRET;
  if (!secret) return true; // enforcement disabled
  if (typeof token !== "string" || token.indexOf(".") === -1) return false;
  const dot = token.indexOf(".");
  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const now = Date.now();
  if (now - tsNum > GALLERY_TOKEN_TTL_MS || tsNum > now + 60000) return false;
  const expected = await hmacHex(secret, ts);
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// --- Gallery owner deletion ---
// The delete token is returned only to the saving browser. R2 metadata stores a
// SHA-256 hash, not the raw token, so share pages and metadata leaks cannot delete
// a work unless the user kept the one-time delete URL.
export function issueGalleryDeleteToken() {
  return `${crypto.randomUUID()}.${crypto.randomUUID()}`;
}

export async function hashGalleryDeleteToken(token) {
  return sha256Hex(token);
}

export async function verifyGalleryDeleteTokenHash(expectedHash, token) {
  if (typeof expectedHash !== "string" || !expectedHash || typeof token !== "string" || !token) return false;
  return constantTimeEqual(expectedHash, await hashGalleryDeleteToken(token));
}
