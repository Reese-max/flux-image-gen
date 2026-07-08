import re
from pathlib import Path


STATIC_DIR = Path(__file__).resolve().parents[1] / "app" / "static"
ROOT_DIR = Path(__file__).resolve().parents[1]


def read_static(name):
    path = STATIC_DIR / name
    return path.read_text(encoding="utf-8") if path.exists() else ""


def read_repo(path):
    return (ROOT_DIR / path).read_text(encoding="utf-8")


def test_product_branding_seo_and_app_metadata_are_wired():
    html = read_static("index.html")
    manifest = read_static("manifest.webmanifest")

    assert "<title>Fluxi 中文 FLUX 圖片產生器｜白話中文直接生成圖片</title>" in html
    assert 'meta name="description" content="中文 FLUX 圖片產生器：輸入白話中文，自動補全 prompt，生成簡報、社群、產品與角色圖片。"' in html
    assert 'property="og:title" content="Fluxi 中文 FLUX 圖片產生器"' in html
    assert 'property="og:description" content="輸入白話中文，自動補全 prompt，生成簡報、社群、產品與角色圖片。"' in html
    assert 'property="og:image" content="https://flux-image-gen.irisx-tracker.workers.dev/static/og.jpg"' in html
    assert 'name="twitter:title" content="Fluxi 中文 FLUX 圖片產生器"' in html
    assert 'name="twitter:description" content="輸入白話中文，自動補全 prompt，生成簡報、社群、產品與角色圖片。"' in html
    assert '<span class="brand-name">Fluxi</span>' in html
    assert "中文原生 · 智慧體補 prompt · FLUX 出圖" in html
    assert "Fluxi 中文 FLUX 圖片產生器 · 版本 v1.2.0" in html
    assert '"name": "Fluxi 中文 FLUX 圖片產生器"' in manifest
    assert '"short_name": "Fluxi 生圖"' in manifest
    assert '"description": "輸入白話中文，自動補全 prompt，生成簡報、社群、產品與角色圖片。"' in manifest
    assert '"purpose": "any maskable"' in manifest


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
        "自訂尺寸",
        "自訂尺寸必須介於 256～1920，且為 64 的倍數",
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
        'value="custom"',
    ]:
        assert value in html
    assert 'id="customSizeFields"' in html
    assert 'id="customWidth"' in html
    assert 'id="customHeight"' in html
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
        "GEMINI_VISION_MODEL",
        "VISION_QA_ENABLED",
        "TURNSTILE_SECRET_KEY",
        "GALLERY_ADMIN_TOKEN",
        "X-Gallery-Admin-Token",
        "TURNSTILE_REQUIRED = \"true\"",
        "TURNSTILE_SITE_KEY",
        "IMAGE_BUCKET",
        "GENERATE_RATE_LIMITER",
        "USAGE_ESTIMATED_COST_USD_PER_IMAGE",
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
        "AgentStep 流程",
        "Vision QA 部署抽驗",
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
    assert '點一下只套用 prompt，不會自動消耗額度' in html
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
    assert "setPromptForReview(randomPrompt(), '隨機靈感')" in app_js
    assert "setPromptForReview(button.getAttribute('data-prompt'), '靈感 prompt')" in app_js
    idea_handlers = re.search(
        r"el\('random'\)\.addEventListener\('click'([\s\S]*?)el\('prompt'\)\.addEventListener",
        app_js,
    ).group(1)
    assert "generate()" not in idea_handlers
    assert "setPromptForReview(prompt, 'HF 靈感 prompt')" in hf_ideas_js
    assert "setPromptForReview(card.en, '精選提示詞')" in prompt_pack_js
    assert ".example-gallery" in styles
    assert ".example-grid" in styles
    assert ".example-card" in styles


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

    assert 'id="provider-pill" class="pill" title="後端服務狀態" role="status" aria-live="polite" aria-atomic="true"' in html
    assert 'id="demo-notice" class="demo-notice" role="status" aria-live="polite"' in html
    assert 'id="plainPromptHelp" class="visually-hidden"' in html
    assert 'id="plainPrompt" rows="3" aria-describedby="plainPromptHelp status" aria-required="true"' in html
    assert 'id="promptStyle" aria-label="選擇圖片風格"' in html
    assert 'id="useCase" aria-label="選擇圖片用途"' in html
    assert 'id="go" class="btn primary hero-generate" type="button" aria-describedby="status"' in html
    assert 'id="transformStatus" class="transform-status" role="status" aria-live="polite" aria-atomic="true"' in html
    assert 'id="status" class="status" role="status" aria-live="polite" aria-atomic="true"' in html
    assert 'id="stage" role="region" aria-label="生成結果" aria-live="polite" aria-busy="false" tabindex="-1"' in html
    assert 'id="mobileGenerateBar" class="mobile-generate-bar" role="region" aria-label="手機固定生成列"' in html
    assert 'id="mobileGenerateSummary" class="mobile-generate-summary" aria-live="polite"' in html
    assert 'id="mobileGenerate" class="btn primary" type="button" aria-describedby="mobileGenerateSummary status"' in html
    assert "function setFieldInvalid" in app_js
    assert "function setStageBusy" in app_js
    assert "status.setAttribute('role', cls === 'fail' ? 'alert' : 'status')" in app_js
    assert "go.setAttribute('aria-disabled'" in app_js
    assert "go.setAttribute('aria-busy'" in app_js
    assert "mobile.setAttribute('aria-disabled'" in app_js
    assert "stage.setAttribute('aria-busy', on ? 'true' : 'false')" in app_js
    assert "field.setAttribute('aria-invalid', 'true')" in app_js
    assert "field.setAttribute('aria-errormessage', 'status')" in app_js
    assert "node.setAttribute('role', 'alert')" in app_js
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


