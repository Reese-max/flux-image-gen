from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.image_service import GenerationResult
from app.main import app
from app.rate_limit import reset_rate_limiter


@pytest.mark.parametrize('prompt', ['做一張身\u200b分證正面', '做一張健保卡', '做一張居留卡',
                                    '做一張驾驶证樣張', 'ＦＡＫＥ ＰＡＳＳＰＯＲＴ'])
def test_normalized_identity_document_stops_before_provider(prompt):
    reset_rate_limiter()
    result = GenerationResult(image='data:image/png;base64,aGVsbG8=', provider='fixture',
                              model='schnell', width=1024, height=1024, seed=1)
    with patch('app.main.generate_image', new_callable=AsyncMock, return_value=result) as generate:
        response = TestClient(app).post('/generate', json={
            'prompt': prompt, 'model': 'schnell', 'size': 'square',
        })
    assert response.status_code == 422
    assert response.json()['category'] == 'fake_documents'
    generate.assert_not_awaited()
