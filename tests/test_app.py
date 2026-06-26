import unittest
from unittest.mock import AsyncMock, patch

from app.image_service import GenerationResult
from app.main import app
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


if __name__ == "__main__":
    unittest.main()
