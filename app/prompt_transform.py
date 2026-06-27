from __future__ import annotations

from dataclasses import dataclass
import logging
import re

from .prompt_llm import PromptLLMError, codex_transform_prompt, llm_transform_prompt
from .settings import get_settings

_log = logging.getLogger(__name__)


SUPPORTED_STYLES = {"auto", "cute", "cinematic", "realistic", "anime", "product"}
MAX_PROMPT_LENGTH = 900
CJK_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

PHRASE_RULES = (
    (("台北", "臺北", "夜市"), "Taipei night market"),
    (("下雨", "雨天", "雨", "街景"), "rainy street scene"),
    (("柴犬",), "Shiba Inu"),
    (("貓", "猫"), "cat"),
    (("狗", "犬"), "dog"),
    (("月球", "月亮", "月面"), "on the moon"),
    (("拉麵", "拉面"), "eating ramen"),
    (("可愛", "萌", "療癒"), "adorable"),
    (("紅色", "紅"), "red"),
    (("白色", "白"), "white"),
    (("黑色", "黑"), "black"),
    (("藍色", "藍"), "blue"),
    (("綠色", "綠"), "green"),
    (("黃色", "黃"), "yellow"),
    (("杯子", "杯"), "cup"),
    (("木桌", "木桌上"), "wooden table"),
    (("桌上", "桌子", "桌面"), "tabletop"),
    (("陽光", "日光", "自然光"), "sunlight"),
)

TRANSLATED_CHINESE_TERMS = tuple(
    sorted(
        {keyword for keywords, _phrase in PHRASE_RULES for keyword in keywords},
        key=len,
        reverse=True,
    )
)
CHINESE_FILLER_TERMS = (
    "旁邊",
    "附近",
    "放在",
    "放置",
    "正在",
    "風格",
    "一點",
    "一個",
    "一隻",
    "一張",
    "一片",
    "一位",
    "一名",
    "幫我",
    "請",
    "生成",
    "圖片",
    "照片",
    "場景",
    "上",
    "下",
    "裡",
    "中",
    "旁",
    "的",
    "在",
    "有",
    "和",
    "與",
    "並",
    "要",
    "吃",
    "個",
    "隻",
    "張",
    "片",
    "位",
    "名",
)


@dataclass(frozen=True)
class PromptTransformResult:
    provider: str
    prompt: str
    warnings: tuple[str, ...] = ()
    style: str = "auto"
    source: str = ""


def transform_plain_prompt(source: str, style: str = "auto") -> PromptTransformResult:
    source_text = (source or "").strip()
    if not source_text:
        raise ValueError("請先輸入白話描述")

    normalized_style = _normalize_style(style)
    resolved_style = _resolve_style(source_text, normalized_style)

    settings = get_settings()

    # Tier 1: Gemini (primary) → Tier 2: local Codex proxy → Tier 3: offline rules.
    if settings.gemini_api_key:
        try:
            prompt = llm_transform_prompt(source_text, resolved_style)
            return _llm_result("gemini", prompt, resolved_style, source_text)
        except PromptLLMError as exc:
            _log.warning("gemini prompt transform failed, falling back: %s", exc)

    if settings.codex_api_key:
        try:
            prompt = codex_transform_prompt(source_text, resolved_style)
            return _llm_result("codex", prompt, resolved_style, source_text)
        except PromptLLMError as exc:
            _log.warning("codex prompt transform failed, falling back: %s", exc)

    return _rule_based_transform(source_text, resolved_style)


def _llm_result(
    provider: str, prompt: str, resolved_style: str, source_text: str
) -> PromptTransformResult:
    return PromptTransformResult(
        provider=provider,
        prompt=prompt,
        warnings=(),
        style=resolved_style,
        source=source_text,
    )


def _rule_based_transform(source_text: str, resolved_style: str) -> PromptTransformResult:
    core_phrases = _extract_core_phrases(source_text)
    warnings = _build_warnings(source_text)
    modifiers = _style_modifiers(resolved_style)
    prompt_parts = _dedupe(core_phrases + modifiers + ["highly detailed"])
    prompt = ", ".join(prompt_parts)

    if len(prompt) > MAX_PROMPT_LENGTH:
        prompt = prompt[:MAX_PROMPT_LENGTH].rstrip(" ,")

    return PromptTransformResult(
        provider="rule_based",
        prompt=prompt,
        warnings=tuple(warnings),
        style=resolved_style,
        source=source_text,
    )


def _normalize_style(style: str) -> str:
    style_key = (style or "auto").strip().lower()
    if style_key not in SUPPORTED_STYLES:
        return "auto"
    return style_key


def _resolve_style(source_text: str, style: str) -> str:
    if style != "auto":
        return style

    if any(keyword in source_text for keyword in ("可愛", "萌", "療癒")):
        return "cute"
    if any(keyword in source_text for keyword in ("電影", "鏡頭", "夜景", "街景")):
        return "cinematic"
    if any(keyword in source_text for keyword in ("動畫", "動漫", "二次元")):
        return "anime"
    if any(keyword in source_text for keyword in ("商品", "產品", "包裝")):
        return "product"
    if any(keyword in source_text for keyword in ("寫實", "真實", "照片")):
        return "realistic"
    return "auto"


def _build_warnings(source_text: str) -> list[str]:
    warnings: list[str] = []
    if len(source_text) <= 2:
        warnings.append("描述較短")
    if _has_untranslated_cjk(source_text):
        warnings.append("部分詞彙未能精準翻譯，已使用通用英文描述補足")
    return warnings


def _extract_core_phrases(source_text: str) -> list[str]:
    phrases: list[str] = []
    for keywords, phrase in PHRASE_RULES:
        if any(keyword in source_text for keyword in keywords):
            phrases.append(phrase)

    if not phrases:
        phrases.append(_fallback_core_phrase(source_text))
    return _dedupe(phrases)


def _fallback_core_phrase(source_text: str) -> str:
    if _contains_cjk(source_text) or any(ord(char) > 127 for char in source_text):
        return "imaginative visual scene"
    return source_text


def _contains_cjk(text: str) -> bool:
    return CJK_PATTERN.search(text) is not None


def _has_untranslated_cjk(source_text: str) -> bool:
    if not _contains_cjk(source_text):
        return False

    remaining = source_text
    for term in TRANSLATED_CHINESE_TERMS + CHINESE_FILLER_TERMS:
        remaining = remaining.replace(term, "")
    return _contains_cjk(remaining)


def _style_modifiers(style: str) -> list[str]:
    modifiers_by_style = {
        "cute": ["adorable", "soft rounded shapes", "warm pastel colors"],
        "cinematic": [
            "cinematic lighting",
            "film still",
            "dramatic atmosphere",
            "shallow depth of field",
        ],
        "realistic": ["photorealistic", "natural lighting", "realistic textures"],
        "anime": ["anime style", "expressive character design", "vibrant colors"],
        "product": ["studio product photography", "clean background", "commercial lighting"],
        "auto": ["clean composition"],
    }
    return modifiers_by_style.get(style, modifiers_by_style["auto"])


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result
