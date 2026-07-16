const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const stylesPath = path.resolve(__dirname, '../../app/static/styles.css');

test('Regression: narrow style cards keep edit and project actions on separate rows', () => {
  const styles = fs.readFileSync(stylesPath, 'utf8');
  const narrowRules = styles.match(/@media \(max-width: 460px\)\s*\{([\s\S]*)\n\}/);

  assert.ok(narrowRules, '找不到窄螢幕樣式區塊');
  assert.match(narrowRules[1], /\.custom-card \.custom-idea\s*\{[\s\S]*?padding-bottom:\s*42px/);
  assert.match(narrowRules[1], /\.custom-card \.card-project\s*\{\s*top:\s*auto;\s*bottom:\s*8px;/);
});