def test_mobile_result_cards_can_swipe_and_save():
    app_js = read_static("app.js")
    styles = read_static("styles.css")
    mobile_e2e = read_repo("tests/e2e/mobile-generation-qa.mjs")

    assert "function createMobileSaveHint" in app_js
    assert "手機上可按「下載」，或長按圖片保存。多張結果可左右滑動挑選。" in app_js
    assert "grid.setAttribute('role', 'list')" in app_js
    assert "grid.setAttribute('aria-label', '多張生成結果，可左右滑動挑選')" in app_js
    assert "card.setAttribute('role', 'listitem')" in app_js
    assert "stage.classList.add('has-batch-results')" in app_js
    assert "stage.classList.add('has-mobile-save')" in app_js
    assert "stage.appendChild(createMobileSaveHint())" in app_js
    assert ".mobile-save-hint" in styles
    assert ".stage.has-batch-results" in styles
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
    idea_store_js = read_static("idea-store.js")
    network_e2e = read_repo("tests/e2e/network-interrupted-qa.mjs")

    assert "if(generationInFlight)" in app_js
    assert "return Promise.resolve()" in app_js
    assert "function handleGenerateError" in app_js
    assert "reportClientError(err, { type: 'generate_network' })" in app_js
    assert "renderFailureAdvice('network')" in app_js
    assert "setGenerationState('error')" in app_js
    assert "setResultActionsVisible(false)" in app_js
    assert "出錯了：' + err.message" in app_js
    assert "網路連線中斷" in failure_advice_js
    assert "目前輸入內容仍保留，不需要重新輸入" in failure_advice_js
    assert "網路中斷顯示專用建議" in network_e2e
    assert "使用者中文輸入未遺失" in network_e2e
    assert "失敗時不建立歷史作品" in network_e2e
    assert "雲端儲存失敗，本機歷史仍保留" in app_js
    assert "雲端圖庫尚未啟用；作品仍保留在本機歷史" in app_js
    assert "if(response.status === 503)" in app_js
    assert "確定要清空全部歷史記錄嗎？此動作無法復原。" in history_wall_js
    assert "已取消清空歷史" in history_wall_js
    assert "確定要刪除已選取的 " in history_wall_js
    assert "while (true)" in history_store_js
    assert "nextRecords.pop()" in history_store_js
    assert "匯入資料不是有效 JSON" in idea_store_js
    assert "不支援的 PromptCard schema version" in idea_store_js


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


