from __future__ import annotations

from dataclasses import dataclass

from .prompt_llm import PromptLLMError, llm_complete_prompt
from .prompt_transform import _normalize_style, _resolve_style
from .settings import get_settings


@dataclass(frozen=True)
class PromptCompleteResult:
    provider: str
    prompt: str
    warnings: tuple[str, ...] = ()
    style: str = "auto"
    source: str = ""


def complete_plain_prompt(source: str, style: str = "auto") -> PromptCompleteResult:
    source_text = (source or "").strip()
    if not source_text:
        raise ValueError("請先輸入白話描述")

    normalized_style = _normalize_style(style)
    resolved_style = _resolve_style(source_text, normalized_style)
    settings = get_settings()

    if not settings.gemini_api_key.strip():
        raise PromptLLMError("missing GEMINI_API_KEY")

    completed = llm_complete_prompt(source_text, resolved_style, settings=settings)
    return PromptCompleteResult(
        provider="gemini",
        prompt=completed,
        warnings=(),
        style=resolved_style,
        source=source_text,
    )
