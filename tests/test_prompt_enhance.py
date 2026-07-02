from unittest.mock import patch

import pytest

from app.prompt_enhance import PromptEnhanceResult, enhance_prompt


def test_enhance_prompt_rejects_blank_prompt():
    with pytest.raises(ValueError, match="請先輸入提示詞"):
        enhance_prompt("   ", "更夢幻")


def test_enhance_prompt_rejects_blank_effect():
    with pytest.raises(ValueError, match="請說明想要的效果"):
        enhance_prompt("a cat on a windowsill", "   ")


def test_enhance_prompt_passes_trimmed_values_to_llm_and_wraps_result():
    with patch("app.prompt_enhance.llm_enhance_prompt") as mocked_llm:
        mocked_llm.return_value = "A dreamy photograph of a cat on a windowsill, misty glow, highly detailed"
        result = enhance_prompt("  a cat on a windowsill  ", "  更夢幻  ")

    assert isinstance(result, PromptEnhanceResult)
    assert result.provider == "gemini"
    assert result.prompt.startswith("A dreamy photograph")
    assert result.effect == "更夢幻"
    mocked_llm.assert_called_once_with("a cat on a windowsill", "更夢幻")
