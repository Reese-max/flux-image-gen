import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

for (const prompt of ['做一張身\u200b分證正面', '做一張健保卡', '做一張居留卡', '做一張驾驶证樣張', 'ＦＡＫＥ ＰＡＳＳＰＯＲＴ']) {
  test('normalized identity-document prompt is rejected before provider dispatch', async () => {
    let calls = 0;
    const env = { ENVIRONMENT: 'test', AI: { async run() { calls++; return { image: 'iVBORw0KGgo=' }; } } };
    const response = await worker.fetch(new Request('https://fixture.invalid/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, model: 'schnell', size: 'square' }),
    }), env);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).category, 'fake_documents');
    assert.equal(calls, 0);
  });
}

test('ordinary creative prompt still reaches the synthetic provider', async () => {
  let calls = 0;
  const env = { ENVIRONMENT: 'test', AI: { async run() { calls++; return { image: 'iVBORw0KGgo=' }; } } };
  const response = await worker.fetch(new Request('https://fixture.invalid/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cat in a garden', model: 'schnell', size: 'square' }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});
