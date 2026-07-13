from unittest.mock import patch
from types import SimpleNamespace

import pytest

from app.prompt_enhance import PromptEnhanceResult, enhance_prompt
from app.prompt_llm import PromptLLMError


def test_enhance_prompt_rejects_blank_prompt():
    with pytest.raises(ValueError, match="請先輸入提示詞"):
        enhance_prompt("   ", "更夢幻")


def test_enhance_prompt_rejects_blank_effect():
    with pytest.raises(ValueError, match="請說明想要的效果"):
        enhance_prompt("a cat on a windowsill", "   ")

def test_enhance_prompt_rejects_oversized_inputs():
    with pytest.raises(ValueError, match="提示詞太長"):
        enhance_prompt("a" * 4001, "更夢幻")
    with pytest.raises(ValueError, match="效果描述太長"):
        enhance_prompt("a cat", "夢" * 501)


def test_enhance_prompt_passes_trimmed_values_to_llm_and_wraps_result():
    with patch("app.prompt_enhance.get_settings", return_value=SimpleNamespace(gemini_api_key="test-key")), patch(
        "app.prompt_enhance.llm_enhance_prompt"
    ) as mocked_llm:
        mocked_llm.return_value = "A dreamy photograph of a cat on a windowsill, misty glow, highly detailed"
        result = enhance_prompt("  a cat on a windowsill  ", "  更夢幻  ")

    assert isinstance(result, PromptEnhanceResult)
    assert result.provider == "gemini"
    assert result.prompt.startswith("A dreamy photograph")
    assert result.effect == "更夢幻"
    mocked_llm.assert_called_once_with("a cat on a windowsill", "更夢幻")


def test_enhance_prompt_uses_offline_rules_without_gemini_key():
    with patch("app.prompt_enhance.get_settings", return_value=SimpleNamespace(gemini_api_key="")):
        result = enhance_prompt("a cat on a windowsill", "更夢幻，加一點霧氣")

    assert result.provider == "rule_based"
    assert "dreamy ethereal atmosphere" in result.prompt
    assert "original subject" in result.prompt
    assert "離線效果強化" in result.warnings[0]


def test_enhance_prompt_falls_back_when_gemini_fails():
    with patch("app.prompt_enhance.get_settings", return_value=SimpleNamespace(gemini_api_key="test-key")), patch(
        "app.prompt_enhance.llm_enhance_prompt",
        side_effect=PromptLLMError("temporary"),
    ):
        result = enhance_prompt("a premium bottle", "高級精品感")

    assert result.provider == "rule_based"
    assert "premium editorial styling" in result.prompt
    assert "Gemini 暫時不可用" in result.warnings[0]
