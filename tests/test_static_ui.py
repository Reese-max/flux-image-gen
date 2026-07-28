import hashlib
import re
from pathlib import Path


STATIC_DIR = Path(__file__).resolve().parents[1] / "app" / "static"
ROOT_DIR = Path(__file__).resolve().parents[1]


def read_static(name):
    path = STATIC_DIR / name
    return path.read_text(encoding="utf-8") if path.exists() else ""


def compute_static_fingerprint():
    """app/static 下所有會進 service worker 快取的 HTML/CSS/JS 的合併雜湊。

    排除 service-worker.js 自己（雜湊就存在它裡面，納入會自我參照）。行尾正規化成
    LF，否則同一份原始碼在 Windows（CRLF）與 CI（LF）會算出不同雜湊。
    """
    digest = hashlib.sha256()
    for path in sorted(STATIC_DIR.glob("*.*"), key=lambda p: p.name):
        if path.suffix not in {".html", ".css", ".js"} or path.name == "service-worker.js":
            continue
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_text(encoding="utf-8").replace("\r\n", "\n").encode("utf-8"))
    return digest.hexdigest()[:12]


def read_repo(path):
    return (ROOT_DIR / path).read_text(encoding="utf-8")


def test_product_branding_seo_and_app_metadata_are_wired():
    html = read_static("index.html")
    manifest = read_static("manifest.webmanifest")

    assert "<title>Fluxi 中文 AI 圖片產生器｜白話中文直接生成圖片</title>" in html
    assert 'meta name="description" content="中文 AI 圖片產生器：輸入白話中文，自動生成簡報、社群、產品與角色圖片。"' in html
    assert 'property="og:title" content="Fluxi 中文 AI 圖片產生器"' in html
    assert 'property="og:description" content="輸入白話中文，自動生成簡報、社群、產品與角色圖片。"' in html
    assert 'property="og:image" content="https://flux-image-gen.irisx-tracker.workers.dev/static/og.jpg"' in html
    assert 'name="twitter:title" content="Fluxi 中文 AI 圖片產生器"' in html
    assert 'name="twitter:description" content="輸入白話中文，自動生成簡報、社群、產品與角色圖片。"' in html
    assert '<span class="brand-name">Fluxi</span>' in html
    assert "打中文就出圖 · 免學提示詞 · 適合簡報和社群" in html
    assert "Fluxi 中文 AI 圖片產生器 · 版本 v1.4.0" in html
    assert '"name": "Fluxi 中文 AI 圖片產生器"' in manifest
    assert '"short_name": "Fluxi 生圖"' in manifest
    assert '"description": "輸入白話中文，自動生成簡報、社群、產品與角色圖片。"' in manifest
    assert '"purpose": "any maskable"' in manifest


def test_seo_discovery_signals_are_wired():
    """canonical、robots 與 JSON-LD 結構化資料，利於搜尋收錄與分享。"""
    import json as _json

    html = read_static("index.html")
    assert 'rel="canonical" href="https://flux-image-gen.irisx-tracker.workers.dev/"' in html
    assert 'name="robots" content="index,follow"' in html
    assert 'type="application/ld+json"' in html

    match = re.search(r'<script type="application/ld\+json">\s*(\{.*?\})\s*</script>', html, re.S)
    assert match, "找不到 JSON-LD 區塊"
    data = _json.loads(match.group(1))
    assert data["@type"] == "WebApplication"
    assert data["name"] == "Fluxi 中文 AI 圖片產生器"
    assert data["inLanguage"] == "zh-Hant"


def test_showcase_images_have_explicit_dimensions():
    """範例圖需帶 width/height，避免版面位移（CLS）並通過最佳實務檢查。"""
    html = read_static("index.html")
    example_imgs = re.findall(r'<img[^>]*src="/static/examples/[^"]+\.webp"[^>]*>', html)
    example_imgs += re.findall(r'<img class="idea-thumb"[^>]*>', html)
    assert len(example_imgs) >= 13
    for tag in example_imgs:
        assert 'width="' in tag and 'height="' in tag, f"缺少尺寸：{tag[:80]}"


def test_use_case_size_presets_are_productized():
    html = read_static("index.html")
    app_js = read_static("app.js")

    for label in [
        "PPT 橫式 16:9（1344×768）",
        "IG 貼文 1:1（1024×1024）",
        "IG 限動 / Reels / Shorts 9:16（768×1344）",
        "YouTube 縮圖 16:9（1344×768）",
        "手機桌布 9:19.5（768×1664）",
        "海報 3:4（960×1280）",
        "A4 插圖（896×1280）",
        "網頁 Hero 21:9（1792×768）",
    ]:
        assert label in html
    for value in [
        'value="ig_post"',
        'value="ppt_16_9"',
        'value="ig_story"',
        'value="youtube_thumb"',
        'value="mobile_wallpaper"',
        'value="poster_3_4"',
        'value="a4_illustration"',
        'value="hero_21_9"',
    ]:
        assert value in html
    assert "if(useCase === 'ppt'){ return 'ppt_16_9'; }" in app_js
    assert "if(useCase === 'thumbnail'){ return 'youtube_thumb'; }" in app_js
    assert "if(useCase === 'story'){ return 'ig_story'; }" in app_js
    assert "if(useCase === 'wallpaper'){ return 'mobile_wallpaper'; }" in app_js
    assert "if(useCase === 'poster'){ return 'poster_3_4'; }" in app_js
    assert "if(useCase === 'hero'){ return 'hero_21_9'; }" in app_js
    assert "function normalizeSizePreset" in app_js
    assert "if(size === 'square'){ return 'ig_post'; }" in app_js
    assert "if(size === 'landscape'){ return 'ppt_16_9'; }" in app_js
    assert "if(size === 'portrait'){ return 'ig_story'; }" in app_js
    assert "if(preset === 'custom')" in app_js
    assert "width: el('customWidth') ? el('customWidth').value : ''" in app_js
    assert "height: el('customHeight') ? el('customHeight').value : ''" in app_js
    assert "updateCustomSizeVisibility" in app_js
    assert "if(preset === 'mobile_wallpaper'){ return {width: 768, height: 1664}; }" in app_js


def test_public_deployment_checklist_documents_required_gates():
    readme = read_repo("README.md")
    checklist = read_repo("docs/deployment-checklist.md")

    assert "docs/deployment-checklist.md" in readme
    assert "docs/release-acceptance-checklist.md" in readme
    assert "Wrangler secrets" in readme
    assert "docs/release-acceptance-checklist.md" in checklist
    assert "Release blocker" in checklist
    for required in [
        "NVIDIA_API_KEY",
        "GEMINI_API_KEY",
        "VISION_QA_ENABLED",
        "TURNSTILE_SECRET_KEY",
        "GALLERY_ADMIN_TOKEN",
        "X-Gallery-Admin-Token",
        "TURNSTILE_REQUIRED = \"true\"",
        "TURNSTILE_SITE_KEY",
        "IMAGE_BUCKET",
        "GENERATE_RATE_LIMITER",
        "USAGE_ESTIMATED_COST_USD_PER_IMAGE",
        "USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST",
        "python scripts\\scan_public_secrets.py",
        "python scripts\\check_deployment_preflight.py",
        "python scripts\\check_deployment_preflight.py --public",
        "python scripts\\smoke_live_provider.py --base-url https://<your-domain> --expect-mode live",
        "npm --prefix cloudflare run sync:check",
        "npm --prefix cloudflare run check:wrangler",
        "npm --prefix cloudflare run check:wrangler -- --verbose",
        "npm --prefix cloudflare run check",
        "Node 20 或 22 LTS",
        "npm --prefix cloudflare test",
        "npm --prefix cloudflare run qa:network",
        "npm --prefix cloudflare run qa:mobile",
        "npm --prefix cloudflare run qa:a11y",
        "npm --prefix cloudflare run deploy:dry-run",
        "node scripts\\verify.mjs",
        "deleteTokenHash",
        "promptPublic=false",
        "/generate",
        "/generate/batch",
        "/edit",
        "/api/gallery",
    ]:
        assert required in checklist
    assert "不可持久化到 `localStorage`" in checklist
    assert "驗證失敗不得呼叫模型" in checklist
    assert "未授權即可列出 R2 metadata" in checklist
    assert "分享頁在 `promptPublic=false` 時仍顯示完整 prompt" in checklist


