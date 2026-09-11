import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRateLimit, isProductionMode } from '../src/http.js';
const req = (ip) => new Request('https://unit.invalid/generate', { headers: ip ? { 'cf-connecting-ip': ip } : {} });
// Fail-closed only guards what there is to protect: a provider key must be
// present for the missing/broken limiter to become a 503 in production.
const PROD = { ENVIRONMENT: 'production', NVIDIA_API_KEY: 'test-provider-key' };

test('production environment detection is explicit', () => {
  assert.equal(isProductionMode({ ENVIRONMENT: 'production' }), true);
  assert.equal(isProductionMode({ ENVIRONMENT: 'Production' }), true);
  assert.equal(isProductionMode({}), false);
});
test('production missing limiter fails closed', async () => {
  const r = await checkRateLimit(req('203.0.113.1'), undefined, PROD);
  assert.equal(r.status, 503); assert.equal((await r.json()).code, 'rate_limiter_unavailable');
});
test('production limiter exception fails closed', async () => {
  const r = await checkRateLimit(req('203.0.113.1'), { limit(){ throw new Error('fixture'); } }, PROD);
  assert.equal(r.status, 503); assert.equal((await r.json()).code, 'rate_limiter_error');
});
test('production without provider keys passes through (nothing to protect)', async () => {
  assert.equal(await checkRateLimit(req(), undefined, { ENVIRONMENT: 'production' }), null);
});
test('development missing limiter retains explicit non-production behavior', async () => {
  assert.equal(await checkRateLimit(req(), undefined, { ENVIRONMENT: 'development' }), null);
});
test('durable limiter rejection remains 429', async () => {
  const r = await checkRateLimit(req('203.0.113.1'), { limit:async()=>({success:false}) }, PROD);
  assert.equal(r.status,429); const data=await r.json(); assert.equal(data.code,'rate_limited'); assert.equal(data.retry_after,60);
});
test('successful production limiter permits request', async () => {
  assert.equal(await checkRateLimit(req('203.0.113.1'), { limit:async()=>({success:true}) }, PROD), null);
});
