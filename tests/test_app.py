import unittest
from unittest.mock import AsyncMock, patch

from app.image_service import GenerationResult
from app.main import app
from app.prompt_complete import PromptCompleteResult
from app.prompt_enhance import PromptEnhanceResult
from app.prompt_llm import PromptLLMError
from fastapi.testclient import TestClient


class AppRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def _generation_result(self, seed=111):
        return GenerationResult(
            image="data:image/png;base64,ZmFrZQ==",
            provider="demo",
            model="schnell",
            width=1024,
            height=1024,
            seed=seed,
        )

    def test_health_reports_ok(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_index_serves_html(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers["content-type"])
        self.assertIn("AI 圖片產生器", response.text)

    def test_manifest_route_serves_webmanifest(self):
        response = self.client.get("/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertIn("application/manifest+json", response.headers["content-type"])
        self.assertIn("AI 圖片產生器", response.text)

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
        mocked_generate.assert_awaited_once()

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

    def test_gallery_route_reports_disabled_on_local_server(self):
        response = self.client.post("/gallery", json={"image": "data:image/png;base64,ZmFrZQ=="})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "gallery_disabled")

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

    def test_prompt_enhance_route_requires_gemini_key(self):
        with patch("app.main.enhance_prompt") as mocked_enhance:
            mocked_enhance.side_effect = PromptLLMError("missing GEMINI_API_KEY")
            response = self.client.post(
                "/prompt/enhance",
                json={"prompt": "a cat on a windowsill", "effect": "更夢幻"},
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "missing_api_key")

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
