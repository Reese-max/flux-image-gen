const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../../app/static/elapsed-timer.js');

function loadElapsedTimer() {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const context = vm.createContext({ Date });
  vm.runInContext(source, context, { filename: scriptPath });
  return context.ElapsedTimer;
}

test('formatElapsed returns non-negative tenths of a second', () => {
  const timer = loadElapsedTimer();
  assert.equal(timer.formatElapsed(1000, 2250), '1.3');
  assert.equal(timer.formatElapsed(2000, 1500), '0.0');
});

test('start reports elapsed time immediately and clears its interval once', () => {
  const timer = loadElapsedTimer();
  let now = 1000;
  let scheduled;
  let cleared = 0;
  const ticks = [];
  const running = timer.start({
    now: () => now,
    onTick: (seconds) => ticks.push(seconds),
    setIntervalFn: (callback) => {
      scheduled = callback;
      return 7;
    },
    clearIntervalFn: (id) => {
      assert.equal(id, 7);
      cleared += 1;
    },
  });

  assert.deepEqual(ticks, ['0.0']);
  now = 2460;
  scheduled();
  assert.deepEqual(ticks, ['0.0', '1.5']);
  assert.equal(running.stop(), '1.5');
  assert.equal(running.stop(), '1.5');
  assert.equal(cleared, 1);
});
