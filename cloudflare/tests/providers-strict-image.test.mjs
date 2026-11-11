import assert from 'node:assert/strict';
import test from 'node:test';
import { generateOneImage, editImage } from '../src/image.js';

const NOT_AN_IMAGE = 'A'.repeat(100);
const REAL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM/////w8AH+4F+7C4l8kAAAAASUVORK5CYII=';

async function rejectsBadProviderResponse(promise) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'bad_provider_response');
    return true;
  });
}

test('generateOneImage rejects raw-base64 non-image provider payloads as bad_provider_response', async () => {
  const env = { AI: { run: async () => ({ image: NOT_AN_IMAGE }) } };
  await rejectsBadProviderResponse(
    generateOneImage(env, { prompt: 'cat', model: 'schnell', size: 'square', seed: 42 })
  );
});

test('generateOneImage rejects data:image payloads whose bytes are not a real image', async () => {
  const env = { AI: { run: async () => ({ image: 'data:image/png;base64,' + NOT_AN_IMAGE }) } };
  await rejectsBadProviderResponse(
    generateOneImage(env, { prompt: 'cat', model: 'schnell', size: 'square', seed: 42 })
  );
});

test('editImage rejects raw-base64 non-image provider payloads as bad_provider_response', async () => {
  const file = new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])],
    'input.png',
    { type: 'image/png' }
  );
  const env = { AI: { run: async () => ({ image: NOT_AN_IMAGE }) } };
  await rejectsBadProviderResponse(
    editImage(env, { prompt: 'make it blue', images: [file] })
  );
});

test('a real PNG provider payload still resolves with the workers-ai provider', async () => {
  const env = { AI: { run: async () => ({ image: REAL_PNG_B64 }) } };
  const result = await generateOneImage(env, { prompt: 'cat', model: 'schnell', size: 'square', seed: 42 });
  assert.equal(result.provider, 'workers-ai');
  assert.ok(result.image.startsWith('data:image/png;base64,'));
});
