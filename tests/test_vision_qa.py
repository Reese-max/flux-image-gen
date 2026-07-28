import httpx

from app.demo_image import make_demo_png_data_url
from app.settings import Settings
from app.vision_qa import maybe_run_vision_qa, run_nvidia_vision_qa


def enabled(**overrides) -> Settings:
    """啟用 QA 且有 NVIDIA 金鑰的設定。明確給 key，才不會受 shell 環境變數影響
    （Settings 的預設值是 import 時從 os.getenv 取的）。"""
    overrides.setdefault("nvidia_api_key", "nv-test")
    return Settings(vision_qa_enabled=True, **overrides)


class FakeClient:
    """讓測試指定回應的假 httpx.Client；請求會被記進 captured。"""

    captured: dict = {}
    response: httpx.Response | None = None

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def post(self, url, headers=None, json=None):
        type(self).captured = {"url": url, "headers": headers, "json": json}
        return type(self).response


def fake_client_returning(monkeypatch, response: httpx.Response):
    klass = type("PinnedFakeClient", (FakeClient,), {"response": response, "captured": {}})
    monkeypatch.setattr("app.vision_qa.httpx.Client", klass)
    return klass


def ok_response(**overrides) -> httpx.Response:
    body = {
        "promptMatchScore": 91,
        "compositionScore": 80,
        "visualQualityScore": 72,
        "detectedIssues": ["背景略雜"],
        "recommendation": "keep",
        "reason": "主體清楚",
    }
    body.update(overrides)
    import json as _json

    return httpx.Response(200, json={"choices": [{"message": {"content": _json.dumps(body, ensure_ascii=False)}}]})


def test_maybe_run_vision_qa_is_disabled_by_default():
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    assert maybe_run_vision_qa(image, "一隻貓", Settings(nvidia_api_key="nv-test")) is None


def test_maybe_run_vision_qa_needs_the_nvidia_key():
    """沒金鑰就靜靜跳過，而不是丟出錯誤物件——生成本身不該因為 QA 不可用而變髒。"""
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    assert maybe_run_vision_qa(image, "一隻貓", Settings(nvidia_api_key="", vision_qa_enabled=True)) is None


def test_run_nvidia_vision_qa_posts_openai_shape_and_normalizes_scores(monkeypatch):
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    client = fake_client_returning(monkeypatch, ok_response())

    result = run_nvidia_vision_qa(
        image, "一個人物拿著杯子", enabled(nvidia_vision_model="meta/test-vlm")
    )

    assert client.captured["url"].endswith("/chat/completions")
    assert client.captured["headers"]["Authorization"] == "Bearer nv-test"
    assert client.captured["json"]["model"] == "meta/test-vlm"
    assert client.captured["json"]["response_format"] == {"type": "json_object"}
    content = client.captured["json"]["messages"][0]["content"]
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    # data URL 只該出現在 image_url，不該連 prompt 一起夾帶。
    assert "data:image" not in content[0]["text"]
    assert result["provider"] == "nvidia"
    assert result["promptMatchScore"] == 91
    assert result["detectedIssues"] == ["背景略雜"]
    assert result["recommendation"] == "keep"
    # 回應沒給的欄位由 normalize 兜底，不丟例外。
    assert "textAccuracyScore" not in result


def test_nvidia_prompt_spells_out_every_field(monkeypatch):
    """json_object 只保證合法 JSON、不保證欄位。欄位名沒寫進提示詞時，模型會回
    合法但欄位不同的 JSON，_normalize_vision_qa 全部填兜底值（70/70/70、空 issues），
    看起來成功其實什麼都沒評估到——實際踩過這個坑。"""
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    client = fake_client_returning(monkeypatch, ok_response())

    run_nvidia_vision_qa(image, "一隻貓", enabled())

    text = client.captured["json"]["messages"][0]["content"][0]["text"]
    for field in (
        "promptMatchScore",
        "compositionScore",
        "visualQualityScore",
        "textAccuracyScore",
        "detectedIssues",
        "recommendation",
        "reason",
    ):
        assert field in text


def test_run_nvidia_vision_qa_accepts_content_returned_as_parts(monkeypatch):
    """有些 NIM 模型把 content 回成陣列而不是字串。"""
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    fake_client_returning(monkeypatch, httpx.Response(200, json={
        "choices": [{"message": {"content": [
            {"type": "text", "text": '{"promptMatchScore":70,'},
            {"type": "text", "text": '"compositionScore":60,"visualQualityScore":50,'
                                     '"detectedIssues":[],"recommendation":"retry","reason":"構圖偏移"}'},
        ]}}]
    }))

    result = run_nvidia_vision_qa(image, "一隻貓", enabled())
    assert result["promptMatchScore"] == 70
    assert result["recommendation"] == "retry"


def test_maybe_run_vision_qa_runs_when_enabled(monkeypatch):
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    client = fake_client_returning(monkeypatch, ok_response())

    result = maybe_run_vision_qa(image, "一隻貓", enabled())

    assert client.captured["url"].endswith("/chat/completions")
    assert result["provider"] == "nvidia"
    assert result["available"] is True


def test_maybe_run_vision_qa_failure_stays_quiet(monkeypatch):
    """失敗要 fail open，且不得把金鑰或圖片內容漏進回應。"""
    image = make_demo_png_data_url("demo", 64, 64, "schnell")
    fake_client_returning(monkeypatch, httpx.Response(500, text="upstream exploded with nvapi-secret"))

    result = maybe_run_vision_qa(image, "一隻貓", enabled())

    assert result["provider"] == "nvidia"
    assert result["available"] is False
    assert result["code"] == "vision_qa_failed"
    assert "nvapi-secret" not in str(result)
    assert "data:image" not in str(result)
