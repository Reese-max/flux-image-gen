"""Provenance receipt + Content Credentials inspection contract tests.

Covers issue #18: every generation/edit record carries a versioned
ProvenanceReceipt (output SHA-256, provider/model/settings, lineage,
app version), upstream C2PA/Content Credentials are inspected into an
explicit status enum, and tampered output bytes must fail verification.
"""
import base64
import binascii
import hashlib
import json
import struct
import zlib

import pytest

from app.main import app
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch

from app.image_service import GenerationResult
from app.rate_limit import reset_rate_limiter
from app.usage_metrics import reset_usage_metrics


def _load_provenance():
    from app import provenance

    return provenance


# --- deterministic fixtures -------------------------------------------------

PINNED_RECEIPT_HASH = "d124aa58706da03a74f4b83a54b5d57c3afc984fa831256c6dee5a61332fe8c5"

TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", binascii.crc32(tag + payload) & 0xFFFFFFFF)
    )


def _png(extra_chunks=()):
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
    idat = _chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\x00"))
    iend = _chunk(b"IEND", b"")
    return sig + ihdr + b"".join(extra_chunks) + idat + iend


def _png_with_c2pa() -> bytes:
    return _png((_chunk(b"caBX", b"c2pa-manifest-store-bytes"),))


def _png_with_xmp_text() -> bytes:
    return _png((_chunk(b"iTXt", b"XML:com.adobe.xmp\x00urn:c2pa:fixture xmp"),))


def _png_truncated_cabx() -> bytes:
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
    # Declared length (0x1000) far exceeds the bytes actually present.
    corrupt = struct.pack(">I", 0x1000) + b"caBX" + b"short"
    idat = _chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\x00"))
    iend = _chunk(b"IEND", b"")
    return sig + ihdr + corrupt + idat + iend


def _jpeg(app11_payload: bytes | None = None, xmp: bytes | None = None) -> bytes:
    data = b"\xff\xd8"  # SOI
    if app11_payload is not None:
        data += b"\xff\xeb" + struct.pack(">H", len(app11_payload) + 2) + app11_payload
    if xmp is not None:
        data += b"\xff\xe1" + struct.pack(">H", len(xmp) + 2) + xmp
    data += b"\xff\xdb" + struct.pack(">H", 4) + b"\x00\x00"  # DQT stub
    data += b"\xff\xda" + struct.pack(">H", 6) + b"\x00\x00\x00\x00"  # SOS
    data += b"\x11\x22" + b"\xff\xd9"  # scan bytes + EOI
    return data


def _jpeg_with_c2pa() -> bytes:
    jumbf = b"JP" + b"\x00\x00\x00\x0c" + b"jumb" + b"urn:c2pa:fixture-claim"
    return _jpeg(app11_payload=jumbf)


def _jpeg_with_xmp_credential() -> bytes:
    xmp = (
        b"http://ns.adobe.com/xap/1.0/\x00"
        b"<x:xmpmeta><rdf:Description pdfaid:part='1' "
        b"iptc:DigitalSourceType='trainedAlgorithmicMedia'/></x:xmpmeta>"
    )
    return _jpeg(xmp=xmp)