def test_productization_spec_coverage_matrix_tracks_all_tasks_and_gaps():
    coverage = read_repo("docs/spec-coverage.md")

    for task_number in range(1, 51):
        assert f"TASK-{task_number:03d}" in coverage
    for milestone in range(1, 15):
        assert f"Milestone {milestone}" in coverage
    for required in [
        "ProviderStatus",
        "GenerationState",
        "Prompt Compiler",
        "AgentStep",
        "QAReport",
        "PromptCard",
        "Rate Limit",
        "Turnstile",
        "Prompt Moderation",
        "scan_public_secrets.py",
        "check_deployment_preflight.py",
        "release-acceptance-checklist.md",
        "smoke_live_provider.py",
        "network-interrupted-qa.mjs",
        "mobile-generation-qa.mjs",
        "accessibility-keyboard-qa.mjs",
        "測試 Prompt 集",
        "錯誤情境測試",
    ]:
        assert required in coverage
    for known_gap in [
        "真實視覺 QA",
        "自動重試",
        "部署驗證",
        "登入與配額",
        "參考圖一致性",
        "法務與授權",
        "Release acceptance",
    ]:
        assert known_gap in coverage


def test_release_acceptance_checklist_tracks_manual_blockers():
    checklist = read_repo("docs/release-acceptance-checklist.md")

    for required in [
        "Release blocker",
        "正式網域與 health / provider 一致性",
        "python scripts\\scan_public_secrets.py",
        "python scripts\\check_deployment_preflight.py --public",
        "npm --prefix cloudflare run check:wrangler",
        "診斷輸出需遮罩帳號 email / account id / token",
        "Node 20 或 22 LTS",
        "node scripts\\verify.mjs",
        "python scripts\\smoke_live_provider.py --base-url https://<正式網域> --expect-mode live",
        "--check-generate --confirm-cost",
        "iPhone Safari",
        "Android Chrome",
        "螢幕閱讀器",
        "用途帶入尺寸",
        "張數明確可控",
        "R2 gallery save",
        "分享頁隱藏 prompt",
        "Turnstile 真實驗證",
        "Rate limit",
        "成本估算校準",
        "隱私政策法務確認",
        "授權與商用說明法務確認",
        "Gallery 範例素材權利",
        "Sign-off",
        "可公開",
        "可內部預覽",
        "不可公開",
    ]:
        assert required in checklist


def test_example_gallery_applies_prompts_without_auto_generation():
    html = read_static("index.html")
    app_js = read_static("app.js")
    hf_ideas_js = read_static("hf-ideas.js")
    prompt_pack_js = read_static("prompt-pack.js")
    styles = read_static("styles.css")

    assert 'id="exampleGallery"' in html
    assert '範例 Gallery' in html
    assert '不會直接消耗生成額度' in html
    assert '點一下只帶入描述，不會自動消耗額度' in html
    assert html.count('class="example-card"') >= 8
    for category in [
        "PPT 插圖",
        "產品照",
        "角色設計",
        "動漫插畫",
        "美食攝影",
        "建築室內",
        "科幻概念",
        "手機桌布",
    ]:
        assert category in html
    assert 'class="btn mini secondary apply-example"' in html
    assert 'data-example-prompt=' in html
    assert 'data-example-style=' in html
    assert 'data-example-use-case=' in html
    assert 'data-example-size=' in html
    assert "function applyExampleGalleryPrompt" in app_js
    assert "findExampleCard" in app_js
    assert "document.querySelectorAll('.apply-example')" in app_js
    assert "applyExampleGalleryPrompt(findExampleCard(button))" in app_js
    example_function = re.search(
        r"function applyExampleGalleryPrompt\(card\)\{([\s\S]*?)\n\}\n\nfunction getLastGeneration",
        app_js,
    ).group(1)
    assert "plain.value = promptValue" in example_function
    assert "provider.value = ''" in example_function
    assert "setStatus('已套用範例到輸入框；確認後再按「生成圖片」，不會自動消耗額度。'" in example_function
    assert "generate()" not in example_function
    assert "function setPromptForReview" in app_js
    # 靈感卡改走 applyInspiration：中文進主框、不彈開進階、絕不觸發生成。
    assert "function applyInspiration" in app_js
    inspiration_function = re.search(
        r"function applyInspiration\(zh, en, label\)\{([\s\S]*?)\n\}",
        app_js,
    ).group(1)
    assert "el('plainPrompt').value = zh" in inspiration_function
    assert "advanced.open = true" not in inspiration_function
    assert "generate()" not in inspiration_function
    assert "applyInspiration(card.getAttribute('data-plain'), card.getAttribute('data-prompt'), '隨機驚喜')" in app_js
    assert "applyInspiration(button.getAttribute('data-plain'), button.getAttribute('data-prompt'), '靈感')" in app_js
    idea_handlers = re.search(
        r"el\('random'\)\.addEventListener\('click'([\s\S]*?)el\('prompt'\)\.addEventListener",
        app_js,
    ).group(1)
    assert "generate()" not in idea_handlers
    assert "app.applyInspiration(item.zh, item.en, 'HF 靈感')" in hf_ideas_js
    assert "app.applyInspiration(card.zh, card.en, '精選提示詞')" in prompt_pack_js
    assert ".example-gallery" in styles
    assert ".example-grid" in styles
    assert ".example-card" in styles


def test_showcase_images_are_wired_and_present():
    """範例 Gallery 縮圖與靈感鈕都改用站台自生的真實範例圖，且檔案必須存在（避免破圖）。"""
    html = read_static("index.html")
    styles = read_static("styles.css")
    examples_dir = STATIC_DIR / "examples"

    gallery_imgs = re.findall(r'<div class="example-thumb"><img[^>]*\sdata-src="(/static/examples/[^"]+\.webp)"', html)
    idea_imgs = re.findall(r'<img class="idea-thumb"[^>]*\sdata-src="(/static/examples/[^"]+\.webp)"', html)
    assert len(gallery_imgs) >= 8
    assert len(idea_imgs) == 5

    for src in gallery_imgs + idea_imgs:
        name = src.rsplit("/", 1)[-1]
        assert (examples_dir / name).exists(), f"缺少範例圖：{name}"

    # 縮圖用 IntersectionObserver 延後設定 src，避免瀏覽器原生 lazy-load
    # 在首屏外預抓大量圖檔；CSS 仍保留固定尺寸與 cover 樣式。
    assert html.count('loading="lazy"') >= 13
    prompt_pack_js = read_static("prompt-pack.js")
    assert "function observeLazyImages" in prompt_pack_js
    assert "img.getAttribute('data-src')" in prompt_pack_js
    assert "TRANSPARENT_PLACEHOLDER" in prompt_pack_js
    assert "rootMargin: '100px 0px'" in prompt_pack_js
    # 內建靈感卡帶 data-plain（中文）＋ data-prompt（英文 provider）：中文進主框、免學提示詞。
    assert html.count('<button class="idea" type="button" data-plain=') == 5
    assert html.count(' data-prompt=') == 5
    assert html.count("v1.4.0") == 2
    assert ".example-thumb img" in styles
    assert ".idea .idea-thumb" in styles


