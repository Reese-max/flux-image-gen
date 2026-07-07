from __future__ import annotations

from dataclasses import dataclass

import httpx
from fastapi import Request

from .rate_limit import client_ip
from .settings import Settings


@dataclass(frozen=True)
class TurnstileDecision:
    allowed: bool
    code: str = "ok"
    message: str = ""
    status_code: int = 200


def turnstile_enabled(settings: Settings) -> bool:
    return bool(settings.turnstile_required)


async def verify_turnstile_token(
    token: str | None,
    request: Request,
    settings: Settings,
) -> TurnstileDecision:
    """Verify a Cloudflare Turnstile token before spending provider quota.

    The secret key and upstream error details are intentionally never returned to
    the caller. Public/dev instances can leave TURNSTILE_REQUIRED=false.
    """

    if not turnstile_enabled(settings):
        return TurnstileDecision(True)

    if not settings.turnstile_secret_key.strip():
        return TurnstileDecision(
            False,
            code="turnstile_unconfigured",
            message="真人驗證尚未完成設定，請稍後再試",
            status_code=503,
        )

    clean_token = (token or "").strip()
    if not clean_token:
        return TurnstileDecision(
            False,
            code="turnstile_required",
            message="請先完成人機驗證再生成圖片",
            status_code=403,
        )

    form = {
        "secret": settings.turnstile_secret_key,
        "response": clean_token,
        "remoteip": client_ip(request),
    }
    try:
        async with httpx.AsyncClient(timeout=settings.turnstile_timeout_seconds) as client:
            response = await client.post(settings.turnstile_verify_url, data=form)
            data = response.json()
    except Exception:
        return TurnstileDecision(
            False,
            code="turnstile_unavailable",
            message="真人驗證服務暫時不可用，請稍後再試",
            status_code=503,
        )

    if response.status_code >= 500:
        return TurnstileDecision(
            False,
            code="turnstile_unavailable",
            message="真人驗證服務暫時不可用，請稍後再試",
            status_code=503,
        )

    if not data.get("success"):
        return TurnstileDecision(
            False,
            code="turnstile_failed",
            message="真人驗證失敗，請重新驗證後再試",
            status_code=403,
        )

    return TurnstileDecision(True)
