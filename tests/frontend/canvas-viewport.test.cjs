const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../../app/static/canvas-viewport.js');

function loadMath() {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const context = vm.createContext({ isFinite });
  vm.runInContext(source, context, { filename: scriptPath });
  assert.ok(context.CanvasViewportMath, 'CanvasViewportMath should be exposed on globalThis');
  return context.CanvasViewportMath;
}

test('clampScale keeps canvas zoom between 25% and 400%', () => {
  const math = loadMath();
  assert.equal(math.clampScale(0.01), 0.25);
  assert.equal(math.clampScale(1.5), 1.5);
  assert.equal(math.clampScale(9), 4);
});

test('wheel zoom moves in the expected direction and respects limits', () => {
  const math = loadMath();
  assert.ok(math.nextWheelScale(1, -100) > 1);
  assert.ok(math.nextWheelScale(1, 100) < 1);
  assert.equal(math.nextWheelScale(4, -100), 4);
  assert.equal(math.nextWheelScale(0.25, 100), 0.25);
});

test('keyboard and button zoom steps stay predictable around 100%', () => {
  const math = loadMath();
  assert.equal(math.nextStepScale(1, 1), 1.25);
  assert.equal(math.nextStepScale(1, -1), 0.9);
  assert.equal(math.nextStepScale(0.9, 1), 1);
  assert.equal(math.nextStepScale(4, 1), 4);
  assert.equal(math.nextStepScale(0.25, -1), 0.25);
});
