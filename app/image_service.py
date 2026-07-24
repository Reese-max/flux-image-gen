from __future__ import annotations

import asyncio
import base64
import random
import re
import time
from dataclasses import dataclass, field, replace
from typing import Any

import httpx

from .demo_image import make_demo_png_data_url
from .settings import Settings, get_settings

SIZE_MAP: dict[str, tuple[int, int]] = {
    # Backward-compatible legacy ids.
    "square": (1024, 1024),
    "landscape": (1344, 768),
    "portrait": (768, 1344),
    # Productized use-case presets.
    "ig_post": (1024, 1024),
    "ppt_16_9": (1344, 768),
    "ig_story": (768, 1344),
    "youtube_thumb": (1344, 768),
    "mobile_wallpaper": (768, 1664),
    "poster_3_4": (960, 1280),
    "a4_illustration": (896, 1280),
    "hero_21_9": (1792, 768),
}

# The fast tier ("schnell") runs on FLUX.2 klein 4B: NVIDIA's hosted
# flux.1-schnell went dark in 2026-07 (accepts requests, never responds), while
# flux.2-klein-4b is a live text-to-image model on the same hosted API — no
# Cloudflare token required. The UI already labels this option "快速 · FLUX.2 Klein".
MODEL_ENDPOINTS: dict[str, str] = {
    "schnell": "black-forest-labs/flux.2-klein-4b",
    "dev": "black-forest-labs/flux.1-dev",
}

MAX_SEED = 2147483647
SEED_ERROR_MESSAGE = f"seed 必須是 0 到 {MAX_SEED} 之間的整數"
# ponytail: dev 逐次調參的邊界取保守值（NVIDIA 官方 API 參考頁是 JS 渲染，抓不到
# 正式 min/max）。落在範圍內但被 NVIDIA 拒絕時，仍會由既有 ProviderError 回報。
# NVIDIA flux.1-dev 實測邊界（2026-07-21）：steps >= 5、cfg_scale > 1 且 <= 9。
MIN_DEV_STEPS = 5
MAX_DEV_STEPS = 50
STEPS_ERROR_MESSAGE = f"steps 必須是 {MIN_DEV_STEPS} 到 {MAX_DEV_STEPS} 之間的整數"
MIN_DEV_CFG_SCALE = 1.5
MAX_DEV_CFG_SCALE = 9.0
CFG_SCALE_ERROR_MESSAGE = f"cfg_scale 必須介於 {MIN_DEV_CFG_SCALE} 到 {MAX_DEV_CFG_SCALE}"
MIN_CUSTOM_DIMENSION = 256
MAX_CUSTOM_DIMENSION = 1920
CUSTOM_DIMENSION_STEP = 64
CUSTOM_SIZE_ERROR_MESSAGE = (
    f"自訂尺寸寬高必須是 {MIN_CUSTOM_DIMENSION} 到 {MAX_CUSTOM_DIMENSION} 之間，"
    f"且為 {CUSTOM_DIMENSION_STEP} 的倍數"
)

# Image generation is the slowest, most expensive call — retry transient failures
# (timeout / network / 5xx) before giving up. 429 is surfaced immediately so the
# client can honour retry_after instead of hammering the quota.
IMAGE_MAX_ATTEMPTS = 2
RETRYABLE_IMAGE_STATUS = frozenset({500, 502, 503, 504})
IMAGE_RETRY_BACKOFF_SECONDS = 0.5

# Batch generation: one prompt -> several variations, each with its own seed.
MAX_BATCH_COUNT = 4
BATCH_COUNT_ERROR_MESSAGE = f"count 必須是 1 到 {MAX_BATCH_COUNT} 之間的整數"

# AI 改圖（instruction edit）：FLUX.2 klein 吃 1-4 張自訂圖，每張須小於 512x512。
MAX_EDIT_IMAGES = 4
EDIT_IMAGE_MAX_DIM = 512
# 上傳單檔上限（縮圖前）；擋掉超大檔案，避免記憶體/頻寬濫用。
MAX_EDIT_IMAGE_BYTES = 12 * 1024 * 1024
# 解碼前的像素上限：擋 decompression bomb（高壓縮卻宣告巨大尺寸的圖），
# 縮到 <512 只需極少像素，50MP 已遠大於一般手機照片。
EDIT_IMAGE_MAX_PIXELS = 50_000_000
EDIT_IMAGE_COUNT_ERROR_MESSAGE = f"請上傳 1 到 {MAX_EDIT_IMAGES} 張圖片"


@dataclass(frozen=True)
class GenerationRequest:
    prompt: str
    model: str = "schnell"
    size: str = "square"
    seed: int | None = None
    width: int | None = None
    height: int | None = None
    # 只有 dev 會用到；None 表示沿用 settings 的 NVIDIA_DEV_* 預設值。
    steps: int | None = None
    cfg_scale: float | None = None