def test_service_worker_static_cache_is_safe():
    service_worker_js = read_static("service-worker.js")

    assert "request.method !== 'GET'" in service_worker_js
    assert "'/generate'" not in service_worker_js
    assert '"/generate"' not in service_worker_js
    assert "caches.delete" in service_worker_js
    assert "ai-image-generator-pwa-v5" in service_worker_js
    assert "self.skipWaiting()" in service_worker_js
    assert "self.clients.claim()" in service_worker_js
    assert "type === 'SKIP_WAITING'" in service_worker_js
    assert "'/static/usage-dashboard.js'" in service_worker_js



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
    styles = read_static("styles.css")

    assert 'id="plainPrompt"' in html
    assert 'for="plainPrompt"' in html
    assert 'id="promptStyle"' in html
    assert 'id="transformPrompt"' in html
    assert 'class="prompt-shortcut-hint"' in html
    assert "鍵盤使用者可按 Ctrl / ⌘ + Enter 轉英文" in html
    assert "Tab 會正常移到下一個控制項" in html
    assert 'src="/static/prompt-transform.js"' in html
    assert "fetch('/prompt/transform'" in transform_js
    assert "fetch('/prompt/complete'" in transform_js
    assert "plainPrompt" in transform_js
    assert "transformPrompt" in transform_js
    assert "completePrompt" in transform_js
    assert "event.key === 'Tab'" not in transform_js
    assert "event.preventDefault()" in transform_js
    assert ".prompt-shortcut-hint" in styles


def test_custom_idea_card_ui_is_wired():
    html = read_static("index.html")
    idea_cards_js = read_static("idea-cards.js")

    assert 'id="customIdeaGrid"' in html
    assert 'id="addIdea"' in html
    assert 'id="ideaEditor"' in html
    assert 'id="saveStyleCard"' in html
    assert 'id="ideaNegativePrompt"' in html
    assert 'id="ideaSeed"' in html
    assert 'id="ideaTags"' in html
    assert "匯出 JSON 會包含完整 prompt、模型、尺寸與 Seed" in html
    assert 'src="/static/idea-store.js"' in html
    assert 'src="/static/idea-cards.js"' in html
    assert "IdeaStore.loadCards" in idea_cards_js
    assert "customIdeaGrid" in idea_cards_js
    assert "ImageGenApp.setGenerationSettings" in idea_cards_js
    assert "createCardFromGeneration" in idea_cards_js
    assert "PromptCards" in idea_cards_js
    assert "fetch('/prompt/transform'" in idea_cards_js
    assert "匯出風格卡 JSON 會包含完整 prompt、模型、尺寸與 Seed" in idea_cards_js
    assert "已取消匯出風格卡 JSON" in idea_cards_js
    assert "檔案包含 prompt 與生成設定" in idea_cards_js


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


