from __future__ import annotations

import logging
import mimetypes
import time
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .image_service import (
    EDIT_IMAGE_COUNT_ERROR_MESSAGE,
    MAX_EDIT_IMAGE_BYTES,
    MAX_EDIT_IMAGES,
    EditRequest,
    GenerationRequest,
    ProviderError,
    SEED_ERROR_MESSAGE,
    edit_image,
    generate_batch,
    generate_image,
    to_http_error,
    validate_seed,
    validate_batch_count,
)
from .prompt_complete import complete_plain_prompt
from .prompt_enhance import enhance_prompt
from .prompt_transform import transform_plain_prompt
from .rate_limit import check_generation_rate_limit
from .settings import get_settings
from .turnstile import turnstile_enabled, verify_turnstile_token
from .moderation import moderate_prompt
from .usage_metrics import record_usage_event, summarize_usage
from .vision_qa import maybe_run_vision_qa

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Windows 的 mimetypes 登錄檔常缺 .webp，StaticFiles 會回 text/plain。
# 明確註冊，確保範例縮圖以 image/webp 提供。
mimetypes.add_type("image/webp", ".webp")

app = FastAPI(title="AI 圖片產生器", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
client_error_logger = logging.getLogger("fluxi.client_error")


@app.middleware("http")
async def static_no_cache(request: Request, call_next):
    # no-cache = 每次帶 ETag 向伺服器驗證（命中回 304），避免瀏覽器啟發式快取
    # 讓部署後的新 CSS/JS 遲遲不生效（使用者卡舊版介面）。
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/") or path == "/service-worker.js":
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    for error in exc.errors():
        if "seed" in error.get("loc", ()):
            return JSONResponse({"error": SEED_ERROR_MESSAGE, "code": "bad_request"}, status_code=400)
    return await request_validation_exception_handler(request, exc)


class GeneratePayload(BaseModel):
    prompt: str
    userPrompt: str | None = None
    model: str = "schnell"
    size: str = "square"
    width: int | None = None
    height: int | None = None
    seed: int | None = None
    turnstileToken: str | None = None
    visionQa: bool = False

    @field_validator("seed", mode="before")
    @classmethod
    def validate_payload_seed(cls, value):
        return validate_seed(value)


class BatchGeneratePayload(BaseModel):
    prompt: str
    userPrompt: str | None = None
    model: str = "schnell"
    size: str = "square"
    width: int | None = None
    height: int | None = None
    seed: int | None = None
    count: int = 1
    turnstileToken: str | None = None
    visionQa: bool = False

    @field_validator("seed", mode="before")
    @classmethod
    def validate_payload_seed(cls, value):
        return validate_seed(value)


class PromptTransformPayload(BaseModel):
    source: str
    style: str = "auto"


class PromptEnhancePayload(BaseModel):
    prompt: str
    effect: str = ""


class ClientErrorPayload(BaseModel):
    type: str = Field(default="client_error", max_length=80)
    message: str = Field(default="", max_length=500)
    stack: str = Field(default="", max_length=900)
    source: str = Field(default="", max_length=300)
    url: str = Field(default="", max_length=300)
    line: int | None = None
    column: int | None = None
    requestId: str = Field(default="", max_length=120)
    userAgent: str = Field(default="", max_length=300)


def rate_limit_response(decision):
    body = {
        "error": "叫用太頻繁，請稍後再試",
        "code": "rate_limited",
    }
    headers = {}
    if decision.retry_after is not None:
        body["retry_after"] = decision.retry_after
        headers["Retry-After"] = str(decision.retry_after)
    if decision.limit is not None:
        body["limit"] = decision.limit
    if decision.remaining is not None:
        body["remaining"] = decision.remaining
    return JSONResponse(body, status_code=429, headers=headers)


def turnstile_response(decision):
    return JSONResponse(
        {"error": decision.message, "code": decision.code},
        status_code=decision.status_code,
    )


def moderation_response(decision):
    return JSONResponse(
        {"error": decision.message, "code": decision.code, "category": decision.category},
        status_code=decision.status_code,
    )


def combined_prompt_for_moderation(provider_prompt: str, user_prompt: str | None = None) -> str:
    return "\n".join(part for part in (user_prompt, provider_prompt) if part)


def elapsed_ms(start: float) -> int:
    return max(0, round((time.perf_counter() - start) * 1000))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/manifest.webmanifest")
def manifest() -> FileResponse:
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/service-worker.js")
def service_worker() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "service-worker.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@app.get("/api/health")
def api_health() -> dict[str, object]:
    settings = get_settings()
    configured_provider = settings.image_provider.strip().lower()
    has_nvidia_key = bool(settings.nvidia_api_key.strip())
    has_workers_ai_key = bool(settings.cf_account_id.strip() and settings.cf_api_token.strip())
    providers = {
        "nvidia": has_nvidia_key,
        "workersAI": has_workers_ai_key,
        "modal": False,
    }
    provider_status = "demo"
    mode = "demo"
    message = "Demo 模式，不會真實出圖"

    if configured_provider == "demo":
        provider_status = "demo"
    elif configured_provider == "nvidia":
        if has_nvidia_key:
            provider_status = "ready"
            mode = "live"
            message = "真實出圖可用"
        else:
            provider_status = "offline"
            message = "圖片服務尚未連接"
    elif configured_provider == "auto":
        if has_nvidia_key or has_workers_ai_key:
            provider_status = "ready" if has_nvidia_key else "degraded"
            mode = "live"
            message = "真實出圖可用" if has_nvidia_key else "部分服務可用"
        else:
            provider_status = "demo"
    else:
        provider_status = "error"
        message = "服務設定錯誤：IMAGE_PROVIDER 只能是 auto、demo 或 nvidia"

    return {
        "status": "ok",
        "provider": "nvidia" if has_nvidia_key else ("workers-ai" if has_workers_ai_key else "demo"),
        "providerStatus": provider_status,
        "mode": mode,
        "providers": providers,
        "hasApiKey": has_nvidia_key or has_workers_ai_key,
        "storageAvailable": False,
        "turnstile": {
            "required": turnstile_enabled(settings),
            "siteKey": settings.turnstile_site_key.strip() if turnstile_enabled(settings) else "",
        },
        "message": message,
        "checkedAt": datetime.now(UTC).isoformat(),
    }


@app.post("/client-error", status_code=204)
def client_error(payload: ClientErrorPayload) -> Response:
    client_error_logger.warning(
        "client_error type=%s message=%s source=%s request_id=%s line=%s column=%s",
        payload.type,
        payload.message,
        payload.source,
        payload.requestId,
        payload.line,
        payload.column,
    )
    return Response(status_code=204)

@app.get("/health")
def health() -> dict[str, object]:
    return api_health()


@app.get("/api/usage")
def api_usage(date: str | None = None):
    settings = get_settings()
    try:
        return summarize_usage(date, settings=settings)
    except ValueError as exc:
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)