@dataclass(frozen=True)
class GenerationResult:
    image: str
    provider: str
    model: str
    width: int
    height: int
    seed: int
    image_quality: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class EditRequest:
    prompt: str
    images: tuple[bytes, ...]  # 1-4 張使用者上傳的原始 bytes


@dataclass(frozen=True)
class EditResult:
    image: str
    provider: str
    model: str
    image_count: int


class ProviderError(Exception):
    def __init__(self, message: str, status_code: int = 500, code: str = "provider_error", retry_after: int | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.retry_after = retry_after


def inspect_generated_image(image: str, expected_width: int, expected_height: int) -> dict[str, Any]:
    """Return safe, non-secret image diagnostics for QAReport and debugging.

    This is intentionally header-only: it never stores prompt text or image
    bytes, and it fails open with an issue list instead of blocking a generation
    that already succeeded at the provider.
    """
    issues: list[str] = []
    score = 100
    result: dict[str, Any] = {
        "checked": False,
        "mime": None,
        "byteSize": None,
        "width": None,
        "height": None,
        "expectedWidth": expected_width,
        "expectedHeight": expected_height,
        "issues": issues,
        "visualQualityScore": score,
    }
    if not isinstance(image, str) or not image:
        issues.append("圖片資料為空")
        result["visualQualityScore"] = 0
        return result
    if image.startswith(("http://", "https://")):
        issues.append("遠端圖片 URL 未做內嵌品質檢查")
        result["visualQualityScore"] = 82
        return result
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", image, re.DOTALL)
    if not match:
        issues.append("圖片格式不是可檢查的 data URL")
        result["visualQualityScore"] = 45
        return result
    result["checked"] = True
    result["mime"] = match.group(1)
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=True)
    except Exception:
        # Kept broad because provider payloads can contain malformed base64 from
        # different runtimes; this must never leak stack details to the client.
        issues.append("圖片 base64 無法解碼")
        result["visualQualityScore"] = 20
        return result
    result["byteSize"] = len(raw)
    if len(raw) < 256:
        issues.append("圖片資料過小，可能是損壞或佔位圖")
        score -= 35
    dims = _sniff_image_dimensions(raw)
    if dims:
        result["width"], result["height"] = dims
        if dims != (expected_width, expected_height):
            issues.append(f"圖片實際尺寸 {dims[0]}×{dims[1]} 與要求 {expected_width}×{expected_height} 不一致")
            score -= 18
    else:
        issues.append("無法讀取圖片實際尺寸")
        score -= 15
    result["visualQualityScore"] = max(0, min(100, score))
    return result


def _sniff_image_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if len(raw) >= 10 and raw[:4] in (b"GIF8",):
        return int.from_bytes(raw[6:8], "little"), int.from_bytes(raw[8:10], "little")
    if len(raw) >= 4 and raw[:3] == b"\xff\xd8\xff":
        i = 2
        while i + 9 < len(raw):
            if raw[i] != 0xFF:
                i += 1
                continue
            marker = raw[i + 1]
            i += 2
            if marker in (0xD8, 0xD9):
                continue
            if i + 2 > len(raw):
                return None
            length = int.from_bytes(raw[i : i + 2], "big")
            if length < 2 or i + length > len(raw):
                return None
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                return int.from_bytes(raw[i + 5 : i + 7], "big"), int.from_bytes(raw[i + 3 : i + 5], "big")
            i += length
    return None


def validate_custom_dimensions(width: Any, height: Any) -> tuple[int, int]:
    if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, int) or not isinstance(height, int):
        raise ValueError(CUSTOM_SIZE_ERROR_MESSAGE)
    for value in (width, height):
        if value < MIN_CUSTOM_DIMENSION or value > MAX_CUSTOM_DIMENSION or value % CUSTOM_DIMENSION_STEP != 0:
            raise ValueError(CUSTOM_SIZE_ERROR_MESSAGE)
    return width, height


def map_size(size: str, width: int | None = None, height: int | None = None) -> tuple[int, int]:
    if size == "custom":
        return validate_custom_dimensions(width, height)
    try:
        return SIZE_MAP[size]
    except KeyError as exc:
        raise ValueError("不支援的尺寸") from exc


def validate_prompt(prompt: str) -> str:
    cleaned = " ".join(prompt.split())
    if not cleaned:
        raise ValueError("請先輸入描述文字")
    if len(cleaned) > 10000:
        raise ValueError("描述文字太長，請縮短到 10000 字以內")
    return cleaned