def test_share_template_links_can_prefill_generation_form_without_auto_generation():
    app_js = read_static("app.js")

    assert "function applyTemplateFromUrl" in app_js
    assert "new URLSearchParams(window.location.search || '')" in app_js
    assert "params.get('prompt')" in app_js
    assert "el('prompt').value = promptValue" in app_js
    assert "params.get('model') || params.get('size') || params.get('width') || params.get('height') || params.get('style') || params.get('useCase')" in app_js
    assert "setSelectIfOptionExists('model', params.get('model'))" in app_js
    assert "setSelectIfOptionExists('size', params.get('size'))" in app_js
    assert "setSelectIfOptionExists('promptStyle', params.get('style'))" in app_js
    assert "setSelectIfOptionExists('useCase', params.get('useCase'))" in app_js
    assert "el('advancedSettings').open = true" in app_js
    assert "已從分享頁套用 prompt 模板" in app_js
    assert "已從分享頁套用公開設定" in app_js
    template_function = re.search(
        r"function applyTemplateFromUrl\(\)\{([\s\S]*?)\n\}\nfunction refreshProvider",
        app_js,
    ).group(1)
    assert "generate()" not in template_function
    assert "if(!promptValue){ return; }" not in template_function


def test_main_generation_accessibility_is_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    prompt_transform_js = read_static("prompt-transform.js")
    keyboard_e2e = read_repo("tests/e2e/accessibility-keyboard-qa.mjs")
    styles = read_static("styles.css")

    assert 'id="provider-pill" class="pill" title="服務狀態" role="status" aria-live="polite" aria-atomic="true"' in html
    assert 'id="demo-notice" class="demo-notice" role="status" aria-live="polite"' in html
    assert 'id="plainPromptHelp" class="visually-hidden"' in html
    assert 'id="plainPrompt" rows="2" maxlength="2000" aria-describedby="plainPromptHelp status" aria-required="true"' in html
    assert 'id="promptStyle" aria-label="選擇圖片風格"' in html
    assert 'id="useCase" aria-label="選擇圖片用途"' in html
    assert 'id="go" class="btn primary hero-generate" type="button" aria-describedby="status"' in html
    assert 'id="transformStatus" class="transform-status" role="status" aria-live="polite" aria-atomic="true"' in html
    assert 'id="status" class="status" role="status" aria-live="polite" aria-atomic="true"' in html
    assert 'id="stage" role="region" aria-label="生成結果，可使用滑鼠滾輪縮放、拖曳平移，或鍵盤加減號縮放" aria-live="polite" aria-busy="false" tabindex="0"' in html
    assert 'class="generation-workspace" id="generationWorkspace"' in html
    assert 'id="generationControls" aria-label="生成設定面板"' in html
    assert 'id="generationPreview" aria-label="圖片預覽工作區"' in html
    assert 'id="workspaceDivider" class="workspace-divider" role="separator"' in html
    assert '<h2>生成畫布</h2>' in html
    assert 'id="canvasStatusbar"' in html
    assert 'id="canvasPresetChip"' in html
    assert 'id="openTutorialTopbar"' in html
    assert 'class="result-heading" id="resultHeading"' in html
    assert 'id="mobileGenerateBar" class="mobile-generate-bar" role="region" aria-label="手機固定生成列"' in html
    assert 'id="mobileGenerateSummary" class="mobile-generate-summary" aria-live="polite"' in html
    assert 'id="mobileGenerate" class="btn primary" type="button" aria-describedby="mobileGenerateSummary status"' in html
    assert "function setFieldInvalid" in app_js
    assert "function setStageBusy" in app_js
    assert "function revealResultStage" in app_js
    assert "var scrollTarget = el('generationPreview') || el('resultHeading') || stage" in app_js
    assert "function initGenerationWorkspace" in app_js
    assert "function applyWorkspaceState" in app_js
    assert "WORKSPACE_STORAGE_KEY = 'fluxiGenerationWorkspace.v1'" in app_js
    assert "event.key === 'ArrowLeft'" in app_js
    assert "event.key === 'ArrowRight'" in app_js
    assert "setPreviewScaleMode('actual')" in app_js
    assert "scrollTarget.scrollIntoView({ behavior: shouldFocus || reduceMotion ? 'auto' : 'smooth', block: 'start' })" in app_js
    assert "status.setAttribute('role', cls === 'fail' ? 'alert' : 'status')" in app_js
    assert "go.setAttribute('aria-disabled'" in app_js
    assert "go.setAttribute('aria-busy'" in app_js
    assert "mobile.setAttribute('aria-disabled'" in app_js
    assert "stage.setAttribute('aria-busy', on ? 'true' : 'false')" in app_js
    assert "field.setAttribute('aria-invalid', 'true')" in app_js
    assert "field.setAttribute('aria-errormessage', 'status')" in app_js
    assert "stage.setAttribute('aria-live', cls === 'err' ? 'off' : 'polite')" in app_js
    assert "node.setAttribute('role', 'alert')" not in app_js
    assert "spinner.setAttribute('role', 'status')" in app_js
    assert "img.alt = '生成完成的圖片'" in app_js
    assert "img.alt = '生成圖片變體第 ' + String(index + 1) + ' 張'" in app_js
    assert "event.key === 'Tab'" not in prompt_transform_js
    assert "空 prompt 錯誤可被螢幕閱讀器讀到" in keyboard_e2e
    assert "鍵盤 Tab 可抵達主要生成按鈕" in keyboard_e2e
    assert "鍵盤主流程可完成生成並恢復可操作狀態" in keyboard_e2e
    assert "成功後結果操作可用鍵盤抵達" in keyboard_e2e
    assert 'textarea[aria-invalid="true"]' in styles
    assert 'button:focus-visible' in styles
    assert '.stage:focus-visible' in styles
    assert '@media (min-width: 700px)' in styles
    assert 'grid-template-columns: minmax(0, 1.25fr) minmax(250px, .75fr)' in styles
    assert '.generation-workspace' in styles
    assert 'grid-template-columns: minmax(320px, var(--control-panel-width)) 10px minmax(0, 1fr)' in styles
    assert '.generation-workspace.is-controls-collapsed' in styles
    assert 'body.invoke-inspired' not in styles
    assert 'height: auto;' in styles
    assert '.canvas-statusbar' in styles
    assert '@media (max-width: 980px)' in styles


def test_mobile_result_cards_can_swipe_and_save():
    app_js = read_static("app.js")
    styles = read_static("styles.css")
    mobile_e2e = read_repo("tests/e2e/mobile-generation-qa.mjs")

    assert "function createMobileSaveHint" in app_js
    assert "手機上可按「下載」，或長按圖片保存。多張結果可左右滑動挑選。" in app_js
    assert "grid.setAttribute('role', 'list')" in app_js
    assert "grid.setAttribute('aria-label', '多張生成結果，可左右滑動挑選')" in app_js
    assert "card.setAttribute('role', 'listitem')" in app_js
    assert "viewer.className = 'batch-viewer'" in app_js
    assert "mainImage.className = 'batch-main-image'" in app_js
    assert "thumb.className = 'batch-thumb'" in app_js
    assert "stage.classList.add('has-batch-results')" in app_js
    assert "stage.classList.add('has-mobile-save')" in app_js
    assert "stage.appendChild(createMobileSaveHint())" in app_js
    assert ".mobile-save-hint" in styles
    assert ".stage.has-batch-results" in styles
    assert ".batch-main-image-wrap" in styles
    assert ".batch-thumb[aria-pressed=\"true\"]" in styles
    assert "scroll-snap-type: x mandatory" in styles
    assert "-webkit-overflow-scrolling: touch" in styles
    assert "scroll-snap-align: center" in styles
    assert re.search(
        r"@media \(max-width: 560px\)\s*\{[\s\S]*?\.batch-grid\s*\{[\s\S]*?display:\s*flex",
        styles,
    )
    assert "手機底部生成列固定可用" in mobile_e2e
    assert "手機多張結果卡片可左右滑動" in mobile_e2e
    assert "手機結果顯示保存提示" in mobile_e2e


