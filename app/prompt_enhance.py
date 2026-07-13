from __future__ import annotations

from dataclasses import dataclass

from .prompt_llm import (
    ENHANCE_FALLBACK_DEFAULT_MODIFIER,
    ENHANCE_FALLBACK_RULES,
    MAX_ENHANCE_EFFECT_LENGTH,
    MAX_ENHANCE_PROMPT_LENGTH,
    MAX_LLM_PROMPT_LENGTH,
    PromptLLMError,
    llm_enhance_prompt,
)
from .settings import get_settings


@dataclass(frozen=True)
class PromptEnhanceResult:
    provider: str
    prompt: str
    effect: str = ""
    warnings: tuple[str, ...] = ()


def rule_based_enhance_prompt(prompt: str, effect: str) -> str:
    lowered = effect.lower()
    modifiers = [
        str(rule["modifier"])
        for rule in ENHANCE_FALLBACK_RULES
        if any(str(keyword).lower() in lowered for keyword in rule["keywords"])
    ]
    if not modifiers:
        modifiers = [str(ENHANCE_FALLBACK_DEFAULT_MODIFIER)]
    base = prompt.rstrip(" .")
    refined = (
        f"{base}. Add {'; '.join(modifiers)} while preserving the original "
        "subject, composition, and concrete details."
    )
    if len(refined) > MAX_LLM_PROMPT_LENGTH:
        refined = refined[:MAX_LLM_PROMPT_LENGTH].rstrip(" ,.;") + "."
    return refined


def enhance_prompt(prompt: str, effect: str) -> PromptEnhanceResult:
    """Rewrite a prompt with Gemini when available, otherwise use local rules."""
    base = (prompt or "").strip()
    if not base:
        raise ValueError("請先輸入提示詞")
    if len(base) > MAX_ENHANCE_PROMPT_LENGTH:
        raise ValueError("提示詞太長")

    wanted = (effect or "").strip()
    if not wanted:
        raise ValueError("請說明想要的效果")
    if len(wanted) > MAX_ENHANCE_EFFECT_LENGTH:
        raise ValueError("效果描述太長")

    settings = get_settings()
    if settings.gemini_api_key.strip():
        try:
            refined = llm_enhance_prompt(base, wanted)
            return PromptEnhanceResult(provider="gemini", prompt=refined, effect=wanted)
        except PromptLLMError:
            warning = "Gemini 暫時不可用，已改用離線效果強化"
    else:
        warning = "未設定 Gemini，已使用離線效果強化"
    return PromptEnhanceResult(
        provider="rule_based",
        prompt=rule_based_enhance_prompt(base, wanted),
        effect=wanted,
        warnings=(warning,),
    )