@app.post("/generate")
async def generate(payload: GeneratePayload, request: Request):
    started = time.perf_counter()
    settings = get_settings()
    moderation_decision = moderate_prompt(combined_prompt_for_moderation(payload.prompt, payload.userPrompt))
    if not moderation_decision.allowed:
        record_usage_event(
            request=request,
            settings=settings,
            route="generate",
            outcome="error",
            status_code=moderation_decision.status_code,
            duration_ms=elapsed_ms(started),
            model=payload.model,
            provider="blocked",
            error_code=moderation_decision.code,
        )
        return moderation_response(moderation_decision)
    turnstile_decision = await verify_turnstile_token(payload.turnstileToken, request, settings)
    if not turnstile_decision.allowed:
        record_usage_event(
            request=request,
            settings=settings,
            route="generate",
            outcome="error",
            status_code=turnstile_decision.status_code,
            duration_ms=elapsed_ms(started),
            model=payload.model,
            provider="unknown",
            error_code=turnstile_decision.code,
        )
        return turnstile_response(turnstile_decision)
    decision = check_generation_rate_limit(request, settings, route="generate")
    if not decision.allowed:
        record_usage_event(
            request=request,
            settings=settings,
            route="generate",
            outcome="error",
            status_code=429,
            duration_ms=elapsed_ms(started),
            model=payload.model,
            provider="unknown",
            error_code="rate_limited",
        )
        return rate_limit_response(decision)
    try:
        result = await generate_image(
            GenerationRequest(
                prompt=payload.prompt,
                model=payload.model,
                size=payload.size,
                width=payload.width,
                height=payload.height,
                seed=payload.seed,
            ),
            settings=settings,
        )
    except ValueError as exc:
        record_usage_event(
            request=request,
            settings=settings,
            route="generate",
            outcome="error",
            status_code=400,
            duration_ms=elapsed_ms(started),
            model=payload.model,
            provider="unknown",
            error_code="bad_request",
        )
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)
    except ProviderError as exc:
        body, status = to_http_error(exc)
        record_usage_event(
            request=request,
            settings=settings,
            route="generate",
            outcome="error",
            status_code=status,
            duration_ms=elapsed_ms(started),
            model=payload.model,
            provider="unknown",
            error_code=str(body.get("code") or exc.code or "provider_error"),
        )
        return JSONResponse(body, status_code=status)
    record_usage_event(
        request=request,
        settings=settings,
        route="generate",
        outcome="success",
        status_code=200,
        duration_ms=elapsed_ms(started),
        model=result.model,
        provider=result.provider,
        image_count=1,
    )
    vision_qa = maybe_run_vision_qa(result.image, payload.prompt, settings) if payload.visionQa else None
    body = {
        "image": result.image,
        "provider": result.provider,
        "model": result.model,
        "width": result.width,
        "height": result.height,
        "seed": result.seed,
        "imageQuality": result.image_quality,
    }
    if vision_qa:
        body["visionQa"] = vision_qa
    return body


