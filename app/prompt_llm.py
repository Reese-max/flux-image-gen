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
COMPLETION_MAX_ATTEMPTS = _CONSTANTS["geminiCompleteMaxAttempts"]
RETRYABLE_STATUS = frozenset(_CONSTANTS["geminiRetryableStatus"])
SYSTEM_INSTRUCTION = _CONSTANTS["systemInstruction"]
RESPONSE_SCHEMA = _CONSTANTS["responseSchema"]
STYLE_HINTS = _CONSTANTS["styleHints"]
ENHANCE_SYSTEM_INSTRUCTION = _CONSTANTS["enhanceSystemInstruction"]
ENHANCE_RESPONSE_SCHEMA = _CONSTANTS["enhanceResponseSchema"]
COMPLETION_SYSTEM_INSTRUCTION = _CONSTANTS["completionSystemInstruction"]
COMPLETION_STYLE_HINTS = _CONSTANTS["completionStyleHints"]
MAX_LLM_PROMPT_LENGTH = _CONSTANTS["maxLlmPromptLength"]
MAX_PROMPT_SOURCE_LENGTH = _CONSTANTS["maxPromptSourceLength"]
MAX_ENHANCE_PROMPT_LENGTH = _CONSTANTS["maxEnhancePromptLength"]
MAX_ENHANCE_EFFECT_LENGTH = _CONSTANTS["maxEnhanceEffectLength"]
ENHANCE_FALLBACK_RULES = _CONSTANTS["enhanceFallbackRules"]
ENHANCE_FALLBACK_DEFAULT_MODIFIER = _CONSTANTS["enhanceFallbackDefaultModifier"]
# Backoff between transient retries, so an immediate re-hit on a 429 doesn't
# just fail again. Mirrors the image service's linear backoff.
RETRY_BACKOFF_SECONDS = 0.5


def llm_transform_prompt(source: str, style: str, settings: Settings | None = None) -> str:
    """Call the Gemini API (Gemma model) to turn a plain description into a FLUX prompt.

    Raises PromptLLMError on any condition that should trigger a rule-based fallback.
    """
    resolved_settings = settings or get_settings()
    keys = resolve_gemini_keys(resolved_settings)
    if not keys:
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
    timeout = resolved_settings.prompt_llm_timeout_seconds

    last_error: PromptLLMError | None = None
    attempts = _gemini_attempt_plan(keys, MAX_ATTEMPTS)
    for attempt in range(attempts):
        try:
            return _request_prompt(url, _key_headers(keys, attempt), payload, timeout)
        except _RetryableError as exc:
            last_error = PromptLLMError(str(exc))
            if attempt + 1 >= attempts:
                break
            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
    raise last_error or PromptLLMError("gemini request failed")


