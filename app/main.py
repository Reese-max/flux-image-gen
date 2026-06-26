from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

from .image_service import (
    GenerationRequest,
    ProviderError,
    SEED_ERROR_MESSAGE,
    generate_batch,
    generate_image,
    to_http_error,
    validate_seed,
)
from .prompt_transform import transform_plain_prompt
from .settings import get_settings

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="AI 圖片產生器", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    for error in exc.errors():
        if "seed" in error.get("loc", ()):
            return JSONResponse({"error": SEED_ERROR_MESSAGE, "code": "bad_request"}, status_code=400)
    return await request_validation_exception_handler(request, exc)


class GeneratePayload(BaseModel):
    prompt: str
    model: str = "schnell"
    size: str = "square"
    seed: int | None = None

    @field_validator("seed", mode="before")
    @classmethod
    def validate_payload_seed(cls, value):
        return validate_seed(value)


class BatchGeneratePayload(BaseModel):
    prompt: str
    model: str = "schnell"
    size: str = "square"
    seed: int | None = None
    count: int = 1

    @field_validator("seed", mode="before")
    @classmethod
    def validate_payload_seed(cls, value):
        return validate_seed(value)


class PromptTransformPayload(BaseModel):
    source: str
    style: str = "auto"


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


@app.get("/health")
def health() -> dict[str, str]:
    settings = get_settings()
    provider = "nvidia" if settings.nvidia_api_key.strip() else "demo"
    if settings.image_provider.strip().lower() in {"demo", "nvidia"}:
        provider = settings.image_provider.strip().lower()
    return {"status": "ok", "provider": provider}


@app.post("/generate")
async def generate(payload: GeneratePayload):
    try:
        result = await generate_image(
            GenerationRequest(prompt=payload.prompt, model=payload.model, size=payload.size, seed=payload.seed)
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)
    except ProviderError as exc:
        body, status = to_http_error(exc)
        return JSONResponse(body, status_code=status)
    return {
        "image": result.image,
        "provider": result.provider,
        "model": result.model,
        "width": result.width,
        "height": result.height,
        "seed": result.seed,
    }


@app.post("/generate/batch")
async def generate_batch_route(payload: BatchGeneratePayload):
    try:
        results = await generate_batch(
            GenerationRequest(prompt=payload.prompt, model=payload.model, size=payload.size, seed=payload.seed),
            payload.count,
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)
    except ProviderError as exc:
        body, status = to_http_error(exc)
        return JSONResponse(body, status_code=status)
    return {
        "images": [
            {
                "image": result.image,
                "provider": result.provider,
                "model": result.model,
                "width": result.width,
                "height": result.height,
                "seed": result.seed,
            }
            for result in results
        ]
    }


@app.post("/prompt/transform")
def prompt_transform(payload: PromptTransformPayload):
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