@app.post("/generate/batch")
async def generate_batch_route(payload: BatchGeneratePayload, request: Request):
    started = time.perf_counter()
    settings = get_settings()
    try:
        count = validate_batch_count(payload.count)
        moderation_decision = moderate_prompt(combined_prompt_for_moderation(payload.prompt, payload.userPrompt))
        if not moderation_decision.allowed:
            record_usage_event(
                request=request,
                settings=settings,
                route="generate_batch",
                outcome="error",
                status_code=moderation_decision.status_code,
                duration_ms=elapsed_ms(started),
                model=payload.model,
                provider="blocked",
                error_code=moderation_decision.code,
            )
            return moderation_response(moderation_decision)
        turnstile_decision = await verify_turnstile_token(payload.turnstileToken, request, settings)
        if not turnstile_decision.allowed:
            record_usage_event(
                request=request,
                settings=settings,
                route="generate_batch",
                outcome="error",
                status_code=turnstile_decision.status_code,
                duration_ms=elapsed_ms(started),
                model=payload.model,
                provider="unknown",
                error_code=turnstile_decision.code,
            )
            return turnstile_response(turnstile_decision)
        decision = check_generation_rate_limit(request, settings, route="generate_batch", cost=count)
        if not decision.allowed:
            record_usage_event(
                request=request,
                settings=settings,
                route="generate_batch",
                outcome="error",
                status_code=429,
                duration_ms=elapsed_ms(started),
                model=payload.model,
                provider="unknown",
                error_code="rate_limited",
            )
            return rate_limit_response(decision)
        results = await generate_batch(
            GenerationRequest(
                prompt=payload.prompt,
                model=payload.model,
                size=payload.size,
                width=payload.width,
                height=payload.height,
                seed=payload.seed,
            ),
            count,
            settings=settings,
        )
    except ValueError as exc:
        record_usage_event(
            request=request,
            settings=settings,
            route="generate_batch",
            outcome="error",
            status_code=400,
            duration_ms=elapsed_ms(started),
            model=payload.model,
            provider="unknown",
            error_code="bad_request",
        )
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)
    except ProviderError as exc:
        body, status = to_http_error(exc)
        record_usage_event(
            request=request,
            settings=settings,
            route="generate_batch",
            outcome="error",
            status_code=status,
            duration_ms=elapsed_ms(started),
            model=payload.model,
            provider="unknown",
            error_code=str(body.get("code") or exc.code or "provider_error"),
        )
        return JSONResponse(body, status_code=status)
    first_result = results[0] if results else None
    record_usage_event(
        request=request,
        settings=settings,
        route="generate_batch",
        outcome="success",
        status_code=200,
        duration_ms=elapsed_ms(started),
        model=first_result.model if first_result else payload.model,
        provider=first_result.provider if first_result else "unknown",
        image_count=len(results),
    )
    images_payload = []
    for result in results:
        item = {
                "image": result.image,
                "provider": result.provider,
                "model": result.model,
                "width": result.width,
                "height": result.height,
                "seed": result.seed,
                "imageQuality": result.image_quality,
            }
        if payload.visionQa:
            vision_qa = maybe_run_vision_qa(result.image, payload.prompt, settings)
            if vision_qa:
                item["visionQa"] = vision_qa
        images_payload.append(item)
    return {"images": images_payload}


