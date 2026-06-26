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
  assert.match(advice.steps.join(' '), /schnell/);
});

test('getAdvice returns fallback guidance for unknown code', () => {
  const advice = loadFailureAdvice().getAdvice('unexpected_code');
  assert.equal(advice.code, 'unexpected_code');
  assert.match(advice.title, /產圖失敗/);
});
