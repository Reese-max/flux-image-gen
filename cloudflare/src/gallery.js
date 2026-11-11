// Cloud gallery (R2) helpers: data-URL decoding, metadata sanitization,
// save authorization, and owner delete tokens.
import { GALLERY_EXT, GALLERY_TOKEN_TTL_MS, MAX_GALLERY_IMAGE_BYTES } from "./constants.js";
import { HttpError } from "./http.js";
import "../../app/static/provenance.js";

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
        out[field] = globalThis.ImageProvenance.redactText(meta[field]).slice(0, 500);
      }
    }
    for (const field of ["width", "height"]) {
      const n = Number(meta[field]);
      if (Number.isInteger(n) && n >= 256 && n <= 1920) out[field] = n;
    }
    if (promptPublic && meta.prompt !== undefined && meta.prompt !== null) {
      out.prompt = globalThis.ImageProvenance.redactText(meta.prompt).slice(0, 500);
    }
  }
  return out;
}

// --- Gallery save authorization (required HMAC token) ---
// /generate(/batch) hand out a short-lived signed token that POST /gallery
// requires, so the cloud gallery can only be written to right after a real
// generation. A missing secret fails closed instead of opening anonymous writes.
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

async function sha256BytesHex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
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

export async function issueGalleryToken(env, imageDataUrl) {
  const secret = env && env.GALLERY_TOKEN_SECRET;
  if (!secret || typeof imageDataUrl !== "string") return undefined;
  let decoded;
  try {
    decoded = decodeImageDataUrl(imageDataUrl);
  } catch {
    return undefined;
  }
  const imageHash = await sha256BytesHex(decoded.bytes);
  const ts = Date.now().toString();
  const nonce = crypto.randomUUID();
  const message = `${ts}.${nonce}.${imageHash}`;
  return `${message}.${await hmacHex(secret, message)}`;
}

export async function verifyGalleryToken(env, token, imageBytes) {
  const secret = env && env.GALLERY_TOKEN_SECRET;
  if (!secret) return false;
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const [ts, nonce, imageHash, sig] = parts;
  if (!nonce) return false;
  if (!/^[a-f0-9]{64}$/.test(imageHash)) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const now = Date.now();
  if (now - tsNum > GALLERY_TOKEN_TTL_MS || tsNum > now + 60000) return false;
  const expected = await hmacHex(secret, `${ts}.${nonce}.${imageHash}`);
  if (!constantTimeEqual(sig, expected)) return false;
  if (imageBytes === undefined) return true;
  try {
    return constantTimeEqual(await sha256BytesHex(imageBytes), imageHash);
  } catch {
    return false;
  }
}

export async function isGalleryTokenUsed(bucket, token) {
  if (!bucket || !token || typeof bucket.get !== "function") return false;
  return !!(await bucket.get(`gallery-token-use/${await sha256Hex(token)}`));
}

export async function markGalleryTokenUsed(bucket, token) {
  if (!bucket || !token || typeof bucket.put !== "function") return;
  await bucket.put(`gallery-token-use/${await sha256Hex(token)}`, "1");
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
