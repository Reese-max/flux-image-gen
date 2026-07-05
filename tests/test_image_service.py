import unittest

from app.image_service import GenerationRequest, choose_provider, map_size, validate_prompt
from app.settings import Settings


class ImageServiceTests(unittest.IsolatedAsyncioTestCase):
    def test_map_size_supports_reference_ui_sizes(self):
        self.assertEqual(map_size("square"), (1024, 1024))
        self.assertEqual(map_size("landscape"), (1344, 768))
        self.assertEqual(map_size("portrait"), (768, 1344))

    def test_validate_prompt_rejects_blank_prompt(self):
        with self.assertRaisesRegex(ValueError, "請先輸入描述文字"):
            validate_prompt("   ")

    def test_validate_seed_accepts_none_zero_and_positive_integer(self):
        from app.image_service import validate_seed

        valid_seeds = [None, 0, 2147483647, 12345]
        for seed in valid_seeds:
            with self.subTest(seed=seed):
                self.assertEqual(validate_seed(seed), seed)

    def test_validate_seed_rejects_invalid_values(self):
        from app.image_service import validate_seed

        invalid_seeds = [True, False, "123", "1.5", 1.0, 1.5, 2147483648, -1]
        for seed in invalid_seeds:
            with self.subTest(seed=seed):
                with self.assertRaisesRegex(ValueError, "seed 必須是 0 到 2147483647 之間的整數"):
                    validate_seed(seed)

    def test_resolve_seed_uses_request_seed_or_model_default(self):
        from app.image_service import resolve_seed

        settings = Settings(nvidia_schnell_seed=111, nvidia_dev_seed=222)
        self.assertEqual(resolve_seed(12345, "schnell", settings), 12345)
        self.assertEqual(resolve_seed(None, "schnell", settings), 111)
        self.assertEqual(resolve_seed(None, "dev", settings), 222)

    def test_resolve_seed_rejects_unknown_model(self):
        from app.image_service import resolve_seed

        with self.assertRaisesRegex(ValueError, "不支援的模型"):
            resolve_seed(None, "unknown", Settings())

    async def test_demo_provider_returns_png_data_url_without_key(self):
        provider = choose_provider(Settings(nvidia_api_key="", image_provider="auto"))
        result = await provider.generate(
            GenerationRequest(
                prompt="a cute corgi astronaut floating in space",
                model="schnell",
                size="square",
            )
        )
        self.assertTrue(result.image.startswith("data:image/png;base64,"))
        self.assertEqual(result.provider, "demo")
        self.assertEqual(result.width, 1024)
        self.assertEqual(result.height, 1024)

    async def test_nvidia_provider_payload_uses_request_seed(self):
        import base64
        from unittest.mock import patch

        import httpx

        from app.image_service import NvidiaProvider

        sent_payload = {}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                nonlocal sent_payload
                sent_payload = json
                png_base64 = base64.b64encode(b"\x89PNG\r\n\x1a\nnot-a-real-full-png").decode("ascii")
                return httpx.Response(200, json={"artifacts": [{"base64": png_base64}]})

        provider = NvidiaProvider(Settings(nvidia_api_key="dummy-key", image_provider="nvidia", nvidia_schnell_seed=111))
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            result = await provider.generate(
                GenerationRequest(
                    prompt="a cute corgi astronaut floating in space",
                    model="schnell",
                    size="square",
                    seed=12345,
                )
            )

        self.assertEqual(sent_payload["seed"], 12345)
        self.assertEqual(result.seed, 12345)

    async def test_nvidia_provider_schnell_payload_has_exact_public_keys(self):
        import base64
        from unittest.mock import patch

        import httpx

        from app.image_service import NvidiaProvider

        sent_payload = {}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                nonlocal sent_payload
                sent_payload = json
                png_base64 = base64.b64encode(b"\x89PNG\r\n\x1a\nnot-a-real-full-png").decode("ascii")
                return httpx.Response(200, json={"artifacts": [{"base64": png_base64}]})

        provider = NvidiaProvider(Settings(nvidia_api_key="dummy-key", image_provider="nvidia", nvidia_schnell_seed=111))
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            await provider.generate(
                GenerationRequest(
                    prompt="a cute corgi astronaut floating in space",
                    model="schnell",
                    size="square",
                    seed=12345,
                )
            )

        self.assertEqual(set(sent_payload), {"prompt", "width", "height", "seed"})
        self.assertEqual(sent_payload["seed"], 12345)
        self.assertNotIn("api_key", sent_payload)
        self.assertNotIn("Authorization", sent_payload)

    async def test_nvidia_provider_dev_payload_includes_cfg_steps_and_seed(self):
        import base64
        from unittest.mock import patch

        import httpx

        from app.image_service import NvidiaProvider

        sent_payload = {}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                nonlocal sent_payload
                sent_payload = json
                png_base64 = base64.b64encode(b"\x89PNG\r\n\x1a\nnot-a-real-full-png").decode("ascii")
                return httpx.Response(200, json={"artifacts": [{"base64": png_base64}]})

        provider = NvidiaProvider(
            Settings(
                nvidia_api_key="dummy-key",
                image_provider="nvidia",
                nvidia_dev_cfg_scale=3.5,
                nvidia_dev_steps=28,
                nvidia_dev_seed=222,
            )
        )
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            await provider.generate(
                GenerationRequest(
                    prompt="a cute corgi astronaut floating in space",
                    model="dev",
                    size="square",
                    seed=12345,
                )
            )

        self.assertEqual(sent_payload["seed"], 12345)
        self.assertEqual(sent_payload["cfg_scale"], 3.5)
        self.assertEqual(sent_payload["steps"], 28)

    async def test_nvidia_provider_rejects_non_json_success_response(self):
        from unittest.mock import patch

        import httpx

        from app.image_service import NvidiaProvider, ProviderError

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                return httpx.Response(200, text="not-json")

        provider = NvidiaProvider(Settings(nvidia_api_key="dummy-key", image_provider="nvidia"))
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            with self.assertRaises(ProviderError) as context:
                await provider.generate(
                    GenerationRequest(
                        prompt="a cute corgi astronaut floating in space",
                        model="schnell",
                        size="square",
                    )
                )

        self.assertEqual(context.exception.message, "NVIDIA 回應不是有效 JSON")
        self.assertEqual(context.exception.status_code, 502)
        self.assertEqual(context.exception.code, "bad_provider_response")

    async def test_rate_limit_error_keeps_retry_after(self):
        from app.image_service import ProviderError, to_http_error

        err = ProviderError("叫用太頻繁", status_code=429, code="rate_limited", retry_after=17)
        payload, status = to_http_error(err)
        self.assertEqual(status, 429)
        self.assertEqual(payload["code"], "rate_limited")
        self.assertEqual(payload["retry_after"], 17)

    async def test_nvidia_provider_retries_transient_failure_then_succeeds(self):
        import base64
        from unittest.mock import AsyncMock, patch

        import httpx

        from app.image_service import NvidiaProvider

        calls = {"count": 0}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                calls["count"] += 1
                if calls["count"] == 1:
                    return httpx.Response(503, text="service unavailable")
                png_base64 = base64.b64encode(b"\x89PNG\r\n\x1a\nnot-a-real-full-png").decode("ascii")
                return httpx.Response(200, json={"artifacts": [{"base64": png_base64}]})

        provider = NvidiaProvider(Settings(nvidia_api_key="dummy-key", image_provider="nvidia"))
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient), patch(
            "app.image_service.asyncio.sleep", new=AsyncMock()
        ) as sleep_mock:
            result = await provider.generate(
                GenerationRequest(prompt="a corgi in space", model="schnell", size="square")
            )

        self.assertEqual(calls["count"], 2)
        self.assertEqual(sleep_mock.await_count, 1)
        self.assertTrue(result.image.startswith("data:image/png;base64,"))

    async def test_nvidia_provider_exhausts_retries_and_raises(self):
        from unittest.mock import AsyncMock, patch

        import httpx

        from app.image_service import IMAGE_MAX_ATTEMPTS, NvidiaProvider, ProviderError

        calls = {"count": 0}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                calls["count"] += 1
                raise httpx.ConnectError("connection refused")

        provider = NvidiaProvider(Settings(nvidia_api_key="dummy-key", image_provider="nvidia"))
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient), patch(
            "app.image_service.asyncio.sleep", new=AsyncMock()
        ):
            with self.assertRaises(ProviderError) as context:
                await provider.generate(
                    GenerationRequest(prompt="a corgi in space", model="schnell", size="square")
                )

        self.assertEqual(calls["count"], IMAGE_MAX_ATTEMPTS)
        self.assertEqual(context.exception.status_code, 502)
        self.assertEqual(context.exception.code, "network_error")

    async def test_generate_batch_returns_count_variations_with_demo_provider(self):
        from app.image_service import generate_batch

        settings = Settings(nvidia_api_key="", image_provider="demo")
        results = await generate_batch(
            GenerationRequest(prompt="a corgi in space", model="schnell", size="square", seed=999),
            count=3,
            settings=settings,
        )

        self.assertEqual(len(results), 3)
        for result in results:
            self.assertTrue(result.image.startswith("data:image/png;base64,"))
            self.assertEqual(result.provider, "demo")
        # First variation honours the explicit seed; the rest are fresh randoms.
        self.assertEqual(results[0].seed, 999)

    def test_validate_batch_count_rejects_out_of_range_values(self):
        from app.image_service import validate_batch_count

        for count in [0, 5, -1, True, "2", 1.5]:
            with self.subTest(count=count):
                with self.assertRaisesRegex(ValueError, "count 必須是 1 到 4 之間的整數"):
                    validate_batch_count(count)

    def test_extract_image_detects_jpeg_base64_from_provider(self):
        import base64

        from app.image_service import extract_image

        jpeg_base64 = base64.b64encode(b"\xff\xd8\xff\xe0not-a-real-full-jpeg").decode("ascii")
        image = extract_image({"artifacts": [{"base64": jpeg_base64}]})
        self.assertTrue(image.startswith("data:image/jpeg;base64,"))


