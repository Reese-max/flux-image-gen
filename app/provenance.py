"""Verifiable generation/edit provenance receipts + Content Credentials inspection.

Internal contract for issue #18: every new generation/edit history record carries
a versioned ProvenanceReceipt that binds the record to its output bytes
(SHA-256), provider/model/settings, and version lineage. Upstream C2PA /
Content Credentials markers on image bytes are inspected into an explicit
status enum; this module performs structural detection only — it never claims
cryptographic ``verified`` without a real signer/trust-list path.

Field names stay camelCase so the receipt schema is identical across the
FastAPI twin, the Cloudflare Worker, and the browser module.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import struct
from datetime import UTC, datetime
from typing import Any

RECEIPT_SCHEMA_VERSION = 1
APP_VERSION_FALLBACK = "v1.4.0"

CREDENTIAL_STATUSES = frozenset(
    {
        "verified",  # reserved: only a validated trust chain may produce this
        "present_untrusted",
        "invalid",
        "absent",
        "unknown_after_transform",
        "unsupported",
    }
)
OUTPUT_HASH_STATUSES = frozenset({"sha256", "remote_url", "unavailable"})
RECEIPT_ACTIONS = frozenset({"generate", "edit", "regenerate"})
EDIT_INPUT_TRANSFORM = "canvas-resize-png"

# Fields copied verbatim into the public/share view. Anything not listed here
# (prompt hashes, input hashes, provider fields) never leaves the local record.
PUBLIC_RECEIPT_FIELDS = (
    "schemaVersion",
    "receiptHash",
    "recordId",
    "action",
    "createdAt",
    "appVersion",
    "provider",
    "model",
    "providerModelRevision",
    "seed",
    "size",
    "steps",
    "cfgScale",
    "mode",
    "outputSha256",
    "outputHashStatus",
    "sourceRecordIds",
    "parentReceiptHash",
    "versionGroupId",
    "versionNumber",
    "credentialStatus",
    "credentialSignals",
    "credentialFormat",
    "transforms",
)

# Allowlisted provider-response provenance fields. Secrets can never pass this
# filter because it is an allowlist, not a denylist.
_SERVER_FIELD_ALLOWLIST = frozenset(
    {
        "outputSha256",
        "credentialStatus",
        "credentialSignals",
        "format",
        "inspection",
        "inputImageHashes",
        "model",
        "provider",
        "claimGenerator",
        "digitalSourceType",
    }
)

_HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")
_C2PA_MARKERS = (b"urn:c2pa", b"c2pa-manifest", b"c2pa.signature", b"c2pa.claim", b"caBX")
_AI_XMP_MARKERS = (
    b"trainedAlgorithmicMedia",
    b"compositeWithTrainedAlgorithmicMedia",
    b"algorithmicallyEnhanced",
    b"digitalSourceType",
)
_XMP_HEADER = b"http://ns.adobe.com/xap/1.0/"
_TEXT_CHUNK_TAGS = (b"iTXt", b"tEXt", b"zTXt")

CREDENTIAL_STATUS_LABELS = {
    "verified": "已驗證 Content Credentials 簽章",
    "present_untrusted": "偵測到 Content Credentials（結構有效，未驗證簽章信任鏈）",
    "invalid": "偵測到 credential 資料，但內容無效或已損毀",
    "absent": "未偵測到 Content Credentials（不代表非 AI 產生）",
    "unknown_after_transform": "輸出經過轉換／重新編碼，credential 狀態無法判定",
    "unsupported": "圖片格式不支援 credential 檢測",
}


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def sha256_hex_bytes(data: bytes) -> str:
    return hashlib.sha256(bytes(data)).hexdigest()


def sha256_hex_text(text: str) -> str:
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()


def decode_data_url(data_url: Any) -> tuple[str, bytes] | None:
    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        return None
    head, sep, payload = data_url.partition(",")
    if not sep:
        return None
    mime = head[5:].split(";", 1)[0] or "application/octet-stream"
    try:
        if ";base64" in head:
            raw = base64.b64decode(payload)
        else:
            from urllib.parse import unquote_to_bytes

            raw = unquote_to_bytes(payload)
    except (binascii.Error, ValueError):
        return None
    return mime, raw


def sniff_image_format(raw: bytes) -> str:
    if len(raw) >= 8 and raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if len(raw) >= 3 and raw[0] == 0xFF and raw[1] == 0xD8:
        return "jpeg"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    if len(raw) >= 6 and raw[:3] == b"GIF" and raw[3:6] in (b"87a", b"89a"):
        return "gif"
    return ""


def _has_c2pa_marker(payload: bytes) -> bool:
    return any(marker in payload for marker in _C2PA_MARKERS)


def _has_xmp_marker(payload: bytes) -> bool:
    return any(marker in payload for marker in _AI_XMP_MARKERS)


def _scan_png(raw: bytes) -> tuple[list[str], bool]:
    """Walk PNG chunks. Returns (provenance signals, structurally_complete)."""
    signals: list[str] = []
    pos = 8
    saw_iend = False
    while pos + 8 <= len(raw):
        length = struct.unpack(">I", raw[pos : pos + 4])[0]
        tag = raw[pos + 4 : pos + 8]
        end = pos + 8 + length + 4  # type + payload + CRC
        if end > len(raw):
            # Truncated/overrun chunk. A credential-bearing tag still counts as
            # detected so the final status is 'invalid', never 'absent'.
            if tag == b"caBX" or (tag in _TEXT_CHUNK_TAGS and _has_c2pa_marker(raw[pos : len(raw)])):
                signals.append("c2pa-manifest" if tag == b"caBX" else "xmp-provenance")
            return signals, False
        payload = raw[pos + 8 : pos + 8 + length]
        if tag == b"caBX":
            signals.append("c2pa-manifest")
        elif tag in _TEXT_CHUNK_TAGS and (_has_c2pa_marker(payload) or (_XMP_HEADER in payload and _has_xmp_marker(payload))):
            signals.append("xmp-provenance")
        pos = end
        if tag == b"IEND":
            saw_iend = True
            break
    if not saw_iend and pos < len(raw):
        # Ran out of bytes mid-structure without reaching IEND.
        if _has_c2pa_marker(raw[pos:]):
            signals.append("c2pa-manifest")
        return signals, False
    return signals, saw_iend or pos == len(raw)


def _scan_jpeg(raw: bytes) -> tuple[list[str], bool]:
    """Walk JPEG segments up to SOS. Returns (signals, structurally_ok)."""
    signals: list[str] = []
    pos = 2
    while pos + 4 <= len(raw):
        if raw[pos] != 0xFF:
            pos += 1
            continue
        marker = raw[pos + 1]
        if marker == 0xDA:  # SOS: compressed scan data follows
            break
        # 0xFF fill bytes before a marker and standalone TEM/SOI/EOI/RSTn
        # carry no length field — skip 2 bytes rather than misreading a size.
        if marker == 0xFF or marker == 0x01 or marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        seg_len = struct.unpack(">H", raw[pos + 2 : pos + 4])[0]
        if seg_len < 2 or pos + 2 + seg_len > len(raw):
            return signals, False
        payload = raw[pos + 4 : pos + 2 + seg_len]
        if marker == 0xEB and payload.startswith(b"JP") and _has_c2pa_marker(payload):
            signals.append("c2pa-manifest")
        elif marker == 0xE1 and (
            (payload.startswith(_XMP_HEADER) and (_has_xmp_marker(payload) or _has_c2pa_marker(payload)))
            or _has_c2pa_marker(payload)
        ):
            signals.append("xmp-provenance")
        pos += 2 + seg_len
    if pos + 4 > len(raw):
        return signals, False
    return signals, True


def _scan_webp(raw: bytes) -> tuple[list[str], bool]:
    signals: list[str] = []
    pos = 12
    while pos + 8 <= len(raw):
        tag = raw[pos : pos + 4]
        length = struct.unpack("<I", raw[pos + 4 : pos + 8])[0]
        end = pos + 8 + length + (length & 1)
        if end > len(raw):
            return signals, False
        payload = raw[pos + 8 : pos + 8 + length]
        if tag == b"XMP " and (_has_xmp_marker(payload) or _has_c2pa_marker(payload)):
            signals.append("xmp-provenance")
        pos = end
    return signals, True


def _scan_generic(raw: bytes) -> list[str]:
    signals: list[str] = []
    if _has_c2pa_marker(raw):
        signals.append("credential-bytes")
    if _XMP_HEADER in raw and (_has_xmp_marker(raw) or _has_c2pa_marker(raw)):
        signals.append("xmp-provenance")
    return signals


def _credential_report(status: str, fmt: str, signals: list[str], detail: str) -> dict[str, Any]:
    return {"status": status, "format": fmt, "signals": signals, "detail": detail}


def inspect_credential(image: Any) -> dict[str, Any]:
    """Inspect image bytes (or a data URL) for embedded provenance credentials.

    Statuses: 'present_untrusted' = credential markers found and the container
    parses cleanly (signature/trust NOT verified); 'invalid' = markers found or
    structure malformed such that inspection failed; 'absent' = clean parse with
    no credential markers; 'unsupported' = not a decodable local image.
    'verified' is never emitted here — no trust chain exists in this layer.
    """
    if isinstance(image, (bytes, bytearray)):
        decoded = ("", bytes(image))
    else:
        decoded = decode_data_url(image) or (None, None)
    raw = decoded[1]
    if raw is None:
        return _credential_report("unsupported", "", [], "no-local-bytes")

    fmt = sniff_image_format(raw)
    if fmt == "png":
        signals, ok = _scan_png(raw)
    elif fmt == "jpeg":
        signals, ok = _scan_jpeg(raw)
    elif fmt == "webp":
        signals, ok = _scan_webp(raw)
    elif fmt == "gif":
        signals, ok = _scan_generic(raw), True
    else:
        signals = _scan_generic(raw)
        if not signals:
            return _credential_report("unsupported", "", [], "unknown-format")
        return _credential_report("present_untrusted", "", signals, "raw-marker-scan")

    if not ok:
        return _credential_report("invalid", fmt, signals, "container-parse-failed")
    if signals:
        return _credential_report("present_untrusted", fmt, signals, "structural-only")
    return _credential_report("absent", fmt, [], "no-credential-markers")


def hash_image(image: Any) -> tuple[str, str]:
    """SHA-256 of decoded image bytes. Remote URLs can't be hashed locally."""
    if isinstance(image, (bytes, bytearray)):
        return sha256_hex_bytes(bytes(image)), "sha256"
    decoded = decode_data_url(image)
    if decoded is not None:
        return sha256_hex_bytes(decoded[1]), "sha256"
    if isinstance(image, str) and (image.startswith("http://") or image.startswith("https://")):
        return "", "remote_url"
    return "", "unavailable"


