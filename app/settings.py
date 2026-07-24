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


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


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
    # Default square generations use the cheaper Cloudflare-hosted FLUX.1 schnell
    # JSON API (no custom dimensions); every other size uses FLUX.2 klein, which
    # accepts width/height. Mirrors cloudflare/src/constants.js.
    workers_ai_fast_model: str = os.getenv(
        "WORKERS_AI_FAST_MODEL", "@cf/black-forest-labs/flux-1-schnell"
    )
    workers_ai_sized_model: str = os.getenv(
        "WORKERS_AI_SIZED_MODEL", "@cf/black-forest-labs/flux-2-klein-4b"
    )
    # AI 改圖（instruction edit）後端。FLUX.2 klein 支援上傳 1-4 張自訂圖做指令式
    # 編輯（NVIDIA hosted kontext 只吃內建範例圖，故本機/雲端一律走 Workers AI）。
    # 需 CF_ACCOUNT_ID + CF_API_TOKEN；未設定時 /edit 回乾淨 503。
    workers_ai_edit_model: str = os.getenv(
        "WORKERS_AI_EDIT_MODEL", "@cf/black-forest-labs/flux-2-klein-4b"
    )
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    gemini_prompt_model: str = os.getenv("GEMINI_PROMPT_MODEL", "gemma-4-31b-it")
    gemini_complete_model: str = os.getenv("GEMINI_COMPLETE_MODEL", "gemma-4-31b-it")
    gemini_vision_model: str = os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash")
    gemini_base_url: str = os.getenv(
        "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"
    )
    prompt_llm_timeout_seconds: float = _float_env("PROMPT_LLM_TIMEOUT_SECONDS", 20.0)
    gemini_complete_timeout_seconds: float = _float_env(
        "GEMINI_COMPLETE_TIMEOUT_SECONDS", 5.0
    )
    vision_qa_enabled: bool = _bool_env("VISION_QA_ENABLED", False)
    # Third-tier keyless Pollinations fallback, reached only when NVIDIA and
    # Workers AI both fail on infrastructure (5xx/timeout). Off by default; set
    # POLLINATIONS_FALLBACK_ENABLED=true to enable (mirrors the Worker flag).
    pollinations_fallback_enabled: bool = _bool_env("POLLINATIONS_FALLBACK_ENABLED", False)
    # Secondary LLM fallback via the local Codex proxy (OpenAI-compatible). Used only
    # when Gemini fails, before dropping to the offline rule engine. Empty key = off.
    codex_api_key: str = os.getenv("CODEX_PROXY_KEY", "")
    codex_base_url: str = os.getenv("CODEX_PROXY_BASE", "http://127.0.0.1:8317/v1")
    codex_prompt_model: str = os.getenv("CODEX_PROMPT_MODEL", "gpt-5.4-mini")
    # 後端硬性成本保護。Demo 與 live 分開計數，避免沒有金鑰時耗掉正式額度；
    # 設為 0 或 RATE_LIMIT_ENABLED=false 可在本機壓測時停用。
    rate_limit_enabled: bool = _bool_env("RATE_LIMIT_ENABLED", True)
    rate_limit_window_seconds: int = _int_env("RATE_LIMIT_WINDOW_SECONDS", 3600)
    generate_rate_limit_per_window: int = _int_env("GENERATE_RATE_LIMIT_PER_WINDOW", 60)
    demo_generate_rate_limit_per_window: int = _int_env("DEMO_GENERATE_RATE_LIMIT_PER_WINDOW", 300)
    # Turnstile / anti-bot gate. 預設不強制，避免本機 Demo 被卡住；公開站可設定
    # TURNSTILE_REQUIRED=true + site key + secret key，後端會在呼叫模型前驗證 token。
    turnstile_required: bool = _bool_env("TURNSTILE_REQUIRED", False)
    turnstile_site_key: str = os.getenv("TURNSTILE_SITE_KEY", "")
    turnstile_secret_key: str = os.getenv("TURNSTILE_SECRET_KEY", "")
    turnstile_verify_url: str = os.getenv(
        "TURNSTILE_VERIFY_URL",
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    )
    turnstile_timeout_seconds: float = _float_env("TURNSTILE_TIMEOUT_SECONDS", 5.0)
    # 成本／用量 Dashboard。只記錄 route、模型、provider、匿名 IP hash、張數、
    # 耗時與錯誤碼；不保存 prompt、圖片內容或任何金鑰。
    usage_logging_enabled: bool = _bool_env("USAGE_LOGGING_ENABLED", True)
    usage_log_dir: str = os.getenv("USAGE_LOG_DIR", "logs")
    usage_estimated_cost_usd_per_image: float = _float_env("USAGE_ESTIMATED_COST_USD_PER_IMAGE", 0.003)
    usage_alert_daily_generations: int = _int_env("USAGE_ALERT_DAILY_GENERATIONS", 1000)


_default_settings: Settings | None = None


def get_settings() -> Settings:
    global _default_settings
    if _default_settings is None:
        _default_settings = Settings()
    return _default_settings
