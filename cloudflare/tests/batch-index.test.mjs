import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

for (const failedIndex of [0, 1]) {
  test(`partial Worker batch retains original image positions and seeds when ${failedIndex} fails`, async () => {
    const calls = [];
    const env = { ENVIRONMENT: 'test', AI: { async run(model, args) {
      let fields = { ...args };
      if (args.multipart) {
        const request = new Request('https://fixture.invalid', {
          method: 'POST', headers: { 'content-type': args.multipart.contentType },
          body: args.multipart.body, duplex: 'half',
        });
        fields = Object.fromEntries((await request.formData()).entries());
      }
      const index = calls.length;
      calls.push({ model, fields });
      if (index === failedIndex) throw new Error('NSFW content detected');
      return { image: 'iVBORw0KGgo=' };
    } } };
    const response = await worker.fetch(new Request('https://fixture.invalid/generate/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a synthetic cat', model: 'schnell', size: 'square', count: 3 }),
    }), env);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.partial, true);
    assert.deepEqual(payload.errors.map(error => error.index), [failedIndex]);
    assert.deepEqual(payload.images.map(image => [image.index, String(image.seed)]),
      calls.map((call, index) => [index, String(call.fields.seed)]).filter(([index]) => index !== failedIndex));
  });
}
