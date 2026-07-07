from __future__ import annotations

import base64
import json
import re
from typing import Any

import httpx

from .settings import Settings, get_settings


class VisionQAError(Exception):
    """Raised when optional visual QA is unavailable or fails."""


VISION_QA_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "promptMatchScore": {"type": "NUMBER"},
        "compositionScore": {"type": "NUMBER"},
        "visualQualityScore": {"type": "NUMBER"},
        "textAccuracyScore": {"type": "NUMBER"},
        "detectedIssues": {"type": "ARRAY", "items": {"type": "STRING"}},
        "recommendation": {"type": "STRING", "enum": ["keep", "retry", "edit"]},
        "reason": {"type": "STRING"},
    },
    "required": [
        "promptMatchScore",
        "compositionScore",
        "visualQualityScore",
        "detectedIssues",
        "recommendation",
        "reason",
    ],
}


def maybe_run_vision_qa(image: str, prompt: str, settings: Settings | None = None) -> dict[str, Any] | None:
    resolved = settings or get_settings()
    if not resolved.vision_qa_enabled:
        return None
    if not resolved.gemini_api_key.strip():
        return None
    try:
        return run_gemini_vision_qa(image, prompt, resolved)
    except VisionQAError as exc:
        return {
            "provider": "gemini",
            "available": False,
            "code": "vision_qa_failed",
            "message": "視覺 QA 暫時不可用，已保留本機 QAReport",
            "detail": str(exc)[:160],
        }


def run_gemini_vision_qa(image: str, prompt: str, settings: Settings | None = None) -> dict[str, Any]:
    resolved = settings or get_settings()
    api_key = resolved.gemini_api_key.strip()
    if not api_key:
        raise VisionQAError("missing GEMINI_API_KEY")
    mime, b64 = _extract_inline_image(image)
    user_text = (
        "請以繁體中文評估這張 AI 生成圖片是否符合提示詞。"
        "只回 JSON，不要加註解。分數 0-100。"
        "請特別檢查：主體是否存在、構圖是否平衡、畫質是否清晰、手指/臉部是否異常、"
        "是否有文字亂碼、浮水印、主體缺失、尺寸用途不適合。"
        "\n\n提示詞：\n"
        + prompt.strip()[:4000]
    )
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": user_text},
                    {"inline_data": {"mime_type": mime, "data": b64}},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 700,
            "responseMimeType": "application/json",
            "responseSchema": VISION_QA_SCHEMA,
        },
    }
    url = f"{resolved.gemini_base_url.rstrip('/')}/models/{resolved.gemini_vision_model}:generateContent"
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
    try:
        with httpx.Client(timeout=resolved.prompt_llm_timeout_seconds) as client:
            response = client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise VisionQAError("vision qa request failed") from exc
    if response.status_code != 200:
        raise VisionQAError(f"vision qa returned HTTP {response.status_code}")
    try:
        raw = _parse_gemini_text(response.json())
    except (ValueError, KeyError, TypeError) as exc:
        raise VisionQAError("vision qa returned invalid response") from exc
    parsed = _parse_json_object(raw)
    return _normalize_vision_qa(parsed)


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


def _parse_gemini_text(data: dict[str, Any]) -> str:
    feedback = data.get("promptFeedback") or {}
    if feedback.get("blockReason"):
        raise VisionQAError(f"vision qa blocked: {feedback.get('blockReason')}")
    candidates = data.get("candidates") or []
    parts = (candidates[0].get("content") or {}).get("parts") if candidates else []
    return "".join(part.get("text", "") for part in (parts or [])).strip()


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
        "provider": "gemini",
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
