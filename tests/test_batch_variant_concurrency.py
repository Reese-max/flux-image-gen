"""Regression tests for the multi-variant batch fan-out (issue #7).

A batch request used to start every variation at once (``asyncio.gather`` here,
``Promise.allSettled`` over eagerly started requests in the Cloudflare Worker
twin). Hosted inference endpoints admit only a limited number of concurrent
runs per account, so every variation after the first came back HTTP 429
``rate_limited`` — a status the fallback chain deliberately never retries or
re-routes. Production reported "1 succeeded, N-1 failed" for both the 2-image
and the 4-image batch while the single-image path kept working, and retrying
the batch reproduced it every time.

The fan-out must therefore keep at most one provider call in flight, and every
variation must still get its own seed and its own result.
"""

import asyncio
import unittest
from unittest.mock import patch

from app.image_service import (
    GenerationRequest,
    GenerationResult,
    NvidiaProvider,
    ProviderError,
    _reset_nvidia_circuit,
    generate_batch,
)
from app.main import app
from app.rate_limit import reset_rate_limiter
from app.settings import Settings
from app.usage_metrics import reset_usage_metrics
from fastapi.testclient import TestClient


def _settings() -> Settings:
    # NVIDIA with no fallback configured: a 429 propagates unchanged, exactly as
    # it does in production where the fallback chain cannot rescue a rate limit.
    return Settings(image_provider="nvidia", nvidia_api_key="test-key")


class SingleRunProvider:
    """Stand-in for an inference endpoint that admits one run at a time."""

    provider_name = "nvidia"

    def __init__(self) -> None:
        self.in_flight = 0
        self.peak_in_flight = 0
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        self.calls += 1
        self.in_flight += 1
        self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
        try:
            # Yield long enough for every concurrently started variation to arrive
            # before deciding, so an overlapping fan-out is always detected.
            for _ in range(10):
                await asyncio.sleep(0)
            if self.in_flight > 1:
                raise ProviderError("叫用太頻繁，請稍後再試", status_code=429, code="rate_limited")
            return GenerationResult(
                image="data:image/png;base64,AAAA",
                provider=self.provider_name,
                model=request.model,
                width=1024,
                height=1024,
                seed=request.seed if request.seed is not None else 0,
            )
        finally:
            self.in_flight -= 1


def _patch_provider(fake: SingleRunProvider):
    async def generate(self, request):  # noqa: ARG001 - patched onto NvidiaProvider
        return await fake.generate(request)

    return patch.object(NvidiaProvider, "generate", new=generate)


class BatchVariantConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _reset_nvidia_circuit()

    def tearDown(self):
        _reset_nvidia_circuit()

    async def test_generate_batch_returns_every_variant_when_provider_admits_one_run(self):
        fake = SingleRunProvider()
        with _patch_provider(fake):
            results = await generate_batch(
                GenerationRequest(prompt="a cute corgi astronaut", model="schnell", size="square"),
                count=4,
                settings=_settings(),
            )

        self.assertEqual(len(results), 4)
        self.assertEqual(len({result.seed for result in results}), 4)
        for result in results:
            self.assertTrue(result.image.startswith("data:image/png;base64,"))

    async def test_generate_batch_keeps_a_single_provider_call_in_flight(self):
        fake = SingleRunProvider()
        with _patch_provider(fake):
            results = await generate_batch(
                GenerationRequest(prompt="a cute corgi astronaut", model="schnell", size="square"),
                count=3,
                settings=_settings(),
            )

        self.assertEqual(fake.calls, 3)
        self.assertEqual(fake.peak_in_flight, 1)
        self.assertEqual(len(results), 3)

    async def test_generate_batch_honours_an_explicit_seed_on_the_first_variant_only(self):
        fake = SingleRunProvider()
        with _patch_provider(fake):
            results = await generate_batch(
                GenerationRequest(prompt="a cute corgi astronaut", model="schnell", size="square", seed=777),
                count=2,
                settings=_settings(),
            )

        self.assertEqual(results[0].seed, 777)
        self.assertNotEqual(results[1].seed, 777)


class BatchVariantRouteTests(unittest.TestCase):
    def setUp(self):
        _reset_nvidia_circuit()
        reset_rate_limiter()
        reset_usage_metrics()
        self.client = TestClient(app)

    def tearDown(self):
        _reset_nvidia_circuit()

    def test_generate_batch_route_returns_every_image_when_provider_admits_one_run(self):
        fake = SingleRunProvider()
        with patch("app.main.get_settings", return_value=_settings()), _patch_provider(fake):
            response = self.client.post(
                "/generate/batch",
                json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square", "count": 4},
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["images"]), 4)
        self.assertEqual(fake.peak_in_flight, 1)


if __name__ == "__main__":
    unittest.main()