class FastTierRoutingTests(unittest.IsolatedAsyncioTestCase):
    """schnell must never hit NVIDIA's dark flux.1-schnell endpoint (2026-07
    outage). It routes to Workers AI when configured, else auto-falls back to
    NVIDIA dev; demo mode is untouched."""

    def test_schnell_with_nvidia_key_and_no_workers_ai_falls_back_to_dev(self):
        from app.image_service import NvidiaProvider, _resolve_provider_and_request

        settings = Settings(nvidia_api_key="dummy-key", image_provider="nvidia", cf_account_id="", cf_api_token="")
        provider, request = _resolve_provider_and_request(
            GenerationRequest(prompt="a corgi", model="schnell", size="square"), settings
        )
        self.assertIsInstance(provider, NvidiaProvider)
        self.assertEqual(request.model, "dev")

    def test_schnell_with_workers_ai_configured_uses_workers_ai(self):
        from app.image_service import WorkersAiProvider, _resolve_provider_and_request

        settings = Settings(
            nvidia_api_key="dummy-key", image_provider="nvidia", cf_account_id="acct", cf_api_token="tok"
        )
        provider, request = _resolve_provider_and_request(
            GenerationRequest(prompt="a corgi", model="schnell", size="square"), settings
        )
        self.assertIsInstance(provider, WorkersAiProvider)
        self.assertEqual(request.model, "schnell")

    def test_schnell_in_demo_mode_is_left_untouched(self):
        from app.image_service import DemoProvider, _resolve_provider_and_request

        settings = Settings(nvidia_api_key="", image_provider="auto", cf_account_id="", cf_api_token="")
        provider, request = _resolve_provider_and_request(
            GenerationRequest(prompt="a corgi", model="schnell", size="square"), settings
        )
        self.assertIsInstance(provider, DemoProvider)
        self.assertEqual(request.model, "schnell")

    def test_dev_is_never_rerouted(self):
        from app.image_service import NvidiaProvider, _resolve_provider_and_request

        settings = Settings(nvidia_api_key="dummy-key", image_provider="nvidia")
        provider, request = _resolve_provider_and_request(
            GenerationRequest(prompt="a corgi", model="dev", size="square"), settings
        )
        self.assertIsInstance(provider, NvidiaProvider)
        self.assertEqual(request.model, "dev")

    async def test_generate_image_schnell_fallback_reports_dev_model(self):
        # End-to-end through generate_image with a demo NVIDIA response: the
        # result must reflect dev (what actually ran), not the requested schnell.
        from unittest.mock import patch

        from app import image_service

        async def fake_generate(self, request):  # noqa: ANN001
            width, height = image_service.map_size(request.size)
            return image_service.GenerationResult(
                image="data:image/png;base64,AAAA",
                provider="nvidia",
                model=request.model,
                width=width,
                height=height,
                seed=request.seed or 0,
            )

        settings = Settings(nvidia_api_key="dummy-key", image_provider="nvidia", cf_account_id="", cf_api_token="")
        with patch.object(image_service.NvidiaProvider, "generate", fake_generate):
            result = await image_service.generate_image(
                GenerationRequest(prompt="a corgi", model="schnell", size="square"), settings
            )
        self.assertEqual(result.provider, "nvidia")
        self.assertEqual(result.model, "dev")


