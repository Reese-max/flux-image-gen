from __future__ import annotations

import asyncio
import base64
import random
from dataclasses import dataclass
from typing import Any

import httpx

from .demo_image import make_demo_png_data_url
from .settings import Settings, get_settings

SIZE_MAP: dict[str, tuple[int, int]] = {
    "square": (1024, 1024),
    "landscape": (1344, 768),
    "portrait": (768, 1344),
}

MODEL_ENDPOINTS: dict[str, str] = {
    "schnell": "black-forest-labs/flux.1-schnell",
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


async def generate_image(request: GenerationRequest, settings: Settings | None = None) -> GenerationResult:
    provider = choose_provider(settings)
    return await provider.generate(request)


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
    provider = choose_provider(settings)
    results: list[GenerationResult] = []
    for index in range(count):
        seed = request.seed if (index == 0 and request.seed is not None) else _random_seed()
        variation = GenerationRequest(
            prompt=request.prompt, model=request.model, size=request.size, seed=seed
        )
        results.append(await provider.generate(variation))
    return results


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


def extract_image(data: Any) -> str:
    candidate = _find_image_candidate(data)
    if not candidate:
        raise ProviderError("NVIDIA 回應中找不到圖片資料", status_code=502, code="bad_provider_response")
    if candidate.startswith("data:image/") or candidate.startswith("http://") or candidate.startswith("https://"):
        return candidate
    try:
        raw = base64.b64decode(candidate, validate=True)
    except Exception as exc:
        raise ProviderError("NVIDIA 回應的圖片資料格式不正確", status_code=502, code="bad_provider_response") from exc
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


def _response_error_message(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        text = response.text.strip()
        return text or f"NVIDIA HTTP {response.status_code}"
    if isinstance(data, dict):
        if isinstance(data.get("error"), str):
            return data["error"]
        if isinstance(data.get("message"), str):
            return data["message"]
        if "detail" in data:
            return f"NVIDIA HTTP {response.status_code}: {data['detail']}"
    return f"NVIDIA HTTP {response.status_code}: {data}"