def test_task_050_frontend_error_scenarios_are_wired():
    app_js = read_static("app.js")
    failure_advice_js = read_static("failure-advice.js")
    history_wall_js = read_static("history-wall.js")
    history_store_js = read_static("history-store.js")
    network_e2e = read_repo("tests/e2e/network-interrupted-qa.mjs")

    assert "if(generationInFlight || retrySecondsRemaining())" in app_js
    assert "return Promise.resolve()" in app_js
    assert "function showGenerateFailure" in app_js
    assert "reportClientError(originalError || new Error(message)" in app_js
    assert "renderFailureAdvice(failure.adviceCode || failure.code || 'unknown'" in app_js
    assert "setGenerationState('error')" in app_js
    assert "setResultActionsVisible(false)" in app_js
    assert "renderStageText(stage, '出錯了：' + message" in app_js
    assert "網路連線中斷" in failure_advice_js
    assert "目前輸入內容仍保留，不需要重新輸入" in failure_advice_js
    assert "網路中斷顯示專用建議" in network_e2e
    assert "使用者中文輸入未遺失" in network_e2e
    assert "失敗時不建立歷史作品" in network_e2e
    assert "確定要清空全部歷史記錄嗎？此動作無法復原。" in history_wall_js
    assert "已取消清空歷史" in history_wall_js
    assert "確定要刪除已選取的 " in history_wall_js
    assert "while (true)" in history_store_js
    assert "nextRecords.pop()" in history_store_js


def test_pwa_and_mobile_ui_are_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'rel="manifest"' in html
    assert 'href="/manifest.webmanifest"' in html
    assert 'rel="apple-touch-icon"' in html
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


def test_tab_switch_resets_scroll_without_overriding_ideas_deep_link():
    tabs_js = read_static("tabs.js")
    activate = re.search(
        r"function activate\(name, focusTab, options\) \{([\s\S]*?)\n  \}\n\n  tabs\.forEach",
        tabs_js,
    )
    ideas_route = re.search(
        r"if \(name === 'ideas'\) \{([\s\S]*?)\n    \}",
        tabs_js,
    )

    assert activate
    assert ideas_route
    assert "function scrollToPanelStart(panel)" in tabs_js
    assert "getComputedStyle(tablist).top" in tabs_js
    assert "scrollToPanelStart(activePanel)" in activate.group(1)
    assert "options.skipPanelScroll" in activate.group(1)
    assert "skipPanelScroll: true" in ideas_route.group(1)
    assert ideas_route.group(1).index("activate('generate'") < ideas_route.group(1).index("scrollToIdeas()")
    assert "scrollToPanelStart(usagePanel)" in tabs_js
    assert "activate(nameOf(tabs[0]), false, { skipPanelScroll: true })" in tabs_js


def test_service_worker_static_cache_is_safe():
    service_worker_js = read_static("service-worker.js")
    install_handler = service_worker_js.split("self.addEventListener('install'", 1)[1].split(
        "self.addEventListener('activate'", 1
    )[0]
    message_handler = service_worker_js.split("self.addEventListener('message'", 1)[1]

    assert "request.method !== 'GET'" in service_worker_js
    assert "'/generate'" not in service_worker_js
    assert '"/generate"' not in service_worker_js
    assert "caches.delete" in service_worker_js
    assert "ai-image-generator-pwa-v29" in service_worker_js
    # HTML 與靜態資產都 network-first，避免新版 HTML 搭配舊版 JS。
    assert "return network.then(function(response){ return response || cached; });" in service_worker_js
    assert "return cached || network;" not in service_worker_js
    assert "self.skipWaiting()" not in install_handler
    assert "self.skipWaiting()" in message_handler
    assert "event.waitUntil(cache.put(event.request, response.clone())" in service_worker_js
    assert "self.clients.claim()" in service_worker_js
    assert "type === 'SKIP_WAITING'" in service_worker_js
    for lazy_script in [
        "image-edit.js",
        "usage-dashboard.js",
    ]:
        assert f"'/static/{lazy_script}'" not in service_worker_js


def test_service_worker_cache_version_tracks_static_assets():
    """改了前端資源卻沒 bump CACHE_NAME 時擋下來。

    worker 是 network-first，舊快取只是 fallback，所以漏 bump 不會壞掉——但也不會
    觸發 install 重抓資產、不會刪掉舊快取、前端的「新版本已準備好」提示也不會跳，
    回訪的分頁就繼續渲染舊介面。這在實務上發生過一次（改完滑桿部署，線上仍是舊的
    select），純靠記性擋不住，所以在這裡設一道閘門。
    """
    service_worker_js = read_static("service-worker.js")
    match = re.search(r"var ASSET_FINGERPRINT = '([0-9a-f]+)';", service_worker_js)
    assert match, "service-worker.js 少了 ASSET_FINGERPRINT"

    expected = compute_static_fingerprint()
    cache_name = re.search(r"var CACHE_NAME = '([^']+)';", service_worker_js)
    assert cache_name, "service-worker.js 少了 CACHE_NAME"
    assert match.group(1) == expected, (
        f"app/static 的資源已變動。請把 service-worker.js 的 ASSET_FINGERPRINT 改成 "
        f"'{expected}'，並把 CACHE_NAME（目前 '{cache_name.group(1)}'）的版本號 +1，"
        f"否則回訪使用者會繼續看到舊介面。"
    )


def test_history_regenerate_restores_complete_settings_before_visible_generation():
    history_wall_js = read_static("history-wall.js")
    regenerate = re.search(
        r"function regenerateHistoryDetail\(\) \{([\s\S]*?)\n  \}\n\n  function deleteHistoryRecord",
        history_wall_js,
    )

    assert regenerate
    body = regenerate.group(1)
    for setting in ["providerPrompt:", "width:", "height:"]:
        assert setting in body
    assert "switchToGenerateTab()" in body
    assert "if (!switchToGenerateTab()) { return; }" in body
    assert body.index("switchToGenerateTab()") < body.index("setNextGenerationSourceRecord")
    assert body.index("switchToGenerateTab()") < body.index("ImageGenApp.setGenerationSettings({") < body.index("ImageGenApp.generate()")


def test_cloudflare_csp_allows_local_image_preview_blobs():
    headers = read_repo("cloudflare/public/_headers")

    assert "Content-Security-Policy:" in headers
    assert "img-src 'self' data: blob:" in headers


def test_cloudflare_csp_allows_turnstile_script_and_frame():
    headers = read_repo("cloudflare/public/_headers")

    assert "script-src 'self' https://challenges.cloudflare.com" in headers
    assert "frame-src https://challenges.cloudflare.com" in headers


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
    assert "window.ModalA11y.open(tutorialModal" in tutorial_js
    assert "window.ModalA11y.close(tutorialModal" in tutorial_js