class WorkersAiProviderTests(unittest.IsolatedAsyncioTestCase):
    """Unit coverage for the Cloudflare Workers AI fast-tier backend. The live
    REST round-trip is unverified pending a token, so these mock httpx and lock
    the request shape, endpoint, response parsing, and error mapping."""

    @staticmethod
    def _long_base64() -> str:
        import base64

        # >80 chars so _looks_like_image_string accepts it via the "image" key.
        return base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 60).decode("ascii")

    def _settings(self, **overrides):
        base = dict(
            nvidia_api_key="dummy-key",
            image_provider="nvidia",
            cf_account_id="acct-123",
            cf_api_token="cf-tok",
        )
        base.update(overrides)
        return Settings(**base)

    async def test_success_calls_rest_endpoint_and_parses_result_image(self):
        from unittest.mock import patch

        import httpx

        from app.image_service import WorkersAiProvider

        captured = {}
        image_b64 = self._long_base64()

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                captured["endpoint"] = endpoint
                captured["headers"] = headers
                captured["json"] = json
                return httpx.Response(200, json={"result": {"image": image_b64}, "success": True})

        provider = WorkersAiProvider(self._settings())
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            result = await provider.generate(
                GenerationRequest(prompt="a corgi", model="schnell", size="square", seed=7)
            )

        self.assertEqual(
            captured["endpoint"],
            "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/black-forest-labs/flux-2-klein-4b",
        )
        self.assertEqual(captured["headers"]["Authorization"], "Bearer cf-tok")
        self.assertEqual(captured["json"], {"prompt": "a corgi", "width": 1024, "height": 1024, "seed": 7})
        self.assertEqual(result.provider, "workers-ai")
        self.assertEqual(result.model, "schnell")
        self.assertEqual(result.seed, 7)
        self.assertTrue(result.image.startswith("data:image/png;base64,"))

    async def test_missing_config_raises_missing_api_key(self):
        from app.image_service import ProviderError, WorkersAiProvider

        provider = WorkersAiProvider(self._settings(cf_api_token=""))
        with self.assertRaises(ProviderError) as ctx:
            await provider.generate(GenerationRequest(prompt="a corgi", model="schnell", size="square"))
        self.assertEqual(ctx.exception.code, "missing_api_key")

    async def test_seed_zero_becomes_random_and_is_returned(self):
        from unittest.mock import patch

        import httpx

        from app.image_service import WorkersAiProvider

        captured = {}
        image_b64 = self._long_base64()

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                captured["json"] = json
                return httpx.Response(200, json={"result": {"image": image_b64}})

        provider = WorkersAiProvider(self._settings())
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            result = await provider.generate(
                GenerationRequest(prompt="a corgi", model="schnell", size="square", seed=0)
            )

        self.assertNotEqual(captured["json"]["seed"], 0)
        self.assertEqual(result.seed, captured["json"]["seed"])

    async def test_error_status_maps_to_workers_ai_error(self):
        from unittest.mock import patch

        import httpx

        from app.image_service import ProviderError, WorkersAiProvider

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                return httpx.Response(400, json={"errors": [{"message": "bad request"}]})

        provider = WorkersAiProvider(self._settings())
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            with self.assertRaises(ProviderError) as ctx:
                await provider.generate(
                    GenerationRequest(prompt="a corgi", model="schnell", size="square", seed=1)
                )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.code, "workers_ai_error")
        # CF errors[].message is surfaced; label must not read "NVIDIA".
        self.assertEqual(ctx.exception.message, "bad request")


if __name__ == "__main__":
    unittest.main()
