from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def test_fastapi_upload_dependency_is_declared():
    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")

    assert any(line.strip().lower().startswith("python-multipart") for line in requirements.splitlines())


def test_downloads_never_attach_data_urls_directly_to_download_links():
    app_js = read("app.js")
    history_js = read("history-wall.js")
    download_js = read("download-utils.js")
    html = read("index.html")
    worker = read("service-worker.js")

    assert "ImageDownload.prepareLink" in app_js
    assert "mainDownload.href = image" not in app_js
    assert "dl.href = image" not in app_js
    assert "ImageDownload.trigger" in history_js
    assert "createObjectURL" in download_js
    assert "dataUrlToBlob" in download_js
    assert '/static/download-utils.js' in html
    assert '/static/download-utils.js' in worker


def test_canvas_metadata_tracks_quality_presets():
    tabs_js = read("tabs.js")
    app_js = read("app.js")

    assert "function qualityText()" in tabs_js
    assert "if (!steps && !cfg) { return '平衡'; }" in tabs_js
    assert "if (steps === '10' && cfg === '3') { return '草稿'; }" in tabs_js
    assert "if (steps === '45' && cfg === '4') { return '精緻'; }" in tabs_js
    assert "imagegen:quality-changed" in tabs_js
    assert "imagegen:quality-changed" in app_js


def test_completion_provider_note_matches_actual_provider():
    app_js = read("app.js")

    assert "if(provider === 'pollinations'){ return '（Pollinations 備援）'; }" in app_js
    assert "if(provider === 'nvidia'){ return '（NVIDIA FLUX）'; }" in app_js
    assert "if(provider){ return '（' + providerDisplayName(provider) + '）'; }" in app_js


def test_lock_composition_without_an_image_shows_a_toast():
    app_js = read("app.js")
    styles = read("styles.css")

    assert "showToast(message, 'warn');" in app_js
    assert "message = '先生成一張圖，才能鎖定它的構圖';" in app_js
    assert ".app-toast" in styles


def test_stale_notices_are_created_only_when_relevant():
    html = read("index.html")
    app_js = read("app.js")
    worker = read("service-worker.js")

    assert 'id="demo-notice"' not in html
    assert 'id="pwaUpdateNotice"' not in html
    assert "目前是<b>展示模式</b>" not in html
    assert "if(banner && banner.parentNode){ banner.parentNode.removeChild(banner); }" in app_js
    assert "function createPwaUpdateNotice()" in app_js
    assert "function dismissPwaUpdate()" in app_js
    assert "PWA_UPDATE_DISMISS_KEY" in app_js
    assert "ai-image-generator-pwa-v25" in worker