def validate_model(model: str) -> str:
    if model not in MODEL_ENDPOINTS:
        raise ValueError("不支援的模型")
    return model


def validate_seed(seed: Any) -> int | None:
    if seed is None:
        return None
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError(SEED_ERROR_MESSAGE)
    if seed < 0 or seed > MAX_SEED:
        raise ValueError(SEED_ERROR_MESSAGE)
    return seed


def validate_steps(steps: Any) -> int | None:
    if steps is None:
        return None
    if isinstance(steps, bool) or not isinstance(steps, int):
        raise ValueError(STEPS_ERROR_MESSAGE)
    if steps < MIN_DEV_STEPS or steps > MAX_DEV_STEPS:
        raise ValueError(STEPS_ERROR_MESSAGE)
    return steps


def validate_cfg_scale(cfg_scale: Any) -> float | None:
    if cfg_scale is None:
        return None
    if isinstance(cfg_scale, bool) or not isinstance(cfg_scale, (int, float)):
        raise ValueError(CFG_SCALE_ERROR_MESSAGE)
    if cfg_scale < MIN_DEV_CFG_SCALE or cfg_scale > MAX_DEV_CFG_SCALE:
        raise ValueError(CFG_SCALE_ERROR_MESSAGE)
    return float(cfg_scale)


def resolve_seed(request_seed: Any, model: str, settings: Settings) -> int:
    validate_model(model)
    seed = validate_seed(request_seed)
    if seed is not None:
        return seed
    default_seed = settings.nvidia_dev_seed if model == "dev" else settings.nvidia_schnell_seed
    resolved = validate_seed(default_seed)
    if resolved is None:
        raise ValueError(SEED_ERROR_MESSAGE)
    return resolved


class DemoProvider:
    provider_name = "demo"

    def __init__(self, settings: Settings | None = None):
        self.settings = settings or get_settings()

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        prompt = validate_prompt(request.prompt)
        model = validate_model(request.model)
        width, height = map_size(request.size, request.width, request.height)
        seed = resolve_seed(request.seed, model, self.settings)
        image = make_demo_png_data_url(f"{prompt}\nseed:{seed}", width, height, model)
        return GenerationResult(
            image=image,
            provider=self.provider_name,
            model=model,
            width=width,
            height=height,
            seed=seed,
            image_quality=inspect_generated_image(image, width, height),
        )


