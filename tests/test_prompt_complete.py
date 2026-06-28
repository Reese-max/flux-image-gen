from types import SimpleNamespace

import pytest

from app import prompt_complete
from app.prompt_llm import PromptLLMError


def _fake_settings(gemini_api_key="", gemini_complete_model="gemma-4-26b-a4b-it"):
    return SimpleNamespace(
        gemini_api_key=gemini_api_key,
        gemini_complete_model=gemini_complete_model,
    )


def test_complete_requires_gemini_key(monkeypatch):
    monkeypatch.setattr(
        prompt_complete,
        "get_settings",
        lambda: _fake_settings(gemini_api_key=""),
    )

    with pytest.raises(PromptLLMError, match="missing GEMINI_API_KEY"):
        prompt_complete.complete_plain_prompt("一個女生在雨中", style="cinematic")


def test_complete_uses_gemma_chinese_completion(monkeypatch):
    monkeypatch.setattr(
        prompt_complete,
        "get_settings",
        lambda: _fake_settings(gemini_api_key="test-key"),
    )
    monkeypatch.setattr(
        prompt_complete,
        "llm_complete_prompt",
        lambda source, style, settings=None: "一位年輕女生站在夜晚雨中的街道，濕潤柏油路反射霓虹燈光，畫面具有電影感。",
    )

    result = prompt_complete.complete_plain_prompt("女生雨中", style="cinematic")

    assert result.provider == "gemini"
    assert result.source == "女生雨中"
    assert result.style == "cinematic"
    assert "霓虹燈" in result.prompt
    assert "女生" in result.prompt