def llm_complete_prompt(source: str, style: str, settings: Settings | None = None) -> str:
    """Call Gemini/Gemma to expand a short Traditional Chinese image idea.

    The output intentionally stays in Traditional Chinese; `/prompt/transform`
    remains responsible for turning the completed description into English.
    """
    resolved_settings = settings or get_settings()
    keys = resolve_gemini_keys(resolved_settings)
    if not keys:
        raise PromptLLMError("missing GEMINI_API_KEY")

    user_text = _build_complete_user_text(source, style)
    payload = {
        "system_instruction": {"parts": [{"text": COMPLETION_SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 300,
            "responseMimeType": "text/plain",
        },
    }
    model = getattr(resolved_settings, "gemini_complete_model", "gemma-4-31b-it")
    url = (
        f"{resolved_settings.gemini_base_url.rstrip('/')}"
        f"/models/{model}:generateContent"
    )
    timeout = getattr(
        resolved_settings,
        "gemini_complete_timeout_seconds",
        _CONSTANTS["geminiCompleteTimeoutMs"] / 1000,
    )

    last_error: PromptLLMError | None = None
    attempts = _gemini_attempt_plan(keys, COMPLETION_MAX_ATTEMPTS)
    for attempt in range(attempts):
        try:
            return _request_prompt(
                url,
                _key_headers(keys, attempt),
                payload,
                timeout,
                response_parser=_parse_gemini_plain_text_response,
            )
        except _RetryableError as exc:
            last_error = PromptLLMError(str(exc))
            if attempt + 1 >= attempts:
                break
            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
    raise last_error or PromptLLMError("gemini completion request failed")


def llm_enhance_prompt(prompt: str, effect: str, settings: Settings | None = None) -> str:
    """Call Gemini to rewrite an English prompt so it incorporates a requested effect.

    Raises PromptLLMError when the key is missing or the request fails; callers map
    that to an HTTP error (there is no offline fallback for effect optimisation).
    """
    resolved_settings = settings or get_settings()
    keys = resolve_gemini_keys(resolved_settings)
    if not keys:
        raise PromptLLMError("missing GEMINI_API_KEY")

    user_text = _build_enhance_user_text(prompt, effect)
    payload = {
        "system_instruction": {"parts": [{"text": ENHANCE_SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0.6,
            "maxOutputTokens": 700,
            "responseMimeType": "application/json",
            "responseSchema": ENHANCE_RESPONSE_SCHEMA,
        },
    }
    url = (
        f"{resolved_settings.gemini_base_url.rstrip('/')}"
        f"/models/{resolved_settings.gemini_prompt_model}:generateContent"
    )
    timeout = resolved_settings.prompt_llm_timeout_seconds

    last_error: PromptLLMError | None = None
    attempts = _gemini_attempt_plan(keys, MAX_ATTEMPTS)
    for attempt in range(attempts):
        try:
            return _request_prompt(url, _key_headers(keys, attempt), payload, timeout)
        except _RetryableError as exc:
            last_error = PromptLLMError(str(exc))
            if attempt + 1 >= attempts:
                break
            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
    raise last_error or PromptLLMError("gemini enhance request failed")


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


def resolve_gemini_keys(settings: Settings) -> list[str]:
    """可用的金鑰清單：GEMINI_API_KEYS（逗號分隔）優先，退回單把 GEMINI_API_KEY。

    去重並保留順序——同一把金鑰列兩次只是白費一次重試。
    """
    raw = (getattr(settings, "gemini_api_keys", "") or "").strip()
    keys: list[str] = []
    for candidate in raw.split(","):
        key = candidate.strip()
        if key and key not in keys:
            keys.append(key)
    if keys:
        return keys
    single = (settings.gemini_api_key or "").strip()
    return [single] if single else []


def _gemini_attempt_plan(keys: list[str], max_attempts: int) -> int:
    """至少讓每把金鑰輪到一次：配額是綁在單把金鑰上的，只重試同一把沒有意義。"""
    return max(max_attempts, len(keys))


def _key_headers(keys: list[str], attempt: int) -> dict:
    return {"x-goog-api-key": keys[attempt % len(keys)], "Content-Type": "application/json"}


def _request_prompt(
    url: str,
    headers: dict,
    payload: dict,
    timeout: float,
    response_parser=None,
) -> str:
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

    parser = response_parser or _parse_gemini_response
    return parser(data)


def _build_user_text(source: str, style: str) -> str:
    style_hint = STYLE_HINTS.get(style, STYLE_HINTS["auto"])
    return f"{style_hint}\n\nDescription:\n{source.strip()}"


def _build_enhance_user_text(prompt: str, effect: str) -> str:
    return f"Existing prompt:\n{prompt.strip()}\n\nRequested effect:\n{effect.strip()}"


def _build_complete_user_text(source: str, style: str) -> str:
    style_hint = COMPLETION_STYLE_HINTS.get(style, COMPLETION_STYLE_HINTS["auto"])
    return (
        f"{style_hint}\n\n原始描述：\n{source.strip()}"
        "\n\n請立即只輸出補完整後的一段繁體中文描述，不要分析、翻譯或列點。"
    )


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


def _parse_gemini_plain_text_response(data: dict) -> str:
    feedback = data.get("promptFeedback") or {}
    if feedback.get("blockReason"):
        raise PromptLLMError(f"gemini blocked prompt: {feedback.get('blockReason')}")

    candidates = data.get("candidates") or []
    if not candidates:
        raise PromptLLMError("gemini returned no candidates")

    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = _strip_wrapping("".join(part.get("text", "") for part in parts))
    if not text:
        raise PromptLLMError("gemini returned empty text")
    cjk_count = sum("\u3400" <= char <= "\u9fff" for char in text)
    forbidden_labels = (
        "input",
        "task",
        "constraints",
        "subject",
        "output",
        "original description",
    )
    if (
        "\n" in text
        or "\r" in text
        or text.lstrip().startswith(("* ", "# ", "- "))
        or any(label in text.lower() for label in forbidden_labels)
        or cjk_count < max(12, int(len(text) * 0.45))
    ):
        raise PromptLLMError("gemini returned non-plain Chinese completion")

    if len(text) > MAX_LLM_PROMPT_LENGTH:
        text = text[:MAX_LLM_PROMPT_LENGTH].rstrip("，。,.；; ")
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
