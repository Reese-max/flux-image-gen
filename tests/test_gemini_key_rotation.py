"""Gemini 多把免費金鑰輪替。

免費層的配額綁在單把金鑰上，所以碰到 429 重試同一把毫無意義——重試必須換下一把，
而且每把都要輪得到，即使該路徑原本只允許 1 次嘗試（補全就是）。
"""
from __future__ import annotations

import httpx
import pytest

from app.prompt_llm import (
    COMPLETION_MAX_ATTEMPTS,
    MAX_ATTEMPTS,
    PromptLLMError,
    llm_complete_prompt,
    llm_transform_prompt,
    resolve_gemini_keys,
)
from app.settings import Settings


def test_resolve_prefers_the_plural_setting_and_falls_back_to_the_single_one():
    assert resolve_gemini_keys(Settings(gemini_api_keys="a,b,c")) == ["a", "b", "c"]
    # 單把仍然可用，既有部署不會因為這個功能而壞掉。
    assert resolve_gemini_keys(Settings(gemini_api_key="solo")) == ["solo"]
    # 複數優先。
    assert resolve_gemini_keys(Settings(gemini_api_keys="x,y", gemini_api_key="solo")) == ["x", "y"]
    # 空白與空項目要清掉，重複的不該浪費一次重試。
    assert resolve_gemini_keys(Settings(gemini_api_keys=" a , , b , a ")) == ["a", "b"]
    assert resolve_gemini_keys(Settings(gemini_api_key="", gemini_api_keys="")) == []


def fake_client_capturing(monkeypatch, responses):
    """依序回傳 responses，並記下每次請求用的金鑰。"""
    used: list[str] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def post(self, url, headers=None, json=None):
            used.append(headers["x-goog-api-key"])
            return responses[min(len(used) - 1, len(responses) - 1)]

    monkeypatch.setattr("app.prompt_llm.httpx.Client", FakeClient)
    monkeypatch.setattr("app.prompt_llm.time.sleep", lambda _: None)
    return used


def ok_transform() -> httpx.Response:
    return httpx.Response(200, json={
        "candidates": [{"content": {"parts": [{"text": '{"prompt":"a cat"}'}]}}]
    })


def quota_exhausted() -> httpx.Response:
    return httpx.Response(429, text="quota exceeded")


def test_transform_moves_to_the_next_key_after_a_quota_error(monkeypatch):
    used = fake_client_capturing(monkeypatch, [quota_exhausted(), ok_transform()])

    result = llm_transform_prompt("一隻貓", "auto", Settings(gemini_api_keys="first,second"))

    assert result == "a cat"
    assert used == ["first", "second"], "第二次嘗試必須換金鑰，重試同一把等於白費"


def test_completion_gives_every_key_a_turn_despite_a_single_attempt_budget(monkeypatch):
    """補全的 max attempts 是 1；金鑰數要能把它撐開，否則第二把永遠用不到。"""
    assert COMPLETION_MAX_ATTEMPTS == 1
    ok = httpx.Response(200, json={
        "candidates": [{"content": {"parts": [{
            # 補全的回應驗證要求足夠長度的純中文，太短會被判成非中文輸出。
            "text": "一隻橘白色的貓咪慵懶地趴在灑滿午後陽光的木質窗台上，背景是模糊的綠色植物與溫暖光斑。"
        }]}}]
    })
    used = fake_client_capturing(monkeypatch, [quota_exhausted(), ok])

    result = llm_complete_prompt("一隻貓", "auto", Settings(gemini_api_keys="first,second"))

    assert "貓" in result
    assert used == ["first", "second"]


def test_single_key_keeps_the_original_attempt_count(monkeypatch):
    """只設一把時行為不變：仍是原本的重試次數，且一直用那把。"""
    used = fake_client_capturing(monkeypatch, [quota_exhausted()])

    with pytest.raises(PromptLLMError):
        llm_transform_prompt("一隻貓", "auto", Settings(gemini_api_key="solo"))

    assert used == ["solo"] * MAX_ATTEMPTS


def test_all_keys_exhausted_raises_rather_than_looping(monkeypatch):
    used = fake_client_capturing(monkeypatch, [quota_exhausted()])

    with pytest.raises(PromptLLMError):
        llm_transform_prompt("一隻貓", "auto", Settings(gemini_api_keys="a,b,c"))

    assert used == ["a", "b", "c"], "每把各試一次就放棄，不要無限輪替"
