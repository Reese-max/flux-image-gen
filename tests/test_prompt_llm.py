from types import SimpleNamespace

import pytest

from app import prompt_llm, prompt_transform
from app.prompt_llm import (
    PromptLLMError,
    _extract_prompt_text,
    _parse_codex_response,
    _parse_gemini_response,
    _parse_gemini_plain_text_response,
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


def test_parse_gemini_plain_text_response_returns_chinese_without_json_parsing():
    data = {
        "candidates": [
            {"content": {"parts": [{"text": "  一位女生站在雨中的霓虹街道。  "}]}}
        ]
    }
    assert _parse_gemini_plain_text_response(data) == "一位女生站在雨中的霓虹街道。"


def test_parse_gemini_plain_text_response_keeps_json_like_text_literal():
    data = {
        "candidates": [
            {"content": {"parts": [{"text": '{"prompt": "普通中文句子。"}'}]}}
        ]
    }
    with pytest.raises(PromptLLMError, match="non-plain Chinese"):
        _parse_gemini_plain_text_response(data)


def test_parse_gemini_plain_text_response_rejects_analysis_list():
    data = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "text": "* Input: 女生雨中\n* Task: Expand into Traditional Chinese."
                        }
                    ]
                }
            }
        ]
    }
    with pytest.raises(PromptLLMError, match="non-plain Chinese"):
        _parse_gemini_plain_text_response(data)


def test_parse_gemini_response_extracts_prompt_from_json_envelope():
    data = {
        "candidates": [
            {"content": {"parts": [{"text": '{"prompt": "a red cup on a wooden table"}'}]}}
        ]
    }
    assert _parse_gemini_response(data) == "a red cup on a wooden table"


def test_extract_prompt_text_unwraps_nested_prompt_json_string():
    raw = '{"prompt": "{\\"prompt\\": \\"一位女生站在雨中的霓虹街道。\\"}"}'
    assert _extract_prompt_text(raw) == "一位女生站在雨中的霓虹街道。"


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


def test_llm_complete_prompt_uses_short_timeout_without_retry(monkeypatch):
    settings = SimpleNamespace(
        gemini_api_key="test-key",
        gemini_base_url="https://example.invalid",
        gemini_complete_model="gemma-test",
        prompt_llm_timeout_seconds=20.0,
        gemini_complete_timeout_seconds=5.0,
    )
    timeouts = []

    def timed_out(_url, _headers, _payload, timeout, response_parser=None):
        timeouts.append(timeout)
        raise prompt_llm._RetryableError("simulated timeout")

    monkeypatch.setattr(prompt_llm, "_request_prompt", timed_out)

    with pytest.raises(PromptLLMError, match="simulated timeout"):
        prompt_llm.llm_complete_prompt("女生雨中", "cinematic", settings=settings)

    assert timeouts == [5.0]


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
