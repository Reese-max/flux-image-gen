from __future__ import annotations

import asyncio
import base64
import random
from dataclasses import dataclass, replace
from typing import Any

import httpx

from .demo_image import make_demo_png_data_url
from .settings import Settings, get_settings

SIZE_MAP: dict[str, tuple[int, int]] = {
    "square": (1024, 1024),
    "landscape": (1344, 768),
    "portrait": (768, 1344),
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


@dataclass(frozen=True)
class GenerationResult:
    image: str
    provider: str
    model: str
    width: int
    height: int
    seed: int


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


def map_size(size: str) -> tuple[int, int]:
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
        width, height = map_size(request.size)
        seed = resolve_seed(request.seed, model, self.settings)
        image = make_demo_png_data_url(f"{prompt}\nseed:{seed}", width, height, model)
        return GenerationResult(image=image, provider=self.provider_name, model=model, width=width, height=height, seed=seed)


class NvidiaProvider:
    provider_name = "nvidia"

    def __init__(self, settings: Settings):
        self.settings = settings

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        if not self.settings.nvidia_api_key.strip():
            raise ProviderError("缺少 NVIDIA_API_KEY", status_code=503, code="missing_api_key")

        prompt = validate_prompt(request.prompt)
        model = validate_model(request.model)
        width, height = map_size(request.size)
        seed = resolve_seed(request.seed, model, self.settings)
        endpoint = self._endpoint_for(model)
        payload: dict[str, Any] = {
            "prompt": prompt,
            "width": width,
            "height": height,
            "seed": seed,
        }
        if model == "dev":
            payload["cfg_scale"] = self.settings.nvidia_dev_cfg_scale
            payload["steps"] = self.settings.nvidia_dev_steps

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
        return GenerationResult(image=image, provider=self.provider_name, model=model, width=width, height=height, seed=seed)

    def _endpoint_for(self, model: str) -> str:
        base = self.settings.nvidia_base_url.rstrip("/")
        return f"{base}/{MODEL_ENDPOINTS[model]}"


class WorkersAiProvider:
    """Fast-tier ("schnell") backend on Cloudflare Workers AI (FLUX.2 klein 4B),
    replacing NVIDIA's dark flux.1-schnell. This is the REST-API twin of the
    Worker's ``env.AI.run`` path (cloudflare/src/image.js). Active only when
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
        width, height = map_size(request.size)
        seed = resolve_seed(request.seed, model, self.settings)
        # UI contract: seed 0 (or blank) means "random variation". klein treats
        # every seed literally, so 0 would pin the output; substitute a real
        # random seed and return it for reproducibility (mirrors the Worker).
        effective_seed = _random_seed() if seed == 0 else seed

        endpoint = (
            f"https://api.cloudflare.com/client/v4/accounts/"
            f"{self.settings.cf_account_id.strip()}/ai/run/{self.settings.workers_ai_fast_model}"
        )
        headers = {
            "Authorization": f"Bearer {self.settings.cf_api_token.strip()}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        payload: dict[str, Any] = {"prompt": prompt, "width": width, "height": height, "seed": effective_seed}

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
            image=image, provider=self.provider_name, model=model, width=width, height=height, seed=effective_seed
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

    - Workers AI configured -> use it (matches the Cloudflare Worker deploy).
    - Otherwise the chosen provider handles schnell directly: NVIDIA maps schnell
      to the live flux.2-klein-4b endpoint (flux.1-schnell went dark 2026-07),
      and Demo renders it locally. No model rewrite needed.
    """
    provider = choose_provider(settings)
    if request.model == "schnell" and _workers_ai_configured(settings):
        return WorkersAiProvider(settings), request
    return provider, request


async def generate_image(request: GenerationRequest, settings: Settings | None = None) -> GenerationResult:
    settings = settings or get_settings()
    provider, effective_request = _resolve_provider_and_request(request, settings)
    return await provider.generate(effective_request)


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
    return list(await asyncio.gather(*(provider.generate(task) for task in tasks)))


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
    payload: dict[str, Any] = {"error": err.message, "code": err.code}
    if err.retry_after is not None:
        payload["retry_after"] = err.retry_after
    return payload, err.status_code


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
        return text or fallback
    if isinstance(data, dict):
        if isinstance(data.get("error"), str):
            return data["error"]
        if isinstance(data.get("message"), str):
            return data["message"]
        # Cloudflare shape: {"errors": [{"message": "..."}], "success": false}
        errors = data.get("errors")
        if isinstance(errors, list):
            for item in errors:
                if isinstance(item, dict) and isinstance(item.get("message"), str):
                    return item["message"]
        if "detail" in data:
            return f"{fallback}: {data['detail']}"
    # Avoid leaking the raw provider payload (repr of an arbitrary dict) to clients.
    return fallback