def _data_url(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def _record(**overrides):
    record = {
        "id": "rec-1",
        "userPrompt": "一隻太空貓",
        "providerPrompt": "a space cat",
        "image": _data_url("image/png", base64.b64decode(TINY_PNG_B64)),
        "provider": "workers-ai",
        "model": "schnell",
        "seed": 42,
        "size": "square",
        "steps": 4,
        "cfgScale": None,
        "mode": "normal",
        "width": 1024,
        "height": 1024,
        "versionGroupId": "rec-1",
        "versionNumber": 1,
        "sourceRecordId": "",
        "createdAt": "2026-09-30T00:00:00.000Z",
    }
    record.update(overrides)
    return record


# --- receipt contract -------------------------------------------------------


def test_build_receipt_for_generation_record():
    provenance = _load_provenance()
    record = _record()
    receipt = provenance.build_receipt(record, app_version="v-test")

    assert receipt["schemaVersion"] == 1
    assert receipt["recordId"] == "rec-1"
    assert receipt["action"] == "generate"
    assert receipt["provider"] == "workers-ai"
    assert receipt["model"] == "schnell"
    assert receipt["seed"] == 42
    assert receipt["size"] == "square"
    assert receipt["steps"] == 4
    assert receipt["createdAt"] == "2026-09-30T00:00:00.000Z"
    assert receipt["appVersion"] == "v-test"
    assert receipt["versionGroupId"] == "rec-1"
    assert receipt["versionNumber"] == 1
    # Output hash is the SHA-256 of the decoded image bytes, not the data URL text.
    expected = hashlib.sha256(base64.b64decode(TINY_PNG_B64)).hexdigest()
    assert receipt["outputSha256"] == expected
    assert receipt["outputHashStatus"] == "sha256"
    # Prompt is hashed, never stored.
    assert receipt["promptSha256"] == hashlib.sha256("一隻太空貓".encode("utf-8")).hexdigest()
    blob = json.dumps(receipt, ensure_ascii=False)
    assert "一隻太空貓" not in blob
    assert "a space cat" not in blob
    assert receipt["promptPublic"] is False
    # Receipt hash is deterministic over canonical fields.
    assert receipt["receiptHash"] == provenance.compute_receipt_hash(receipt)
    assert receipt["receiptHash"] != receipt["outputSha256"]


def test_receipt_has_no_prompt_text_or_secret_fields():
    provenance = _load_provenance()
    record = _record(
        providerProvenance={
            "outputSha256": "aa" * 32,
            "credentialStatus": "absent",
            "apiKey": "sk-should-not-survive",
            "deleteToken": "tok",
            "turnstileToken": "ts",
        }
    )
    receipt = provenance.build_receipt(record)
    blob = json.dumps(receipt, ensure_ascii=False)
    assert "一隻太空貓" not in blob
    assert "a space cat" not in blob
    for forbidden in ("apiKey", "deleteToken", "turnstileToken", "api_key", "secret", "password"):
        assert forbidden not in blob
    # allowlisted server fields survive under providerFields.server
    server = receipt["providerFields"]["server"]
    assert server["outputSha256"] == "aa" * 32
    assert server["credentialStatus"] == "absent"


def test_remote_image_hash_status_is_honest():
    provenance = _load_provenance()
    receipt = provenance.build_receipt(_record(image="https://example.com/x.png", imageUrl="https://example.com/x.png"))
    assert receipt["outputSha256"] == ""
    assert receipt["outputHashStatus"] == "remote_url"
    assert provenance.verify_output(receipt, "https://example.com/x.png") == "unavailable"


def test_verify_output_match_and_tamper_mismatch():
    provenance = _load_provenance()
    raw = base64.b64decode(TINY_PNG_B64)
    receipt = provenance.build_receipt(_record())
    assert provenance.verify_output(receipt, _data_url("image/png", raw)) == "match"
    tampered = _data_url("image/png", raw + b"\x00")
    assert provenance.verify_output(receipt, tampered) == "mismatch"
    assert provenance.verify_output(None, tampered) == "unavailable"
    assert provenance.verify_output(receipt, "not-an-image") == "unavailable"


def test_verify_output_does_not_report_valid_after_edit():
    provenance = _load_provenance()
    receipt = provenance.build_receipt(_record())
    different = _data_url("image/png", _png_with_c2pa())
    assert provenance.verify_output(receipt, different) == "mismatch"


# --- credential inspection --------------------------------------------------


def test_credential_absent_on_plain_png():
    provenance = _load_provenance()
    report = provenance.inspect_credential(base64.b64decode(TINY_PNG_B64))
    assert report["status"] == "absent"
    assert report["format"] == "png"
    data_url_report = provenance.inspect_credential(_data_url("image/png", base64.b64decode(TINY_PNG_B64)))
    assert data_url_report["status"] == "absent"


def test_credential_present_untrusted_on_png_cabx_and_xmp():
    provenance = _load_provenance()
    cabx = provenance.inspect_credential(_png_with_c2pa())
    assert cabx["status"] == "present_untrusted"
    assert "c2pa-manifest" in cabx["signals"]
    xmp = provenance.inspect_credential(_png_with_xmp_text())
    assert xmp["status"] == "present_untrusted"
    assert "xmp-provenance" in xmp["signals"]


def test_credential_invalid_on_truncated_cabx():
    provenance = _load_provenance()
    report = provenance.inspect_credential(_png_truncated_cabx())
    assert report["status"] == "invalid"


def test_credential_present_untrusted_on_jpeg_app11_and_xmp():
    provenance = _load_provenance()
    j = provenance.inspect_credential(_jpeg_with_c2pa())
    assert j["status"] == "present_untrusted"
    assert j["format"] == "jpeg"
    assert "c2pa-manifest" in j["signals"]
    x = provenance.inspect_credential(_jpeg_with_xmp_credential())
    assert x["status"] == "present_untrusted"
    assert "xmp-provenance" in x["signals"]


def test_credential_absent_on_plain_jpeg():
    provenance = _load_provenance()
    report = provenance.inspect_credential(_jpeg())
    assert report["status"] == "absent"
    assert report["format"] == "jpeg"


def test_credential_absent_on_jpeg_with_ff_fill_bytes():
    """0xFF fill bytes / TEM markers are legal JPEG — must not trip 'invalid'."""
    provenance = _load_provenance()
    app0 = b"\xff\xe0" + (10).to_bytes(2, "big") + b"JFIF\x00\x01\x01\x00\x00"
    padded = b"\xff\xd8" + b"\xff\xff\xff\x01" + app0 + b"\xff\xda" + b"\x00\x08" + b"DATA" + b"\xff\xd9"
    report = provenance.inspect_credential(padded)
    assert report["format"] == "jpeg"
    assert report["status"] == "absent"


def test_hash_image_accepts_raw_bytes_like_inspect_credential():
    provenance = _load_provenance()
    raw = base64.b64decode(TINY_PNG_B64)
    digest, status = provenance.hash_image(raw)
    assert status == "sha256"
    assert digest == hashlib.sha256(raw).hexdigest()
    digest2, status2 = provenance.hash_image(bytearray(raw))
    assert (digest2, status2) == (digest, "sha256")


def test_record_transform_with_empty_name_is_noop():
    provenance = _load_provenance()
    receipt = provenance.build_receipt(_record())
    assert provenance.record_transform(receipt, "") == receipt
    assert provenance.record_transform(receipt, "   ") == receipt


def test_credential_unsupported_on_garbage_and_remote():
    provenance = _load_provenance()
    assert provenance.inspect_credential(b"hello world not an image")["status"] == "unsupported"
    assert provenance.inspect_credential("https://example.com/x.png")["status"] == "unsupported"
    assert provenance.inspect_credential("")["status"] == "unsupported"


def test_inspect_credential_never_claims_verified():
    """MVP must never self-declare 'verified' without a real trust chain."""
    provenance = _load_provenance()
    for fixture in (_png_with_c2pa(), _jpeg_with_c2pa(), _jpeg_with_xmp_credential()):
        assert provenance.inspect_credential(fixture)["status"] != "verified"


# --- lineage / transforms ---------------------------------------------------


def test_regenerate_receipt_links_parent_hash():
    provenance = _load_provenance()
    parent = provenance.build_receipt(_record(), app_version="v-test")
    child_record = _record(
        id="rec-2",
        image=_data_url("image/png", _png()),
        sourceRecordId="rec-1",
        versionNumber=2,
        createdAt="2026-09-30T01:00:00.000Z",
    )
    child = provenance.build_receipt(child_record, action="regenerate", parent_receipt=parent, app_version="v-test")
    assert child["action"] == "regenerate"
    assert child["sourceRecordIds"] == ["rec-1"]
    assert child["parentReceiptHash"] == parent["receiptHash"]
    assert child["receiptHash"] != parent["receiptHash"]
    # parent receipt is never mutated by child creation
    assert parent["parentReceiptHash"] == ""


def test_edit_receipt_records_input_hashes_and_transform_status():
    provenance = _load_provenance()
    input_hashes = [hashlib.sha256(b"input-a").hexdigest(), hashlib.sha256(b"input-b").hexdigest()]
    receipt = provenance.build_receipt(
        _record(recordAction="edit", editInputHashes=input_hashes),
        action="edit",
    )
    assert receipt["action"] == "edit"
    assert [entry["sha256"] for entry in receipt["inputs"]] == input_hashes
    # canvas re-encode destroys upstream metadata -> honest unknown_after_transform
    for entry in receipt["inputs"]:
        assert entry["credentialStatus"] == "unknown_after_transform"
        assert entry["transform"] == "canvas-resize-png"


def test_record_transform_marks_credential_unknown_after_transform():
    provenance = _load_provenance()
    receipt = provenance.build_receipt(_record(image=_data_url("image/png", _png_with_c2pa())))
    assert receipt["credentialStatus"] == "present_untrusted"
    updated = provenance.record_transform(receipt, "client-reencode-jpeg")
    assert updated["credentialStatus"] == "unknown_after_transform"
    assert "client-reencode-jpeg" in updated["transforms"]
    assert updated["receiptHash"] != receipt["receiptHash"]


# --- normalization / public allowlist --------------------------------------


def test_receipt_hash_canonicalizes_numbers_like_json_stringify():
    """Python must hash cfgScale 4.0 identically to JS's 4 (JSON.stringify)."""
    provenance = _load_provenance()
    float_receipt = dict(provenance.build_receipt(_record(cfgScale=4.0), app_version="v-test"))
    int_receipt = dict(float_receipt)
    int_receipt["cfgScale"] = 4
    assert provenance.compute_receipt_hash(float_receipt) == provenance.compute_receipt_hash(int_receipt)


def test_receipt_hash_pinned_cross_runtime_fixture():
    """Same literal receipt hashed in Python and JS must produce the same value.

    The pinned constant is mirrored in tests/frontend/provenance.test.cjs which
    asserts ImageProvenance.computeReceiptHash on the identical receipt object.
    """
    provenance = _load_provenance()
    receipt = {
        "schemaVersion": 1,
        "recordId": "pin-fixture-1",
        "action": "generate",
        "createdAt": "2026-09-30T00:00:00.000Z",
        "appVersion": "v1.4.0",
        "provider": "nvidia",
        "model": "dev",
        "providerModelRevision": "",
        "seed": 7,
        "size": "square",
        "steps": 30,
        "cfgScale": 4.0,  # canonicalizes to 4, matching JS JSON.stringify
        "mode": "normal",
        "promptSha256": hashlib.sha256("a lighthouse".encode("utf-8")).hexdigest(),
        "promptPublic": False,
        "outputSha256": hashlib.sha256(b"fake-png-bytes").hexdigest(),
        "outputHashStatus": "sha256",
        "sourceRecordIds": [],
        "inputs": [],
        "parentReceiptHash": "",
        "versionGroupId": "grp-1",
        "versionNumber": 2,
        "credentialStatus": "absent",
        "credentialSignals": [],
        "credentialFormat": "png",
        "transforms": [],
        "providerFields": {"server": {}},
        "receiptHash": "",
    }
    assert provenance.compute_receipt_hash(receipt) == PINNED_RECEIPT_HASH


def test_normalize_receipt_roundtrips_and_detects_tamper():
    provenance = _load_provenance()
    receipt = provenance.build_receipt(_record(), app_version="v-test")
    normalized = provenance.normalize_receipt(json.loads(json.dumps(receipt)))
    assert normalized == receipt
    assert provenance.verify_receipt_hash(normalized) is True
    tampered = dict(receipt)
    tampered["provider"] = "evil-provider"
    normalized_tampered = provenance.normalize_receipt(tampered)
    assert provenance.verify_receipt_hash(normalized_tampered) is False
    assert provenance.normalize_receipt("not-a-receipt") is None
    assert provenance.normalize_receipt({"foo": "bar"}) is None


def test_public_receipt_excludes_private_fields():
    provenance = _load_provenance()
    receipt = provenance.build_receipt(_record(), app_version="v-test")
    public = provenance.public_receipt(receipt)
    blob = json.dumps(public, ensure_ascii=False)
    assert "promptSha256" not in blob
    assert "promptPublic" not in blob
    assert "inputs" not in blob
    assert "providerFields" not in blob
    for required in ("receiptHash", "outputSha256", "credentialStatus", "provider", "model", "action"):
        assert required in public


def test_credential_status_labels_are_honest_about_absence():
    provenance = _load_provenance()
    label = provenance.describe_credential_status("absent")
    assert "非 AI" not in label or "不代表" in label
    assert provenance.describe_credential_status("absent") != provenance.describe_credential_status("invalid")
    assert provenance.describe_credential_status("unknown_after_transform") != provenance.describe_credential_status("absent")


# --- server integration ------------------------------------------------------


def test_generate_response_includes_output_provenance():
    reset_rate_limiter()
    reset_usage_metrics()
    client = TestClient(app)
    result = GenerationResult(
        image=_data_url("image/png", base64.b64decode(TINY_PNG_B64)),
        provider="demo",
        model="schnell",
        width=1024,
        height=1024,
        seed=7,
        image_quality={},
    )
    with patch("app.main.generate_image", new_callable=AsyncMock) as mocked:
        mocked.return_value = result
        response = client.post("/generate", json={"prompt": "a cute corgi", "model": "schnell", "size": "square"})
    assert response.status_code == 200
    provenance_block = response.json()["provenance"]
    expected = hashlib.sha256(base64.b64decode(TINY_PNG_B64)).hexdigest()
    assert provenance_block["outputSha256"] == expected
    assert provenance_block["credentialStatus"] == "absent"
    assert provenance_block["format"] == "png"


def test_edit_response_includes_output_provenance_and_input_hashes():
    reset_rate_limiter()
    reset_usage_metrics()
    client = TestClient(app)
    from app.image_service import EditResult

    input_bytes = base64.b64decode(TINY_PNG_B64)
    out_bytes = _png_with_c2pa()
    result = EditResult(image=_data_url("image/png", out_bytes), provider="workers-ai", model="klein", image_count=1)
    with patch("app.main.edit_image", new_callable=AsyncMock) as mocked:
        mocked.return_value = result
        response = client.post(
            "/edit",
            files={"images": ("a.png", input_bytes, "image/png")},
            data={"prompt": "把背景換成雨夜"},
        )
    assert response.status_code == 200
    block = response.json()["provenance"]
    assert block["outputSha256"] == hashlib.sha256(out_bytes).hexdigest()
    assert block["credentialStatus"] == "present_untrusted"
    assert block["inputImageHashes"] == [hashlib.sha256(input_bytes).hexdigest()]


# --- frontend wiring (static contract) ---------------------------------------


def test_frontend_provenance_module_and_wiring():
    from pathlib import Path

    static = Path(__file__).resolve().parents[1] / "app" / "static"
    prov_js = (static / "provenance.js").read_text(encoding="utf-8")
    html = (static / "index.html").read_text(encoding="utf-8")
    store_js = (static / "history-store.js").read_text(encoding="utf-8")
    wall_js = (static / "history-wall.js").read_text(encoding="utf-8")
    edit_js = (static / "image-edit.js").read_text(encoding="utf-8")
    sw_js = (static / "service-worker.js").read_text(encoding="utf-8")

    assert "root.ImageProvenance" in prov_js
    assert "=>" not in prov_js and "?." not in prov_js  # ES5 contract
    # provenance.js must load before history-store so records get receipts
    assert html.index("provenance.js") < html.index("history-store.js")
    assert "provenance.js" in sw_js  # precached for offline/PWA
    assert "ImageProvenance" in store_js
    # Detail surface must really call the provenance API, not just name-drop it
    assert "renderProvenanceSection" in wall_js
    assert "exportHistoryReceipt" in wall_js
    assert "verifyReceiptHash" in wall_js
    assert "verifyOutput" in wall_js
    assert "describeCredentialStatus" in wall_js
    assert "imagegen:generated" in edit_js  # edits enter the history wall


def test_frontend_share_surface_is_allowlisted():
    """Receipt/public share surfaces must not carry prompt text or secrets."""
    from pathlib import Path
    import re

    static = Path(__file__).resolve().parents[1] / "app" / "static"
    prov_js = (static / "provenance.js").read_text(encoding="utf-8")
    assert "PUBLIC_RECEIPT_FIELDS" in prov_js
    assert re.search(r"promptSha256|promptText|userPrompt", prov_js) is not None  # hashed internally
    assert "promptSha256" not in re.search(r"PUBLIC_RECEIPT_FIELDS\s*=\s*\[[^\]]*\]", prov_js, re.S).group(0)
