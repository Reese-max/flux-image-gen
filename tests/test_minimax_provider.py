import base64
import unittest
from unittest.mock import patch

import httpx

from app.image_service import (
    GenerationRequest,
    MiniMaxProvider,
    ProviderError,
    generate_image,
    minimax_dimensions,
)
from app.settings import Settings

# Distinctive fake key; asserted absent from every error surface.
FAKE_KEY = "minimax-test-key-DO-NOT-LEAK"
MINIMAX_URL = "https://api.minimax.io/v1/image_generation"

# Minimal JPEG header bytes (SOI + APP0) — enough for the signature sniff.
JPEG_B64 = base64.b64encode(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + b"\x00" * 128).decode("ascii")
PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 120).decode("ascii")


def _minimax_ok(**overrides):
    payload = {
        "id": "img-test",
        "base_resp": {"status_code": 0, "status_msg": "success"},
        "data": {"image_base64": [JPEG_B64]},
        "metadata": {},
    }
    payload.update(overrides)
    return httpx.Response(200, json=payload)


def _client(responder):
    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None, data=None, files=None):
            return responder(url, headers or {}, json if json is not None else data)

    return FakeAsyncClient


class MiniMaxProviderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from app.image_service import _reset_nvidia_circuit

        _reset_nvidia_circuit()

    def test_minimax_dimensions_maps_request_sizes(self):
        self.assertEqual(minimax_dimensions(1024, 1024), (1024, 1024))
        self.assertEqual(minimax_dimensions(1344, 768), (1344, 768))
        self.assertEqual(minimax_dimensions(768, 1344), (768, 1344))
        self.assertEqual(minimax_dimensions(256, 384), (512, 768))
        self.assertEqual(minimax_dimensions(1920, 256), (2048, 512))
        for w, h in [(w, h) for w in (256, 640, 960, 1344, 1792) for h in (256, 512, 768, 1280, 1664)]:
            mw, mh = minimax_dimensions(w, h)
            for side in (mw, mh):
                self.assertGreaterEqual(side, 512)
                self.assertLessEqual(side, 2048)
                self.assertEqual(side % 8, 0)

    async def test_minimax_success_returns_base64_jpeg_and_reports_sent_dims(self):
        sent = {}

        def responder(url, headers, json):
            sent["url"] = url
            sent["headers"] = headers
            sent["json"] = json
            return _minimax_ok()

        provider = MiniMaxProvider(Settings(minimax_api_key=FAKE_KEY))
        with patch("app.image_service.httpx.AsyncClient", _client(responder)):
            result = await provider.generate(
                GenerationRequest(prompt="a cute corgi", model="schnell", size="square", seed=0)
            )

        self.assertEqual(sent["url"], MINIMAX_URL)
        self.assertEqual(sent["headers"]["Authorization"], f"Bearer {FAKE_KEY}")
        self.assertEqual(sent["json"]["model"], "image-01")
        self.assertEqual(sent["json"]["prompt"], "a cute corgi")
        self.assertEqual(sent["json"]["response_format"], "base64")
        self.assertEqual(sent["json"]["n"], 1)
        self.assertEqual((sent["json"]["width"], sent["json"]["height"]), (1024, 1024))
        self.assertTrue(result.image.startswith("data:image/jpeg;base64,"))
        self.assertEqual(result.provider, "minimax")
        self.assertEqual((result.width, result.height), (1024, 1024))
        self.assertEqual(result.provider_provenance, {"model_id": "image-01", "steps": None, "cfg_scale": None})

    async def test_minimax_dimension_mapping_landscape_and_small_custom(self):
        sent = {}

        def responder(url, headers, json):
            sent.update(json)
            return _minimax_ok()

        provider = MiniMaxProvider(Settings(minimax_api_key=FAKE_KEY))
        with patch("app.image_service.httpx.AsyncClient", _client(responder)):
            result = await provider.generate(GenerationRequest(prompt="x", model="dev", size="landscape"))
        self.assertEqual((sent["width"], sent["height"]), (1344, 768))
        self.assertEqual((result.width, result.height), (1344, 768))

        with patch("app.image_service.httpx.AsyncClient", _client(responder)):
            result = await provider.generate(
                GenerationRequest(prompt="x", model="dev", size="custom", width=256, height=384)
            )
        self.assertEqual((sent["width"], sent["height"]), (512, 768))
        self.assertEqual((result.width, result.height), (512, 768))

    async def test_minimax_seed_is_passed_through_only_when_set(self):
        sent = {}

        def responder(url, headers, json):
            sent.update(json)
            return _minimax_ok()

        provider = MiniMaxProvider(Settings(minimax_api_key=FAKE_KEY))
        with patch("app.image_service.httpx.AsyncClient", _client(responder)):
            result = await provider.generate(
                GenerationRequest(prompt="x", model="schnell", size="square", seed=12345)
            )
        self.assertEqual(sent["seed"], 12345)
        self.assertEqual(result.seed, 12345)

        sent.clear()
        with patch("app.image_service.httpx.AsyncClient", _client(responder)):
            await provider.generate(GenerationRequest(prompt="x", model="schnell", size="square", seed=0))
        self.assertNotIn("seed", sent)

    async def test_minimax_error_mapping(self):
        cases = [
            # (http_status, json_body, expected_status, expected_code)
            (200, {"base_resp": {"status_code": 1002}}, 429, "rate_limited"),
            (429, None, 429, "rate_limited"),
            (200, {"base_resp": {"status_code": 1026}}, 422, "content_filtered"),
            (200, {"base_resp": {"status_code": 1027}}, 422, "content_filtered"),
            (200, {"base_resp": {"status_code": 1004}}, 502, "provider_auth_failed"),
            (200, {"base_resp": {"status_code": 2049}}, 502, "provider_auth_failed"),
            (200, {"base_resp": {"status_code": 9999}}, 502, "minimax_error"),
            (500, None, 502, "minimax_error"),
            (503, {"base_resp": {"status_code": 0}}, 502, "minimax_error"),
            (200, "not-json", 502, "bad_provider_response"),
            (200, {"base_resp": {"status_code": 0}, "data": {"image_base64": ["aGVsbG8gd29ybGQ="]}}, 502, "bad_provider_response"),
            (200, {"base_resp": {"status_code": 0}}, 502, "bad_provider_response"),
            (200, {"base_resp": {"status_code": 0}, "data": {}}, 502, "bad_provider_response"),
            (200, {"base_resp": {"status_code": 0}, "image_base64": [JPEG_B64]}, 502, "bad_provider_response"),
        ]
        for http_status, body, expected_status, expected_code in cases:
            with self.subTest(http_status=http_status, body=body):
                if isinstance(body, str):
                    response = httpx.Response(http_status, text=body)
                elif body is None:
                    response = httpx.Response(http_status)
                else:
                    response = httpx.Response(http_status, json=body)

                provider = MiniMaxProvider(Settings(minimax_api_key=FAKE_KEY))
                with patch("app.image_service.httpx.AsyncClient", _client(lambda *a: response)):
                    with self.assertRaises(ProviderError) as ctx:
                        await provider.generate(GenerationRequest(prompt="x", model="schnell", size="square"))
                self.assertEqual(ctx.exception.status_code, expected_status)
                self.assertEqual(ctx.exception.code, expected_code)
                self.assertNotIn(FAKE_KEY, ctx.exception.message)

    async def test_minimax_timeout_and_network_errors_map_to_minimax_error(self):
        for exc in (httpx.TimeoutException("boom"), httpx.ConnectError("nope")):
            with self.subTest(exc=type(exc).__name__):
                def responder(url, headers, json):
                    raise exc

                provider = MiniMaxProvider(Settings(minimax_api_key=FAKE_KEY))
                with patch("app.image_service.httpx.AsyncClient", _client(responder)):
                    with self.assertRaises(ProviderError) as ctx:
                        await provider.generate(GenerationRequest(prompt="x", model="schnell", size="square"))
                self.assertEqual(ctx.exception.status_code, 502)
                self.assertEqual(ctx.exception.code, "minimax_error")

    async def test_nvidia_infra_failure_falls_back_to_minimax(self):
        calls = []

        def responder(url, headers, json):
            calls.append(url)
            if "minimax" in url:
                return _minimax_ok()
            return httpx.Response(500, json={"error": "nvidia down"})

        settings = Settings(nvidia_api_key="nvapi-fake", minimax_api_key=FAKE_KEY)
        with patch("app.image_service.httpx.AsyncClient", _client(responder)):
            result = await generate_image(GenerationRequest(prompt="x", model="dev", size="square"), settings)
        self.assertEqual(result.provider, "minimax")
        self.assertTrue(any("minimax" in url for url in calls))

    async def test_minimax_infra_failure_falls_back_to_workers_ai(self):
        def responder(url, headers, json):
            if "minimax" in url:
                return httpx.Response(500, json={"base_resp": {"status_code": -1}})
            return httpx.Response(200, json={"result": {"image": PNG_B64}, "success": True})

        settings = Settings(
            nvidia_api_key="",
            minimax_api_key=FAKE_KEY,
            cf_account_id="cf-acct",
            cf_api_token="cf-token",
        )
        with patch("app.image_service.httpx.AsyncClient", _client(responder)):
            result = await generate_image(GenerationRequest(prompt="x", model="schnell", size="square"), settings)
        self.assertEqual(result.provider, "workers-ai")

    async def test_minimax_rate_limit_and_content_filter_do_not_fall_back(self):
        for code in (1002, 1026):
            with self.subTest(code=code):
                calls = []

                def responder(url, headers, json):
                    calls.append(url)
                    return httpx.Response(200, json={"base_resp": {"status_code": code}})

                settings = Settings(nvidia_api_key="", minimax_api_key=FAKE_KEY, cf_account_id="a", cf_api_token="t")
                with patch("app.image_service.httpx.AsyncClient", _client(responder)):
                    with self.assertRaises(ProviderError):
                        await generate_image(GenerationRequest(prompt="x", model="schnell", size="square"), settings)
                self.assertEqual(len(calls), 1)
                self.assertIn("minimax", calls[0])

    def test_choose_provider_auto_prefers_nvidia_then_minimax_then_demo(self):
        from app.image_service import DemoProvider, NvidiaProvider, choose_provider

        self.assertIsInstance(choose_provider(Settings(nvidia_api_key="k", minimax_api_key="m")), NvidiaProvider)
        self.assertIsInstance(choose_provider(Settings(nvidia_api_key="", minimax_api_key="m")), MiniMaxProvider)
        self.assertIsInstance(choose_provider(Settings(nvidia_api_key="", minimax_api_key="")), DemoProvider)
        self.assertIsInstance(choose_provider(Settings(image_provider="minimax", minimax_api_key="m")), MiniMaxProvider)


if __name__ == "__main__":
    unittest.main()