def _clean_hex64(value: Any) -> str:
    text = _text(value).lower()
    return text if _HEX64.match(text) else ""


def _clean_str_list(value: Any, limit: int = 16, max_len: int = 120) -> list[str]:
    out: list[str] = []
    if isinstance(value, (list, tuple)):
        for item in value:
            text = _text(item)[:max_len]
            if text:
                out.append(text)
            if len(out) >= limit:
                break
    return out


def _clean_hex_list(value: Any, limit: int = 16) -> list[str]:
    out: list[str] = []
    if isinstance(value, (list, tuple)):
        for item in value:
            text = _clean_hex64(item)
            if text:
                out.append(text)
            if len(out) >= limit:
                break
    return out


def sanitize_provider_fields(raw: Any) -> dict[str, Any]:
    """Allowlist filter for provider/server provenance blocks."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key, value in raw.items():
        name = _text(key)
        if name not in _SERVER_FIELD_ALLOWLIST:
            continue
        if name == "outputSha256":
            cleaned = _clean_hex64(value)
            if cleaned:
                out[name] = cleaned
        elif name == "credentialStatus":
            text = _text(value)
            if text in CREDENTIAL_STATUSES:
                out[name] = text
        elif name in ("credentialSignals", "inputImageHashes"):
            out[name] = _clean_hex_list(value) if name == "inputImageHashes" else _clean_str_list(value)
        else:
            out[name] = _text(value)[:200]
    return out


def _canon_scalar(value: Any) -> Any:
    """Canonicalize numbers so Python and JS produce the same receiptHash.

    JSON.stringify(4.0) is '4' and NaN/Infinity become null; json.dumps keeps
    floats and emits bare NaN — normalize before serializing so both runtimes
    hash identical canonical bytes.
    """
    if isinstance(value, dict):
        return {key: _canon_scalar(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canon_scalar(item) for item in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return int(value) if value.is_integer() else value
    return value


def _canonical_json(value: Any) -> str:
    return json.dumps(_canon_scalar(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_receipt_hash(receipt: dict[str, Any]) -> str:
    body = {key: value for key, value in receipt.items() if key != "receiptHash"}
    return sha256_hex_text(_canonical_json(body))


def verify_receipt_hash(receipt: Any) -> bool:
    if not isinstance(receipt, dict):
        return False
    stored = _clean_hex64(receipt.get("receiptHash"))
    if not stored:
        return False
    return compute_receipt_hash(receipt) == stored


def _normalize_action(record: dict[str, Any], action: Any) -> str:
    if action in RECEIPT_ACTIONS:
        return action
    if _text(record.get("recordAction")) == "edit" or _clean_hex_list(record.get("editInputHashes")):
        return "edit"
    if _text(record.get("sourceRecordId")) or _clean_str_list(record.get("sourceRecordIds")):
        return "regenerate"
    return "generate"


def build_receipt(
    record: dict[str, Any],
    *,
    action: str | None = None,
    parent_receipt: dict[str, Any] | None = None,
    app_version: str | None = None,
    now: str | None = None,
    transforms: list[str] | None = None,
) -> dict[str, Any]:
    """Build a versioned provenance receipt for a generation/edit record."""
    source = record if isinstance(record, dict) else {}
    output_sha256, output_status = hash_image(source.get("image"))
    credential = inspect_credential(source.get("image"))
    parent = normalize_receipt(parent_receipt) if isinstance(parent_receipt, dict) else None
    parent_id = _text(source.get("sourceRecordId"))
    source_ids = _clean_str_list(source.get("sourceRecordIds")) or ([parent_id] if parent_id else [])
    input_hashes = _clean_hex_list(source.get("editInputHashes") or source.get("inputImageHashes"))
    prompt_text = _text(source.get("userPrompt")) or _text(source.get("prompt"))
    steps = source.get("steps")
    cfg_scale = source.get("cfgScale")
    transform_list = _clean_str_list(
        transforms if transforms is not None else source.get("transforms"),
        limit=8,
        max_len=80,
    )

    receipt: dict[str, Any] = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "recordId": _text(source.get("id")),
        "action": _normalize_action(source, action),
        "createdAt": _text(source.get("createdAt")) or (now or datetime.now(UTC).isoformat()),
        "appVersion": _text(app_version) or APP_VERSION_FALLBACK,
        "provider": _text(source.get("provider")),
        "model": _text(source.get("model")),
        "providerModelRevision": _text(source.get("providerModelRevision")),
        "seed": int(source["seed"]) if isinstance(source.get("seed"), int) and not isinstance(source.get("seed"), bool) else 0,
        "size": _text(source.get("size")),
        "steps": steps if isinstance(steps, (int, float)) and not isinstance(steps, bool) else None,
        "cfgScale": cfg_scale if isinstance(cfg_scale, (int, float)) and not isinstance(cfg_scale, bool) else None,
        "mode": _text(source.get("mode")),
        "promptSha256": sha256_hex_text(prompt_text) if prompt_text else "",
        "promptPublic": False,
        "outputSha256": output_sha256,
        "outputHashStatus": output_status,
        "sourceRecordIds": source_ids,
        "inputs": [
            {
                "sha256": digest,
                "credentialStatus": "unknown_after_transform",
                "transform": EDIT_INPUT_TRANSFORM,
            }
            for digest in input_hashes
        ],
        "parentReceiptHash": parent["receiptHash"] if parent else "",
        "versionGroupId": _text(source.get("versionGroupId")),
        "versionNumber": (
            max(1, int(source["versionNumber"]))
            if isinstance(source.get("versionNumber"), int) and not isinstance(source.get("versionNumber"), bool)
            else 1
        ),
        "credentialStatus": credential["status"],
        "credentialSignals": list(credential["signals"]),
        "credentialFormat": credential["format"],
        "transforms": transform_list,
        "providerFields": {"server": sanitize_provider_fields(source.get("providerProvenance"))},
    }
    if transform_list and receipt["credentialStatus"] in ("absent", "present_untrusted", "verified"):
        receipt["credentialStatus"] = "unknown_after_transform"
    receipt["receiptHash"] = compute_receipt_hash(receipt)
    return receipt


def normalize_receipt(raw: Any) -> dict[str, Any] | None:
    """Validate + sanitize a stored/exported receipt. Returns None if unusable."""
    if not isinstance(raw, dict):
        return None
    if raw.get("schemaVersion") != RECEIPT_SCHEMA_VERSION:
        return None
    record_id = _text(raw.get("recordId"))
    credential_status = _text(raw.get("credentialStatus"))
    if not record_id or credential_status not in CREDENTIAL_STATUSES:
        return None
    inputs: list[dict[str, str]] = []
    if isinstance(raw.get("inputs"), list):
        for item in raw["inputs"]:
            if not isinstance(item, dict):
                continue
            digest = _clean_hex64(item.get("sha256"))
            if not digest:
                continue
            status = _text(item.get("credentialStatus"))
            inputs.append(
                {
                    "sha256": digest,
                    "credentialStatus": status if status in CREDENTIAL_STATUSES else "unknown_after_transform",
                    "transform": _text(item.get("transform"))[:80],
                }
            )
    normalized: dict[str, Any] = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "recordId": record_id,
        "action": raw.get("action") if raw.get("action") in RECEIPT_ACTIONS else "generate",
        "createdAt": _text(raw.get("createdAt")),
        "appVersion": _text(raw.get("appVersion")),
        "provider": _text(raw.get("provider")),
        "model": _text(raw.get("model")),
        "providerModelRevision": _text(raw.get("providerModelRevision")),
        "seed": raw.get("seed") if isinstance(raw.get("seed"), int) and not isinstance(raw.get("seed"), bool) else 0,
        "size": _text(raw.get("size")),
        "steps": raw.get("steps") if isinstance(raw.get("steps"), (int, float)) and not isinstance(raw.get("steps"), bool) else None,
        "cfgScale": raw.get("cfgScale") if isinstance(raw.get("cfgScale"), (int, float)) and not isinstance(raw.get("cfgScale"), bool) else None,
        "mode": _text(raw.get("mode")),
        "promptSha256": _clean_hex64(raw.get("promptSha256")),
        "promptPublic": raw.get("promptPublic") is True,
        "outputSha256": _clean_hex64(raw.get("outputSha256")),
        "outputHashStatus": raw.get("outputHashStatus") if raw.get("outputHashStatus") in OUTPUT_HASH_STATUSES else "unavailable",
        "sourceRecordIds": _clean_str_list(raw.get("sourceRecordIds")),
        "inputs": inputs,
        "parentReceiptHash": _clean_hex64(raw.get("parentReceiptHash")),
        "versionGroupId": _text(raw.get("versionGroupId")),
        "versionNumber": (
            max(1, int(raw["versionNumber"]))
            if isinstance(raw.get("versionNumber"), int) and not isinstance(raw.get("versionNumber"), bool)
            else 1
        ),
        "credentialStatus": credential_status,
        "credentialSignals": _clean_str_list(raw.get("credentialSignals")),
        "credentialFormat": _text(raw.get("credentialFormat")),
        "transforms": _clean_str_list(raw.get("transforms"), limit=8, max_len=80),
        "providerFields": {
            "server": sanitize_provider_fields(
                raw.get("providerFields", {}).get("server") if isinstance(raw.get("providerFields"), dict) else None
            )
        },
        "receiptHash": _clean_hex64(raw.get("receiptHash")),
    }
    return normalized


def verify_output(receipt: Any, image: Any) -> str:
    """Re-hash the current image and compare to the receipt's outputSha256."""
    if not isinstance(receipt, dict):
        return "unavailable"
    expected = _clean_hex64(receipt.get("outputSha256"))
    if not expected:
        return "unavailable"
    actual, status = hash_image(image)
    if status != "sha256":
        return "unavailable"
    return "match" if actual == expected else "mismatch"


