import re
from pathlib import Path


STATIC_DIR = Path(__file__).resolve().parents[1] / "app" / "static"


def read_static(name):
    path = STATIC_DIR / name
    return path.read_text(encoding="utf-8") if path.exists() else ""


def test_pwa_and_mobile_ui_are_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'rel="manifest"' in html
    assert 'href="/manifest.webmanifest"' in html
    assert 'rel="apple-touch-icon"' not in html
    assert 'id="mobileGenerateBar"' in html
    assert 'id="pwaUpdateNotice"' in html
    assert 'id="reloadPwa"' in html
    assert 'registerServiceWorker' in app_js
    assert 'showPwaUpdateNotice' in app_js
    assert 'reloadPwaVersion' in app_js
    assert 'hadServiceWorkerController' in app_js
    assert "if(!hadServiceWorkerController)" in app_js
    assert "serviceWorker.register('/service-worker.js'" in app_js
    assert "postMessage({ type: 'SKIP_WAITING' })" in app_js
    assert '.mobile-generate-bar' in styles
    assert '.pwa-update-notice' in styles
    assert '@media (max-width: 720px)' in styles


def test_service_worker_static_cache_is_safe():
    service_worker_js = read_static("service-worker.js")

    assert "event.request.method !== 'GET'" in service_worker_js
    assert "'/generate'" not in service_worker_js
    assert '"/generate"' not in service_worker_js
    assert "caches.delete" in service_worker_js
    assert "ai-image-generator-pwa-v2" in service_worker_js
    assert "self.skipWaiting()" in service_worker_js
    assert "self.clients.claim()" in service_worker_js
    assert "type === 'SKIP_WAITING'" in service_worker_js



def test_performance_avoids_external_font_payloads():
    html = read_static("index.html")
    styles = read_static("styles.css")

    assert "fonts.googleapis.com" not in html
    assert "fonts.gstatic.com" not in html
    assert '"Noto Sans TC"' not in styles
    assert '"Inter"' not in styles
    assert "-apple-system" in styles


def test_modal_accessibility_and_clipboard_fallback_are_wired():
    app_js = read_static("app.js")
    history_wall_js = read_static("history-wall.js")
    idea_cards_js = read_static("idea-cards.js")
    tutorial_js = read_static("tutorial.js")

    assert "window.ModalA11y" in app_js
    assert "trapModalTab" in app_js
    assert "closeTopAccessibleModal" in app_js
    assert "event.key === 'Escape'" in app_js
    assert "event.key === 'Tab'" in app_js
    assert "fallbackCopyText" in app_js
    assert "navigator.clipboard.writeText(value).catch" in app_js
    assert "document.execCommand('copy')" in app_js
    assert "root.ModalA11y.open(modal" in history_wall_js
    assert "root.ModalA11y.close(modal" in history_wall_js
    assert "root.ModalA11y.open(backdrop" in idea_cards_js
    assert "root.ModalA11y.close(backdrop" in idea_cards_js
    assert "window.ModalA11y.open(tutorialModal" in tutorial_js
    assert "window.ModalA11y.close(tutorialModal" in tutorial_js


def test_prompt_transform_ui_is_wired():
    html = read_static("index.html")
    transform_js = read_static("prompt-transform.js")

    assert 'id="plainPrompt"' in html
    assert 'for="plainPrompt"' in html
    assert 'id="promptStyle"' in html
    assert 'id="transformPrompt"' in html
    assert 'src="/static/prompt-transform.js"' in html
    assert "fetch('/prompt/transform'" in transform_js
    assert "plainPrompt" in transform_js
    assert "transformPrompt" in transform_js


def test_custom_idea_card_ui_is_wired():
    html = read_static("index.html")
    idea_cards_js = read_static("idea-cards.js")

    assert 'id="customIdeaGrid"' in html
    assert 'id="addIdea"' in html
    assert 'id="ideaEditor"' in html
    assert 'src="/static/idea-store.js"' in html
    assert 'src="/static/idea-cards.js"' in html
    assert "IdeaStore.loadCards" in idea_cards_js
    assert "customIdeaGrid" in idea_cards_js
    assert "ImageGenApp.setPromptAndGenerate" in idea_cards_js
    assert "fetch('/prompt/transform'" in idea_cards_js


def test_tutorial_ui_is_wired():
    html = read_static("index.html")
    tutorial_js = read_static("tutorial.js")

    assert 'id="openTutorial"' in html
    assert 'id="tutorialModal"' in html
    assert 'data-tutorial-step="1"' in html
    assert 'data-tutorial-step="4"' in html
    assert 'src="/static/tutorial.js"' in html
    assert "aiImageTutorialSeen.v1" in tutorial_js
    assert "openTutorial" in tutorial_js
    assert "tutorialModal" in tutorial_js


