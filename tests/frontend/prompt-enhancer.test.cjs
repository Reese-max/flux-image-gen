const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPromptEnhancer() {
  const sourcePath = path.resolve(__dirname, '../../app/static/prompt-enhancer.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return context.PromptEnhancer;
}

test('enhancePrompt appends cinematic modifiers without duplicating', () => {
  const enhancer = loadPromptEnhancer();
  const result = enhancer.enhancePrompt('a cat portrait', 'cinematic');
  assert.match(result.prompt, /a cat portrait/);
  assert.match(result.prompt, /cinematic lighting/);
  assert.match(result.prompt, /film still/);
  assert.equal(result.mode, 'cinematic');
});

test('enhancePrompt supports artifact repair mode', () => {
  const enhancer = loadPromptEnhancer();
  const result = enhancer.enhancePrompt('a hand holding a cup', 'fix_artifacts');
  assert.match(result.prompt, /avoid extra fingers/);
  assert.match(result.prompt, /sharp details/);
});

test('enhancePrompt rejects blank prompt', () => {
  const enhancer = loadPromptEnhancer();
  assert.throws(() => enhancer.enhancePrompt('   ', 'realistic'), /請先輸入提示詞/);
});

test('listModes exposes user-facing labels', () => {
  const enhancer = loadPromptEnhancer();
  const modes = enhancer.listModes();
  assert.ok(modes.some((mode) => mode.id === 'realistic' && mode.label));
  assert.ok(modes.some((mode) => mode.id === 'clean'));
});
