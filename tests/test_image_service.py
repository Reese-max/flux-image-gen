import unittest

from app.image_service import GenerationRequest, choose_provider, map_size, validate_prompt
from app.settings import Settings


class ImageServiceTests(unittest.IsolatedAsyncioTestCase):
    def test_map_size_supports_reference_ui_sizes(self):
        self.assertEqual(map_size("square"), (1024, 1024))
        self.assertEqual(map_size("landscape"), (1344, 768))
        self.assertEqual(map_size("portrait"), (768, 1344))
        self.assertEqual(map_size("ig_post"), (1024, 1024))
        self.assertEqual(map_size("ppt_16_9"), (1344, 768))
        self.assertEqual(map_size("ig_story"), (768, 1344))
        self.assertEqual(map_size("youtube_thumb"), (1344, 768))
        self.assertEqual(map_size("mobile_wallpaper"), (768, 1664))
        self.assertEqual(map_size("poster_3_4"), (960, 1280))
        self.assertEqual(map_size("a4_illustration"), (896, 1280))
        self.assertEqual(map_size("hero_21_9"), (1792, 768))
        self.assertEqual(map_size("custom", 1152, 1536), (1152, 1536))

    def test_map_size_validates_custom_dimensions(self):
        with self.assertRaisesRegex(ValueError, "自訂尺寸寬高必須"):
            map_size("custom", 1000, 1024)
        with self.assertRaisesRegex(ValueError, "自訂尺寸寬高必須"):
            map_size("custom", 1024, 2048)

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
        self.assertEqual(result.image_quality["mime"], "image/png")
        self.assertEqual(result.image_quality["width"], 1024)
        self.assertEqual(result.image_quality["height"], 1024)
        self.assertEqual(result.image_quality["issues"], [])

    def test_inspect_generated_image_flags_dimension_mismatch_without_leaking_image_data(self):
        from app.demo_image import make_demo_png_data_url
        from app.image_service import inspect_generated_image

        image = make_demo_png_data_url("tiny", 512, 512, "schnell")
        quality = inspect_generated_image(image, 1024, 1024)

        self.assertTrue(quality["checked"])
        self.assertEqual(quality["mime"], "image/png")
        self.assertEqual(quality["width"], 512)
        self.assertEqual(quality["height"], 512)
        self.assertIn("與要求 1024×1024 不一致", "；".join(quality["issues"]))
        self.assertNotIn("base64", str(quality))

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

    async def test_nvidia_provider_dev_payload_honours_per_request_tuning(self):
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
            )
        )
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            await provider.generate(
                GenerationRequest(
                    prompt="a cute corgi astronaut floating in space",
                    model="dev",
                    size="square",
                    seed=1,
                    steps=45,
                    cfg_scale=7.5,
                )
            )

        self.assertEqual(sent_payload["cfg_scale"], 7.5)
        self.assertEqual(sent_payload["steps"], 45)

    def test_validate_steps_and_cfg_scale_reject_out_of_range(self):
        from app.image_service import validate_cfg_scale, validate_steps

        self.assertIsNone(validate_steps(None))
        self.assertIsNone(validate_cfg_scale(None))
        self.assertEqual(validate_steps(50), 50)
        self.assertEqual(validate_steps(5), 5)
        self.assertEqual(validate_cfg_scale(1.5), 1.5)
        self.assertEqual(validate_cfg_scale(9), 9.0)
        # NVIDIA flux.1-dev 實測邊界：steps >= 5、cfg_scale > 1 且 <= 9。
        for bad in (0, 4, 51, True, 3.5, "30"):
            with self.assertRaises(ValueError):
                validate_steps(bad)
        for bad in (0.9, 1.0, 9.1, True, "5"):
            with self.assertRaises(ValueError):
                validate_cfg_scale(bad)

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

    def test_provider_error_message_redacts_secrets_and_stack_traces(self):
        from app.image_service import ProviderError, to_http_error

        payload, status = to_http_error(
            ProviderError(
                "NVIDIA failed Authorization: Bearer nvapi-secret-token sk-proj-secret\nTraceback (most recent call last)",
                status_code=500,
                code="nvidia_error",
            )
        )

        self.assertEqual(status, 500)
        self.assertEqual(payload["code"], "nvidia_error")
        self.assertEqual(payload["error"], "出圖服務回傳錯誤，請稍後再試")
        self.assertNotIn("nvapi-secret-token", payload["error"])
        self.assertNotIn("sk-proj-secret", payload["error"])
        self.assertNotIn("Traceback", payload["error"])

    def test_response_error_message_redacts_secret_tokens_without_hiding_status(self):
        import httpx

        from app.image_service import _response_error_message

        response = httpx.Response(500, text="upstream failed with Bearer nvapi-secret-token")
        message = _response_error_message(response)

        self.assertIn("Bearer [redacted]", message)
        self.assertNotIn("nvapi-secret-token", message)

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

    async def test_generate_image_falls_back_to_workers_ai_on_nvidia_5xx(self):
        from unittest.mock import AsyncMock, patch

        from app.image_service import (
            GenerationResult,
            NvidiaProvider,
            ProviderError,
            generate_image,
        )

        settings = Settings(
            nvidia_api_key="dummy-key",
            image_provider="nvidia",
            cf_account_id="acct",
            cf_api_token="tok",
        )
        fallback = GenerationResult(
            image="data:image/png;base64,AAAA",
            provider="workers-ai",
            model="schnell",
            width=1024,
            height=1024,
            seed=1,
        )
        with patch.object(
            NvidiaProvider,
            "generate",
            new=AsyncMock(side_effect=ProviderError("NVIDIA 產圖逾時", status_code=504, code="timeout")),
        ), patch("app.image_service.WorkersAiProvider") as workers_ai_cls:
            workers_ai_cls.return_value.generate = AsyncMock(return_value=fallback)
            result = await generate_image(
                GenerationRequest(prompt="a cat", model="schnell", size="square"),
                settings,
            )

        self.assertEqual(result.provider, "workers-ai")
        workers_ai_cls.return_value.generate.assert_awaited_once()

    async def test_generate_image_does_not_fall_back_on_nvidia_4xx(self):
        from unittest.mock import AsyncMock, patch

        from app.image_service import NvidiaProvider, ProviderError, generate_image

        settings = Settings(
            nvidia_api_key="dummy-key",
            image_provider="nvidia",
            cf_account_id="acct",
            cf_api_token="tok",
        )
        with patch.object(
            NvidiaProvider,
            "generate",
            new=AsyncMock(side_effect=ProviderError("內容過濾", status_code=422, code="content_filtered")),
        ), patch("app.image_service.WorkersAiProvider") as workers_ai_cls:
            workers_ai_cls.return_value.generate = AsyncMock()
            with self.assertRaises(ProviderError) as ctx:
                await generate_image(
                    GenerationRequest(prompt="a cat", model="schnell", size="square"),
                    settings,
                )

        self.assertEqual(ctx.exception.status_code, 422)
        workers_ai_cls.return_value.generate.assert_not_awaited()

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
    """The fast tier ("schnell") runs on flux.2-klein-4b via NVIDIA (flux.1-schnell
    went dark 2026-07), or Workers AI when configured. Demo mode is untouched."""

    def test_schnell_endpoint_maps_to_flux2_klein(self):
        from app.image_service import MODEL_ENDPOINTS

        self.assertEqual(MODEL_ENDPOINTS["schnell"], "black-forest-labs/flux.2-klein-4b")

    def test_schnell_with_nvidia_key_and_no_workers_ai_stays_on_nvidia_klein(self):
        from app.image_service import NvidiaProvider, _resolve_provider_and_request

        settings = Settings(nvidia_api_key="dummy-key", image_provider="nvidia", cf_account_id="", cf_api_token="")
        provider, request = _resolve_provider_and_request(
            GenerationRequest(prompt="a corgi", model="schnell", size="square"), settings
        )
        self.assertIsInstance(provider, NvidiaProvider)
        # No rewrite: schnell hits klein directly (see MODEL_ENDPOINTS).
        self.assertEqual(request.model, "schnell")

    def test_schnell_prefers_nvidia_over_workers_ai_when_key_exists(self):
        from app.image_service import NvidiaProvider, _resolve_provider_and_request

        settings = Settings(
            nvidia_api_key="dummy-key", image_provider="nvidia", cf_account_id="acct", cf_api_token="tok"
        )
        provider, request = _resolve_provider_and_request(
            GenerationRequest(prompt="a corgi", model="schnell", size="square"), settings
        )
        self.assertIsInstance(provider, NvidiaProvider)
        self.assertEqual(request.model, "schnell")

    def test_schnell_without_nvidia_falls_back_to_workers_ai(self):
        from app.image_service import WorkersAiProvider, _resolve_provider_and_request

        settings = Settings(nvidia_api_key="", image_provider="auto", cf_account_id="acct", cf_api_token="tok")
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

    async def test_generate_image_schnell_hits_klein_endpoint_via_nvidia(self):
        # End-to-end through generate_image (NVIDIA, no Workers AI): schnell must
        # POST to the flux.2-klein-4b endpoint and report provider/model as-is.
        import base64
        from unittest.mock import patch

        import httpx

        from app import image_service

        captured = {}
        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 60).decode("ascii")

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, json):
                captured["endpoint"] = endpoint
                return httpx.Response(200, json={"artifacts": [{"base64": png_b64}]})

        settings = Settings(nvidia_api_key="dummy-key", image_provider="nvidia", cf_account_id="", cf_api_token="")
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            result = await image_service.generate_image(
                GenerationRequest(prompt="a corgi", model="schnell", size="square"), settings
            )
        self.assertTrue(captured["endpoint"].endswith("black-forest-labs/flux.2-klein-4b"))
        self.assertEqual(result.provider, "nvidia")
        self.assertEqual(result.model, "schnell")


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
                GenerationRequest(prompt="a corgi", model="schnell", size="landscape", seed=7)
            )

        # Non-square sizes use FLUX.2 klein, which accepts width/height.
        self.assertEqual(
            captured["endpoint"],
            "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/black-forest-labs/flux-2-klein-4b",
        )
        self.assertEqual(captured["headers"]["Authorization"], "Bearer cf-tok")
        self.assertEqual(captured["json"], {"prompt": "a corgi", "width": 1344, "height": 768, "seed": 7})
        self.assertEqual(result.provider, "workers-ai")
        self.assertEqual(result.model, "schnell")
        self.assertEqual(result.seed, 7)
        self.assertTrue(result.image.startswith("data:image/png;base64,"))

    async def test_default_square_uses_flux_1_schnell(self):
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
                captured["json"] = json
                return httpx.Response(200, json={"result": {"image": image_b64}, "success": True})

        provider = WorkersAiProvider(self._settings())
        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            result = await provider.generate(
                GenerationRequest(prompt="a corgi", model="schnell", size="square", seed=7)
            )

        # The default 1024² preset runs on the cheaper FLUX.1 schnell JSON API,
        # which takes no custom dimensions (mirrors the Cloudflare Worker).
        self.assertEqual(
            captured["endpoint"],
            "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/black-forest-labs/flux-1-schnell",
        )
        self.assertEqual(captured["json"], {"prompt": "a corgi", "seed": 7, "steps": 4})
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


