// Regression tests for the multi-variant batch fan-out (issue #7).
//
// /generate/batch used to start every variation at once (Promise.allSettled over
// eagerly started generateOneImage promises). Hosted inference endpoints admit
// only a limited number of concurrent runs per account, so every variation after
// the first came back HTTP 429 rate_limited — a status the fallback chain
// deliberately never retries or re-routes. Production reported "1 succeeded,
// N-1 failed" for both the 2-image and the 4-image batch while /generate kept
// working. The fan-out must keep at most one provider call in flight.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

function jsonRequest(path, body) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fakeEnv(extra = {}) {
  return {
    ASSETS: {
      fetch() {
        return new Response('asset fallback', { status: 200 });
      },
    },
    ...extra,
  };
}

// A provider that admits one in-flight run per account: overlapping calls get the
// same 429 the deployed provider returned for every variant after the first.
function singleRunProvider({ latencyMs = 20 } = {}) {
  const state = { inFlight: 0, peakInFlight: 0, calls: 0 };
  const fetchImpl = async () => {
    state.calls += 1;
    state.inFlight += 1;
    state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      if (state.inFlight > 1) {
        return new Response(JSON.stringify({ detail: 'concurrent run limit' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      state.inFlight -= 1;
    }
  };
  return { state, fetchImpl };
}

async function withProvider(options, run) {
  const originalFetch = globalThis.fetch;
  const { state, fetchImpl } = singleRunProvider(options);
  globalThis.fetch = fetchImpl;
  try {
    return { state, result: await run() };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('POST /generate/batch returns every requested image when the provider admits one run', async () => {
  const { state, result } = await withProvider({}, () =>
    worker.fetch(
      jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 4 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    )
  );
  const data = await result.json();

  assert.equal(result.status, 200);
  assert.equal(data.images.length, 4);
  assert.deepEqual(data.errors, []);
  assert.equal(data.partial, false, 'a complete batch must not report partial results');
  assert.equal(state.peakInFlight, 1);
  assert.equal(state.calls, 4);
  assert.equal(new Set(data.images.map((item) => item.seed)).size, 4);
});

test('POST /generate/batch keeps a single provider call in flight for two variants', async () => {
  const { state, result } = await withProvider({}, () =>
    worker.fetch(
      jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 2 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    )
  );
  const data = await result.json();

  assert.equal(result.status, 200);
  assert.equal(data.images.length, 2);
  assert.equal(state.peakInFlight, 1);
});

test('POST /generate/batch still reports a failed variant against its own index', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function () {
    calls += 1;
    // Second variant is rate limited by the provider itself.
    if (calls === 2) {
      return new Response(JSON.stringify({ detail: 'quota exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate/batch', { prompt: 'a cat', model: 'schnell', size: 'square', count: 3 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.partial, true);
    assert.equal(data.images.length, 2);
    assert.equal(data.errors.length, 1);
    assert.equal(data.errors[0].index, 1);
    assert.equal(data.errors[0].code, 'rate_limited');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
