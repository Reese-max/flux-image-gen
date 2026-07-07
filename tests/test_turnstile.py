import unittest
from unittest.mock import AsyncMock, patch

from fastapi import Request

from app.settings import Settings
from app.turnstile import verify_turnstile_token


def make_request(ip="203.0.113.90"):
    return Request({"type": "http", "headers": [(b"cf-connecting-ip", ip.encode("ascii"))]})


class TurnstileTests(unittest.IsolatedAsyncioTestCase):
    async def test_turnstile_disabled_allows_without_network(self):
        settings = Settings(turnstile_required=False)
        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mocked_post:
            decision = await verify_turnstile_token(None, make_request(), settings)
        self.assertTrue(decision.allowed)
        mocked_post.assert_not_called()

    async def test_turnstile_missing_token_blocks_cleanly(self):
        settings = Settings(turnstile_required=True, turnstile_secret_key="secret")
        decision = await verify_turnstile_token("", make_request(), settings)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "turnstile_required")
        self.assertEqual(decision.status_code, 403)
        self.assertNotIn("secret", decision.message)

    async def test_turnstile_provider_failure_is_sanitized(self):
        settings = Settings(turnstile_required=True, turnstile_secret_key="secret")
        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mocked_post:
            mocked_post.side_effect = RuntimeError("raw secret stack")
            decision = await verify_turnstile_token("token", make_request(), settings)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "turnstile_unavailable")
        self.assertNotIn("secret", decision.message)


if __name__ == "__main__":
    unittest.main()