def test_cloud_save_privacy_modal_is_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="cloudSaveModal"' in html
    assert 'id="cloudIncludePrompt"' in html
    assert 'id="cloudAcknowledge"' in html
    assert 'id="cloudShareInfo"' in html
    assert 'id="cloudShareUrl"' in html
    assert 'id="copyCloudShareUrl"' in html
    assert 'id="cloudFallbackInfo"' in html
    assert 'id="downloadCloudFallbackImage"' in html
    assert 'id="exportCloudFallbackJson"' in html
    assert 'id="cloudDeleteInfo"' in html
    assert 'id="cloudDeleteUrl"' in html
    assert 'id="copyCloudDeleteUrl"' in html
    assert 'id="confirmCloudSave"' in html
    assert 'id="cloudLocalOnly"' in html
    assert "Cloudflare R2" in html
    assert "預設不公開也不保存完整 prompt" in html
    assert "刪除連結已保存到本機歷史" in html
    assert "雲端分享連結" in html
    assert "雲端保存失敗時的本機備援" in html
    assert "匯出本機作品 JSON" in html
    assert "預設不公開完整 prompt" in html
    assert "同步保存在本機歷史詳情" in html
    assert "打開連結後可確認刪除 R2 圖片與 metadata" in html
    assert "不是登入保護的私密作品" in html
    assert "function openCloudSaveModal" in app_js
    assert "function uploadToCloud" in app_js
    assert "buildCloudSavePayload" in app_js
    assert "promptPublic: includePrompt" in app_js
    assert "if(includePrompt)" in app_js
    assert "meta.prompt = lastGeneration.providerPrompt || lastGeneration.prompt || '';" in app_js
    assert "cloudIncludePrompt').checked = false" in app_js
    assert "cloudAcknowledge').checked = false" in app_js
    assert "cloudAcknowledge') && !el('cloudAcknowledge').checked" in app_js
    assert "請先勾選確認：此連結不是登入保護的私密作品。" in app_js
    assert "function setCloudFallbackInfo" in app_js
    assert "function downloadCloudFallbackImage" in app_js
    assert "function exportCloudFallbackJson" in app_js
    assert "function setCloudShareInfo" in app_js
    assert "function setCloudDeleteInfo" in app_js
    assert "function persistCloudSaveToHistory" in app_js
    assert "function copyCloudShareUrl" in app_js
    assert "function copyCloudDeleteUrl" in app_js
    assert "data.deleteUrl" in app_js
    assert "setCloudFallbackInfo(true)" in app_js
    assert "exportReason = 'cloud_save_fallback'" in app_js
    assert "已匯出本機作品 JSON；檔案包含 prompt 與生成設定" in app_js
    assert "downloadCloudFallbackImage').addEventListener('click', downloadCloudFallbackImage)" in app_js
    assert "exportCloudFallbackJson').addEventListener('click', exportCloudFallbackJson)" in app_js
    assert "setCloudShareInfo(url)" in app_js
    assert "history-record-updated" in app_js
    assert "cloudShareUrl: shareUrl || ''" in app_js
    assert "cloudDeleteUrl: deleteUrl || ''" in app_js
    assert "copyCloudShareUrl').addEventListener('click', copyCloudShareUrl)" in app_js
    assert "copyCloudDeleteUrl').addEventListener('click', copyCloudDeleteUrl)" in app_js
    assert "data.shareUrl" in app_js
    assert "分享連結已複製" in app_js
    assert "刪除連結已寫入本機歷史" in app_js
    assert "打開後可確認刪除" in app_js
    assert "本機歷史仍保留" in app_js
    assert "metadata 已分開保存" in app_js
    assert ".cloud-save-modal" in styles
    assert ".cloud-save-copy" in styles
    assert ".cloud-fallback-info" in styles
    assert ".cloud-link-info" in styles
    assert ".cloud-delete-info" in styles
    assert ".cloud-link-row" in styles


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
    assert "fd.append('turnstileToken'" in image_edit_js
    assert ".turnstile-gate" in styles
    assert ".turnstile-status" in styles


def test_reference_image_modes_and_edit_stubs_are_wired():
    html = read_static("index.html")
    image_edit_js = read_static("image-edit.js")
    styles = read_static("styles.css")

    assert "參考圖與 AI 改圖" in html
    assert "上傳 1–4 張參考圖，標示用途後一起送出" in html
    assert 'data-edit-mode="general"' in html
    assert 'data-edit-mode="character"' in html
    assert 'data-edit-mode="product"' in html
    assert "至少一張角色參考圖；可保持角色特徵但不能保證完全一致。" in html
    assert "點此選擇參考圖（最多 4 張，支援角色／產品／風格／構圖）" in html
    assert 'id="editProductBackground"' in html
    assert 'id="editProductLighting"' in html
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
    assert "角色一致模式需要至少一張標成「角色」的參考圖" in image_edit_js
    assert "產品照模式需要至少一張標成「產品」的參考圖" in image_edit_js
    assert "composeEditPrompt(prompt, selected" in image_edit_js

    assert ".edit-mode-grid" in styles
    assert ".edit-mode-card" in styles
    assert ".edit-thumb-role" in styles
    assert ".edit-thumb-move" in styles
    assert ".edit-product-controls" in styles
    assert ".edit-stub-tools" in styles
    assert re.search(
        r"@media \(max-width: 760px\)\s*\{[\s\S]*?\.edit-mode-grid,\s*\.edit-product-controls\s*\{\s*grid-template-columns:\s*1fr",
        styles,
    )


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
    assert "今日生成次數、失敗率、估計成本、模型用量與異常提醒" in html
    assert "此摘要不保存 prompt、圖片內容或原始 IP" in html
    assert 'id="usageDate"' in html
    assert 'id="refreshUsage"' in html
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
    assert 'src="/static/usage-dashboard.js"' in html

    assert "fetch('/api/usage?date='" in usage_js
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
    assert ".usage-metrics" in styles
    assert ".usage-columns" in styles
    assert ".usage-row" in styles
    assert ".gallery-admin-card" in styles
    assert ".gallery-admin-controls" in styles
    assert ".gallery-admin-filters" in styles
    assert ".gallery-admin-list" in styles
    assert ".gallery-admin-item" in styles
    assert "body[data-tab=\"usage\"] #mobileGenerateBar" in styles