@app.post("/edit")
async def edit(
    request: Request,
    prompt: str = Form(...),
    images: list[UploadFile] = File(...),
    turnstileToken: str | None = Form(None),
):
    started = time.perf_counter()
    settings = get_settings()
    moderation_decision = moderate_prompt(prompt)
    if not moderation_decision.allowed:
        record_usage_event(
            request=request,
            settings=settings,
            route="edit",
            outcome="error",
            status_code=moderation_decision.status_code,
            duration_ms=elapsed_ms(started),
            model="edit",
            provider="blocked",
            error_code=moderation_decision.code,
        )
        return moderation_response(moderation_decision)
    turnstile_decision = await verify_turnstile_token(turnstileToken, request, settings)
    if not turnstile_decision.allowed:
        record_usage_event(
            request=request,
            settings=settings,
            route="edit",
            outcome="error",
            status_code=turnstile_decision.status_code,
            duration_ms=elapsed_ms(started),
            model="edit",
            provider="unknown",
            error_code=turnstile_decision.code,
        )
        return turnstile_response(turnstile_decision)
    decision = check_generation_rate_limit(request, settings, route="edit")
    if not decision.allowed:
        record_usage_event(
            request=request,
            settings=settings,
            route="edit",
            outcome="error",
            status_code=429,
            duration_ms=elapsed_ms(started),
            model="edit",
            provider="unknown",
            error_code="rate_limited",
        )
        return rate_limit_response(decision)
    # 讀取 body 前先擋數量與單檔大小，避免把大量/超大部件全載進記憶體（DoS 防護）。
    if not images or len(images) > MAX_EDIT_IMAGES:
        record_usage_event(
            request=request,
            settings=settings,
            route="edit",
            outcome="error",
            status_code=400,
            duration_ms=elapsed_ms(started),
            model="edit",
            provider="unknown",
            error_code="bad_request",
        )
        return JSONResponse({"error": EDIT_IMAGE_COUNT_ERROR_MESSAGE, "code": "bad_request"}, status_code=400)
    for image in images:
        if image.size is not None and image.size > MAX_EDIT_IMAGE_BYTES:
            record_usage_event(
                request=request,
                settings=settings,
                route="edit",
                outcome="error",
                status_code=400,
                duration_ms=elapsed_ms(started),
                model="edit",
                provider="unknown",
                error_code="bad_request",
            )
            return JSONResponse(
                {"error": f"單張圖片不可超過 {MAX_EDIT_IMAGE_BYTES // (1024 * 1024)}MB", "code": "bad_request"},
                status_code=400,
            )
    raw_images = tuple([await image.read() for image in images])
    try:
        result = await edit_image(EditRequest(prompt=prompt, images=raw_images), settings=settings)
    except ValueError as exc:
        record_usage_event(
            request=request,
            settings=settings,
            route="edit",
            outcome="error",
            status_code=400,
            duration_ms=elapsed_ms(started),
            model="edit",
            provider="unknown",
            error_code="bad_request",
        )
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)
    except ProviderError as exc:
        body, status = to_http_error(exc)
        record_usage_event(
            request=request,
            settings=settings,
            route="edit",
            outcome="error",
            status_code=status,
            duration_ms=elapsed_ms(started),
            model="edit",
            provider="unknown",
            error_code=str(body.get("code") or exc.code or "provider_error"),
        )
        return JSONResponse(body, status_code=status)
    record_usage_event(
        request=request,
        settings=settings,
        route="edit",
        outcome="success",
        status_code=200,
        duration_ms=elapsed_ms(started),
        model=result.model,
        provider=result.provider,
        image_count=1,
    )
    return {
        "image": result.image,
        "provider": result.provider,
        "model": result.model,
        "image_count": result.image_count,
    }


