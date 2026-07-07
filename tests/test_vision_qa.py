import httpx

from app.demo_image import make_demo_png_data_url
from app.settings import Settings
from app.vision_qa import maybe_run_vision_qa, run_gemini_vision_qa


def test_maybe_run_vision_qa_is_disabled_by_default():
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    result = maybe_run_vision_qa(image, "一隻貓", Settings(gemini_api_key="key", vision_qa_enabled=False))
    assert result is None


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
        Settings(gemini_api_key="test-key", gemini_vision_model="gemini-test-vision", vision_qa_enabled=True),
    )

    assert captured["url"].endswith("/models/gemini-test-vision:generateContent")
    assert captured["headers"]["x-goog-api-key"] == "test-key"
    parts = captured["json"]["contents"][0]["parts"]
    assert parts[1]["inline_data"]["mime_type"] == "image/png"
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
    result = maybe_run_vision_qa(
        image,
        "一隻貓",
        Settings(gemini_api_key="test-key", vision_qa_enabled=True),
    )

    assert result["provider"] == "gemini"
    assert result["available"] is False
    assert result["code"] == "vision_qa_failed"
    assert "data:image" not in str(result)