def test_iteration_ux_ui_is_wired():
    html = read_static("index.html")
    styles = read_static("styles.css")

    assert 'id="seed"' in html
    assert 'id="avoid"' in html
    assert 'id="resultActions"' in html
    assert 'id="regenerate"' in html
    assert 'id="copySettings"' in html
    assert 'id="copyPrompt"' in html
    assert 'id="historyWall"' in html
    assert 'id="historyGrid"' in html
    assert 'id="clearHistory"' in html
    assert 'src="/static/generation-settings.js"' in html
    assert 'src="/static/app.js"' in html
    assert 'src="/static/history-store.js"' in html
    assert 'src="/static/history-wall.js"' in html
    assert 'src="/static/tutorial.js"' in html
    assert html.index('src="/static/generation-settings.js"') < html.index('src="/static/app.js"')
    assert html.index('src="/static/history-store.js"') < html.index('src="/static/history-wall.js"')
    assert html.index('src="/static/history-wall.js"') < html.index('src="/static/tutorial.js"')
    assert ".advanced-controls" in styles
    assert ".field-wide" in styles
    assert ".text-input" in styles
    assert ".result-actions" in styles
    assert ".result-actions[hidden]" in styles
    assert ".history-wall" in styles
    assert ".history-head" in styles
    assert ".history-grid" in styles
    assert ".history-card" in styles
    assert ".history-thumb" in styles
    assert ".history-body" in styles
    assert ".history-prompt" in styles
    assert ".history-meta" in styles
    assert ".history-actions" in styles
    assert ".history-empty" in styles


def test_iteration_ux_scripts_integrate_with_app():
    app_js = read_static("app.js")
    history_wall_js = read_static("history-wall.js")

    assert "GenerationSettings.serializeSettings" in app_js
    assert "seed: settings.seed" in app_js
    assert "imagegen:generated" in app_js
    assert "model === 'dev'" in app_js
    assert "copySettings" in app_js
    assert "regenerate" in app_js
    assert "setGenerationSettings" in app_js
    assert "copyText" in app_js
    assert "ImageHistoryStore.loadRecords" in history_wall_js
    assert "ImageHistoryStore.addRecord" in history_wall_js
    assert "downloadHistoryImage" in history_wall_js
    assert "regenerateHistoryImage" in history_wall_js
    assert "textContent" in history_wall_js
    assert "innerHTML" not in history_wall_js
    assert "safeStore" in history_wall_js
    assert "歷史記錄讀取失敗" in history_wall_js
    assert "validateHistoryImageUrl" in history_wall_js
    assert "generationInFlight" in app_js
    assert "shallowClone(generatedRecord)" in app_js
    assert "detail: shallowClone(generatedRecord)" in app_js
    assert "thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : image" in app_js


def test_history_detail_share_and_versions_are_wired():
    html = read_static("index.html")
    history_wall_js = read_static("history-wall.js")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="historyDetailModal"' in html
    assert 'id="historyDetailImage"' in html
    assert 'id="historyDetailPrompt"' in html
    assert 'id="historyDetailProviderPrompt"' in html
    assert 'id="historyVersionList"' in html
    assert 'id="copyHistoryShareText"' in html
    assert 'id="exportHistoryJson"' in html
    assert 'id="hidePromptInShare"' in html
    assert 'openHistoryDetail' in history_wall_js
    assert 'renderVersionList' in history_wall_js
    assert 'copyHistoryShareText' in history_wall_js
    assert 'exportHistoryJson' in history_wall_js
    assert 'sourceRecordId' in app_js
    assert '.history-detail' in styles
    assert '.version-list' in styles


def test_history_search_filters_tags_and_favorites_are_wired():
    html = read_static("index.html")
    history_wall_js = read_static("history-wall.js")
    styles = read_static("styles.css")
    save_tags = re.search(
        r"function saveHistoryTags\(\) \{([\s\S]*?)\n  \}\n\n  function appendMeta",
        history_wall_js,
    ).group(1)
    favorite_handler = re.search(
        r"favorite\.addEventListener\('click', function \(event\) \{([\s\S]*?)\n    \}\);",
        history_wall_js,
    ).group(1)
    record_filter = re.search(
        r"function recordMatchesFilters\(record\) \{([\s\S]*?)\n  \}\n\n  function applyHistoryFilters",
        history_wall_js,
    ).group(1)

    assert 'id="historySearch"' in html
    assert 'id="historyModelFilter"' in html
    assert 'id="historySizeFilter"' in html
    assert 'id="historyFavoritesOnly"' in html
    assert 'id="historyTagEditor"' in html
    assert 'applyHistoryFilters' in history_wall_js
    assert 'toggleHistoryFavorite' in history_wall_js
    assert 'saveHistoryTags' in history_wall_js
    assert 'history-card-favorite' in history_wall_js
    assert '.history-filters' in styles
    assert '.history-tags' in styles
    assert '.history-card-favorite' in styles
    assert "if (!editor)" in save_tags
    assert "標籤輸入欄位尚未就緒" in save_tags
    assert "editor ? editor.value : ''" not in save_tags
    assert "event.stopPropagation();" in favorite_handler
    assert "toggleHistoryFavorite(record);" in favorite_handler
    assert "sourceRecord.prompt" in record_filter
    assert "sourceRecord.providerPrompt" in record_filter
    assert "getRecordTags(sourceRecord)" in record_filter
    assert re.search(
        r"@media \(max-width: 760px\)\s*\{[\s\S]*?\.history-filters\s*\{\s*grid-template-columns:\s*1fr",
        styles,
    )


