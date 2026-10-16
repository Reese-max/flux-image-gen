const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function client(fetchImpl, token = 'first-token', timer = setTimeout) {
  const field = { value: token };
  const context = {
    document: { querySelector: () => field, getElementById: () => null, addEventListener() {} },
    fetch: fetchImpl, setTimeout: timer, console, Promise, JSON, Date, FormData,
    addEventListener() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/static/app.js'), 'utf8'), context);
  context.turnstileState = { required: true, siteKey: 'test-site', widgetId: 'test-widget' };
  return { context, field };
}

test('protected prompt then generation uses a fresh single-use Turnstile token', async () => {
  const tokens = [];
  const { context, field } = client(async (_url, init) => {
    tokens.push(JSON.parse(init.body).turnstileToken);
    return { ok: true };
  });
  let resets = 0;
  context.turnstile = { reset() { field.value = `fresh-${++resets}`; } };
  await context.fetchWithTurnstile('/prompt/transform', { method: 'POST', body: '{}' });
  await context.fetchWithTurnstile('/generate', { method: 'POST', body: '{}' });
  assert.deepEqual(tokens, ['first-token', 'fresh-1']);
  assert.equal(resets, 2);
});

test('concurrent protected requests cannot reuse a token while verification is pending', async () => {
  const tokens = [];
  let completeFirst;
  const { context, field } = client((_url, init) => {
    tokens.push(JSON.parse(init.body).turnstileToken);
    return tokens.length === 1 ? new Promise((resolve) => { completeFirst = resolve; }) : Promise.resolve({ ok: true });
  });
  context.turnstile = { reset() { field.value = 'next-token'; } };
  const first = context.fetchWithTurnstile('/prompt/complete', { body: '{}' });
  const second = context.fetchWithTurnstile('/prompt/enhance', { body: '{}' });
  await Promise.resolve();
  assert.deepEqual(tokens, ['first-token']);
  completeFirst({ ok: true });
  await Promise.all([first, second]);
  assert.deepEqual(tokens, ['first-token', 'next-token']);
});

test('protected multipart requests receive a token and reset after network failure', async () => {
  const { context } = client(async () => { throw new Error('offline'); });
  let resets = 0;
  context.turnstile = { reset() { resets++; } };
  const body = new FormData();
  await assert.rejects(() => context.fetchWithTurnstile('/edit', { body }), /offline/);
  assert.equal(body.get('turnstileToken'), 'first-token');
  assert.equal(resets, 1);
});

test('waiting for verification is bounded and never sends an unverified request', async () => {
  let calls = 0;
  const { context } = client(async () => { calls++; }, '', (callback) => {
    context.Date = { now: () => 60000 };
    callback();
  });
  context.Date = { now: () => 0 };
  await assert.rejects(() => context.fetchWithTurnstile('/prompt/transform', { body: '{}' }), /真人驗證/);
  assert.equal(calls, 0);
});

test('local mode keeps existing requests unchanged', async () => {
  let body;
  const { context } = client(async (_url, init) => { body = init.body; return { ok: true }; });
  context.turnstileState.required = false;
  await context.fetchWithTurnstile('/generate', { body: '{"prompt":"a cat"}' });
  assert.equal(body, '{"prompt":"a cat"}');
});