@app.post("/gallery")
def gallery_save_unavailable():
    # The cloud gallery is backed by Cloudflare R2 and is only served by the Worker.
    # The local FastAPI dev server returns 503 so the frontend shows a clear notice.
    return JSONResponse({"error": "雲端圖庫僅在 Cloudflare 部署可用", "code": "gallery_disabled"}, status_code=503)


@app.get("/api/gallery")
def gallery_admin_list_unavailable():
    # The admin cloud gallery list reads Cloudflare R2 metadata through the Worker.
    # Local FastAPI intentionally returns the same machine-readable disabled code
    # so the station/admin UI can show a clear fallback instead of a generic 404.
    return JSONResponse({"error": "站長雲端圖庫僅在 Cloudflare 部署可用", "code": "gallery_disabled"}, status_code=503)


@app.post("/prompt/transform")
def prompt_transform(request: Request, payload: PromptTransformPayload):
    settings = get_settings()
    decision = check_generation_rate_limit(request, settings, route="prompt_transform")
    if not decision.allowed:
        return rate_limit_response(decision)
    try:
        result = transform_plain_prompt(payload.source, payload.style)
    except ValueError as exc:
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)
    return {
        "source": result.source,
        "prompt": result.prompt,
        "provider": result.provider,
        "warnings": result.warnings,
    }


@app.post("/prompt/enhance")
def prompt_enhance(request: Request, payload: PromptEnhancePayload):
    settings = get_settings()
    decision = check_generation_rate_limit(request, settings, route="prompt_enhance")
    if not decision.allowed:
        return rate_limit_response(decision)
    try:
        result = enhance_prompt(payload.prompt, payload.effect)
    except ValueError as exc:
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)
    return {
        "prompt": result.prompt,
        "provider": result.provider,
        "effect": result.effect,
        "warnings": result.warnings,
    }


@app.post("/prompt/complete")
def prompt_complete(request: Request, payload: PromptTransformPayload):
    settings = get_settings()
    decision = check_generation_rate_limit(request, settings, route="prompt_complete")
    if not decision.allowed:
        return rate_limit_response(decision)
    try:
        result = complete_plain_prompt(payload.source, payload.style)
    except ValueError as exc:
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)
    return {
        "source": result.source,
        "prompt": result.prompt,
        "provider": result.provider,
        "warnings": result.warnings,
    }
