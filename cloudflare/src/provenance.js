// 來源驗證（provenance）伺服器端區塊：輸出位元組 SHA-256 + Content Credentials
// 結構檢測。只回報偵測到的訊號；沒有 signer/trust-list 時絕不宣稱 verified。
// 與 app/static/provenance.js（前端）及 app/provenance.py（FastAPI twin）同約定。

export const CREDENTIAL_STATUSES = new Set([
  "verified",
  "present_untrusted",
  "invalid",
  "absent",
  "unknown_after_transform",
  "unsupported",
]);

const C2PA_MARKERS = ["urn:c2pa", "c2pa-manifest", "c2pa.signature", "c2pa.claim", "caBX"];
const AI_XMP_MARKERS = [
  "trainedAlgorithmicMedia",
  "compositeWithTrainedAlgorithmicMedia",
  "algorithmicallyEnhanced",
  "digitalSourceType",
];
const XMP_HEADER = "http://ns.adobe.com/xap/1.0/";

function bytesToStr(u8, start, end) {
  let out = "";
  const limit = Math.min(end === undefined ? u8.length : end, u8.length);
  for (let i = start || 0; i < limit; i += 1) {
    out += String.fromCharCode(u8[i]);
  }
  return out;
}

function bytesContain(u8, needle, start) {
  const first = needle.charCodeAt(0);
  const n = needle.length;
  for (let i = start || 0; i + n <= u8.length; i += 1) {
    if (u8[i] === first) {
      let j = 1;
      for (; j < n; j += 1) {
        if (u8[i + j] !== needle.charCodeAt(j)) break;
      }
      if (j === n) return true;
    }
  }
  return false;
}

function hasAnyMarker(u8, markers) {
  return markers.some((marker) => bytesContain(u8, marker, 0));
}

function readU32BE(u8, pos) {
  return u8[pos] * 0x1000000 + ((u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]);
}

function readU32LE(u8, pos) {
  return ((u8[pos + 3] * 0x1000000 + ((u8[pos + 2] << 16) | (u8[pos + 1] << 8) | u8[pos])) >>> 0);
}

function sniffImageFormat(u8) {
  if (
    u8.length >= 8 &&
    u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
    u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a
  ) {
    return "png";
  }
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8) return "jpeg";
  if (u8.length >= 12 && bytesToStr(u8, 0, 4) === "RIFF" && bytesToStr(u8, 8, 12) === "WEBP") return "webp";
  if (
    u8.length >= 6 && bytesToStr(u8, 0, 3) === "GIF" &&
    (bytesToStr(u8, 3, 6) === "87a" || bytesToStr(u8, 3, 6) === "89a")
  ) {
    return "gif";
  }
  return "";
}

function isTextChunkTag(tag) {
  return tag === "iTXt" || tag === "tEXt" || tag === "zTXt";
}