def test_prompt_transform_ui_is_wired():
    html = read_static("index.html")
    transform_js = read_static("prompt-transform.js")
    styles = read_static("styles.css")

    assert 'id="plainPrompt"' in html
    assert 'for="plainPrompt"' in html
    assert 'id="promptStyle"' in html
    assert 'id="transformPrompt"' in html
    assert 'id="completePrompt"' in html
    assert "✨ 幫我補完整" in html
    assert 'class="prompt-shortcut-hint"' in html
    assert "鍵盤使用者可按 Ctrl / ⌘ + Enter 轉英文" in html
    assert "Tab 會正常移到下一個控制項" in html
    assert 'src="/static/prompt-transform.js"' in html
    assert "'/prompt/transform'" in transform_js
    assert "'/prompt/complete'" in transform_js
    # 生成分頁的欄位仍由同一份管線驅動（ctx 設定，不是硬編碼在函式裡）。
    assert "sourceId: 'plainPrompt'" in transform_js
    assert "targetId: 'prompt'" in transform_js
    assert "styleId: 'promptStyle'" in transform_js
    assert "transformButtonId: 'transformPrompt'" in transform_js
    assert "completeButtonId: 'completePrompt'" in transform_js
    assert "completeButton.addEventListener('click', function(){ completePrompt(ctx); })" in transform_js
    assert "targetField.setAttribute('data-auto-source', source)" in transform_js
    assert "targetField.getAttribute('data-auto-source')" in transform_js
    assert "targetField.removeAttribute('data-auto-source')" in transform_js
    assert "setBusy(button, true" in transform_js
    assert "setBusy(button, false)" in transform_js
    assert "button.setAttribute('aria-busy', 'true')" in transform_js
    assert "button.removeAttribute('aria-busy')" in transform_js
    assert "event.key === 'Tab'" not in transform_js
    assert "event.preventDefault()" in transform_js
    assert ".prompt-shortcut-hint" in styles


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
    assert "function shouldAutoOpenTutorial" in tutorial_js
    assert "hash && hash !== 'generate'" in tutorial_js
    assert "activeTab && activeTab !== 'generate'" in tutorial_js
    assert "if (shouldAutoOpenTutorial())" in tutorial_js


def test_iteration_ux_ui_is_wired():
    html = read_static("index.html")
    styles = read_static("styles.css")

    assert 'id="seed"' in html
    assert 'id="avoid"' not in html
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


def test_cloud_save_feature_is_removed():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="saveToCloud"' not in html
    assert 'id="cloudSaveModal"' not in html
    assert "☁️ 存到雲端" not in html
    assert "function openCloudSaveModal" not in app_js
    assert "function uploadToCloud" not in app_js
    assert "function saveToCloud" not in app_js
    assert "fetch('/gallery'" not in app_js
    assert "galleryToken:" not in app_js
    assert ".cloud-save-modal" not in styles
    assert ".cloud-save-copy" not in styles
    assert ".cloud-fallback-info" not in styles
    assert ".cloud-link-info" not in styles
    assert ".cloud-delete-info" not in styles
    assert ".cloud-link-row" not in styles


def test_turnstile_generation_gate_is_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    image_edit_js = read_static("image-edit.js")
    styles = read_static("styles.css")

    assert 'id="turnstileGate"' in html
    assert 'id="turnstileWidget"' in html
    assert 'data-action="turnstile-spin-v1"' in html
    assert 'id="turnstileStatus"' in html
    assert "function configureTurnstile" in app_js
    assert "function verify" not in app_js
    assert "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" in app_js
    assert "turnstileToken: readTurnstileToken()" in app_js
    assert "requireTurnstileReady" in app_js
    assert "data.turnstile" in app_js
    assert "fetch('/api/health', { cache: 'no-store' })" in app_js
    assert "fd.append('turnstileToken'" in image_edit_js
    assert ".turnstile-gate" in styles
    assert ".turnstile-status" in styles


def test_reference_image_modes_and_edit_stubs_are_wired():
    html = read_static("index.html")
    image_edit_js = read_static("image-edit.js")
    styles = read_static("styles.css")

    assert 'class="edit-workspace"' in html
    assert "參考圖與改圖設定" in html
    assert "拖曳圖片到這裡" in html
    assert 'id="editPreviewBadge"' in html
    assert 'class="stage edit-stage" id="editStage"' in html
    assert 'data-edit-mode="general"' in html
    assert 'data-edit-mode="character"' in html
    assert 'data-edit-mode="product"' in html
    assert "保留角色核心外觀與辨識特徵。" in html
    assert "自動縮至模型可用尺寸" in html
    assert 'id="editProductBackground"' in html
    assert 'id="editProductLighting"' in html
    assert 'id="editProductControls"' in html
    assert 'id="editReferenceCount"' in html
    assert 'id="editPromptLabel"' in html
    assert "乾淨棚拍背景" in html
    assert "明亮商業光" in html
    # 樁按鈕（即將推出）已於 2026-07 溫暖創作風改版移除，不應再出現空承諾 UI。
    assert 'class="edit-stub-tools"' not in html
    assert "（即將推出）" not in html

    assert "REFERENCE_ROLES" in image_edit_js
    assert "function normalizeReferenceRole" in image_edit_js
    assert "function composeEditPrompt" in image_edit_js
    assert "role.className = 'edit-thumb-role'" in image_edit_js
    assert "moveUp.className = 'edit-thumb-move edit-thumb-up'" in image_edit_js
    assert "moveDown.className = 'edit-thumb-move edit-thumb-down'" in image_edit_js
    assert "function setEditMode" in image_edit_js
    assert "productControls.hidden = editMode !== 'product'" in image_edit_js
    assert "referenceCount.textContent" in image_edit_js
    assert "角色一致模式需要至少一張標成「角色」的參考圖" in image_edit_js
    assert "產品照模式需要至少一張標成「產品」的參考圖" in image_edit_js
    assert "composeEditPrompt(prompt, selected" in image_edit_js

    assert ".edit-mode-grid" in styles
    assert ".edit-mode-card" in styles
    assert ".edit-workspace" in styles
    assert ".edit-preview-panel" in styles
    assert ".edit-preview-badge" in styles
    assert ".edit-empty-state" in styles
    assert ".edit-thumb-role" in styles
    assert ".edit-thumb-move" in styles
    assert ".edit-product-controls" in styles
    assert ".edit-stub-tools" not in styles
    assert re.search(
        r"@media \(max-width: 760px\)\s*\{[\s\S]*?\.edit-mode-grid,\s*\.edit-product-controls\s*\{\s*grid-template-columns:\s*1fr",
        styles,
    )


def test_edit_tab_has_the_same_creative_toolkit_as_the_generate_tab():
    """改圖分頁補齊生成分頁的工具：快速指令、強度/保留、對比、迭代、複製、歷史、失敗建議。"""
    html = read_static("index.html")
    image_edit_js = read_static("image-edit.js")
    styles = read_static("styles.css")

    # 快速指令庫 + 修改幅度 + 保留項目
    assert 'id="editPresets"' in html
    assert 'data-edit-strength="subtle"' in html
    assert 'data-edit-strength="balanced"' in html
    assert 'data-edit-strength="bold"' in html
    assert 'id="editStrengthHint"' in html
    assert 'id="editKeep"' in html
    # 結果操作列與狀態列
    assert 'id="editCompare"' in html
    assert 'id="editReuse"' in html
    assert 'id="editCopyPrompt"' in html
    assert 'id="editStatusbar"' in html
    assert 'id="editStateMeta"' in html

    assert "EDIT_PRESETS" in image_edit_js
    assert "function presetsForMode" in image_edit_js
    assert "function normalizeStrength" in image_edit_js
    assert "function normalizeKeepList" in image_edit_js
    assert "function buildEditRecord" in image_edit_js
    assert "function renderCompare" in image_edit_js
    # 歷史記錄與失敗建議重用生成分頁的既有管線，不另建一套
    assert "imagegen:generated" in image_edit_js
    assert "root.FailureAdvice.getAdvice" in image_edit_js
    assert "navigator.clipboard.writeText" in image_edit_js

    assert ".edit-preset" in styles
    assert ".edit-keep" in styles
    assert ".edit-compare" in styles
    assert "clip-path: inset(0 0 0 var(--split))" in styles


