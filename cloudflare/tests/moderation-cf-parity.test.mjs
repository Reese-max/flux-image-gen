import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker from '../src/index.js';
import { detectHighRiskPromptCategory } from '../src/moderation.js';

const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/moderation-cf-parity.json', import.meta.url), 'utf8'));
assert.equal(fixture.schemaVersion, 1);
assert.equal(fixture.cases.length, 14);
for (const item of fixture.cases) {
  test(`format parity: ${item.id}`, () => {
    assert.equal(detectHighRiskPromptCategory(item.prompt), item.category);
  });
}

// This tiny local image matches the existing route fixtures. AI.run is an
// injectable binding: no credentials or provider transport are used here.
const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
function requestFor(route, prompt) {
  if (route === '/edit') {
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('images', new Blob([Buffer.from(IMAGE, 'base64')], { type: 'image/png' }), 'local.png');
    return new Request(`https://example.test${route}`, { method: 'POST', body: form });
  }
  return new Request(`https://example.test${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cat', userPrompt: prompt, model: 'schnell', size: 'square', ...(route.endsWith('/batch') ? { count: 2 } : {}) }),
  });
}

for (const route of ['/generate', '/generate/batch', '/edit']) {
  test(`${route}: format-sensitive refusal precedes provider and safe control reaches provider`, async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let aiCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('unexpected transport in owned moderation control');
    };
    const env = { AI: { async run() { aiCalls += 1; return { image: IMAGE }; } } };
    try {
      // Both the existing ordinary refusal and the missing-Cf example must
      // reject through the public dispatcher; no short-circuit test helper.
      for (const prompt of ['blank passport template', fixture.cases[0].prompt]) {
        aiCalls = 0;
        const response = await worker.fetch(requestFor(route, prompt), env);
        const body = await response.json();
        assert.equal(response.status, 422);
        assert.equal(body.code, 'prompt_blocked');
        assert.equal(body.category, 'fake_documents');
        assert.equal(typeof body.error, 'string');
        assert.ok(body.error.length > 0);
        assert.equal(body.error.includes(prompt), false);
        assert.equal(aiCalls, 0);
        assert.equal(fetchCalls, 0);
      }
      // The same valid route/body/binding must call the stub for an allowed
      // existing PR27 example, so zero provider calls above are not vacuous.
      aiCalls = 0;
      const response = await worker.fetch(requestFor(route, 'credit card mockup for fintech landing page'), env);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(aiCalls, route === '/generate/batch' ? 2 : 1);
      assert.equal(fetchCalls, 0);
      if (route === '/generate/batch') {
        assert.equal(body.images.length, 2);
        assert.ok(body.images.every(image => image.provider === 'workers-ai'));
      } else {
        assert.equal(body.provider, 'workers-ai');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