class EditImageTests(unittest.IsolatedAsyncioTestCase):
    """AI 改圖：Cloudflare Workers AI FLUX.2 klein multipart 編輯。live 呼叫需 CF
    token（未取得，故 mock httpx 鎖住請求 shape / resize / 回應解析 / 錯誤映射）。"""

    @staticmethod
    def _png(width: int, height: int) -> bytes:

        from io import BytesIO

        from PIL import Image

        buf = BytesIO()
        Image.new("RGB", (width, height), (10, 20, 200)).save(buf, format="PNG")
        return buf.getvalue()

    def _settings(self, **overrides):
        base = dict(cf_account_id="acct-1", cf_api_token="cf-tok")
        base.update(overrides)
        return Settings(**base)

    def test_validate_edit_images_rejects_out_of_range_and_empty_and_oversized(self):
        from app.image_service import MAX_EDIT_IMAGE_BYTES, validate_edit_images

        with self.assertRaises(ValueError):
            validate_edit_images(())
        with self.assertRaises(ValueError):
            validate_edit_images((b"x",) * 5)
        with self.assertRaises(ValueError):
            validate_edit_images((b"",))
        with self.assertRaises(ValueError):
            validate_edit_images((b"x" * (MAX_EDIT_IMAGE_BYTES + 1),))
        # 合法：1..4 張非空
        self.assertEqual(len(validate_edit_images((b"a", b"b"))), 2)

    def test_resize_for_edit_shrinks_below_512_and_rejects_garbage(self):
        from io import BytesIO

        from PIL import Image

        from app.image_service import _resize_for_edit

        out = _resize_for_edit(self._png(1600, 900))
        with Image.open(BytesIO(out)) as im:
            self.assertLess(max(im.size), 512)
        with self.assertRaises(ValueError):
            _resize_for_edit(b"not an image at all")

    async def test_edit_image_without_cf_token_raises_missing_api_key(self):
        from app.image_service import EditRequest, ProviderError, edit_image

        with self.assertRaises(ProviderError) as ctx:
            await edit_image(EditRequest(prompt="make it green", images=(self._png(64, 64),)), Settings())
        self.assertEqual(ctx.exception.code, "missing_api_key")
        self.assertEqual(ctx.exception.status_code, 503)

    async def test_edit_image_success_posts_multipart_and_parses_result(self):
        import base64
        from unittest.mock import patch

        import httpx

        from app.image_service import EditRequest, edit_image

        captured = {}
        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 60).decode("ascii")

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, data, files):
                captured["endpoint"] = endpoint
                captured["headers"] = headers
                captured["prompt"] = data["prompt"]
                captured["fields"] = sorted(files.keys())
                return httpx.Response(200, json={"result": {"image": png_b64}, "success": True})

        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            result = await edit_image(
                EditRequest(prompt="make it green", images=(self._png(800, 600), self._png(300, 300))),
                self._settings(),
            )

        self.assertTrue(captured["endpoint"].endswith("/ai/run/@cf/black-forest-labs/flux-2-klein-4b"))
        self.assertIn("acct-1", captured["endpoint"])
        self.assertEqual(captured["headers"]["Authorization"], "Bearer cf-tok")
        self.assertNotIn("Content-Type", captured["headers"])  # httpx 自帶 multipart boundary
        self.assertEqual(captured["fields"], ["input_image_0", "input_image_1"])
        self.assertEqual(captured["prompt"], "make it green")
        self.assertEqual(result.provider, "workers-ai")
        self.assertEqual(result.image_count, 2)
        self.assertTrue(result.image.startswith("data:image/png;base64,"))

    async def test_edit_image_error_status_maps_to_workers_ai_error(self):
        from unittest.mock import patch

        import httpx

        from app.image_service import EditRequest, ProviderError, edit_image

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, data, files):
                return httpx.Response(400, json={"errors": [{"message": "bad edit request"}]})

        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            with self.assertRaises(ProviderError) as ctx:
                await edit_image(EditRequest(prompt="x", images=(self._png(64, 64),)), self._settings())
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.code, "workers_ai_error")
        self.assertEqual(ctx.exception.message, "bad edit request")


