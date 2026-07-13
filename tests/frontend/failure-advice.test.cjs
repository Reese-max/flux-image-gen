const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFailureAdvice() {
  const sourcePath = path.resolve(__dirname, '../../app/static/failure-advice.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return context.FailureAdvice;
}

test('getAdvice returns content filtered guidance', () => {
  const advice = loadFailureAdvice().getAdvice('content_filtered');
  assert.match(advice.title, /內容安全/);
  assert.ok(advice.steps.length >= 2);
});

test('getAdvice returns timeout guidance', () => {
  const advice = loadFailureAdvice().getAdvice('timeout');
  assert.match(advice.steps.join(' '), /重試/);
  assert.doesNotMatch(advice.steps.join(' '), /先改用 schnell/);
});

test('getAdvice uses retry_after for rate limits without blaming the prompt', () => {
  const advice = loadFailureAdvice().getAdvice('rate_limited', { retryAfter: 30 });
  assert.match(advice.steps.join(' '), /30 秒後/);
  assert.doesNotMatch(advice.steps.join(' '), /seed|prompt|模型/i);
});

test('getAdvice treats unavailable service as a server problem', () => {
  const advice = loadFailureAdvice().getAdvice('service_unavailable');
  assert.match(advice.title, /服務暫時不可用/);
  assert.doesNotMatch(advice.steps.join(' '), /seed|縮短 prompt|模型/i);
});

test('getAdvice keeps environment variables out of public copy', () => {
  const advice = loadFailureAdvice().getAdvice('missing_api_key');
  assert.match(advice.title, /圖片服務尚未連接/);
  assert.doesNotMatch(advice.title + advice.steps.join(' '), /NVIDIA_API_KEY|CF_ACCOUNT_ID|wrangler/i);
});

test('getAdvice returns fallback guidance for unknown code', () => {
  const advice = loadFailureAdvice().getAdvice('unexpected_code');
  assert.equal(advice.code, 'unexpected_code');
  assert.match(advice.title, /產圖失敗/);
  assert.doesNotMatch(advice.steps.join(' '), /seed|縮短 prompt|模型/i);
});