def test_app_exposes_generation_helpers_for_feature_scripts():
    app_js = read_static("app.js")

    assert "window.ImageGenApp" in app_js
    assert "setPromptAndGenerate" in app_js


def test_app_renders_generated_image_without_html_injection():
    app_js = read_static("app.js")

    assert "stage.innerHTML = '<img src=\"" not in app_js
    assert "document.createElement('img')" in app_js
    assert "img.src = image" in app_js
    assert "img.alt = 'generated image'" in app_js
    assert "stage.appendChild(img)" in app_js


def test_app_validates_image_url_and_renders_errors_as_text():
    app_js = read_static("app.js")

    assert "function validateImageUrl" in app_js
    assert "typeof image !== 'string'" in app_js
    assert "image.indexOf('data:image/') === 0" in app_js
    assert "image.indexOf('http://') === 0" in app_js
    assert "image.indexOf('https://') === 0" in app_js
    assert "stage.innerHTML = '<span class=\"err\">出錯了：" not in app_js
    assert "textContent = '出錯了：' + err.message" in app_js


def test_prompt_enhancer_and_failure_advice_are_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="promptEnhancer"' in html
    assert 'data-enhance-mode="realistic"' in html
    assert 'data-enhance-mode="cinematic"' in html
    assert 'data-enhance-mode="product"' in html
    assert 'data-enhance-mode="cute"' in html
    assert 'data-enhance-mode="clean"' in html
    assert 'data-enhance-mode="fix_artifacts"' in html
    assert 'src="/static/prompt-enhancer.js"' in html
    assert 'src="/static/failure-advice.js"' in html
    assert 'PromptEnhancer.enhancePrompt' in app_js
    assert 'FailureAdvice.getAdvice' in app_js
    assert 'renderFailureAdvice' in app_js
    assert '.prompt-enhancer' in styles
    assert '.failure-advice' in styles


def test_app_shell_stays_es5_friendly_and_mobile_controls_are_single_column():
    styles = read_static("styles.css")

    production_js_paths = sorted(path for path in STATIC_DIR.glob("*.js"))
    assert {path.name for path in production_js_paths} == {
        "app.js",
        "failure-advice.js",
        "generation-settings.js",
        "history-store.js",
        "history-wall.js",
        "idea-cards.js",
        "idea-store.js",
        "prompt-enhancer.js",
        "prompt-transform.js",
        "service-worker.js",
        "tutorial.js",
    }

    for path in production_js_paths:
        source = path.read_text(encoding="utf-8")
        for forbidden in [
            "async function",
            "await ",
            "Object.assign",
            ".replaceChildren",
            ".padStart",
            ".finally(",
            "=>",
            "?.",
        ]:
            assert forbidden not in source, f"{path.name} should not contain {forbidden}"
        assert re.search(r"\bconst\b", source) is None, f"{path.name} should not contain const"
        assert re.search(r"\blet\b", source) is None, f"{path.name} should not contain let"
    assert re.search(
        r"@media \(max-width: 760px\)\s*\{[\s\S]*?\.advanced-controls\s*\{[\s\S]*?grid-template-columns:\s*1fr",
        styles,
    )


def test_app_does_not_wire_frontend_cooldown_or_retry_after_flow():
    app_js = read_static("app.js")

    assert "cooldownTimer" not in app_js
    assert "startCooldown" not in app_js
    assert "retry_after" not in app_js



def test_frontend_error_monitoring_is_wired():
    app_js = read_static("app.js")

    assert "function reportClientError" in app_js
    assert "window.addEventListener('error'" in app_js
    assert "window.addEventListener('unhandledrejection'" in app_js
    assert "'/client-error'" in app_js
    assert "navigator.sendBeacon" in app_js
    assert "fetch('/client-error'" in app_js
    assert "requestId" in app_js