class NvidiaProvider:
    provider_name = "nvidia"

    def __init__(self, settings: Settings):
        self.settings = settings

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        if not self.settings.nvidia_api_key.strip():
            raise ProviderError("缺少 NVIDIA_API_KEY", status_code=503, code="missing_api_key")

        prompt = validate_prompt(request.prompt)
        model = validate_model(request.model)
        width, height = map_size(request.size, request.width, request.height)
        seed = resolve_seed(request.seed, model, self.settings)
        endpoint = self._endpoint_for(model)
        payload: dict[str, Any] = {
            "prompt": prompt,
            "width": width,
            "height": height,
            "seed": seed,
        }
        if model == "dev":
            cfg_scale = validate_cfg_scale(request.cfg_scale)
            steps = validate_steps(request.steps)
            payload["cfg_scale"] = self.settings.nvidia_dev_cfg_scale if cfg_scale is None else cfg_scale
            payload["steps"] = self.settings.nvidia_dev_steps if steps is None else steps

        headers = {
            "Authorization": f"Bearer {self.settings.nvidia_api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        last_error: ProviderError | None = None
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            for attempt in range(IMAGE_MAX_ATTEMPTS):
                try:
                    response = await client.post(endpoint, headers=headers, json=payload)
                except httpx.TimeoutException:
                    last_error = ProviderError("NVIDIA 產圖逾時，請稍後再試", status_code=504, code="timeout")
                except httpx.HTTPError as exc:
                    last_error = ProviderError(f"NVIDIA 連線失敗：{exc}", status_code=502, code="network_error")
                else:
                    if response.status_code not in RETRYABLE_IMAGE_STATUS:
                        break
                    last_error = ProviderError(
                        _response_error_message(response), status_code=response.status_code, code="nvidia_error"
                    )
                if attempt + 1 >= IMAGE_MAX_ATTEMPTS:
                    raise last_error
                await asyncio.sleep(IMAGE_RETRY_BACKOFF_SECONDS * (attempt + 1))

        if response.status_code == 429:
            retry_after = _parse_retry_after(response.headers.get("retry-after"))
            raise ProviderError("叫用太頻繁，請稍後再試", status_code=429, code="rate_limited", retry_after=retry_after)
        if response.status_code >= 400:
            raise ProviderError(_response_error_message(response), status_code=response.status_code, code="nvidia_error")

        try:
            data = response.json()
        except ValueError as exc:
            raise ProviderError("NVIDIA 回應不是有效 JSON", status_code=502, code="bad_provider_response") from exc
        if is_content_filtered(data):
            raise ProviderError(
                "此描述觸發 NVIDIA 內容安全過濾，無法生成圖片，請換個描述再試",
                status_code=422,
                code="content_filtered",
            )
        image = extract_image(data)
        return GenerationResult(
            image=image,
            provider=self.provider_name,
            model=model,
            width=width,
            height=height,
            seed=seed,
            image_quality=inspect_generated_image(image, width, height),
        )

    def _endpoint_for(self, model: str) -> str:
        base = self.settings.nvidia_base_url.rstrip("/")
        return f"{base}/{MODEL_ENDPOINTS[model]}"


class WorkersAiProvider:
    """Fast-tier ("schnell") backend on Cloudflare Workers AI. Default 1024²
    squares run on FLUX.1 schnell (cheap, no custom dims); every other size uses
    FLUX.2 klein for width/height. This is the REST-API twin of the Worker's
    ``env.AI.run`` path (cloudflare/src/image.js). Active only when
    CF_ACCOUNT_ID + CF_API_TOKEN are set.

    NOTE: the request/response shape follows Cloudflare's documented Workers AI
    REST contract but is unverified end-to-end pending a Workers-AI-scoped token;
    without one the caller uses the NVIDIA-dev fallback instead."""

    provider_name = "workers-ai"

    def __init__(self, settings: Settings):
        self.settings = settings

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        if not (self.settings.cf_account_id.strip() and self.settings.cf_api_token.strip()):
            raise ProviderError("缺少 Cloudflare Workers AI 設定", status_code=503, code="missing_api_key")

        prompt = validate_prompt(request.prompt)
        model = validate_model(request.model)
        width, height = map_size(request.size, request.width, request.height)
        seed = resolve_seed(request.seed, model, self.settings)
        # UI contract: seed 0 (or blank) means "random variation". klein treats
        # every seed literally, so 0 would pin the output; substitute a real
        # random seed and return it for reproducibility (mirrors the Worker).
        effective_seed = _random_seed() if seed == 0 else seed

        # Default square previews run on the cheaper FLUX.1 schnell JSON API,
        # whose documented schema does not take custom dimensions; every other
        # size uses FLUX.2 klein, which accepts width/height. Mirrors the Worker's
        # square-vs-sized split in cloudflare/src/image.js:runWorkersAiOnce.
        if width == 1024 and height == 1024:
            model_id = self.settings.workers_ai_fast_model
            payload: dict[str, Any] = {"prompt": prompt, "seed": effective_seed, "steps": 4}
        else:
            model_id = self.settings.workers_ai_sized_model
            payload = {"prompt": prompt, "width": width, "height": height, "seed": effective_seed}

        endpoint = (
            f"https://api.cloudflare.com/client/v4/accounts/"
            f"{self.settings.cf_account_id.strip()}/ai/run/{model_id}"
        )
        headers = {
            "Authorization": f"Bearer {self.settings.cf_api_token.strip()}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

        last_error: ProviderError | None = None
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            for attempt in range(IMAGE_MAX_ATTEMPTS):
                try:
                    response = await client.post(endpoint, headers=headers, json=payload)
                except httpx.TimeoutException:
                    last_error = ProviderError("Workers AI 產圖逾時，請稍後再試", status_code=504, code="timeout")
                except httpx.HTTPError as exc:
                    last_error = ProviderError(f"Workers AI 連線失敗：{exc}", status_code=502, code="network_error")
                else:
                    if response.status_code not in RETRYABLE_IMAGE_STATUS:
                        break
                    last_error = ProviderError(
                        _response_error_message(response, "Workers AI"), status_code=response.status_code, code="workers_ai_error"
                    )
                if attempt + 1 >= IMAGE_MAX_ATTEMPTS:
                    raise last_error
                await asyncio.sleep(IMAGE_RETRY_BACKOFF_SECONDS * (attempt + 1))

        if response.status_code == 429:
            retry_after = _parse_retry_after(response.headers.get("retry-after"))
            raise ProviderError("叫用太頻繁，請稍後再試", status_code=429, code="rate_limited", retry_after=retry_after)
        if response.status_code >= 400:
            raise ProviderError(_response_error_message(response, "Workers AI"), status_code=response.status_code, code="workers_ai_error")

        try:
            data = response.json()
        except ValueError as exc:
            raise ProviderError("Workers AI 回應不是有效 JSON", status_code=502, code="bad_provider_response") from exc
        # Cloudflare wraps the payload as {"result": {...}, "success": bool}.
        result_payload = data.get("result") if isinstance(data, dict) else None
        image = extract_image(result_payload if result_payload is not None else data, "Workers AI")
        return GenerationResult(
            image=image,
            provider=self.provider_name,
            model=model,
            width=width,
            height=height,
            seed=effective_seed,
            image_quality=inspect_generated_image(image, width, height),
        )


POLLINATIONS_BASE_URL = "https://image.pollinations.ai/prompt"


class PollinationsProvider:
    """Third-tier fallback on the keyless Pollinations flux endpoint, which returns
    raw image bytes. Reached only when NVIDIA and Workers AI both fail on
    infrastructure (5xx/timeout) — never on content_filtered/rate_limited, since
    Pollinations has no content filter (see _generate_one_with_fallback)."""

    provider_name = "pollinations"

    def __init__(self, settings: Settings):
        self.settings = settings

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        from urllib.parse import quote

        prompt = validate_prompt(request.prompt)
        model = validate_model(request.model)
        width, height = map_size(request.size, request.width, request.height)
        seed = resolve_seed(request.seed, model, self.settings)
        # UI contract: seed 0 means "random variation"; substitute a real seed and
        # return it for reproducibility (mirrors the Worker / Workers AI path).
        effective_seed = _random_seed() if seed == 0 else seed

        url = f"{POLLINATIONS_BASE_URL}/{quote(prompt, safe='')}"
        params = {
            "width": width,
            "height": height,
            "seed": effective_seed,
            "model": "flux",
            "nologo": "true",
        }
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            try:
                response = await client.get(url, params=params)
            except httpx.TimeoutException as exc:
                raise ProviderError("Pollinations 產圖逾時，請稍後再試", status_code=504, code="timeout") from exc
            except httpx.HTTPError as exc:
                raise ProviderError(f"Pollinations 連線失敗：{exc}", status_code=502, code="pollinations_error") from exc

        if response.status_code >= 400:
            raise ProviderError(
                _response_error_message(response, "Pollinations"),
                status_code=response.status_code,
                code="pollinations_error",
            )

        content_type = (response.headers.get("content-type") or "image/jpeg").split(";")[0].strip() or "image/jpeg"
        image = f"data:{content_type};base64," + base64.b64encode(response.content).decode("ascii")
        return GenerationResult(
            image=image,
            provider=self.provider_name,
            model="flux",
            width=width,
            height=height,
            seed=effective_seed,
            image_quality=inspect_generated_image(image, width, height),
        )


def _workers_ai_configured(settings: Settings) -> bool:
    return bool(settings.cf_account_id.strip() and settings.cf_api_token.strip())


def choose_provider(settings: Settings | None = None):
    settings = settings or get_settings()
    provider = settings.image_provider.strip().lower()
    if provider == "demo":
        return DemoProvider(settings)
    if provider == "nvidia":
        return NvidiaProvider(settings)
    if provider != "auto":
        raise ValueError("IMAGE_PROVIDER 只能是 auto、demo 或 nvidia")
    if settings.nvidia_api_key.strip():
        return NvidiaProvider(settings)
    return DemoProvider(settings)


def _resolve_provider_and_request(
    request: GenerationRequest, settings: Settings
) -> tuple[Any, GenerationRequest]:
    """Pick the backend for the fast tier ("schnell").

    - NVIDIA available -> use it (matches the Cloudflare Worker deploy: the
      Workers AI models apply a stricter content filter, so Workers AI is only
      the fallback when no NVIDIA key is configured).
    - Otherwise Workers AI if configured, else Demo renders it locally.
    """
    provider = choose_provider(settings)
    if (
        request.model == "schnell"
        and _workers_ai_configured(settings)
        and not isinstance(provider, NvidiaProvider)
    ):
        return WorkersAiProvider(settings), request
    return provider, request


# NVIDIA circuit breaker: once an infra failure (5xx/timeout) is seen, mark the
# provider "down" for a cooldown so subsequent requests skip the ~60s dark-provider
# wait and go straight to the fallback chain. Cheap in-process state (monotonic
# deadline); good enough for one worker, and a batch's concurrent tasks all benefit
# once the first trips it. Half-open is implicit: past the deadline the next request
# re-probes NVIDIA and re-trips only if it's still down.
NVIDIA_CIRCUIT_COOLDOWN_S = 180
_nvidia_circuit_open_until: float = 0.0


def _nvidia_circuit_open() -> bool:
    return time.monotonic() < _nvidia_circuit_open_until


def _trip_nvidia_circuit() -> None:
    global _nvidia_circuit_open_until
    _nvidia_circuit_open_until = time.monotonic() + NVIDIA_CIRCUIT_COOLDOWN_S


def _reset_nvidia_circuit() -> None:
    """Test hook: clear circuit state so it never leaks across tests."""
    global _nvidia_circuit_open_until
    _nvidia_circuit_open_until = 0.0


def _has_fallback(settings: Settings) -> bool:
    return _workers_ai_configured(settings) or settings.pollinations_fallback_enabled


async def _run_fallback_chain(request: GenerationRequest, settings: Settings) -> GenerationResult:
    """Workers AI -> Pollinations tail, shared by the circuit-open skip path and the
    NVIDIA-infra-failure path. A Workers AI content filter (422) / rate limit (429)
    does NOT fall through to Pollinations (which has no moderation)."""
    pollinations_enabled = settings.pollinations_fallback_enabled
    if _workers_ai_configured(settings):
        try:
            return await WorkersAiProvider(settings).generate(request)
        except ProviderError as wa_error:
            if pollinations_enabled and (wa_error.status_code or 0) >= 500:
                return await PollinationsProvider(settings).generate(request)
            raise
    if pollinations_enabled:
        return await PollinationsProvider(settings).generate(request)
    raise ProviderError("目前沒有可用的生圖服務，請稍後再試", status_code=503, code="no_provider")


async def _generate_one_with_fallback(
    provider: Any, request: GenerationRequest, settings: Settings
) -> GenerationResult:
    """Run a single generation, falling back NVIDIA -> Workers AI -> Pollinations
    on provider-infrastructure failures (timeout / network / 5xx). Content
    filtering (422) and rate limits (429) propagate unchanged: retrying downstream
    would just fail again (Workers AI's filter is stricter) or bypass moderation
    (Pollinations has none), so those never fall through.

    A circuit breaker skips NVIDIA outright during a cooldown after an infra
    failure, so requests don't each eat the ~60s dark-provider timeout — but only
    when a fallback is actually available."""
    if isinstance(provider, NvidiaProvider) and _has_fallback(settings) and _nvidia_circuit_open():
        return await _run_fallback_chain(request, settings)
    try:
        return await provider.generate(request)
    except ProviderError as error:
        if not (isinstance(provider, NvidiaProvider) and (error.status_code or 0) >= 500):
            raise
        if not _has_fallback(settings):
            raise
        _trip_nvidia_circuit()
        return await _run_fallback_chain(request, settings)


async def generate_image(request: GenerationRequest, settings: Settings | None = None) -> GenerationResult:
    settings = settings or get_settings()
    provider, effective_request = _resolve_provider_and_request(request, settings)
    return await _generate_one_with_fallback(provider, effective_request, settings)


def validate_batch_count(count: Any) -> int:
    if isinstance(count, bool) or not isinstance(count, int):
        raise ValueError(BATCH_COUNT_ERROR_MESSAGE)
    if count < 1 or count > MAX_BATCH_COUNT:
        raise ValueError(BATCH_COUNT_ERROR_MESSAGE)
    return count


def _random_seed() -> int:
    return random.randint(1, MAX_SEED)


async def generate_batch(
    request: GenerationRequest, count: int, settings: Settings | None = None
) -> list[GenerationResult]:
    """Generate ``count`` variations of a prompt. The first image honours an
    explicit seed (so users can vary a locked composition); the rest get fresh
    random seeds so the batch shows genuine variety."""
    count = validate_batch_count(count)
    settings = settings or get_settings()
    # Resolve the fast-tier routing once (schnell -> Workers AI or NVIDIA dev) so
    # every variation in the batch uses the same provider/model.
    provider, effective_request = _resolve_provider_and_request(request, settings)
    # The variations are independent network calls; run them concurrently so a
    # 4-image batch costs one round-trip of latency, not four. The first image
    # honours an explicit seed; the rest get fresh random seeds for variety.
    seeds = [
        effective_request.seed if (index == 0 and effective_request.seed is not None) else _random_seed()
        for index in range(count)
    ]
    tasks = [replace(effective_request, seed=seed) for seed in seeds]
    return list(
        await asyncio.gather(
            *(_generate_one_with_fallback(provider, task, settings) for task in tasks)
        )
    )


def validate_edit_images(images: tuple[bytes, ...]) -> tuple[bytes, ...]:
    if not images or len(images) > MAX_EDIT_IMAGES:
        raise ValueError(EDIT_IMAGE_COUNT_ERROR_MESSAGE)
    for raw in images:
        if not raw:
            raise ValueError("上傳的圖片是空的")
        if len(raw) > MAX_EDIT_IMAGE_BYTES:
            raise ValueError(f"單張圖片不可超過 {MAX_EDIT_IMAGE_BYTES // (1024 * 1024)}MB")
    return images


def _resize_for_edit(raw: bytes) -> bytes:
    """FLUX.2 klein 要求每張輸入圖小於 512x512。等比縮到框內並轉成 PNG。
    非法圖片 bytes 會拋 ValueError（讓上層回 400 而非 500）。"""
    from io import BytesIO

    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(BytesIO(raw)) as opened:
            # 先看宣告尺寸再解碼，擋 decompression bomb（避免 convert 前吃爆記憶體，
            # 也把 PIL 的 DecompressionBombError/警告收斂成乾淨 400）。
            width, height = opened.size
            if width * height > EDIT_IMAGE_MAX_PIXELS:
                raise ValueError("圖片尺寸過大，請改用較小的圖片")
            rgb = opened.convert("RGB")
            # thumbnail 只縮不放大；用 511 上限確保「小於 512」（嚴格小於）。
            rgb.thumbnail((EDIT_IMAGE_MAX_DIM - 1, EDIT_IMAGE_MAX_DIM - 1))
            buf = BytesIO()
            rgb.save(buf, format="PNG", optimize=True)
            return buf.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("無法讀取圖片，請確認是有效的影像檔") from exc


async def edit_image(request: EditRequest, settings: Settings | None = None) -> EditResult:
    """指令式 AI 改圖：把 1-4 張自訂圖 + 文字指令送到 Cloudflare Workers AI 的
    FLUX.2 klein（multipart input_image_0..3），回傳編輯後圖片的 data URL。

    NOTE: 請求/回應格式依 Cloudflare Workers AI 官方文件；未取得 CF token 前無法
    端到端實測，故無 token 時直接回乾淨 503（missing_api_key）。"""
    settings = settings or get_settings()
    prompt = validate_prompt(request.prompt)
    images = validate_edit_images(request.images)

    if not (settings.cf_account_id.strip() and settings.cf_api_token.strip()):
        raise ProviderError(
            "AI 改圖需要 Cloudflare Workers AI 設定（CF_ACCOUNT_ID / CF_API_TOKEN）",
            status_code=503,
            code="missing_api_key",
        )

    resized = [_resize_for_edit(raw) for raw in images]
    endpoint = (
        f"https://api.cloudflare.com/client/v4/accounts/"
        f"{settings.cf_account_id.strip()}/ai/run/{settings.workers_ai_edit_model}"
    )
    # 走 multipart，Content-Type 交給 httpx 設定 boundary，這裡不可自帶。
    headers = {"Authorization": f"Bearer {settings.cf_api_token.strip()}", "Accept": "application/json"}

    last_error: ProviderError | None = None
    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        for attempt in range(IMAGE_MAX_ATTEMPTS):
            files = {
                f"input_image_{i}": (f"input_image_{i}.png", data, "image/png")
                for i, data in enumerate(resized)
            }
            try:
                response = await client.post(endpoint, headers=headers, data={"prompt": prompt}, files=files)
            except httpx.TimeoutException:
                last_error = ProviderError("AI 改圖逾時，請稍後再試", status_code=504, code="timeout")
            except httpx.HTTPError as exc:
                last_error = ProviderError(f"Workers AI 連線失敗：{exc}", status_code=502, code="network_error")
            else:
                if response.status_code not in RETRYABLE_IMAGE_STATUS:
                    break
                last_error = ProviderError(
                    _response_error_message(response, "Workers AI"),
                    status_code=response.status_code,
                    code="workers_ai_error",
                )
            if attempt + 1 >= IMAGE_MAX_ATTEMPTS:
                raise last_error
            await asyncio.sleep(IMAGE_RETRY_BACKOFF_SECONDS * (attempt + 1))

    if response.status_code == 429:
        retry_after = _parse_retry_after(response.headers.get("retry-after"))
        raise ProviderError("叫用太頻繁，請稍後再試", status_code=429, code="rate_limited", retry_after=retry_after)
    if response.status_code >= 400:
        raise ProviderError(
            _response_error_message(response, "Workers AI"), status_code=response.status_code, code="workers_ai_error"
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise ProviderError("Workers AI 回應不是有效 JSON", status_code=502, code="bad_provider_response") from exc
    result_payload = payload.get("result") if isinstance(payload, dict) else None
    image = extract_image(result_payload if result_payload is not None else payload, "Workers AI")
    return EditResult(
        image=image, provider="workers-ai", model=settings.workers_ai_edit_model, image_count=len(resized)
    )


def to_http_error(err: ProviderError) -> tuple[dict[str, Any], int]:
    payload: dict[str, Any] = {"error": sanitize_error_message(err.message), "code": err.code}
    if err.retry_after is not None:
        payload["retry_after"] = err.retry_after
    return payload, err.status_code


def sanitize_error_message(message: str) -> str:
    """Return a user-safe provider error.

    Provider payloads and SDK exceptions can include Authorization headers,
    API keys, or stack traces. Keep short actionable messages, but redact
    secret-looking tokens and collapse stack traces to a generic user message.
    """
    text = str(message or "").strip()
    if not text:
        return "出圖服務回傳錯誤，請稍後再試"

    lower = text.lower()
    if "traceback" in lower or "\n  file " in lower or "stack trace" in lower:
        return "出圖服務回傳錯誤，請稍後再試"

    redactions = (
        (r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]"),
        (r"Authorization\s*:\s*[^\s,;]+", "Authorization: [redacted]"),
        (r"\bnvapi-[A-Za-z0-9._-]+", "nvapi-[redacted]"),
        (r"\bsk-proj-[A-Za-z0-9._-]+", "sk-proj-[redacted]"),
        (r"\bsk-[A-Za-z0-9._-]+", "sk-[redacted]"),
        (r"\bcf-[A-Za-z0-9._-]{16,}", "cf-[redacted]"),
    )
    for pattern, replacement in redactions:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return text


def is_content_filtered(data: Any) -> bool:
    """NVIDIA NIM may return HTTP 200 with a black placeholder image plus a
    ``finishReason`` of ``CONTENT_FILTERED`` when its safety filter blocks a
    prompt. Detect that so the caller can surface a clear error instead of
    rendering the blank image as a success."""
    if not isinstance(data, dict):
        return False
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, list):
        return False
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        reason = artifact.get("finishReason", artifact.get("finish_reason"))
        if isinstance(reason, str) and reason.strip().upper() == "CONTENT_FILTERED":
            return True
    return False


def extract_image(data: Any, provider_label: str = "NVIDIA") -> str:
    candidate = _find_image_candidate(data)
    if not candidate:
        raise ProviderError(f"{provider_label} 回應中找不到圖片資料", status_code=502, code="bad_provider_response")
    if candidate.startswith("data:image/") or candidate.startswith("http://") or candidate.startswith("https://"):
        return candidate
    try:
        raw = base64.b64decode(candidate, validate=True)
    except Exception as exc:
        raise ProviderError(
            f"{provider_label} 回應的圖片資料格式不正確", status_code=502, code="bad_provider_response"
        ) from exc
    return f"data:{_detect_image_mime(raw)};base64," + candidate


def _find_image_candidate(data: Any) -> str | None:
    if isinstance(data, str):
        return data if _looks_like_image_string(data) else None
    if isinstance(data, list):
        for item in data:
            found = _find_image_candidate(item)
            if found:
                return found
        return None
    if not isinstance(data, dict):
        return None

    for key in ("base64", "b64_json"):
        value = data.get(key)
        if isinstance(value, str) and _is_valid_base64(value):
            return value

    for key in ("image", "url", "image_url"):
        value = data.get(key)
        if isinstance(value, str) and _looks_like_image_string(value):
            return value

    for key in ("artifacts", "images", "data", "output"):
        found = _find_image_candidate(data.get(key))
        if found:
            return found
    return None


def _looks_like_image_string(value: str) -> bool:
    if value.startswith(("data:image/", "http://", "https://")):
        return True
    compact = value.strip()
    return len(compact) > 80 and all(ch.isalnum() or ch in "+/=_-" for ch in compact[:120])


def _is_valid_base64(value: str) -> bool:
    try:
        base64.b64decode(value.strip(), validate=True)
        return True
    except Exception:
        return False


def _detect_image_mime(raw: bytes) -> str:
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"GIF87a") or raw.startswith(b"GIF89a"):
        return "image/gif"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def _parse_retry_after(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return max(1, int(float(value)))
    except ValueError:
        return None


def _response_error_message(response: httpx.Response, provider_label: str = "NVIDIA") -> str:
    fallback = f"{provider_label} HTTP {response.status_code}"
    try:
        data = response.json()
    except ValueError:
        text = response.text.strip()
        return sanitize_error_message(text or fallback)
    if isinstance(data, dict):
        if isinstance(data.get("error"), str):
            return sanitize_error_message(data["error"])
        if isinstance(data.get("message"), str):
            return sanitize_error_message(data["message"])
        # Cloudflare shape: {"errors": [{"message": "..."}], "success": false}
        errors = data.get("errors")
        if isinstance(errors, list):
            for item in errors:
                if isinstance(item, dict) and isinstance(item.get("message"), str):
                    return sanitize_error_message(item["message"])
        if "detail" in data:
            return sanitize_error_message(f"{fallback}: {data['detail']}")
    # Avoid leaking the raw provider payload (repr of an arbitrary dict) to clients.
    return fallback