class EditImageHardeningTests(unittest.IsolatedAsyncioTestCase):
    """審查後補強：resize 像素/bomb 防護、重試/逾時/429、resized bytes 保證 <512、
    以及 extract_image 的 provider label。"""

    @staticmethod
    def _png(width: int, height: int) -> bytes:
        from io import BytesIO

        from PIL import Image

        buf = BytesIO()
        Image.new("RGB", (width, height), (10, 20, 200)).save(buf, format="PNG")
        return buf.getvalue()

    def _settings(self, **overrides):
        base = dict(cf_account_id="acct-1", cf_api_token="cf-tok")
        base.update(overrides)
        return Settings(**base)

    def test_resize_rejects_images_over_pixel_cap(self):
        from unittest.mock import patch

        from app import image_service

        with patch.object(image_service, "EDIT_IMAGE_MAX_PIXELS", 100):
            with self.assertRaises(ValueError):
                image_service._resize_for_edit(self._png(64, 64))  # 4096 px > 100

    def test_resize_converts_decompression_bomb_to_valueerror_not_500(self):
        from unittest.mock import patch

        from PIL import Image

        from app.image_service import _resize_for_edit

        # 把 PIL 的 bomb 門檻壓到極低，讓 Image.open 對正常圖也拋 DecompressionBombError，
        # 驗證 _resize_for_edit 會收斂成 ValueError（上層才會回 400 而非 500）。
        with patch.object(Image, "MAX_IMAGE_PIXELS", 100):
            with self.assertRaises(ValueError):
                _resize_for_edit(self._png(64, 64))

    async def test_edit_image_retries_transient_5xx_then_succeeds(self):
        import base64
        from unittest.mock import AsyncMock, patch

        import httpx

        from app.image_service import EditRequest, edit_image

        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 60).decode("ascii")
        calls = {"n": 0}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, data, files):
                calls["n"] += 1
                if calls["n"] == 1:
                    return httpx.Response(503, json={"errors": [{"message": "overloaded"}]})
                return httpx.Response(200, json={"result": {"image": png_b64}})

        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            with patch("app.image_service.asyncio.sleep", new_callable=AsyncMock) as sleep_mock:
                result = await edit_image(
                    EditRequest(prompt="x", images=(self._png(64, 64),)), self._settings()
                )
        self.assertEqual(calls["n"], 2)
        self.assertEqual(sleep_mock.await_count, 1)
        self.assertEqual(result.provider, "workers-ai")

    async def test_edit_image_timeout_maps_to_504(self):
        from unittest.mock import AsyncMock, patch

        import httpx

        from app.image_service import EditRequest, ProviderError, edit_image

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, data, files):
                raise httpx.ReadTimeout("hang")

        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            with patch("app.image_service.asyncio.sleep", new_callable=AsyncMock):
                with self.assertRaises(ProviderError) as ctx:
                    await edit_image(EditRequest(prompt="x", images=(self._png(64, 64),)), self._settings())
        self.assertEqual(ctx.exception.status_code, 504)
        self.assertEqual(ctx.exception.code, "timeout")

    async def test_edit_image_429_keeps_retry_after(self):
        from unittest.mock import patch

        import httpx

        from app.image_service import EditRequest, ProviderError, edit_image

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, data, files):
                return httpx.Response(429, headers={"retry-after": "7"}, json={})

        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            with self.assertRaises(ProviderError) as ctx:
                await edit_image(EditRequest(prompt="x", images=(self._png(64, 64),)), self._settings())
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertEqual(ctx.exception.code, "rate_limited")
        self.assertEqual(ctx.exception.retry_after, 7)

    async def test_edit_image_uploads_resized_png_under_512(self):
        import base64
        from io import BytesIO
        from unittest.mock import patch

        import httpx
        from PIL import Image

        from app.image_service import EditRequest, edit_image

        captured = {}
        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 60).decode("ascii")

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, endpoint, headers, data, files):
                captured["files"] = files
                return httpx.Response(200, json={"result": {"image": png_b64}})

        with patch("app.image_service.httpx.AsyncClient", FakeAsyncClient):
            await edit_image(
                EditRequest(prompt="x", images=(self._png(1600, 900),)), self._settings()
            )
        # 綁定 multipart 輸出到 resize 步驟：實際上傳的 bytes 必須是 <512 的 PNG。
        filename, blob, content_type = captured["files"]["input_image_0"]
        self.assertEqual(content_type, "image/png")
        with Image.open(BytesIO(blob)) as im:
            self.assertEqual(im.format, "PNG")
            self.assertLess(max(im.size), 512)

    def test_extract_image_error_uses_provider_label(self):
        from app.image_service import ProviderError, extract_image

        with self.assertRaises(ProviderError) as ctx:
            extract_image({"result": None}, "Workers AI")
        self.assertIn("Workers AI", ctx.exception.message)
        self.assertNotIn("NVIDIA", ctx.exception.message)


if __name__ == "__main__":
    unittest.main()
