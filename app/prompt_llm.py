from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

from .settings import Settings, get_settings


class PromptLLMError(Exception):
    """Raised when the LLM prompt transformation is unavailable or fails.

    Callers are expected to catch this and fall back to the rule-based engine.
    """


class _RetryableError(Exception):
    """Internal: a transient failure (network / 429 / 5xx) worth one retry."""


# Prompt-transform constants live in a single source of truth shared with the
# Cloudflare Worker (cloudflare/src/index.js): shared/prompt-constants.json.
# Edit that file, not these names.
_CONSTANTS_PATH = Path(__file__).resolve().parent.parent / "shared" / "prompt-constants.json"
with _CONSTANTS_PATH.open(encoding="utf-8") as _constants_file:
    _CONSTANTS = json.load(_constants_file)

MAX_ATTEMPTS = _CONSTANTS["geminiMaxAttempts"]
RETRYABLE_STATUS = frozenset(_CONSTANTS["geminiRetryableStatus"])
SYSTEM_INSTRUCTION = _CONSTANTS["systemInstruction"]
RESPONSE_SCHEMA = _CONSTANTS["responseSchema"]
STYLE_HINTS = _CONSTANTS["styleHints"]
COMPLETION_SYSTEM_INSTRUCTION = _CONSTANTS["completionSystemInstruction"]
COMPLETION_RESPONSE_SCHEMA = _CONSTANTS["completionResponseSchema"]
COMPLETION_STYLE_HINTS = _CONSTANTS["completionStyleHints"]
MAX_LLM_PROMPT_LENGTH = _CONSTANTS["maxLlmPromptLength"]
# Backoff between transient retries, so an immediate re-hit on a 429 doesn't
# just fail again. Mirrors the image service's linear backoff.
RETRY_BACKOFF_SECONDS = 0.5


def llm_transform_prompt(source: str, style: str, settings: Settings | None = None) -> str:
    """Call the Gemini API (Gemma model) to turn a plain description into a FLUX prompt.

    Raises PromptLLMError on any condition that should trigger a rule-based fallback.
    """
    resolved_settings = settings or get_settings()
    api_key = resolved_settings.gemini_api_key.strip()
    if not api_key:
        raise PromptLLMError("missing GEMINI_API_KEY")

    user_text = _build_user_text(source, style)
    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0.6,
            "maxOutputTokens": 700,
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }
    url = (
        f"{resolved_settings.gemini_base_url.rstrip('/')}"
        f"/models/{resolved_settings.gemini_prompt_model}:generateContent"
    )
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
    timeout = resolved_settings.prompt_llm_timeout_seconds

    last_error: PromptLLMError | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            return _request_prompt(url, headers, payload, timeout)
        except _RetryableError as exc:
            last_error = PromptLLMError(str(exc))
            if attempt + 1 >= MAX_ATTEMPTS:
                break
            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
    raise last_error or PromptLLMError("gemini request failed")


