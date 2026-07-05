from __future__ import annotations

import os
from dataclasses import dataclass


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    nvidia_api_key: str = os.getenv("NVIDIA_API_KEY", "")
    image_provider: str = os.getenv("IMAGE_PROVIDER", "auto")
    nvidia_base_url: str = os.getenv("NVIDIA_BASE_URL", "https://ai.api.nvidia.com/v1/genai")
    request_timeout_seconds: float = _float_env("REQUEST_TIMEOUT_SECONDS", 120.0)
    nvidia_dev_steps: int = _int_env("NVIDIA_DEV_STEPS", 30)
    nvidia_dev_cfg_scale: float = _float_env("NVIDIA_DEV_CFG_SCALE", 5.0)
    nvidia_schnell_seed: int = _int_env("NVIDIA_SCHNELL_SEED", 0)
    nvidia_dev_seed: int = _int_env("NVIDIA_DEV_SEED", 0)
    # Fast-tier ("schnell") backend. NVIDIA's hosted flux.1-schnell went dark in
    # 2026-07 (accepts requests, never responds), so the fast tier runs on
    # Cloudflare Workers AI instead — mirroring the Worker deploy. Set both
    # CF_ACCOUNT_ID and CF_API_TOKEN to enable; otherwise schnell auto-falls back
    # to NVIDIA dev (see image_service._resolve_provider_and_request).
    cf_account_id: str = os.getenv("CF_ACCOUNT_ID", "")
    cf_api_token: str = os.getenv("CF_API_TOKEN", "")
    workers_ai_fast_model: str = os.getenv(
        "WORKERS_AI_FAST_MODEL", "@cf/black-forest-labs/flux-2-klein-4b"
    )
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    gemini_prompt_model: str = os.getenv("GEMINI_PROMPT_MODEL", "gemma-4-31b-it")
    gemini_complete_model: str = os.getenv("GEMINI_COMPLETE_MODEL", "gemma-4-26b-a4b-it")
    gemini_base_url: str = os.getenv(
        "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"
    )
    prompt_llm_timeout_seconds: float = _float_env("PROMPT_LLM_TIMEOUT_SECONDS", 20.0)
    # Secondary LLM fallback via the local Codex proxy (OpenAI-compatible). Used only
    # when Gemini fails, before dropping to the offline rule engine. Empty key = off.
    codex_api_key: str = os.getenv("CODEX_PROXY_KEY", "")
    codex_base_url: str = os.getenv("CODEX_PROXY_BASE", "http://127.0.0.1:8317/v1")
    codex_prompt_model: str = os.getenv("CODEX_PROMPT_MODEL", "gpt-5.4-mini")


_default_settings: Settings | None = None


def get_settings() -> Settings:
    global _default_settings
    if _default_settings is None:
        _default_settings = Settings()
    return _default_settings
