"""Receipts must describe the actual provider payload, including fallback defaults."""
import base64
import unittest
from unittest.mock import patch

import httpx

from app.image_service import GenerationRequest, NvidiaProvider, WorkersAiProvider
from app.settings import Settings


class EffectiveProvenanceSettingsTests(unittest.IsolatedAsyncioTestCase):
    async def test_effective_model_and_settings_follow_resolved_payload(self):
        settings = Settings(nvidia_api_key="fixture-only", cf_account_id="fixture", cf_api_token="fixture-only")
        original_client = httpx.AsyncClient
        sent = []

        def respond(request):
            import json
            sent.append((str(request.url), json.loads(request.content)))
            image = base64.b64encode(b"\x89PNG\r\n\x1a\nfixture").decode()
            return httpx.Response(200, json={"artifacts": [{"base64": image}]})

        cases = [
            (NvidiaProvider(settings), GenerationRequest("cat", model="dev"), "flux.1-dev", 30, 5),
            (NvidiaProvider(settings), GenerationRequest("cat", model="dev", steps=45, cfg_scale=7.5), "flux.1-dev", 45, 7.5),
            (WorkersAiProvider(settings), GenerationRequest("cat"), settings.workers_ai_fast_model, 4, None),
            (WorkersAiProvider(settings), GenerationRequest("cat", size="landscape"), settings.workers_ai_sized_model, None, None),
        ]
        with patch("app.image_service.httpx.AsyncClient", lambda **kw: original_client(transport=httpx.MockTransport(respond))):
            for provider, request, model_suffix, steps, cfg in cases:
                with self.subTest(provider=provider.provider_name, size=request.size, steps=steps):
                    result = await provider.generate(request)
                    meta = result.provider_provenance
                    self.assertTrue(meta["model_id"].endswith(model_suffix))
                    self.assertEqual(meta["steps"], steps)
                    self.assertEqual(meta["cfg_scale"], cfg)
                    self.assertEqual(meta["steps"], sent[-1][1].get("steps"))
                    self.assertEqual(meta["cfg_scale"], sent[-1][1].get("cfg_scale"))
