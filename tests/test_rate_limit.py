from types import SimpleNamespace

from app.rate_limit import (
    InMemoryRateLimiter,
    check_generation_rate_limit,
    client_ip,
    rate_limit_tier,
    reset_rate_limiter,
)
from app.settings import Settings


def test_in_memory_rate_limiter_blocks_after_limit_and_returns_retry_after():
    clock = {"now": 1000.0}
    limiter = InMemoryRateLimiter(now=lambda: clock["now"])

    first = limiter.check("ip-1", limit=2, window_seconds=60)
    second = limiter.check("ip-1", limit=2, window_seconds=60)
    third = limiter.check("ip-1", limit=2, window_seconds=60)

    assert first.allowed is True
    assert first.remaining == 1
    assert second.allowed is True
    assert second.remaining == 0
    assert third.allowed is False
    assert third.retry_after == 60


def test_in_memory_rate_limiter_resets_after_window():
    clock = {"now": 1000.0}
    limiter = InMemoryRateLimiter(now=lambda: clock["now"])

    assert limiter.check("ip-1", limit=1, window_seconds=60).allowed is True
    assert limiter.check("ip-1", limit=1, window_seconds=60).allowed is False
    clock["now"] = 1061.0
    assert limiter.check("ip-1", limit=1, window_seconds=60).allowed is True


def test_rate_limit_cost_counts_batch_images():
    limiter = InMemoryRateLimiter(now=lambda: 1000.0)

    first = limiter.check("ip-1", limit=4, window_seconds=60, cost=4)
    second = limiter.check("ip-1", limit=4, window_seconds=60, cost=1)

    assert first.allowed is True
    assert first.remaining == 0
    assert second.allowed is False


def test_client_ip_prefers_cloudflare_header_then_forwarded_for():
    cf_request = SimpleNamespace(
        headers={"cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1"},
        client=SimpleNamespace(host="127.0.0.1"),
    )
    forwarded_request = SimpleNamespace(
        headers={"x-forwarded-for": "198.51.100.1, 198.51.100.2"},
        client=SimpleNamespace(host="127.0.0.1"),
    )

    assert client_ip(cf_request) == "203.0.113.9"
    assert client_ip(forwarded_request) == "198.51.100.1"


def test_rate_limit_tier_separates_demo_and_live():
    assert rate_limit_tier(Settings(image_provider="demo", nvidia_api_key="live-key")) == "demo"
    assert rate_limit_tier(Settings(image_provider="auto", nvidia_api_key="")) == "demo"
    assert rate_limit_tier(Settings(image_provider="auto", nvidia_api_key="live-key")) == "live"


def test_check_generation_rate_limit_uses_demo_limit_when_no_live_key():
    reset_rate_limiter()
    request = SimpleNamespace(headers={"cf-connecting-ip": "203.0.113.10"}, client=None)
    settings = Settings(
        image_provider="auto",
        nvidia_api_key="",
        rate_limit_window_seconds=60,
        generate_rate_limit_per_window=1,
        demo_generate_rate_limit_per_window=2,
    )

    first = check_generation_rate_limit(request, settings, route="generate")
    second = check_generation_rate_limit(request, settings, route="generate")
    third = check_generation_rate_limit(request, settings, route="generate")

    assert first.allowed is True
    assert second.allowed is True
    assert third.allowed is False
    assert third.limit == 2