def test_usage_panel_reachable_without_tab_button():
    """#usage 沒有 tab 按鈕也要能直達：tabs.js 需支援無 tab 的 panel 顯示與切回。"""
    tabs_js = read_static("tabs.js")

    assert "function showUsagePanel" in tabs_js
    assert "document.getElementById('panel-usage')" in tabs_js
    assert "usagePanel.hidden = false" in tabs_js
    # 顯示 usage 時所有 tab 取消 active；切回任何一般分頁時 usage panel 要再藏起。
    assert "tab.classList.remove('is-active')" in tabs_js
    assert "if (usagePanel) { usagePanel.hidden = true; }" in tabs_js
    assert "document.body.setAttribute('data-tab', 'usage')" in tabs_js
    # hash 路由與 showTab 都要吃到相容路由。
    assert "if (name === 'usage') { return showUsagePanel(); }" in tabs_js
    assert "window.showTab = function (name) { return applyHash(name, false); };" in tabs_js


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
        "addIdea",
        "exportIdeas",
        "importIdeas",
        "customIdeaGrid",
    ]:
        assert f'id="{element_id}"' in panel_generate
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
    assert "Prompt 與圖片會送去哪裡" in html
    assert "本機歷史與雲端保存差異" in html
    assert "本站不主動拿你的 prompt 或圖片訓練自有模型" in html
    assert "模型與 provider 限制" in html
    assert "生成圖能否商用" in html
    assert "不得用於違法、詐欺、仿冒證件" in html
    assert "AI 生成標示建議" in html
    assert "model-license-hint" in html
    assert "openPolicyModal" in app_js
    assert "closePolicyModal" in app_js
    assert "function clearLocalData" in app_js
    assert "ImageHistoryStore.STORAGE_KEY" in app_js
    assert "IdeaStore.STORAGE_KEY" in app_js
    assert "ImageProjectStore.STORAGE_KEY" in app_js
    assert "aiImageTutorialSeen.v1" in app_js
    assert "window.localStorage.removeItem" in app_js
    assert "雲端作品不會因此刪除" in app_js
    assert ".footer-link" in styles
    assert ".policy-modal" in styles
    assert ".policy-copy" in styles
    assert ".local-data-row" in styles
    assert ".model-license-hint" in styles