def test_edit_panel_matches_the_generate_panel_layout_and_prompt_tools():
    """改圖設定面板與生成分頁同構：首屏 composer + 進階設定，並共用同一套 prompt 工具。"""
    html = read_static("index.html")
    image_edit_js = read_static("image-edit.js")
    transform_js = read_static("prompt-transform.js")

    # 版面：首屏 composer（模式／參考圖／指令／風格＋幅度／主按鈕），其餘收進進階設定。
    assert 'class="composer" aria-label="改圖描述"' in html
    assert 'id="editAdvancedSettings" class="advanced-settings"' in html
    assert 'class="composer-options" role="group" aria-label="改圖選項"' in html
    assert 'class="btn primary hero-generate"' in html
    assert 'class="edit-panel-footer"' not in html

    # 生成分頁的三個 prompt 工具在改圖分頁也有對應控制項。
    assert 'id="editCompletePrompt"' in html
    assert 'id="editTransformPrompt"' in html
    assert 'id="editEffectPrompt"' in html
    assert 'id="editApplyEffect"' in html
    assert 'id="editTransformStatus"' in html
    assert 'id="editPromptStyle"' in html
    # 修改幅度是有序三段，用原生 range 畫成分段滑桿（拖曳／方向鍵由瀏覽器提供）。
    assert 'id="editStrength" type="range" min="0" max="2" step="1"' in html
    assert 'class="segmented-slider"' in html
    assert 'class="segmented-ticks"' in html
    assert 'id="editStrengthValue"' in html
    assert "STRENGTH_ORDER" in image_edit_js
    assert "function strengthFromIndex" in image_edit_js
    assert "aria-valuetext" in html

    # 補完整／轉英文重用同一份管線，只是換一組 ctx；加效果重用 PromptEnhancer。
    assert "sourceId: 'editPrompt'" in transform_js
    assert "styleId: 'editPromptStyle'" in transform_js
    assert "statusId: 'editTransformStatus'" in transform_js
    assert "root.PromptEnhancer.applyEffect" in image_edit_js

    # 風格選擇要真的進得了送出的指令。
    assert "STYLE_CLAUSES" in image_edit_js
    assert "function normalizeStyle" in image_edit_js
    assert "style: styleSelect ? styleSelect.value : 'auto'" in image_edit_js

    # 人機驗證框移到分頁外層，兩個分頁共用；改圖送出前先自己擋一次。
    assert html.index('id="turnstileGate"') < html.index('id="panel-generate"')
    assert "isTurnstileRequired" in image_edit_js


def test_edit_panel_keeps_mode_relevant_controls_out_of_the_fold():
    """跟模式與「改多少」有關的控制項要在首屏，不能收進進階設定。

    先前產品背景／光線藏在摺疊區裡：選了產品照模式，畫面上什麼都不會變，最相關的
    兩個設定要自己展開才找得到。快速指令不消耗額度卻也被收起來，反而是會呼叫 API
    的轉英文／加效果留在同一層。
    """
    html = read_static("index.html")
    advanced_at = html.index('id="editAdvancedSettings"')

    for element_id in ("editProductControls", "editPresets", "editKeep"):
        assert html.index(f'id="{element_id}"') < advanced_at, (
            f"{element_id} 應該留在首屏，不該收進進階設定"
        )

    # 進階設定只留會呼叫 AI 的兩項。
    assert html.index('id="editTransformPrompt"') > advanced_at
    assert html.index('id="editApplyEffect"') > advanced_at

    # 多圖能力要講出來，否則沒人知道可以傳 4 張並分別標用途。
    assert "最多 4 張" in html
    assert 'id="editRefRoleHint"' in html
    # 錯誤訊息要指出那個 role 下拉在哪。
    image_edit_js = read_static("image-edit.js")
    assert "用縮圖下方的選單改" in image_edit_js


def test_workspace_canvas_viewport_is_wired_without_duplicate_library():
    html = read_static("index.html")
    history_wall_js = read_static("history-wall.js")
    canvas_viewport_js = read_static("canvas-viewport.js")
    service_worker_js = read_static("service-worker.js")
    styles = read_static("styles.css")

    assert 'class="invoke-library' not in html
    assert 'class="invoke-inspired"' not in html
    assert "function renderHistoryLibrary" not in history_wall_js
    assert "function applyLibraryRecord" not in history_wall_js
    assert ".invoke-history-grid" not in styles
    assert ".invoke-history-card" not in styles

    assert 'id="canvasZoomOut"' in html
    assert 'id="canvasZoomValue"' in html
    assert 'id="canvasZoomIn"' in html
    assert 'src="/static/canvas-viewport.js"' in html
    assert "function clampScale" in canvas_viewport_js
    assert "stage.addEventListener('wheel'" in canvas_viewport_js
    assert "stage.addEventListener('pointerdown'" in canvas_viewport_js
    assert "stage.addEventListener('keydown'" in canvas_viewport_js
    assert "function nextStepScale" in canvas_viewport_js
    assert "translate(' + String(offsetX)" in canvas_viewport_js
    assert 'class="canvas-interaction-hint"' in html
    assert ".canvas-zoom-controls" in styles
    assert ".stage.is-canvas-interactive" in styles
    assert "'/static/canvas-viewport.js'" in service_worker_js


def test_secondary_feature_scripts_are_loaded_on_demand():
    html = read_static("index.html")
    app_js = read_static("app.js")
    tabs_js = read_static("tabs.js")

    for script in [
        "image-edit.js",
        "usage-dashboard.js",
    ]:
        assert f'src="/static/{script}"' not in html
        assert f"'/static/{script}'" in tabs_js
    assert "function loadFeatureScripts" in tabs_js
    assert "getProviderHealth" in tabs_js
    assert "lastProviderHealth" in app_js


