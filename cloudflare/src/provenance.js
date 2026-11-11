// 來源 receipt 的伺服器端正規化與雜湊驗證，是 app/static/provenance.js 的
// Worker twin：同一份 receipt_schema_version=1 規則，兩邊修改必須保持一致。
// 只用於驗證瀏覽器提交的 receipt 並產出可公開的欄位；沒有 signer/trust-list
// 時絕不宣稱 verified。

const STATUSES = ["verified", "present_untrusted", "invalid", "absent", "unknown_after_transform", "unsupported"];
const HASH = /^[a-f0-9]{64}$/;

function identifier(value) {
  const text = typeof value === "string" ? value : "";
  return /^[a-z0-9@_. /-]{1,160}$/i.test(text) && !/https?:|token|secret|api.?key/i.test(text) && redactText(text) === text ? text : "";
}

function digest(value) {
  return HASH.test(value) ? value : "";
}

function number(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

function status(value) {
  return STATUSES.indexOf(value) >= 0 ? value : "unsupported";
}

export function redactText(value) {
  return String(value || "").replace(/https?:\/\/[^\s<>"']*[?][^\s<>"']*/gi, "[redacted-url]")
    .replace(/https?:\/\/[^\s<>"'/]+@[^\s<>"']*/gi, "[redacted-url]")
    // Consume the complete quoted value, including spaces and JSON-style
    // quoted keys; otherwise only "Bearer gets removed and the token leaks.
    .replace(/["']?\b(?:authorization|api[_ -]?key|(?:turnstile|delete|access|refresh)?[_ -]?token|secret)\b["']?\s*[:=]\s*(?:[a-z][a-z0-9_-]*\s+)?(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$))/gi, "[redacted]")
    .replace(/["']?\bauthorization\b["']?\s*[:=]\s*(?:[a-z][a-z0-9_-]*\s+)?[^\s,;]+/gi, "[redacted]")
    .replace(/["']?\b(?:api[_ -]?key|(?:turnstile|delete|access|refresh)?[_ -]?token|authorization|secret)\b["']?\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\b(?:sk-(?:proj-)?|nvapi-|ghp_|github_pat_|hf_)[a-z0-9_-]{20,}\b/gi, "[redacted]");
}

function canonical(value) {
  if (Array.isArray(value)) { return "[" + value.map(canonical).join(",") + "]"; }
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const data = bytes && typeof bytes.arrayBuffer === "function" ? await bytes.arrayBuffer() : bytes;
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((n) => `0${n.toString(16)}`.slice(-2)).join("");
}

function credential(value) {
  const source = value || {};
  const codes = Array.isArray(source.codes) ? source.codes.filter((code) => /^[a-z][a-z0-9.]{0,100}$/i.test(code)).slice(0, 32) : [];
  let result = status(source.status);
  if (codes.some((code) => /\.(mismatch|invalid|malformed|revoked)$/.test(code))) { result = "invalid"; }
  return { status: result, codes };
}

export function normalizeInputs(inputs) {
  // 先丟掉非物件項目（null、數字、字串），正規化後再丟掉缺有效摘要的物件；
  // 兩道過濾缺一不可，且必須與前端 twin 同序。
  return (Array.isArray(inputs) ? inputs : []).filter((input) => input && typeof input === "object" && !Array.isArray(input)).slice(0, 4).map((input) => {
    const transformed = input.transform === "resize_reencode";
    return {
      original_sha256: digest(input.original_sha256), submitted_sha256: digest(input.submitted_sha256),
      original_credential_status: status(input.original_credential_status || input.credential_status),
      credential_status: transformed ? "unknown_after_transform" : status(input.credential_status),
      transform: transformed ? "resize_reencode" : "none"
    };
  }).filter((input) => input.original_sha256 && input.submitted_sha256);
}

export function normalizeReceipt(source) {
  if (!source || source.receipt_schema_version !== 1) { return null; }
  const settings = source.settings || {};
  return {
    receipt_schema_version: 1,
    record_id: identifier(source.record_id),
    source_record_ids: (Array.isArray(source.source_record_ids) ? source.source_record_ids : []).map(identifier).filter(Boolean).slice(0, 4),
    inputs: normalizeInputs(source.inputs),
    provider: identifier(source.provider), model: identifier(source.model),
    settings: { seed: number(settings.seed), size: identifier(settings.size), width: number(settings.width) || 0,
      height: number(settings.height) || 0, steps: number(settings.steps), cfg: number(settings.cfg),
      mode: ["generate", "edit", "regenerate"].indexOf(settings.mode) >= 0 ? settings.mode : "generate" },
    prompt_sha256: digest(source.prompt_sha256), provider_prompt_sha256: digest(source.provider_prompt_sha256),
    created_at: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(source.created_at) ? source.created_at : "",
    output_sha256: digest(source.output_sha256), parent_receipt_sha256: digest(source.parent_receipt_sha256),
    version_group_id: identifier(source.version_group_id), version_number: number(source.version_number),
    app_version: identifier(source.app_version), build_version: identifier(source.build_version),
    provider_provenance: { model_revision: identifier(source.provider_provenance && source.provider_provenance.model_revision) },
    credential: credential(source.credential), receipt_sha256: digest(source.receipt_sha256)
  };
}

async function receiptHash(receipt) {
  const content = normalizeReceipt(receipt);
  delete content.receipt_sha256;
  return sha256(canonical(content));
}

export function publicProvenance(raw, bytes) {
  const receipt = normalizeReceipt(raw);
  if (!receipt) { return Promise.reject(new Error("Invalid provenance receipt")); }
  return Promise.all([receiptHash(receipt), sha256(bytes)]).then((hashes) => {
    if (receipt.receipt_sha256 !== hashes[0] || receipt.output_sha256 !== hashes[1]) { throw new Error("Provenance receipt/output hash mismatch"); }
    return {
    receipt_schema_version: receipt.receipt_schema_version, record_id: receipt.record_id,
    provider: receipt.provider, model: receipt.model, output_sha256: receipt.output_sha256,
    receipt_sha256: receipt.receipt_sha256,
    // A browser's claimed issuer trust is not server-side C2PA verification.
    credential_status: receipt.credential.status === "verified" ? "present_untrusted" : receipt.credential.status,
    version_group_id: receipt.version_group_id, version_number: receipt.version_number,
    source_record_ids: receipt.source_record_ids, parent_receipt_sha256: receipt.parent_receipt_sha256,
    created_at: receipt.created_at, app_version: receipt.app_version, build_version: receipt.build_version
    };
  });
}
