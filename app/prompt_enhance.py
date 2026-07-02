from __future__ import annotations

from dataclasses import dataclass

from .prompt_llm import llm_enhance_prompt


@dataclass(frozen=True)
class PromptEnhanceResult:
    provider: str
    prompt: str
    effect: str = ""


def enhance_prompt(prompt: str, effect: str) -> PromptEnhanceResult:
    """Rewrite an English prompt so it incorporates the user's requested effect.

    Effect optimisation is Gemini-only: llm_enhance_prompt raises PromptLLMError
    when no GEMINI_API_KEY is configured, and the caller maps that to HTTP 503.
    """
    base = (prompt or "").strip()
    if not base:
        raise ValueError("請先輸入提示詞")

    wanted = (effect or "").strip()
    if not wanted:
        raise ValueError("請說明想要的效果")

    refined = llm_enhance_prompt(base, wanted)
    return PromptEnhanceResult(provider="gemini", prompt=refined, effect=wanted)
