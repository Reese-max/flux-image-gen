import re
from pathlib import Path


STATIC_DIR = Path(__file__).resolve().parents[1] / "app" / "static"


def read_static(name):
    path = STATIC_DIR / name
    return path.read_text(encoding="utf-8") if path.exists() else ""


def extract_function_body(source, name):
    match = re.search(r"function " + re.escape(name) + r"\([^)]*\) \{", source)
    assert match, f"{name} should be defined"
    depth = 0
    for index in range(match.end() - 1, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[match.end() - 1:index + 1]
    raise AssertionError(f"{name} body is unterminated")


def test_export_history_json_keeps_blob_url_alive_until_browser_consumes_download():
    """Issue #8: 匯出作品 JSON must produce a file, not a cancelled blob URL."""
    body = extract_function_body(read_static("history-wall.js"), "exportHistoryJson")

    click_at = body.index("link.click()")
    timer_at = body.index("setTimeout(", click_at)
    assert "revokeObjectURL" not in body[click_at:timer_at], (
        "revokeObjectURL must not run synchronously after link.click()"
    )

    # Revoking in the same task as click() cancels the download in Chromium/Firefox.
    # The revocation must be deferred (setTimeout) exactly like downloadHistoryImage.
    deferred = re.search(r"setTimeout\(function \(\) \{[\s\S]*?revokeObjectURL", body[click_at:])
    assert deferred, "revokeObjectURL must run in a deferred setTimeout after link.click()"


def test_export_history_json_downloads_record_payload_with_safe_filename():
    body = extract_function_body(read_static("history-wall.js"), "exportHistoryJson")

    assert "new Blob([JSON.stringify(normalized, null, 2)], { type: 'application/json' })" in body
    assert "link.download = 'history_' + safeFilePart(normalized.id) + '.json'" in body
    assert "document.body.appendChild(link)" in body
    assert "link.click()" in body
    assert "setAppStatus('已匯出備份檔" in body


def test_export_history_json_guards_empty_selection_and_support():
    body = extract_function_body(read_static("history-wall.js"), "exportHistoryJson")

    assert "setAppStatus('尚無可匯出的作品', 'warn')" in body
    assert "typeof root.URL.createObjectURL !== 'function'" in body
    assert "setAppStatus('瀏覽器不支援匯出 JSON', 'fail')" in body
    assert "setAppStatus('作品資料格式不正確，無法匯出', 'fail')" in body
    assert "root.confirm" in body
    assert "setAppStatus('已取消匯出作品 JSON', 'warn')" in body


def test_download_history_image_keeps_deferred_revocation_pattern():
    body = extract_function_body(read_static("history-wall.js"), "downloadHistoryImage")

    click_at = body.index("link.click()")
    deferred = re.search(r"setTimeout\(function \(\) \{[\s\S]*?revokeObjectURL", body[click_at:])
    assert deferred
