from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.image_service import GenerationResult, ProviderError
from app.main import app
from app.rate_limit import reset_rate_limiter
from app.usage_metrics import reset_usage_metrics


@pytest.mark.parametrize('failed_index', [0, 1])
def test_partial_batch_preserves_original_positions_and_seeds(failed_index):
    reset_rate_limiter()
    reset_usage_metrics()
    outcomes = [GenerationResult(image='data:image/png;base64,c2VlZA==', provider='demo',
                                 model='schnell', width=1024, height=1024, seed=100 + index)
                for index in range(3)]
    outcomes[failed_index] = ProviderError('synthetic failure', status_code=422, code='content_filtered')
    with patch('app.main.generate_batch', new_callable=AsyncMock, return_value=outcomes):
        response = TestClient(app).post('/generate/batch', json={
            'prompt': 'a synthetic cat', 'model': 'schnell', 'size': 'square', 'count': 3,
        })
    assert response.status_code == 200
    payload = response.json()
    assert payload['partial'] is True
    assert [error['index'] for error in payload['errors']] == [failed_index]
    assert [(image['index'], image['seed']) for image in payload['images']] == [
        (index, 100 + index) for index in range(3) if index != failed_index
    ]