def record_transform(receipt: dict[str, Any], transform: str) -> dict[str, Any]:
    """Return a new receipt recording a transform; invalidates credential claims."""
    name = _text(transform)[:80]
    if not name:
        return dict(receipt)
    updated = dict(receipt)
    transforms = list(updated.get("transforms") or [])
    transforms.append(name)
    updated["transforms"] = transforms
    updated["credentialStatus"] = "unknown_after_transform"
    updated["receiptHash"] = compute_receipt_hash(updated)
    return updated


def public_receipt(receipt: Any) -> dict[str, Any] | None:
    """Share-safe projection: allowlisted fields only, never prompt material."""
    normalized = normalize_receipt(receipt)
    if normalized is None:
        return None
    return {key: normalized[key] for key in PUBLIC_RECEIPT_FIELDS if key in normalized}


def describe_credential_status(status: Any) -> str:
    return CREDENTIAL_STATUS_LABELS.get(_text(status), CREDENTIAL_STATUS_LABELS["unsupported"])


def build_output_provenance(image: Any, input_image_hashes: list[str] | None = None) -> dict[str, Any]:
    """Server-side output attestation block returned by /generate and /edit.

    Attests only what the server can see: the exact bytes it produced and
    structural credential inspection on them. Never claims 'verified'.
    """
    output_sha256, output_status = hash_image(image)
    credential = inspect_credential(image)
    block: dict[str, Any] = {
        "outputSha256": output_sha256,
        "outputHashStatus": output_status,
        "credentialStatus": credential["status"],
        "credentialSignals": list(credential["signals"]),
        "format": credential["format"],
        "inspection": "structural",
    }
    hashes = _clean_hex_list(input_image_hashes)
    if hashes:
        block["inputImageHashes"] = hashes
    return block