def test_usage_dashboard_ui_is_wired():
    html = read_static("index.html")
    usage_js = read_static("usage-dashboard.js")
    styles = read_static("styles.css")

    # 階段二資訊架構：「用量」移出主導覽（無 tab 按鈕），panel 保留、由 footer 站長工具連結直達。
    assert 'id="tab-usage"' not in html
    assert 'data-tab="usage"' not in html
    assert 'id="panel-usage"' in html
    assert 'id="openUsagePanel"' in html
    assert 'href="#usage"' in html
    assert "站長工具" in html
    assert 'id="usageDashboard"' in html
    assert "成本 Dashboard" in html
    assert "所選 UTC 日期的生成次數、供應商嘗試、失敗率、估計成本與異常提醒" in html
    assert "此摘要不保存提示詞、圖片內容或原始 IP" in html
    assert 'id="usageDate"' in html
    assert 'id="refreshUsage"' in html
    assert 'class="history-actions usage-query-controls"' in html
    assert "查詢日期（UTC）" in html
    assert 'id="galleryAdminToken"' in html
    assert 'id="refreshGalleryAdmin"' in html
    assert 'id="galleryAdminNext"' in html
    assert 'id="galleryAdminStatus"' in html
    assert 'id="galleryAdminCount"' in html
    assert 'id="galleryAdminList"' in html
    assert 'id="galleryAdminSearch"' in html
    assert 'id="galleryAdminVisibility"' in html
    assert 'id="galleryAdminPromptPublic"' in html
    assert 'id="galleryAdminModel"' in html
    assert "搜尋標題、id、模型或尺寸" in html
    assert "GALLERY_ADMIN_TOKEN" in html
    assert "不會暴露刪除 token hash" in html
    assert "不會顯示未公開的完整 prompt" in html
    for metric_id in [
        "usageGeneratedImages",
        "usageTotalAttempts",
        "usageSuccessRequests",
        "usageFailedRequests",
        "usageEstimatedCost",
        "usageAverageMs",
        "usageErrorRate",
        "usageTotalRequests",
        "usageByModel",
        "usageByProvider",
        "usageByRoute",
        "usageByError",
    ]:
        assert f'id="{metric_id}"' in html
    assert "'/static/usage-dashboard.js'" in read_static("tabs.js")

    assert "fetch('/api/usage?date='" in usage_js
    assert "headers: { 'X-Gallery-Admin-Token': token }" in usage_js
    assert "請先輸入站長 Token" in usage_js
    assert "function renderUsage" in usage_js
    assert "function renderUsageBucket" in usage_js
    assert "byModel" in usage_js
    assert "byProvider" in usage_js
    assert "byRoute" in usage_js
    assert "byErrorCode" in usage_js
    assert "UsageDashboard" in usage_js
    assert "url = '/api/gallery?limit=50'" in usage_js
    assert "'X-Gallery-Admin-Token': token" in usage_js
    assert "function fetchGalleryAdmin" in usage_js
    assert "function renderGalleryAdmin" in usage_js
    assert "function applyGalleryAdminFilters" in usage_js
    assert "function galleryItemMatchesFilters" in usage_js
    assert "function copyGalleryAdminUrl" in usage_js
    assert "function appendGalleryCopyButton" in usage_js
    assert "button.textContent = '複製' + label" in usage_js
    assert "appendGalleryCopyButton(actions, '圖片'" in usage_js
    assert "appendGalleryCopyButton(actions, '分享頁'" in usage_js
    assert "navigator.clipboard.writeText(safeUrl)" in usage_js
    assert "document.execCommand('copy')" in usage_js
    assert "galleryPromptPublic" in usage_js
    assert "目前篩選沒有符合的雲端作品" in usage_js
    assert "control.addEventListener('input', applyGalleryAdminFilters)" in usage_js
    assert "GALLERY_ADMIN_TOKEN" in usage_js
    assert "刪除 token hash 或未公開 prompt" in usage_js
    assert "window.localStorage" not in re.search(
        r"function fetchGalleryAdmin\(reset\) \{([\s\S]*?)\n  \}\n\n  if \(els.date",
        usage_js,
    ).group(1)

    assert ".usage-dashboard" in styles
    assert ".usage-query-controls" in styles
    assert ".usage-metrics" in styles
    assert ".usage-columns" in styles
    assert ".usage-row" in styles
    assert ".gallery-admin-card" in styles
    assert ".gallery-admin-controls" in styles
    assert ".gallery-admin-filters" in styles
    assert ".gallery-admin-list" in styles
    assert ".gallery-admin-item" in styles
    assert "body[data-tab=\"usage\"] #mobileGenerateBar" in styles


def test_batch_partial_failure_and_pwa_reload_are_visible_and_user_initiated():
    app_js = read_static("app.js")

    assert "batchErrors = (data && Array.isArray(data.errors))" in app_js
    assert "batchErrors.length ? '，' + batchErrors.length + ' 張失敗'" in app_js
    assert "if(!images.length)" in app_js
    assert "var pwaUpdateRequested = false" in app_js
    assert "if(!pwaUpdateRequested){ return; }" in app_js
    assert app_js.index("pwaUpdateRequested = true") < app_js.index("postMessage({ type: 'SKIP_WAITING' })")


def test_usage_panel_reachable_without_tab_button():
    """#usage 沒有 tab 按鈕也要能直達：tabs.js 需支援無 tab 的 panel 顯示與切回。"""
    tabs_js = read_static("tabs.js")
    html = read_static("index.html")

    assert "function showUsagePanel" in tabs_js
    assert "document.getElementById('panel-usage')" in tabs_js
    assert "usagePanel.hidden = false" in tabs_js
    # 顯示 usage 時所有 tab 取消 active；切回任何一般分頁時 usage panel 要再藏起。
    assert "tab.classList.remove('is-active')" in tabs_js
    assert "if (usagePanel) { usagePanel.hidden = true; }" in tabs_js
    assert "document.body.setAttribute('data-tab', 'usage')" in tabs_js
    # hash 路由與 showTab 都要吃到相容路由。
    assert "if (name === 'usage') { return showUsagePanel(); }" in tabs_js
    assert "window.showTab = function (name) { return applyHash(String(name).toLowerCase(), false); };" in tabs_js
    # hash 大小寫正規化 + 未知 hash 用 replaceState 清掉（不污染上一頁）。
    assert ".replace(/^#/, '').toLowerCase()" in tabs_js
    assert "replaceState(null, '', '#' + current)" in tabs_js
    # 用量 panel 沒有對應 tab，語意上是獨立 region 而非 tabpanel。
    assert 'id="panel-usage" role="region"' in html


def test_ideas_hash_redirects_into_generate_tab():
    """#ideas 相容導向：靈感併入生成分頁後，#ideas 需切到生成分頁並捲動到靈感 section。"""
    html = read_static("index.html")
    tabs_js = read_static("tabs.js")

    # 靈感 tab 與 panel-ideas 容器已移除；靈感 section 併入生成分頁且元素 id 保留。
    assert 'id="tab-ideas"' not in html
    assert 'id="panel-ideas"' not in html
    panel_generate = html[html.index('id="panel-generate"'):html.index("/panel-generate")]
    for element_id in [
        "ideasSection",
        "random",
    ]:
        assert f'id="{element_id}"' in panel_generate
    assert 'class="idea"' in panel_generate
    assert "data-prompt=" in panel_generate
    # 靈感 section 要在範例 Gallery 之前。
    assert panel_generate.index('id="ideasSection"') < panel_generate.index('id="exampleGallery"')

    assert "if (name === 'ideas')" in tabs_js
    assert "activate('generate', false)" in tabs_js
    assert "function scrollToIdeas" in tabs_js
    assert "scrollIntoView" in tabs_js


def test_privacy_and_license_policy_modals_are_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="openPrivacyPolicy"' in html
    assert 'id="openLicensePolicy"' in html
    assert 'id="privacyPolicyModal"' in html
    assert 'id="licensePolicyModal"' in html
    assert 'id="clearLocalData"' in html
    assert "你的描述與圖片會送去哪裡" in html
    assert "本機資料如何保存" in html
    assert "本站不主動拿你的描述或圖片訓練自有模型" in html
    assert "畫質與服務商限制" in html
    assert "生成圖能否商用" in html
    assert "不得用於違法、詐欺、仿冒證件" in html
    assert "AI 生成標示建議" in html
    assert "model-license-hint" in html
    assert "openPolicyModal" in app_js
    assert "closePolicyModal" in app_js
    assert "function clearLocalData" in app_js
    assert "ImageHistoryStore.STORAGE_KEY" in app_js
    assert "aiImageTutorialSeen.v1" in app_js
    assert "window.localStorage.removeItem" in app_js
    assert "本機歷史與教學偏好" in html
    assert ".footer-link" in styles
    assert ".policy-modal" in styles
    assert ".policy-copy" in styles
    assert ".local-data-row" in styles
    assert ".model-license-hint" in styles


def test_generation_flow_is_single_path_with_explicit_batch_control():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="modeNormal"' not in html
    assert 'id="modeAgent"' not in html
    assert 'id="agentPanel"' not in html
    assert 'id="batchCount"' in html
    assert "多張會使用更多生成額度" in html
    assert "function sizeForUseCase" in app_js
    assert "function applyUseCaseSize" in app_js
    assert "applyUseCaseSize();" in app_js
    assert "finalPromptField.setAttribute('data-auto-source', source)" in app_js
    assert "function clearAutoProviderPrompt" in app_js
    assert "autoSource !== el('plainPrompt').value.trim()" in app_js
    assert "clearAutoProviderPrompt();" in app_js
    assert "el('promptStyle').addEventListener('change', function()" in app_js
    assert "AGENT_STEP_DEFS" not in app_js
    assert "function prepareAgentFlow" not in app_js
    assert "function runAgentAutoRetry" not in app_js
    assert "visionQa: generationMode === 'agent'" not in app_js
    assert ".mode-switch" not in styles
    assert ".agent-panel" not in styles


