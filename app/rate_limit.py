from __future__ import annotations

import time
from dataclasses import dataclass
from threading import Lock

from fastapi import Request

from .settings import Settings


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after: int | None = None
    limit: int | None = None
    remaining: int | None = None
    window_seconds: int | None = None


class InMemoryRateLimiter:
    """Simple process-local fixed-window limiter for the FastAPI dev/server path.

    Cloudflare deploys use the Worker rate-limiting binding. This protects the
    local/VM FastAPI backend too, so public exposure is not accidentally unlimited.
    """

    def __init__(self, now=time.time):
        self._now = now
        self._lock = Lock()
        self._buckets: dict[tuple[str, str], tuple[float, int]] = {}

    def check(self, key: str, *, limit: int, window_seconds: int, cost: int = 1) -> RateLimitDecision:
        if limit <= 0 or window_seconds <= 0:
            return RateLimitDecision(True, limit=limit, remaining=None, window_seconds=window_seconds)
        normalized_cost = max(1, int(cost))
        now = float(self._now())
        with self._lock:
            window_start, used = self._buckets.get((key, str(window_seconds)), (now, 0))
            if now - window_start >= window_seconds:
                window_start = now
                used = 0
            if used + normalized_cost > limit:
                retry_after = max(1, int(window_seconds - (now - window_start)))
                remaining = max(0, limit - used)
                self._buckets[(key, str(window_seconds))] = (window_start, used)
                return RateLimitDecision(False, retry_after, limit, remaining, window_seconds)
            used += normalized_cost
            self._buckets[(key, str(window_seconds))] = (window_start, used)
            return RateLimitDecision(True, None, limit, max(0, limit - used), window_seconds)

    def clear(self) -> None:
        with self._lock:
            self._buckets.clear()


_limiter = InMemoryRateLimiter()


def client_ip(request: Request) -> str:
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip and cf_ip.strip():
        return cf_ip.strip()
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded and forwarded.strip():
        return forwarded.split(",", 1)[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "anonymous"


def rate_limit_tier(settings: Settings) -> str:
    provider = settings.image_provider.strip().lower()
    has_live_key = bool(
        settings.nvidia_api_key.strip()
        or (settings.cf_account_id.strip() and settings.cf_api_token.strip())
    )
    if provider == "demo" or not has_live_key:
        return "demo"
    return "live"


def check_generation_rate_limit(
    request: Request,
    settings: Settings,
    *,
    route: str,
    cost: int = 1,
) -> RateLimitDecision:
    if not settings.rate_limit_enabled:
        return RateLimitDecision(True)
    tier = rate_limit_tier(settings)
    limit = (
        settings.demo_generate_rate_limit_per_window
        if tier == "demo"
        else settings.generate_rate_limit_per_window
    )
    key = f"{tier}:{route}:{client_ip(request)}"
    return _limiter.check(
        key,
        limit=limit,
        window_seconds=settings.rate_limit_window_seconds,
        cost=cost,
    )


def reset_rate_limiter() -> None:
    _limiter.clear()