def test_agent_mode_ui_and_flow_are_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="modeNormal"' in html
    assert 'id="modeAgent"' in html
    assert 'id="agentPanel"' in html
    assert 'id="agentSteps"' in html
    assert 'id="agentRecommendation"' in html
    assert "AGENT_STEP_DEFS" in app_js
    assert "解析需求" in app_js
    assert "補全畫面" in app_js
    assert "產生 prompt" in app_js
    assert "選模型與尺寸" in app_js
    assert "檢查品質" in app_js
    assert "function analyzeIntentForAgent" in app_js
    assert "function prepareAgentFlow" in app_js
    assert "function syncGenerationModeUi" in app_js
    assert "setAgentStep('generate', 'running'" in app_js
    assert "mode: generationMode === 'agent' ? 'agent' : 'normal'" in app_js
    assert "qaReport: generationMode === 'agent'" in app_js
    assert "function createQaReport" in app_js
    assert "imageQuality" in app_js
    assert "imageQualityIssues" in app_js
    assert "visionQa" in app_js
    assert "visionIssues" in app_js
    assert "視覺 QA：" in app_js
    assert "function formatVisionQaSummary" in app_js
    assert "function formatImageQualitySummary" in app_js
    assert "function appendQaDetails" in app_js
    assert "provider === 'gemini' ? 'Gemini'" in app_js
    assert "圖片檢查：" in app_js
    assert ".qa-vision-line" in styles
    assert "visionQa: generationMode === 'agent'" in app_js
    assert "visualQualityScore" in app_js
    assert "function isSevereQaFailure" in app_js
    assert "function classifyQaRetry" in app_js
    assert "function collectQaIssueText" in app_js
    assert "function issueTextHasAny" in app_js
    assert "malformed hands, extra fingers, fused fingers" in app_js
    assert "文字亂碼通常不適合用自動重試硬修" in app_js
    assert "function runAgentAutoRetry" in app_js
    assert "function appendAgentAutoRetryResult" in app_js
    assert "Quality correction retry" in app_js
    assert "Negative focus:" in app_js
    assert "action = 'auto_retry'" in app_js
    assert "visionQa: true" in app_js
    assert "runAgentAutoRetry(settings, providerPrompt, prompt, model, size, batchOutcome.retryPlan)" in app_js
    assert "已自動修正一次" in app_js
    assert "function renderAgentOutcome" in app_js
    assert "推薦最佳圖" in app_js
    assert "data-agent-suggestion" in app_js
    assert ".mode-switch" in styles
    assert ".agent-panel" in styles
    assert ".agent-step" in styles


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
    assert 'id="cloudLibrary"' in html
    assert 'id="cloudLibraryCount"' in html
    assert 'id="cloudRecordList"' in html
    assert 'id="copyHistoryShareText"' in html
    assert 'id="saveHistoryAsStyleCard"' in html
    assert 'id="exportHistoryJson"' in html
    assert 'id="hidePromptInShare"' in html
    assert "匯出作品 JSON 會包含白話 prompt、Provider prompt、Seed、metadata" in html
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
    assert 'saveHistoryAsStyleCard' in history_wall_js
    assert 'copyHistoryShareText' in history_wall_js
    assert 'exportHistoryJson' in history_wall_js
    assert "匯出作品 JSON 會包含完整 prompt、Provider prompt、Seed、metadata" in history_wall_js
    assert "已取消匯出作品 JSON" in history_wall_js
    assert "檔案可能包含完整 prompt 與雲端刪除連結" in history_wall_js
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
    assert "textContent = '出錯了：' + err.message" in app_js


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
        "failure-advice.js",
        "generation-settings.js",
        "hf-ideas.js",
        "history-store.js",
        "history-wall.js",
        "idea-cards.js",
        "idea-store.js",
        "image-edit.js",
            "project-board.js",
            "project-store.js",
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


def test_project_board_ui_and_scripts_are_wired():
    html = read_static("index.html")
    project_store_js = read_static("project-store.js")
    project_board_js = read_static("project-board.js")
    history_wall_js = read_static("history-wall.js")
    idea_cards_js = read_static("idea-cards.js")
    styles = read_static("styles.css")

    assert 'id="tab-projects"' in html
    assert 'id="panel-projects"' in html
    assert 'id="projectBoard"' in html
    assert 'id="projectName"' in html
    assert 'id="projectDescription"' in html
    assert 'id="createProject"' in html
    assert 'id="deleteProject"' in html
    assert 'id="projectList"' in html
    assert 'id="projectRecordList"' in html
    assert 'id="projectCardList"' in html
    assert 'id="historyProjectSelect"' in html
    assert 'id="addHistoryToProject"' in html
    assert 'src="/static/project-store.js"' in html
    assert 'src="/static/project-board.js"' in html
    assert html.index('src="/static/history-wall.js"') < html.index('src="/static/project-store.js"')
    assert html.index('src="/static/project-store.js"') < html.index('src="/static/project-board.js"')
    assert "ImageProjectCollection" in project_store_js
    assert "normalizeProject" in project_store_js
    assert "addRecordToProject" in project_store_js
    assert "addPromptCardToProject" in project_store_js
    assert "removeRecordFromProject" in project_store_js
    assert "removePromptCardFromProject" in project_store_js
    assert "ImageProjectStore.loadProjects" in project_board_js
    assert "ProjectBoard" in project_board_js
    assert "continueFromRecord" in project_board_js
    assert "continueFromCard" in project_board_js
    assert "ImageGenApp.setGenerationSettings" in project_board_js
    assert "PromptCards.generateFromCard" in project_board_js
    assert "addHistoryToProject" in history_wall_js
    assert "ProjectBoard.addRecordToProject" in history_wall_js
    assert "card-project" in idea_cards_js
    assert "ProjectBoard.addPromptCardToProject" in idea_cards_js
    assert ".project-board" in styles
    assert ".project-create" in styles
    assert ".project-chip" in styles
    assert ".project-item" in styles
    assert ".project-add-row" in styles
