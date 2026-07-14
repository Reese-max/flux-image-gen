from __future__ import annotations

from dataclasses import dataclass

from .prompt_llm import MAX_PROMPT_SOURCE_LENGTH, PromptLLMError, llm_complete_prompt
from .prompt_transform import _normalize_style, _resolve_style
from .settings import get_settings

STYLE_FALLBACK_DETAILS = {
    "cute": "柔和明亮的色彩，圓潤可愛的造型，溫暖療癒的氛圍",
    "cinematic": "具有層次的電影光影，明確鏡頭構圖，背景帶有景深與情緒氛圍",
    "realistic": "自然可信的光線與材質，寫實攝影質感，細節清楚",
    "anime": "乾淨俐落的動漫線條，鮮明角色設計，色彩活潑",
    "product": "主體置中清楚，乾淨商業背景，細緻棚拍光線與材質反射",
    "auto": "主體清楚，構圖完整，背景、光線與色調協調，畫面細節自然",
}


@dataclass(frozen=True)
class PromptCompleteResult:
    provider: str
    prompt: str
    warnings: tuple[str, ...] = ()
    style: str = "auto"
    source: str = ""

def rule_based_complete_prompt(source: str, style: str) -> str:
    base = source.rstrip("，。,.！!？?；; ")
    detail = STYLE_FALLBACK_DETAILS.get(style, STYLE_FALLBACK_DETAILS["auto"])
    completed = f"{base}。" if detail in base else f"{base}，{detail}。"
    if len(completed) > 180:
        completed = completed[:179].rstrip("，。,.；; ") + "。"
    return completed


def complete_plain_prompt(source: str, style: str = "auto") -> PromptCompleteResult:
    source_text = (source or "").strip()
    if not source_text:
        raise ValueError("請先輸入白話描述")
    if len(source_text) > MAX_PROMPT_SOURCE_LENGTH:
        raise ValueError("描述太長")

    normalized_style = _normalize_style(style)
    resolved_style = _resolve_style(source_text, normalized_style)
    settings = get_settings()
    warnings: tuple[str, ...]

    if settings.gemini_api_key.strip():
        try:
            completed = llm_complete_prompt(source_text, resolved_style, settings=settings)
            provider = "gemini"
            warnings = ()
        except PromptLLMError:
            completed = rule_based_complete_prompt(source_text, resolved_style)
            provider = "rule_based"
            warnings = ("Gemma 暫時不可用，已改用離線補全",)
    else:
        completed = rule_based_complete_prompt(source_text, resolved_style)
        provider = "rule_based"
        warnings = ("未設定 Gemini，已使用離線補全",)
    return PromptCompleteResult(
        provider=provider,
        prompt=completed,
        warnings=warnings,
        style=resolved_style,
        source=source_text,
    )
