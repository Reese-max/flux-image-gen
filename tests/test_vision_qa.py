import httpx

from app.demo_image import make_demo_png_data_url
from app.settings import Settings
from app.vision_qa import (
    VISION_QA_SCHEMA,
    maybe_run_vision_qa,
    resolve_vision_provider,
    run_gemini_vision_qa,
    run_nvidia_vision_qa,
)


def gemini_only(**overrides) -> Settings:
    """Gemini 分支的測試設定：明確清掉 NVIDIA 金鑰，才不會受 shell 環境變數影響
    （Settings 的預設值是 import 時從 os.getenv 取的）。"""
    return Settings(nvidia_api_key="", gemini_api_key="test-key", vision_qa_enabled=True, **overrides)


def test_maybe_run_vision_qa_is_disabled_by_default():
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    result = maybe_run_vision_qa(
        image, "一隻貓", Settings(nvidia_api_key="", gemini_api_key="key", vision_qa_enabled=False)
    )
    assert result is None


def test_default_vision_provider_is_nvidia():
    """預設後端。改預設只需要動這裡——其餘測試都明確指定 provider，不依賴預設值。

    選 nvidia 是為了共用生圖的金鑰、不另外吃付費配額；代價是實測 1024x1024 圖片
    中位 23.2 秒（Gemini 3.8 秒）。換預設時 VISION_QA_TIMEOUT_MS 要一起調。
    """
    assert Settings().vision_qa_provider == "nvidia"
    assert resolve_vision_provider(
        Settings(nvidia_api_key="n", gemini_api_key="g", vision_qa_enabled=True)
    ) == "nvidia"


def test_resolve_vision_provider_honours_config_and_falls_back_on_missing_keys():
    for requested in ("nvidia", "gemini"):
        assert resolve_vision_provider(Settings(
            nvidia_api_key="n", gemini_api_key="g",
            vision_qa_provider=requested, vision_qa_enabled=True)) == requested
    # 指定的後端沒金鑰就退到另一邊，而不是整個關掉。
    assert resolve_vision_provider(Settings(
        nvidia_api_key="n", gemini_api_key="",
        vision_qa_provider="gemini", vision_qa_enabled=True)) == "nvidia"
    assert resolve_vision_provider(Settings(
        nvidia_api_key="", gemini_api_key="g",
        vision_qa_provider="nvidia", vision_qa_enabled=True)) == "gemini"
    # 兩邊都沒金鑰＝沒有可用後端。
    assert resolve_vision_provider(Settings(
        nvidia_api_key="", gemini_api_key="", vision_qa_enabled=True)) == ""


def test_run_nvidia_vision_qa_posts_openai_shape_and_normalizes_scores(monkeypatch):
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    captured = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": '{"promptMatchScore":91,"compositionScore":80,"visualQualityScore":72,"detectedIssues":["背景略雜"],"recommendation":"keep","reason":"主體清楚"}'
                            }
                        }
                    ]
                },
            )

    monkeypatch.setattr("app.vision_qa.httpx.Client", FakeClient)
    result = run_nvidia_vision_qa(
        image,
        "一個人物拿著杯子",
        Settings(
            nvidia_api_key="nv-test",
            nvidia_vision_model="meta/test-vlm",
            vision_qa_enabled=True,
        ),
    )

    assert captured["url"].endswith("/chat/completions")
    assert captured["headers"]["Authorization"] == "Bearer nv-test"
    assert captured["json"]["model"] == "meta/test-vlm"
    assert captured["json"]["response_format"] == {"type": "json_object"}
    content = captured["json"]["messages"][0]["content"]
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    # json_object 只保證合法 JSON，不保證欄位。欄位名沒寫進提示詞的話，模型會回
    # 別的欄位，normalize 就整組填兜底值（70/70/70、空 issues）——看起來成功，
    # 其實什麼都沒評估。實測過：拿掉這段，相符與不相符的圖會拿到一模一樣的分數。
    sent_text = content[0]["text"]
    for field in (
        "promptMatchScore",
        "compositionScore",
        "visualQualityScore",
        "textAccuracyScore",
        "detectedIssues",
        "recommendation",
        "reason",
    ):
        assert field in sent_text, f"{field} missing from the NVIDIA prompt"
    assert result["provider"] == "nvidia"
    assert result["promptMatchScore"] == 91
    assert result["detectedIssues"] == ["背景略雜"]
    assert result["recommendation"] == "keep"
    # NVIDIA 沒有 responseSchema，缺欄位要由 normalize 兜底而不是丟例外。
    assert "textAccuracyScore" not in result


def test_run_nvidia_vision_qa_accepts_content_returned_as_parts(monkeypatch):
    """有些 NIM 模型把 content 回成陣列而不是字串。"""
    image = make_demo_png_data_url("demo", 64, 64, "schnell")

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": [
                                    {"type": "text", "text": '{"promptMatchScore":70,'},
                                    {"type": "text", "text": '"compositionScore":60,"visualQualityScore":50,"detectedIssues":[],"recommendation":"retry","reason":"構圖偏移"}'},
                                ]
                            }
                        }
                    ]
                },
            )

    monkeypatch.setattr("app.vision_qa.httpx.Client", FakeClient)
    result = run_nvidia_vision_qa(
        image, "一隻貓", Settings(nvidia_api_key="nv-test", vision_qa_enabled=True)
    )
    assert result["promptMatchScore"] == 70
    assert result["recommendation"] == "retry"


