from types import SimpleNamespace

import pytest

from app import prompt_transform
from app.prompt_llm import (
    PromptLLMError,
    _parse_codex_response,
    _parse_gemini_response,
    _strip_wrapping,
    llm_transform_prompt,
)


def _fake_settings(gemini_api_key="", codex_api_key=""):
    return SimpleNamespace(gemini_api_key=gemini_api_key, codex_api_key=codex_api_key)


def test_parse_gemini_response_returns_stripped_text():
    data = {
        "candidates": [
            {"content": {"parts": [{"text": "  A serene mountain at dawn.  "}]}}
        ]
    }
    assert _parse_gemini_response(data) == "A serene mountain at dawn."


def test_parse_gemini_response_extracts_prompt_from_json_envelope():
    data = {
        "candidates": [
            {"content": {"parts": [{"text": '{"prompt": "a red cup on a wooden table"}'}]}}
        ]
    }
    assert _parse_gemini_response(data) == "a red cup on a wooden table"


def test_parse_gemini_response_handles_trailing_code_fence():
    # Gemma sometimes appends a code fence even in JSON mode; the {...} must still
    # be extracted cleanly rather than leaking the envelope into the prompt.
    raw = '{\n  "prompt": "a quiet lake at dawn"\n}\n```'
    data = {"candidates": [{"content": {"parts": [{"text": raw}]}}]}
    assert _parse_gemini_response(data) == "a quiet lake at dawn"


def test_parse_gemini_response_blocked_raises():
    data = {"promptFeedback": {"blockReason": "SAFETY"}}
    with pytest.raises(PromptLLMError, match="blocked"):
        _parse_gemini_response(data)


def test_parse_gemini_response_no_candidates_raises():
    with pytest.raises(PromptLLMError, match="no candidates"):
        _parse_gemini_response({"candidates": []})


def test_parse_gemini_response_empty_text_raises():
    data = {"candidates": [{"content": {"parts": [{"text": "   "}]}}]}
    with pytest.raises(PromptLLMError, match="empty"):
        _parse_gemini_response(data)


def test_strip_wrapping_removes_code_fence_and_quotes():
    assert _strip_wrapping('```\na red cup on a table\n```') == "a red cup on a table"
    assert _strip_wrapping('"a red cup on a table"') == "a red cup on a table"


def test_llm_transform_prompt_missing_key_raises():
    fake_settings = SimpleNamespace(gemini_api_key="   ")
    with pytest.raises(PromptLLMError, match="missing GEMINI_API_KEY"):
        llm_transform_prompt("一隻貓", "auto", settings=fake_settings)


def test_parse_codex_response_extracts_prompt_from_choices():
    data = {"choices": [{"message": {"content": '{"prompt": "a misty pine forest"}'}}]}
    assert _parse_codex_response(data) == "a misty pine forest"


def test_transform_falls_back_to_rule_based_when_llm_fails(monkeypatch):
    monkeypatch.setattr(prompt_transform, "get_settings", lambda: _fake_settings(gemini_api_key="key"))

    def boom(*_args, **_kwargs):
        raise PromptLLMError("simulated outage")

    monkeypatch.setattr(prompt_transform, "llm_transform_prompt", boom)

    result = prompt_transform.transform_plain_prompt("貓")
    assert result.provider == "rule_based"
    assert "cat" in result.prompt


def test_transform_uses_gemini_when_llm_succeeds(monkeypatch):
    monkeypatch.setattr(prompt_transform, "get_settings", lambda: _fake_settings(gemini_api_key="key"))
    monkeypatch.setattr(
        prompt_transform,
        "llm_transform_prompt",
        lambda source, style: "A photorealistic orange cat on a windowsill at sunset.",
    )

    result = prompt_transform.transform_plain_prompt("一隻橘貓在窗台看夕陽", style="realistic")
    assert result.provider == "gemini"
    assert "cat" in result.prompt
    assert result.style == "realistic"
    assert result.warnings == ()


def test_transform_uses_codex_when_gemini_fails(monkeypatch):
    monkeypatch.setattr(
        prompt_transform,
        "get_settings",
        lambda: _fake_settings(gemini_api_key="key", codex_api_key="ck"),
    )

    def gemini_down(*_args, **_kwargs):
        raise PromptLLMError("gemini outage")

    monkeypatch.setattr(prompt_transform, "llm_transform_prompt", gemini_down)
    monkeypatch.setattr(
        prompt_transform,
        "codex_transform_prompt",
        lambda source, style: "A cinematic shot of a quiet alley at night.",
    )

    result = prompt_transform.transform_plain_prompt("夜晚的小巷", style="cinematic")
    assert result.provider == "codex"
    assert "alley" in result.prompt


def test_transform_falls_back_to_rule_when_both_llms_fail(monkeypatch):
    monkeypatch.setattr(
        prompt_transform,
        "get_settings",
        lambda: _fake_settings(gemini_api_key="key", codex_api_key="ck"),
    )

    def down(*_args, **_kwargs):
        raise PromptLLMError("outage")

    monkeypatch.setattr(prompt_transform, "llm_transform_prompt", down)
    monkeypatch.setattr(prompt_transform, "codex_transform_prompt", down)

    result = prompt_transform.transform_plain_prompt("貓")
    assert result.provider == "rule_based"
    assert "cat" in result.prompt