def llm_complete_prompt(source: str, style: str, settings: Settings | None = None) -> str:
    """Call Gemini/Gemma to expand a short Traditional Chinese image idea.

    The output intentionally stays in Traditional Chinese; `/prompt/transform`
    remains responsible for turning the completed description into English.
    """
    resolved_settings = settings or get_settings()
    api_key = resolved_settings.gemini_api_key.strip()
    if not api_key:
        raise PromptLLMError("missing GEMINI_API_KEY")

    user_text = _build_complete_user_text(source, style)
    payload = {
        "system_instruction": {"parts": [{"text": COMPLETION_SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0.35,
            "maxOutputTokens": 450,
            "responseMimeType": "application/json",
            "responseSchema": COMPLETION_RESPONSE_SCHEMA,
        },
    }
    model = getattr(resolved_settings, "gemini_complete_model", "gemma-4-26b-a4b-it")
    url = (
        f"{resolved_settings.gemini_base_url.rstrip('/')}"
        f"/models/{model}:generateContent"
    )
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
    timeout = resolved_settings.prompt_llm_timeout_seconds

    last_error: PromptLLMError | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            return _request_prompt(url, headers, payload, timeout)
        except _RetryableError as exc:
            last_error = PromptLLMError(str(exc))
            if attempt + 1 >= MAX_ATTEMPTS:
                break
            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
    raise last_error or PromptLLMError("gemini completion request failed")


def codex_transform_prompt(source: str, style: str, settings: Settings | None = None) -> str:
    """Secondary transform via the local Codex proxy (OpenAI-compatible chat API).

    Raises PromptLLMError when disabled or on any failure, so the caller falls back.
    """
    resolved_settings = settings or get_settings()
    api_key = resolved_settings.codex_api_key.strip()
    if not api_key:
        raise PromptLLMError("codex proxy disabled (no CODEX_PROXY_KEY)")

    url = f"{resolved_settings.codex_base_url.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": resolved_settings.codex_prompt_model,
        "messages": [
            {"role": "system", "content": SYSTEM_INSTRUCTION},
            {"role": "user", "content": _build_user_text(source, style)},
        ],
        "reasoning_effort": "low",
    }
    timeout = resolved_settings.prompt_llm_timeout_seconds

    last_error: PromptLLMError | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            return _request_codex_prompt(url, headers, payload, timeout)
        except _RetryableError as exc:
            last_error = PromptLLMError(str(exc))
            if attempt + 1 >= MAX_ATTEMPTS:
                break
            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
    raise last_error or PromptLLMError("codex request failed")


def _request_codex_prompt(url: str, headers: dict, payload: dict, timeout: float) -> str:
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        raise _RetryableError(f"codex request timed out: {exc}") from exc
    except httpx.HTTPError as exc:
        raise _RetryableError(f"codex request failed: {exc}") from exc

    if response.status_code in RETRYABLE_STATUS:
        raise _RetryableError(f"codex returned HTTP {response.status_code}")
    if response.status_code != 200:
        raise PromptLLMError(
            f"codex returned HTTP {response.status_code}: {response.text[:200]}"
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise PromptLLMError("codex returned non-JSON response") from exc

    return _parse_codex_response(data)


def _parse_codex_response(data: dict) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise PromptLLMError("codex returned no choices")
    content = (choices[0].get("message") or {}).get("content") or ""
    text = _extract_prompt_text(content)
    if not text:
        raise PromptLLMError("codex returned empty text")
    if len(text) > MAX_LLM_PROMPT_LENGTH:
        text = text[:MAX_LLM_PROMPT_LENGTH].rstrip(" ,")
    return text


def _request_prompt(url: str, headers: dict, payload: dict, timeout: float) -> str:
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        raise _RetryableError(f"gemini request timed out: {exc}") from exc
    except httpx.HTTPError as exc:
        raise _RetryableError(f"gemini request failed: {exc}") from exc

    if response.status_code in RETRYABLE_STATUS:
        raise _RetryableError(f"gemini returned HTTP {response.status_code}")
    if response.status_code != 200:
        raise PromptLLMError(
            f"gemini returned HTTP {response.status_code}: {response.text[:200]}"
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise PromptLLMError("gemini returned non-JSON response") from exc

    return _parse_gemini_response(data)


def _build_user_text(source: str, style: str) -> str:
    style_hint = STYLE_HINTS.get(style, STYLE_HINTS["auto"])
    return f"{style_hint}\n\nDescription:\n{source.strip()}"


def _build_complete_user_text(source: str, style: str) -> str:
    style_hint = COMPLETION_STYLE_HINTS.get(style, COMPLETION_STYLE_HINTS["auto"])
    return f"{style_hint}\n\n原始描述：\n{source.strip()}"


def _parse_gemini_response(data: dict) -> str:
    feedback = data.get("promptFeedback") or {}
    if feedback.get("blockReason"):
        raise PromptLLMError(f"gemini blocked prompt: {feedback.get('blockReason')}")

    candidates = data.get("candidates") or []
    if not candidates:
        raise PromptLLMError("gemini returned no candidates")

    parts = (candidates[0].get("content") or {}).get("parts") or []
    raw_text = "".join(part.get("text", "") for part in parts).strip()
    text = _extract_prompt_text(raw_text)
    if not text:
        raise PromptLLMError("gemini returned empty text")

    if len(text) > MAX_LLM_PROMPT_LENGTH:
        text = text[:MAX_LLM_PROMPT_LENGTH].rstrip(" ,")
    return text


def _extract_prompt_text(raw_text: str) -> str:
    """Pull the prompt string out of the model output.

    Primary path: the JSON envelope {"prompt": "..."}. The model sometimes wraps it
    in a code fence or adds stray text, so we also try the {...} substring before
    falling back to the cleaned text as-is.
    """
    cleaned = _strip_wrapping(raw_text)

    found = _try_parse_prompt_json(cleaned)
    if found:
        return found

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        found = _try_parse_prompt_json(cleaned[start : end + 1])
        if found:
            return found

    return cleaned


def _try_parse_prompt_json(candidate: str) -> str | None:
    try:
        parsed = json.loads(candidate)
    except (ValueError, TypeError):
        return None
    if isinstance(parsed, dict):
        prompt = parsed.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            cleaned_prompt = prompt.strip()
            nested = _try_parse_prompt_json(cleaned_prompt)
            return nested or cleaned_prompt
    return None


def _strip_wrapping(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = [line for line in cleaned.splitlines() if not line.strip().startswith("```")]
        cleaned = "\n".join(lines).strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {'"', "'"}:
        cleaned = cleaned[1:-1].strip()
    return cleaned
