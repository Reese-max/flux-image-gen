import re
from pathlib import Path


STATIC_DIR = Path(__file__).resolve().parents[1] / "app" / "static"


def test_advanced_settings_use_progressive_disclosure_without_hiding_shared_prompts():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    app_js = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

    assert "進階設定（提示詞、生成品質與輸出）" not in html
    assert '<span>更多設定</span>' in html
    assert html.index('id="advGroupOutput"') < html.index('id="advancedQualitySettings"') < html.index('id="advancedPromptSettings"')

    review_flow = re.search(
        r"function setPromptForReview\(prompt, label\)\{([\s\S]*?)\n\}\n\nfunction setPromptAndGenerate",
        app_js,
    ).group(1)
    assert "promptSettings.open = true" in review_flow
    assert "promptValue && el('advancedPromptSettings')" in app_js