def test_history_detail_share_and_versions_are_wired():
    html = read_static("index.html")
    history_wall_js = read_static("history-wall.js")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="historyDetailModal"' in html
    assert 'id="historyDetailImage"' in html
    assert 'id="historyDetailPrompt"' in html
    assert 'id="historyDetailProviderPrompt"' in html
    assert 'id="historyDetailQaReport"' in html
    assert 'id="historyVersionList"' in html
    assert 'id="historyCloudSection"' in html
    assert 'id="historyCloudMeta"' in html
    assert 'id="openHistoryCloudShare"' in html
    assert 'id="openHistoryCloudDelete"' in html
    assert 'id="copyHistoryShareText"' in html
    assert 'id="exportHistoryJson"' in html
    assert 'id="hidePromptInShare"' in html
    assert "匯出的備份檔會包含你的中文描述、英文提示詞、畫面編號與設定" in html
    assert 'openHistoryDetail' in history_wall_js
    assert 'renderVersionList' in history_wall_js
    assert 'renderCloudLinks' in history_wall_js
    assert 'renderCloudLibrary' in history_wall_js
    assert 'createCloudRecordCard' in history_wall_js
    assert 'getCloudRecords' in history_wall_js
    assert 'safeCloudUrl' in history_wall_js
    assert "document.addEventListener('history-record-updated'" in history_wall_js
    assert 'cloudShareUrl' in history_wall_js
    assert 'cloudDeleteUrl' in history_wall_js
    assert 'formatQaReport' in history_wall_js
    assert 'imageQuality = report.imageQuality' in history_wall_js
    assert 'visionQa = report.visionQa' in history_wall_js
    assert '視覺 QA：' in history_wall_js
    assert '圖片檢查：' in history_wall_js
    assert 'copyHistoryShareText' in history_wall_js
    assert 'exportHistoryJson' in history_wall_js
    assert "匯出的備份檔會包含完整中文描述、英文提示詞、畫面編號與設定" in history_wall_js
    assert "已取消匯出作品 JSON" in history_wall_js
    assert "檔案可能包含完整描述與雲端刪除連結" in history_wall_js
    assert 'sourceRecordId' in app_js
    assert '.history-detail' in styles
    assert '.history-cloud-actions' in styles
    assert '.cloud-library' in styles
    assert '.cloud-record-card' in styles
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
    assert 'id="historyDateFrom"' in html
    assert 'id="historyDateTo"' in html
    assert 'id="historyFavoritesOnly"' in html
    assert 'id="historyCloudOnly"' in html
    assert 'id="historyBatchBar"' in html
    assert 'id="selectVisibleHistory"' in html
    assert 'id="clearHistorySelection"' in html
    assert 'id="deleteSelectedHistory"' in html
    assert 'id="historyTagEditor"' in html
    assert 'applyHistoryFilters' in history_wall_js
    assert 'toggleHistoryFavorite' in history_wall_js
    assert 'filters.cloudOnly' in history_wall_js
    assert 'selectVisibleHistory' in history_wall_js
    assert 'deleteSelectedHistoryRecords' in history_wall_js
    assert 'deleteRecords(records, ids)' in history_wall_js
    assert 'confirmAction(' in history_wall_js
    assert 'saveHistoryTags' in history_wall_js
    assert 'history-select' in history_wall_js
    assert 'history-card-favorite' in history_wall_js
    assert '.history-filters' in styles
    assert '.history-date-filter' in styles
    assert '.history-batch-bar' in styles
    assert '.history-select' in styles
    assert '.history-tags' in styles
    assert '.history-card-favorite' in styles
    assert '.cloud-record-list' in styles
    assert "if (!editor)" in save_tags
    assert "標籤輸入欄位尚未就緒" in save_tags
    assert "editor ? editor.value : ''" not in save_tags
    assert "event.stopPropagation();" in favorite_handler
    assert "toggleHistoryFavorite(record);" in favorite_handler
    assert "sourceRecord.prompt" in record_filter
    assert "sourceRecord.providerPrompt" in record_filter
    assert "getRecordTags(sourceRecord)" in record_filter
    assert "filters.dateFrom" in record_filter
    assert "filters.dateTo" in record_filter
    assert "filters.cloudOnly" in record_filter
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
    assert "img.alt = '生成完成的圖片'" in app_js
    assert "stage.appendChild(img)" in app_js


def test_app_validates_image_url_and_renders_errors_as_text():
    app_js = read_static("app.js")

    assert "function validateImageUrl" in app_js
    assert "typeof image !== 'string'" in app_js
    assert "image.indexOf('data:image/') === 0" in app_js
    assert "image.indexOf('http://') === 0" in app_js
    assert "image.indexOf('https://') === 0" in app_js
    assert "stage.innerHTML = '<span class=\"err\">出錯了：" not in app_js
    assert "node.textContent = text" in app_js
    assert "renderStageText(stage, '出錯了：' + message" in app_js


def test_prompt_enhancer_and_failure_advice_are_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    enhancer_js = read_static("prompt-enhancer.js")
    styles = read_static("styles.css")

    assert 'id="promptEnhancer"' in html
    assert 'id="effectPrompt"' in html
    assert 'id="applyEffect"' in html
    assert "data-enhance-mode" not in html
    assert 'src="/static/prompt-enhancer.js"' in html
    assert 'src="/static/failure-advice.js"' in html
    assert 'PromptEnhancer.applyEffect' in app_js
    assert "result.provider === 'gemini' ? 'Gemini' : '離線強化'" in app_js
    assert "warnings: data.warnings || []" in enhancer_js
    assert "'/prompt/enhance'" in enhancer_js
    assert 'FailureAdvice.getAdvice' in app_js
    assert 'renderFailureAdvice' in app_js
    assert '.prompt-enhancer' in styles
    assert '.failure-advice' in styles


def test_app_shell_stays_es5_friendly_and_mobile_controls_are_single_column():
    styles = read_static("styles.css")

    production_js_paths = sorted(path for path in STATIC_DIR.glob("*.js"))
    assert {path.name for path in production_js_paths} == {
        "app.js",
        "canvas-viewport.js",
        "elapsed-timer.js",
        "failure-advice.js",
        "generation-settings.js",
        "hf-ideas.js",
        "history-store.js",
        "history-wall.js",
        "image-edit.js",
            "prompt-enhancer.js",
            "prompt-pack.js",
            "prompt-transform.js",
            "service-worker.js",
            "tabs.js",
            "tutorial.js",
            "usage-dashboard.js",
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


def test_app_honors_backend_retry_after_without_legacy_cooldown_names():
    app_js = read_static("app.js")

    assert "cooldownTimer" not in app_js
    assert "startCooldown" not in app_js
    assert "retry_after" in app_js
    assert "retry-after" in app_js.lower()



def test_frontend_error_monitoring_is_wired():
    app_js = read_static("app.js")

    assert "function reportClientError" in app_js
    assert "window.addEventListener('error'" in app_js
    assert "window.addEventListener('unhandledrejection'" in app_js
    assert "'/client-error'" in app_js
    assert "navigator.sendBeacon" in app_js
    assert "fetch('/client-error'" in app_js
    assert "requestId" in app_js


def test_optional_generation_controls_are_wired_to_the_backend():
    html = read_static("index.html")
    app_js = read_static("app.js")

    # 這些控制項一旦被刪掉，前端會靜默地不再送出對應欄位，後端也就永遠走預設值。
    assert 'id="visionQa"' in html
    assert 'id="devSteps"' in html
    assert 'id="devCfgScale"' in html
    assert "visionQa: readVisionQa()" in app_js
    assert "steps: devTuning.steps" in app_js
    assert "cfgScale: devTuning.cfgScale" in app_js
