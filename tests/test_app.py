import unittest
from unittest.mock import AsyncMock, patch

from app.image_service import GenerationResult
from app.image_service import ProviderError
from app.main import app
from app.prompt_complete import PromptCompleteResult
from app.prompt_enhance import PromptEnhanceResult
from app.rate_limit import RateLimitDecision, reset_rate_limiter
from app.settings import Settings
from app.usage_metrics import reset_usage_metrics
from fastapi.testclient import TestClient


class AppRouteTests(unittest.TestCase):
    def setUp(self):
        reset_rate_limiter()
        reset_usage_metrics()
        self.client = TestClient(app)

    def _generation_result(self, seed=111):
        return GenerationResult(
            image="data:image/png;base64,ZmFrZQ==",
            provider="demo",
            model="schnell",
            width=1024,
            height=1024,
            seed=seed,
            image_quality={
                "checked": True,
                "mime": "image/png",
                "width": 1024,
                "height": 1024,
                "issues": [],
                "visualQualityScore": 100,
            },
        )

    def test_health_reports_ok(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_index_serves_html(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers["content-type"])
        self.assertIn("Fluxi 中文 AI 圖片產生器", response.text)

    def test_manifest_route_serves_webmanifest(self):
        response = self.client.get("/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertIn("application/manifest+json", response.headers["content-type"])
        self.assertIn("Fluxi 中文 AI 圖片產生器", response.text)

    def test_service_worker_route_serves_js_with_scope_header(self):
        response = self.client.get("/service-worker.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("javascript", response.headers["content-type"])
        self.assertEqual(response.headers.get("service-worker-allowed"), "/")

    def test_generate_returns_reference_shape(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            mocked_generate.return_value = self._generation_result()
            response = self.client.post(
                "/generate",
                json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square"},
            )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["image"].startswith("data:image/png;base64,"))
        self.assertEqual(data["provider"], "demo")
        self.assertEqual(data["width"], 1024)
        self.assertEqual(data["height"], 1024)
        self.assertEqual(data["imageQuality"]["visualQualityScore"], 100)
        mocked_generate.assert_awaited_once()

    def test_generate_can_attach_optional_vision_qa_without_blocking_generation(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate, patch(
            "app.main.maybe_run_vision_qa",
            return_value={
                "provider": "gemini",
                "available": True,
                "promptMatchScore": 91,
                "compositionScore": 88,
                "visualQualityScore": 86,
                "detectedIssues": [],
                "recommendation": "keep",
                "reason": "符合提示詞",
            },
        ) as mocked_vision:
            mocked_generate.return_value = self._generation_result()
            response = self.client.post(
                "/generate",
                json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square", "visionQa": True},
            )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["visionQa"]["provider"], "gemini")
        self.assertEqual(data["visionQa"]["promptMatchScore"], 91)
        mocked_vision.assert_called_once()

    def test_generate_accepts_custom_dimensions(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            mocked_generate.return_value = GenerationResult(
                image="data:image/png;base64,ZmFrZQ==",
                provider="demo",
                model="schnell",
                width=1152,
                height=1536,
                seed=123,
            )
            response = self.client.post(
                "/generate",
                json={
                    "prompt": "a custom poster",
                    "model": "schnell",
                    "size": "custom",
                    "width": 1152,
                    "height": 1536,
                },
            )
        self.assertEqual(response.status_code, 200)
        request = mocked_generate.await_args.args[0]
        self.assertEqual(request.size, "custom")
        self.assertEqual(request.width, 1152)
        self.assertEqual(request.height, 1536)

    def test_usage_dashboard_summarizes_generation_without_prompt_or_raw_ip(self):
        settings = Settings(usage_logging_enabled=False, usage_alert_daily_generations=1)
        with patch("app.main.get_settings", return_value=settings), patch(
            "app.main.generate_image", new_callable=AsyncMock
        ) as mocked_generate:
            mocked_generate.return_value = GenerationResult(
                image="data:image/png;base64,ZmFrZQ==",
                provider="nvidia",
                model="schnell",
                width=1024,
                height=1024,
                seed=111,
            )
            generated = self.client.post(
                "/generate",
                json={
                    "prompt": "secret provider prompt",
                    "userPrompt": "秘密中文描述",
                    "model": "schnell",
                    "size": "square",
                },
                headers={"cf-connecting-ip": "203.0.113.77"},
            )
            usage = self.client.get("/api/usage")

        self.assertEqual(generated.status_code, 200)
        self.assertEqual(usage.status_code, 200)
        body = usage.json()
        self.assertEqual(body["generatedImages"], 1)
        self.assertEqual(body["failedRequests"], 0)
        self.assertEqual(body["byModel"]["schnell"]["images"], 1)
        self.assertEqual(body["byProvider"]["nvidia"]["requests"], 1)
        self.assertEqual(body["byRoute"]["generate"]["successes"], 1)
        self.assertEqual(body["alerts"][0]["code"], "daily_generation_threshold")
        serialized = str(body)
        self.assertNotIn("secret provider prompt", serialized)
        self.assertNotIn("秘密中文描述", serialized)
        self.assertNotIn("203.0.113.77", serialized)

    def test_usage_dashboard_records_safe_failure_code(self):
        settings = Settings(usage_logging_enabled=False)
        with patch("app.main.get_settings", return_value=settings), patch(
            "app.main.generate_image", new_callable=AsyncMock
        ) as mocked_generate:
            mocked_generate.side_effect = ProviderError(
                "provider failed with Bearer secret-key",
                status_code=500,
                code="nvidia_error",
            )
            response = self.client.post(
                "/generate",
                json={"prompt": "a product photo", "model": "schnell", "size": "square"},
            )
            usage = self.client.get("/api/usage")

        self.assertEqual(response.status_code, 500)
        body = usage.json()
        self.assertEqual(body["generatedImages"], 0)
        self.assertEqual(body["failedRequests"], 1)
        self.assertEqual(body["byErrorCode"]["nvidia_error"], 1)
        self.assertNotIn("secret-key", str(body))

    def test_usage_dashboard_validates_date(self):
        response = self.client.get("/api/usage?date=not-a-date")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")

    def test_generate_accepts_seed_and_returns_it(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            mocked_generate.return_value = self._generation_result(seed=12345)
            response = self.client.post(
                "/generate",
                json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square", "seed": 12345},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["seed"], 12345)
        request = mocked_generate.await_args.args[0]
        self.assertEqual(request.seed, 12345)

    def test_generate_forwards_dev_tuning_to_the_provider(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            mocked_generate.return_value = self._generation_result()
            response = self.client.post(
                "/generate",
                json={
                    "prompt": "a cute corgi astronaut",
                    "model": "dev",
                    "size": "square",
                    "steps": 45,
                    "cfgScale": 7.5,
                },
            )
        self.assertEqual(response.status_code, 200)
        request = mocked_generate.await_args.args[0]
        self.assertEqual(request.steps, 45)
        self.assertEqual(request.cfg_scale, 7.5)

    def test_generate_rejects_invalid_seed(self):
        invalid_seeds = [True, "123", 1.5, 2147483648, -1]
        for seed in invalid_seeds:
            with self.subTest(seed=seed):
                with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
                    response = self.client.post(
                        "/generate",
                        json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square", "seed": seed},
                    )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "bad_request")
                self.assertIn("seed 必須是 0 到 2147483647 之間的整數", response.json()["error"])
                mocked_generate.assert_not_called()

    def test_generate_rejects_boolean_seed(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            response = self.client.post(
                "/generate",
                json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square", "seed": True},
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")
        self.assertIn("seed 必須是 0 到 2147483647 之間的整數", response.json()["error"])
        mocked_generate.assert_not_called()

    def test_generate_rejects_blank_prompt(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            mocked_generate.side_effect = ValueError("請先輸入描述文字")
            response = self.client.post("/generate", json={"prompt": "   ", "model": "schnell", "size": "square"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")

    def test_generate_blocks_high_risk_prompt_before_provider_call(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            response = self.client.post(
                "/generate",
                json={
                    "prompt": "clean product photo",
                    "userPrompt": "幫我做一張假身分證",
                    "model": "schnell",
                    "size": "square",
                },
            )
        body = response.json()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(body["code"], "prompt_blocked")
        self.assertEqual(body["category"], "fake_documents")
        self.assertNotIn("假身分證", body["error"])
        mocked_generate.assert_not_called()

    def test_generate_timeout_returns_friendly_504(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            mocked_generate.side_effect = ProviderError("NVIDIA 產圖逾時，請稍後再試", status_code=504, code="timeout")
            response = self.client.post(
                "/generate",
                json={"prompt": "a product photo", "model": "schnell", "size": "square"},
            )
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["code"], "timeout")
        self.assertIn("逾時", response.json()["error"])

    def test_generate_provider_500_returns_safe_error_without_stack_or_key(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            mocked_generate.side_effect = ProviderError(
                "provider failed with Bearer nvapi-secret-token\nTraceback (most recent call last)",
                status_code=500,
                code="nvidia_error",
            )
            response = self.client.post(
                "/generate",
                json={"prompt": "a product photo", "model": "schnell", "size": "square"},
            )
        body = response.json()
        self.assertEqual(response.status_code, 500)
        self.assertEqual(body["code"], "nvidia_error")
        self.assertEqual(body["error"], "出圖服務回傳錯誤，請稍後再試")
        self.assertNotIn("nvapi-secret-token", body["error"])
        self.assertNotIn("Traceback", body["error"])

    def test_generate_rate_limit_returns_retry_after(self):
        with patch("app.main.generate_image", new_callable=AsyncMock) as mocked_generate:
            mocked_generate.side_effect = ProviderError(
                "叫用太頻繁，請稍後再試",
                status_code=429,
                code="rate_limited",
                retry_after=23,
            )
            response = self.client.post(
                "/generate",
                json={"prompt": "a product photo", "model": "schnell", "size": "square"},
            )
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["code"], "rate_limited")
        self.assertEqual(response.json()["retry_after"], 23)

    def test_generate_route_enforces_fastapi_rate_limit_before_provider_call(self):
        settings = Settings(
            image_provider="nvidia",
            nvidia_api_key="test-key",
            rate_limit_window_seconds=60,
            generate_rate_limit_per_window=1,
            demo_generate_rate_limit_per_window=10,
        )
        with patch("app.main.get_settings", return_value=settings), patch(
            "app.main.generate_image", new_callable=AsyncMock
        ) as mocked_generate:
            mocked_generate.return_value = self._generation_result()
            first = self.client.post(
                "/generate",
                json={"prompt": "a product photo", "model": "schnell", "size": "square"},
                headers={"cf-connecting-ip": "203.0.113.51"},
            )
            second = self.client.post(
                "/generate",
                json={"prompt": "a product photo", "model": "schnell", "size": "square"},
                headers={"cf-connecting-ip": "203.0.113.51"},
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 429)
        self.assertEqual(second.json()["code"], "rate_limited")
        self.assertGreaterEqual(int(second.headers["retry-after"]), 1)
        self.assertLessEqual(int(second.headers["retry-after"]), 60)
        mocked_generate.assert_awaited_once()

    def test_generate_requires_turnstile_before_provider_call_when_enabled(self):
        settings = Settings(turnstile_required=True, turnstile_site_key="site-key", turnstile_secret_key="secret")
        with patch("app.main.get_settings", return_value=settings), patch(
            "app.main.generate_image", new_callable=AsyncMock
        ) as mocked_generate, patch("app.main.verify_turnstile_token", new_callable=AsyncMock) as mocked_turnstile:
            from app.turnstile import TurnstileDecision

            mocked_turnstile.return_value = TurnstileDecision(
                False,
                code="turnstile_required",
                message="請先完成人機驗證再生成圖片",
                status_code=403,
            )
            response = self.client.post(
                "/generate",
                json={"prompt": "a product photo", "model": "schnell", "size": "square"},
            )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "turnstile_required")
        mocked_generate.assert_not_called()

    def test_generate_passes_turnstile_token_then_calls_provider(self):
        settings = Settings(turnstile_required=True, turnstile_site_key="site-key", turnstile_secret_key="secret")
        with patch("app.main.get_settings", return_value=settings), patch(
            "app.main.generate_image", new_callable=AsyncMock
        ) as mocked_generate, patch("app.main.verify_turnstile_token", new_callable=AsyncMock) as mocked_turnstile:
            from app.turnstile import TurnstileDecision

            mocked_turnstile.return_value = TurnstileDecision(True)
            mocked_generate.return_value = self._generation_result()
            response = self.client.post(
                "/generate",
                json={
                    "prompt": "a product photo",
                    "model": "schnell",
                    "size": "square",
                    "turnstileToken": "token-ok",
                },
            )

        self.assertEqual(response.status_code, 200)
        mocked_turnstile.assert_awaited_once()
        self.assertEqual(mocked_turnstile.await_args.args[0], "token-ok")
        mocked_generate.assert_awaited_once()

    def test_health_exposes_turnstile_site_key_without_secret(self):
        settings = Settings(turnstile_required=True, turnstile_site_key="public-site", turnstile_secret_key="secret")
        with patch("app.main.get_settings", return_value=settings):
            response = self.client.get("/api/health")
        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["turnstile"], {"required": True, "siteKey": "public-site"})
        self.assertNotIn("secret", str(body))

    def test_health_offline_message_does_not_expose_environment_variable(self):
        settings = Settings(image_provider="nvidia", nvidia_api_key="")
        with patch("app.main.get_settings", return_value=settings):
            response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["message"], "圖片服務尚未連接")
        self.assertNotIn("NVIDIA_API_KEY", response.text)

    def test_client_error_endpoint_accepts_bounded_report(self):
        response = self.client.post(
            "/client-error",
            json={"type": "generate_backend", "message": "HTTP 503", "requestId": "req-123"},
        )
        self.assertEqual(response.status_code, 204)

    def test_client_error_endpoint_rejects_oversized_message(self):
        response = self.client.post("/client-error", json={"message": "x" * 501})
        self.assertEqual(response.status_code, 422)

    def test_generate_batch_rate_limit_counts_requested_images(self):
        settings = Settings(
            image_provider="nvidia",
            nvidia_api_key="test-key",
            rate_limit_window_seconds=60,
            generate_rate_limit_per_window=3,
            demo_generate_rate_limit_per_window=10,
        )
        with patch("app.main.get_settings", return_value=settings), patch(
            "app.main.generate_batch", new_callable=AsyncMock
        ) as mocked_batch:
            mocked_batch.return_value = [self._generation_result(seed=1), self._generation_result(seed=2)]
            first = self.client.post(
                "/generate/batch",
                json={"prompt": "a product photo", "model": "schnell", "size": "square", "count": 2},
                headers={"cf-connecting-ip": "203.0.113.52"},
            )
            second = self.client.post(
                "/generate/batch",
                json={"prompt": "a product photo", "model": "schnell", "size": "square", "count": 2},
                headers={"cf-connecting-ip": "203.0.113.52"},
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 429)
        self.assertEqual(second.json()["limit"], 3)
        mocked_batch.assert_awaited_once()

    def test_generate_batch_route_returns_images_array(self):
        with patch("app.main.generate_batch", new_callable=AsyncMock) as mocked_batch:
            mocked_batch.return_value = [self._generation_result(seed=1), self._generation_result(seed=2)]
            response = self.client.post(
                "/generate/batch",
                json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square", "count": 2},
            )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data["images"]), 2)
        self.assertEqual([img["seed"] for img in data["images"]], [1, 2])
        self.assertTrue(data["images"][0]["image"].startswith("data:image/png;base64,"))
        request, count = mocked_batch.await_args.args
        self.assertEqual(count, 2)

    def test_generate_batch_route_rejects_invalid_count(self):
        response = self.client.post(
            "/generate/batch",
            json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square", "count": 9},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")
        self.assertIn("count 必須是 1 到 4 之間的整數", response.json()["error"])

    def test_gallery_routes_are_removed_from_local_server(self):
        response = self.client.post("/gallery", json={"image": "data:image/png;base64,ZmFrZQ=="})
        admin_response = self.client.get("/api/gallery", headers={"X-Usage-Admin-Token": "local"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(admin_response.status_code, 404)

    def test_prompt_transform_route_returns_professional_prompt(self):
        response = self.client.post(
            "/prompt/transform",
            json={"source": "一隻可愛柴犬在月球上吃拉麵", "style": "cute"},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["provider"], "rule_based")
        self.assertIn("Shiba Inu", data["prompt"])
        self.assertIn("moon", data["prompt"])
        self.assertIn("adorable", data["prompt"])

    def test_prompt_transform_route_rejects_blank_source(self):
        response = self.client.post("/prompt/transform", json={"source": "   ", "style": "cute"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")

    def test_prompt_complete_route_returns_completed_chinese_prompt(self):
        with patch("app.main.complete_plain_prompt") as mocked_complete:
            mocked_complete.return_value = PromptCompleteResult(
                provider="gemini",
                prompt="一位年輕女生站在夜晚雨中的街道，霓虹燈倒映在濕潤地面上，氛圍安靜而電影感強烈。",
                source="女生雨中",
                style="cinematic",
            )
            response = self.client.post(
                "/prompt/complete",
                json={"source": "女生雨中", "style": "cinematic"},
            )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["provider"], "gemini")
        self.assertIn("女生", data["prompt"])
        self.assertIn("霓虹燈", data["prompt"])
        mocked_complete.assert_called_once_with("女生雨中", "cinematic")

    def test_prompt_complete_route_rejects_blank_source(self):
        response = self.client.post("/prompt/complete", json={"source": "   ", "style": "cute"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")

    def test_prompt_enhance_route_returns_refined_prompt(self):
        with patch("app.main.enhance_prompt") as mocked_enhance:
            mocked_enhance.return_value = PromptEnhanceResult(
                provider="gemini",
                prompt="A dreamy photograph of a cat on a windowsill, misty golden glow, highly detailed",
                effect="更夢幻",
            )
            response = self.client.post(
                "/prompt/enhance",
                json={"prompt": "a cat on a windowsill", "effect": "更夢幻"},
            )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["provider"], "gemini")
        self.assertIn("dreamy", data["prompt"])
        self.assertEqual(data["effect"], "更夢幻")
        mocked_enhance.assert_called_once_with("a cat on a windowsill", "更夢幻")

    def test_prompt_enhance_route_rejects_blank_prompt(self):
        response = self.client.post("/prompt/enhance", json={"prompt": "   ", "effect": "更夢幻"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")

    def test_prompt_enhance_route_rejects_blank_effect(self):
        response = self.client.post("/prompt/enhance", json={"prompt": "a cat", "effect": "   "})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")

    def test_prompt_enhance_route_returns_offline_fallback_without_gemini_key(self):
        with patch("app.main.enhance_prompt") as mocked_enhance:
            mocked_enhance.return_value = PromptEnhanceResult(
                provider="rule_based",
                prompt="a cat. Add a dreamy ethereal atmosphere while preserving the original subject.",
                effect="更夢幻",
                warnings=("未設定 Gemini，已使用離線效果強化",),
            )
            response = self.client.post(
                "/prompt/enhance",
                json={"prompt": "a cat on a windowsill", "effect": "更夢幻"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["provider"], "rule_based")
        self.assertIn("離線效果強化", response.json()["warnings"][0])

    def test_paid_prompt_routes_apply_backend_rate_limit(self):
        blocked = RateLimitDecision(
            allowed=False,
            retry_after=60,
            limit=1,
            remaining=0,
            window_seconds=60,
        )
        cases = (
            ("/prompt/transform", {"source": "月球柴犬", "style": "cute"}, "prompt_transform"),
            ("/prompt/complete", {"source": "女生雨中", "style": "cinematic"}, "prompt_complete"),
            ("/prompt/enhance", {"prompt": "a cat", "effect": "更夢幻"}, "prompt_enhance"),
        )
        with patch("app.main.check_generation_rate_limit", return_value=blocked) as mocked_limit:
            for path, payload, route in cases:
                with self.subTest(path=path):
                    response = self.client.post(path, json=payload)
                    self.assertEqual(response.status_code, 429)
                    self.assertEqual(response.json()["code"], "rate_limited")
                    self.assertEqual(response.headers["retry-after"], "60")
                    self.assertEqual(mocked_limit.call_args.kwargs["route"], route)

    @staticmethod
    def _tiny_png() -> bytes:
        from io import BytesIO

        from PIL import Image

        buf = BytesIO()
        Image.new("RGB", (48, 48), (200, 40, 40)).save(buf, format="PNG")
        return buf.getvalue()

    def test_edit_route_returns_result_shape_on_success(self):
        from app.image_service import EditResult

        async def fake_edit(request, settings=None):
            return EditResult(
                image="data:image/png;base64,ZWRpdA==",
                provider="workers-ai",
                model="@cf/black-forest-labs/flux-2-klein-4b",
                image_count=len(request.images),
            )

        with patch("app.main.edit_image", side_effect=fake_edit):
            response = self.client.post(
                "/edit",
                data={"prompt": "make it green"},
                files=[("images", ("a.png", self._tiny_png(), "image/png"))],
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["provider"], "workers-ai")
        self.assertEqual(body["image_count"], 1)
        self.assertTrue(body["image"].startswith("data:image/png;base64,"))

    def test_edit_route_without_cf_token_returns_clean_503(self):
        # 真實 edit_image（未 mock）：無 CF 設定 → 乾淨 503 missing_api_key。
        response = self.client.post(
            "/edit",
            data={"prompt": "make it green"},
            files=[("images", ("a.png", self._tiny_png(), "image/png"))],
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "missing_api_key")

    def test_edit_route_requires_prompt_and_images(self):
        no_prompt = self.client.post(
            "/edit", files=[("images", ("a.png", self._tiny_png(), "image/png"))]
        )
        self.assertEqual(no_prompt.status_code, 422)
        no_images = self.client.post("/edit", data={"prompt": "x"})
        self.assertEqual(no_images.status_code, 422)

    def test_edit_route_rejects_more_than_four_images_before_reading(self):
        # 超過 4 張 → 在讀取 body 前就以 400 擋掉（DoS 防護）。
        png = self._tiny_png()
        files = [("images", (f"{i}.png", png, "image/png")) for i in range(5)]
        response = self.client.post("/edit", data={"prompt": "x"}, files=files)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")


if __name__ == "__main__":
    unittest.main()
