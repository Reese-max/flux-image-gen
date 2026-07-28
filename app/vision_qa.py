from __future__ import annotations

import base64
import json
import re
from typing import Any

import httpx

from .settings import Settings, get_settings


class VisionQAError(Exception):
    """Raised when optional visual QA is unavailable or fails."""


VISION_QA_USER_TEXT = (
    "請以繁體中文評估這張 AI 生成圖片是否符合提示詞。"
    "只回 JSON，不要加註解。分數 0-100。"
    "請特別檢查：主體是否存在、構圖是否平衡、畫質是否清晰、手指/臉部是否異常、"
    "是否有文字亂碼、浮水印、主體缺失、尺寸用途不適合。"
    # NVIDIA 只有 response_format=json_object，保證合法 JSON 但不保證欄位。不把欄位名
    # 寫進提示詞，模型會回合法但欄位不同的 JSON，_normalize_vision_qa 全部填兜底值
    # （70/70/70、空 issues），看起來成功其實什麼都沒評估到。
    "\n\n只回下面這個 JSON 物件，欄位一個都不能少："
    '{"promptMatchScore": 整數 0-100, "compositionScore": 整數 0-100, '
    '"visualQualityScore": 整數 0-100, "textAccuracyScore": 整數 0-100（畫面沒有文字就給 100）, '
    '"detectedIssues": 字串陣列（沒發現問題就給 []）, '
    '"recommendation": "keep" 或 "retry" 或 "edit", "reason": 一句繁體中文說明}'
)


def maybe_run_vision_qa(image: str, prompt: str, settings: Settings | None = None) -> dict[str, Any] | None:
    resolved = settings or get_settings()
    if not resolved.vision_qa_enabled:
        return None
    if not resolved.nvidia_api_key.strip():
        return None
    try:
        return run_nvidia_vision_qa(image, prompt, resolved)
    except VisionQAError as exc:
        return {
            "provider": "nvidia",
            "available": False,
            "code": "vision_qa_failed",
            "message": "視覺 QA 暫時不可用，已保留本機 QAReport",
            "detail": str(exc)[:160],
        }


def run_nvidia_vision_qa(image: str, prompt: str, settings: Settings | None = None) -> dict[str, Any]:
    """OpenAI 相容的 chat/completions + data URI 圖片。

    走 NVIDIA 是為了與生圖共用同一把金鑰，不另外吃付費配額；代價是延遲較高
    （實測 1024x1024 中位約 8.4 秒）。
    """
    resolved = settings or get_settings()
    api_key = resolved.nvidia_api_key.strip()
    if not api_key:
        raise VisionQAError("missing NVIDIA_API_KEY")
    mime, b64 = _extract_inline_image(image)
    payload = {
        "model": resolved.nvidia_vision_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _build_vision_user_text(prompt)},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            }
        ],
        "max_tokens": 700,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }
    url = f"{resolved.nvidia_chat_base_url.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=resolved.prompt_llm_timeout_seconds) as client:
            response = client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise VisionQAError("vision qa request failed") from exc
    if response.status_code != 200:
        raise VisionQAError(f"vision qa returned HTTP {response.status_code}")
    try:
        raw = _parse_openai_text(response.json())
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        raise VisionQAError("vision qa returned invalid response") from exc
    parsed = _parse_json_object(raw)
    return _normalize_vision_qa(parsed)


def _build_vision_user_text(prompt: str) -> str:
    return VISION_QA_USER_TEXT + "\n\n提示詞：\n" + prompt.strip()[:4000]


def _parse_openai_text(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise VisionQAError("vision qa returned no choices")
    content = (choices[0].get("message") or {}).get("content")
    if isinstance(content, list):
        # 有些 NIM 模型回 content 陣列而非字串。
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content or "").strip()


def _extract_inline_image(image: str) -> tuple[str, str]:
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$", image or "")
    if not match:
        raise VisionQAError("vision qa requires a data URL image")
    mime = match.group(1)
    b64 = re.sub(r"\s+", "", match.group(2))
    try:
        base64.b64decode(b64, validate=True)
    except ValueError as exc:
        raise VisionQAError("vision qa image base64 is invalid") from exc
    if len(b64) > 7_000_000:
        raise VisionQAError("vision qa image is too large")
    return mime, b64


def _parse_json_object(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        text = "\n".join(line for line in text.splitlines() if not line.strip().startswith("```")).strip()
    try:
        parsed = json.loads(text)
    except ValueError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise VisionQAError("vision qa JSON is not an object")
    return parsed


def _score(value: Any, default: int = 70) -> int:
    try:
        number = round(float(value))
    except (TypeError, ValueError):
        number = default
    return max(0, min(100, number))


def _normalize_vision_qa(data: dict[str, Any]) -> dict[str, Any]:
    issues = data.get("detectedIssues")
    if not isinstance(issues, list):
        issues = []
    clean_issues = [str(issue).strip()[:120] for issue in issues if str(issue).strip()]
    recommendation = str(data.get("recommendation") or "edit").strip().lower()
    if recommendation not in {"keep", "retry", "edit"}:
        recommendation = "edit"
    result: dict[str, Any] = {
        "provider": "nvidia",
        "available": True,
        "promptMatchScore": _score(data.get("promptMatchScore")),
        "compositionScore": _score(data.get("compositionScore")),
        "visualQualityScore": _score(data.get("visualQualityScore")),
        "detectedIssues": clean_issues[:8],
        "recommendation": recommendation,
        "reason": str(data.get("reason") or "已完成視覺 QA").strip()[:220],
    }
    if data.get("textAccuracyScore") is not None:
        result["textAccuracyScore"] = _score(data.get("textAccuracyScore"))
    return result