function scanPng(u8) {
  const signals = [];
  let sawIend = false;
  let pos = 8;
  while (pos + 8 <= u8.length) {
    const len = readU32BE(u8, pos);
    const tag = bytesToStr(u8, pos + 4, pos + 8);
    const end = pos + 8 + len + 4;
    if (end > u8.length) {
      if (tag === "caBX") signals.push("c2pa-manifest");
      else if (isTextChunkTag(tag) && hasAnyMarker(u8.subarray(pos), C2PA_MARKERS)) signals.push("xmp-provenance");
      return { signals, ok: false };
    }
    const payload = u8.subarray(pos + 8, pos + 8 + len);
    if (tag === "caBX") {
      signals.push("c2pa-manifest");
    } else if (
      isTextChunkTag(tag) &&
      (hasAnyMarker(payload, C2PA_MARKERS) ||
        (bytesContain(payload, XMP_HEADER, 0) && hasAnyMarker(payload, AI_XMP_MARKERS)))
    ) {
      signals.push("xmp-provenance");
    }
    pos = end;
    if (tag === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIend && pos < u8.length) {
    if (hasAnyMarker(u8.subarray(pos), C2PA_MARKERS)) signals.push("c2pa-manifest");
    return { signals, ok: false };
  }
  return { signals, ok: sawIend || pos === u8.length };
}

function scanJpeg(u8) {
  const signals = [];
  let pos = 2;
  while (pos + 4 <= u8.length) {
    if (u8[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    const marker = u8[pos + 1];
    if (marker === 0xda) break;
    // 0xFF fill bytes before a marker and standalone TEM/SOI/EOI/RSTn carry no
    // length field — skip 2 bytes rather than misreading a size.
    if (marker === 0xff || marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const segLen = (u8[pos + 2] << 8) | u8[pos + 3];
    if (segLen < 2 || pos + 2 + segLen > u8.length) {
      return { signals, ok: false };
    }
    const payload = u8.subarray(pos + 4, pos + 2 + segLen);
    if (marker === 0xeb && bytesContain(payload, "JP", 0) && hasAnyMarker(payload, C2PA_MARKERS)) {
      signals.push("c2pa-manifest");
    } else if (
      marker === 0xe1 &&
      ((bytesContain(payload, XMP_HEADER, 0) &&
        (hasAnyMarker(payload, AI_XMP_MARKERS) || hasAnyMarker(payload, C2PA_MARKERS))) ||
        hasAnyMarker(payload, C2PA_MARKERS))
    ) {
      signals.push("xmp-provenance");
    }
    pos += 2 + segLen;
  }
  if (pos + 4 > u8.length) return { signals, ok: false };
  return { signals, ok: true };
}

function scanWebp(u8) {
  const signals = [];
  let pos = 12;
  while (pos + 8 <= u8.length) {
    const tag = bytesToStr(u8, pos, pos + 4);
    const len = readU32LE(u8, pos + 4);
    const end = pos + 8 + len + (len & 1);
    if (end > u8.length) return { signals, ok: false };
    const payload = u8.subarray(pos + 8, pos + 8 + len);
    if (tag === "XMP " && (hasAnyMarker(payload, AI_XMP_MARKERS) || hasAnyMarker(payload, C2PA_MARKERS))) {
      signals.push("xmp-provenance");
    }
    pos = end;
  }
  return { signals, ok: true };
}

function scanGeneric(u8) {
  const signals = [];
  if (hasAnyMarker(u8, C2PA_MARKERS)) signals.push("credential-bytes");
  if (bytesContain(u8, XMP_HEADER, 0) && (hasAnyMarker(u8, AI_XMP_MARKERS) || hasAnyMarker(u8, C2PA_MARKERS))) {
    signals.push("xmp-provenance");
  }
  return signals;
}

export function inspectCredentialBytes(raw) {
  if (!raw || !raw.length) {
    return { status: "unsupported", format: "", signals: [], detail: "no-local-bytes" };
  }
  const fmt = sniffImageFormat(raw);
  let scan;
  if (fmt === "png") scan = scanPng(raw);
  else if (fmt === "jpeg") scan = scanJpeg(raw);
  else if (fmt === "webp") scan = scanWebp(raw);
  else if (fmt === "gif") scan = { signals: scanGeneric(raw), ok: true };
  else {
    const signals = scanGeneric(raw);
    if (!signals.length) return { status: "unsupported", format: "", signals: [], detail: "unknown-format" };
    return { status: "present_untrusted", format: "", signals, detail: "raw-marker-scan" };
  }
  if (!scan.ok) return { status: "invalid", format: fmt, signals: scan.signals, detail: "container-parse-failed" };
  if (scan.signals.length) {
    return { status: "present_untrusted", format: fmt, signals: scan.signals, detail: "structural-only" };
  }
  return { status: "absent", format: fmt, signals: [], detail: "no-credential-markers" };
}

export function decodeDataUrlBytes(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  const head = dataUrl.slice(5, comma);
  const mime = head.split(";")[0] || "application/octet-stream";
  const payload = dataUrl.slice(comma + 1);
  let bin;
  if (head.includes(";base64")) {
    try {
      bin = atob(payload);
    } catch {
      return null;
    }
  } else {
    try {
      bin = unescape(payload);
    } catch {
      return null;
    }
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i) & 0xff;
  return { mime, bytes };
}

export async function sha256HexBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashImage(image) {
  if (image && typeof image.byteLength === "number" && typeof image.length === "number") {
    return { sha256: await sha256HexBytes(image), status: "sha256" };
  }
  const decoded = decodeDataUrlBytes(image);
  if (decoded) return { sha256: await sha256HexBytes(decoded.bytes), status: "sha256" };
  if (typeof image === "string" && (image.startsWith("http://") || image.startsWith("https://"))) {
    return { sha256: "", status: "remote_url" };
  }
  return { sha256: "", status: "unavailable" };
}

// /generate 與 /edit 回應用的伺服器端 output attestation block。
// 只證明伺服器看到的位元組；永遠不會是 'verified'。
export async function buildOutputProvenance(image, inputImageHashes) {
  const hashed = await hashImage(image);
  const decoded = decodeDataUrlBytes(image);
  const credential = decoded
    ? inspectCredentialBytes(decoded.bytes)
    : { status: "unsupported", format: "", signals: [] };
  const block = {
    outputSha256: hashed.sha256,
    outputHashStatus: hashed.status,
    credentialStatus: credential.status,
    credentialSignals: credential.signals.slice(0),
    format: credential.format,
    inspection: "structural",
  };
  if (Array.isArray(inputImageHashes) && inputImageHashes.length) {
    block.inputImageHashes = inputImageHashes
      .map((value) => String(value || "").toLowerCase())
      .filter((value) => /^[0-9a-f]{64}$/.test(value))
      .slice(0, 16);
  }
  return block;
}
