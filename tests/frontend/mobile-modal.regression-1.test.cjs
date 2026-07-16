const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const stylesPath = path.resolve(__dirname, '../../app/static/styles.css');

test('Regression: mobile generation bar stays below modal backdrops', () => {
  const styles = fs.readFileSync(stylesPath, 'utf8');
  const modalMatch = styles.match(/\.modal-backdrop\s*\{[\s\S]*?z-index:\s*(\d+)/);
  const mobileMatch = styles.match(/@media \(max-width: 720px\)\s*\{[\s\S]*?\.mobile-generate-bar\s*\{[\s\S]*?z-index:\s*(\d+)/);

  assert.ok(modalMatch, '找不到彈窗遮罩的 z-index');
  assert.ok(mobileMatch, '找不到手機固定生成列的 z-index');
  assert.ok(Number(modalMatch[1]) > Number(mobileMatch[1]));
});