def test_maybe_run_vision_qa_routes_to_gemini_when_asked(monkeypatch):
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    captured = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, url, headers=None, json=None):
            captured["url"] = url
            return httpx.Response(
                200,
                json={
                    "candidates": [
                        {"content": {"parts": [{"text": '{"promptMatchScore":80,"compositionScore":80,"visualQualityScore":80,"detectedIssues":[],"recommendation":"keep","reason":"ok"}'}]}}
                    ]
                },
            )

    monkeypatch.setattr("app.vision_qa.httpx.Client", FakeClient)
    result = maybe_run_vision_qa(
        image,
        "一隻貓",
        Settings(
            nvidia_api_key="nv-test",
            gemini_api_key="gm-test",
            vision_qa_provider="gemini",
            vision_qa_enabled=True,
        ),
    )

    assert captured["url"].endswith(":generateContent")
    assert result["provider"] == "gemini"


def test_maybe_run_vision_qa_routes_to_nvidia_when_asked(monkeypatch):
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    captured = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, url, headers=None, json=None):
            captured["url"] = url
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {"message": {"content": '{"promptMatchScore":80,"compositionScore":80,"visualQualityScore":80,"detectedIssues":[],"recommendation":"keep","reason":"ok"}'}}
                    ]
                },
            )

    monkeypatch.setattr("app.vision_qa.httpx.Client", FakeClient)
    result = maybe_run_vision_qa(
        image,
        "一隻貓",
        Settings(
            nvidia_api_key="nv-test",
            gemini_api_key="gm-test",
            vision_qa_provider="nvidia",
            vision_qa_enabled=True,
        ),
    )

    assert captured["url"].endswith("/chat/completions")
    assert result["provider"] == "nvidia"


def test_maybe_run_vision_qa_nvidia_failure_stays_quiet(monkeypatch):
    image = make_demo_png_data_url("demo", 64, 64, "schnell")

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            return httpx.Response(500, text="upstream exploded with nvapi-secret")

    monkeypatch.setattr("app.vision_qa.httpx.Client", FakeClient)
    result = maybe_run_vision_qa(
        image, "一隻貓", Settings(nvidia_api_key="nv-test", vision_qa_enabled=True)
    )

    assert result["provider"] == "nvidia"
    assert result["available"] is False
    assert result["code"] == "vision_qa_failed"
    assert "nvapi-secret" not in str(result)
    assert "data:image" not in str(result)


def test_run_gemini_vision_qa_sends_inline_image_and_normalizes_scores(monkeypatch):
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    captured = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return httpx.Response(
                200,
                json={
                    "candidates": [
                        {
                            "content": {
                                "parts": [
                                    {
                                        "text": '{"promptMatchScore":88,"compositionScore":77,"visualQualityScore":66,"textAccuracyScore":55,"detectedIssues":["手指略怪"],"recommendation":"edit","reason":"主體符合，但手部需微調"}'
                                    }
                                ]
                            }
                        }
                    ]
                },
            )

    monkeypatch.setattr("app.vision_qa.httpx.Client", FakeClient)
    result = run_gemini_vision_qa(
        image,
        "一個人物拿著杯子",
        gemini_only(gemini_vision_model="gemini-test-vision"),
    )

    assert captured["url"].endswith("/models/gemini-test-vision:generateContent")
    assert captured["headers"]["x-goog-api-key"] == "test-key"
    parts = captured["json"]["contents"][0]["parts"]
    assert parts[1]["inline_data"]["mime_type"] == "image/png"
    # Gemini 用 responseSchema 綁欄位，提示詞不必再列一次。
    gen_config = captured["json"]["generationConfig"]
    assert gen_config["responseSchema"] is VISION_QA_SCHEMA
    assert "promptMatchScore" not in parts[0]["text"]
    # thinking 與輸出共用 maxOutputTokens：實測 gemini-2.5-flash 評一張複雜圖會用掉
    # 669 個 thinking token，只剩 16 個給 JSON，回來是半截字串（finishReason=MAX_TOKENS）。
    assert gen_config["thinkingConfig"] == {"thinkingBudget": 0}
    assert gen_config["maxOutputTokens"] >= 2048
    assert "data:image" not in str(captured["json"])
    assert result["provider"] == "gemini"
    assert result["available"] is True
    assert result["promptMatchScore"] == 88
    assert result["compositionScore"] == 77
    assert result["visualQualityScore"] == 66
    assert result["textAccuracyScore"] == 55
    assert result["detectedIssues"] == ["手指略怪"]
    assert result["recommendation"] == "edit"


def test_maybe_run_vision_qa_fails_open_without_sensitive_payload(monkeypatch):
    image = make_demo_png_data_url("demo", 64, 64, "schnell")

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, *args, **kwargs):
            return httpx.Response(500, text="upstream exploded with secret")

    monkeypatch.setattr("app.vision_qa.httpx.Client", FakeClient)
    result = maybe_run_vision_qa(image, "一隻貓", gemini_only())

    assert result["provider"] == "gemini"
    assert result["available"] is False
    assert result["code"] == "vision_qa_failed"
    assert "data:image" not in str(result)
