import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRateLimit, isProductionEnvironment } from '../src/http.js';
const req = (ip) => new Request('https://unit.invalid/generate', { headers: ip ? { 'cf-connecting-ip': ip } : {} });

test('production environment detection is explicit', () => {
  assert.equal(isProductionEnvironment({ ENVIRONMENT: 'production' }), true);
  assert.equal(isProductionEnvironment({ ENVIRONMENT: 'Production' }), true);
  assert.equal(isProductionEnvironment({}), false);
});
test('production missing limiter fails closed', async () => {
  const r = await checkRateLimit(req('203.0.113.1'), undefined, { ENVIRONMENT: 'production' });
  assert.equal(r.status, 503); assert.equal((await r.json()).code, 'rate_limiter_unavailable');
});
test('production limiter exception fails closed', async () => {
  const r = await checkRateLimit(req('203.0.113.1'), { limit(){ throw new Error('fixture'); } }, { ENVIRONMENT: 'production' });
  assert.equal(r.status, 503);
});
test('production missing platform identity fails closed before limiter', async () => {
  let calls=0; const r=await checkRateLimit(req(), { limit(){calls++;return {success:true};} }, { ENVIRONMENT:'production' });
  assert.equal(r.status,503); assert.equal(calls,0); assert.equal((await r.json()).code,'client_identity_unavailable');
});
test('development missing limiter retains explicit non-production behavior', async () => {
  assert.equal(await checkRateLimit(req(), undefined, { ENVIRONMENT: 'development' }), null);
});
test('durable limiter rejection remains 429', async () => {
  const r=await checkRateLimit(req('203.0.113.1'), { limit:async()=>({success:false}) }, { ENVIRONMENT:'production' });
  assert.equal(r.status,429); const data=await r.json(); assert.equal(data.code,'rate_limited'); assert.equal(data.retry_after,60);
});
test('successful production limiter permits request', async () => {
  assert.equal(await checkRateLimit(req('203.0.113.1'), { limit:async()=>({success:true}) }, { ENVIRONMENT:'production' }), null);
});
