from __future__ import annotations

import json

import httpx

from .settings import Settings, get_settings


class PromptLLMError(Exception):
    """Raised when the LLM prompt transformation is unavailable or fails.

    Callers are expected to catch this and fall back to the rule-based engine.
    """


class _RetryableError(Exception):
    """Internal: a transient failure (network / 429 / 5xx) worth one retry."""


MAX_ATTEMPTS = 2
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


SYSTEM_INSTRUCTION = (
    "You are an expert prompt engineer for the FLUX.1 text-to-image model. FLUX.1 is "
    "driven by a T5 text encoder and renders best from rich, natural-language "
    "descriptions, not keyword lists.\n"
    "Your job: rewrite the user's casual description (usually Traditional Chinese) "
    "into ONE polished English image prompt that FLUX.1 can render beautifully.\n"
    "How to write it:\n"
    "- Use flowing natural language (one to three sentences), never a comma-separated "
    "tag dump.\n"
    "- Cover, in this order and only when relevant: the main subject and what it is "
    "doing; the setting/environment and key background elements; lighting and time of "
    "day; colour palette and mood; the art medium or render style (e.g. photograph, "
    "oil painting, 3D render, anime cel, watercolour); and for photographic looks, "
    "concrete camera detail (lens, depth of field, angle).\n"
    "- Name the visual medium explicitly so the model commits to a coherent look.\n"
    "- Faithfully preserve every concrete detail the user gave (subject, count, "
    "colours, objects, place, time of day). Enrich with fitting detail, but never "
    "contradict or drop what they asked for.\n"
    "- Translate every non-English word into natural, idiomatic English. EXCEPTION: "
    "if the user clearly wants specific words to appear in the image (a sign, label, "
    "banner or title), keep that exact text verbatim in double quotes, e.g. a neon "
    'sign reading "營業中". Do not translate or romanise such on-image text.\n'
    "- Do not add on-image text, captions, logos or watermarks that the user did not "
    "ask for. Keep it under 600 characters.\n"
    "- Do NOT restate these rules, and do NOT show any reasoning, labels, or "
    "alternatives.\n"
    'Return ONLY a JSON object of the form {"prompt": "<the english prompt>"}.\n'
    "Example input: 一隻可愛的橘貓在窗台上看夕陽\n"
    'Example output: {"prompt": "A heartwarming photograph of an adorable orange '
    "tabby cat perched on a wooden windowsill, gazing out at a glowing golden "
    "sunset, warm rim light catching its soft fur, cozy and serene atmosphere, shot "
    'on a 50mm lens with a gentle shallow depth of field, highly detailed"}'
)

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {"prompt": {"type": "string"}},
    "required": ["prompt"],
}

STYLE_HINTS = {
    "auto": "Choose the most fitting visual style for the described scene.",
    "cute": "Style: adorable, soft rounded shapes, warm pastel colours, gentle and cozy.",
    "cinematic": (
        "Style: cinematic film still, dramatic lighting, atmospheric mood, "
        "shallow depth of field."
    ),
    "realistic": "Style: photorealistic, natural lighting, true-to-life textures and detail.",
    "anime": "Style: anime illustration, expressive character design, vibrant clean colours.",
    "product": (
        "Style: studio product photography, clean seamless background, "
        "crisp commercial lighting."
    ),
}

MAX_LLM_PROMPT_LENGTH = 900


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
    raise last_error or PromptLLMError("gemini request failed")


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
            return prompt.strip()
    return None


def _strip_wrapping(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = [line for line in cleaned.splitlines() if not line.strip().startswith("```")]
        cleaned = "\n".join(lines).strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {'"', "'"}:
        cleaned = cleaned[1:-1].strip()
    return cleaned
