const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const tabsJsPath = path.resolve(__dirname, '../../app/static/tabs.js');
const tabsJsSource = fs.readFileSync(tabsJsPath, 'utf8');

function createMockElement(id, initialValue = '', initialText = '') {
  const listeners = {};
  const attributes = {};
  return {
    id: id,
    value: initialValue,
    textContent: initialText,
    selectedIndex: 0,
    options: [{ value: initialValue, text: initialText }],
    getAttribute: (attr) => attributes[attr] || null,
    setAttribute: (attr, val) => { attributes[attr] = String(val); },
    addEventListener: (type, handler) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    dispatchEvent: (event) => {
      const handlers = listeners[event.type] || [];
      handlers.forEach((h) => h(event));
    },
    classList: {
      toggle: () => {},
      add: () => {},
      remove: () => {}
    }
  };
}

function setupMockDocument() {
  const elements = {
    size: createMockElement('size', 'square', '正方形（1024×1024）'),
    model: createMockElement('model', 'dev', '高品質（較慢）'),
    seed: createMockElement('seed', '', ''),
    seedRandom: createMockElement('seedRandom', '', ''),
    seedLock: createMockElement('seedLock', '', ''),
    devSteps: createMockElement('devSteps', '', ''),
    devCfgScale: createMockElement('devCfgScale', '', ''),
    stage: createMockElement('stage', '', ''),
    status: createMockElement('status', '', ''),
    canvasSizeMeta: createMockElement('canvasSizeMeta', '', '1024 × 1024'),
    canvasModelMeta: createMockElement('canvasModelMeta', '', '平衡'),
    canvasSeedMeta: createMockElement('canvasSeedMeta', '', 'Seed 自動'),
    canvasPresetChip: createMockElement('canvasPresetChip', '', '1024 × 1024'),
    canvasStateMeta: createMockElement('canvasStateMeta', '', '待命'),
    canvasStatusbar: createMockElement('canvasStatusbar', '', ''),
    customWidth: createMockElement('customWidth', '1024', ''),
    customHeight: createMockElement('customHeight', '1024', '')
  };

  const draftBtn = createMockElement('qualityDraft', '', '🚀 草稿');
  draftBtn.setAttribute('data-preset', 'draft');
  const balancedBtn = createMockElement('qualityBalanced', '', '⚖️ 平衡');
  balancedBtn.setAttribute('data-preset', 'balanced');
  const fineBtn = createMockElement('qualityFine', '', '✨ 精緻');
  fineBtn.setAttribute('data-preset', 'fine');

  const presetButtons = [draftBtn, balancedBtn, fineBtn];

  const doc = {
    querySelector: (sel) => {
      if (sel === '.tabs[role="tablist"]') {
        const mockTab = {
          getAttribute: (attr) => (attr === 'data-tab' ? 'generate' : 'panel-generate'),
          addEventListener: () => {},
          setAttribute: () => {},
          classList: { toggle: () => {}, add: () => {}, remove: () => {} },
          focus: () => {}
        };
        return { querySelectorAll: () => [mockTab] };
      }
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '[role="tab"]') return [{ getAttribute: () => 'generate', addEventListener: () => {} }];
      if (sel === '[data-open-history]') return [];
      if (sel === '.quality-preset-btn') return presetButtons;
      return [];
    },
    getElementById: (id) => elements[id] || null,
    addEventListener: () => {},
    body: { setAttribute: () => {} }
  };

  return { elements, presetButtons, doc };
}

test('canvas status bar reflects quality presets accurately', () => {
  const { elements, doc } = setupMockDocument();
  const windowObj = {
    setTimeout: (fn) => fn(),
    document: doc,
    location: { hash: '', pathname: '/', search: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {}
  };

  const context = vm.createContext({
    window: windowObj,
    document: doc,
    location: windowObj.location,
    localStorage: windowObj.localStorage,
    setTimeout: windowObj.setTimeout
  });

  vm.runInContext(tabsJsSource, context);

  // Default should be 平衡
  assert.strictEqual(elements.canvasModelMeta.textContent, '平衡');

  // Change to Draft preset (steps: 10, cfg: 3)
  elements.devSteps.value = '10';
  elements.devCfgScale.value = '3';
  context.window.updateCanvasSettings();
  assert.strictEqual(elements.canvasModelMeta.textContent, '草稿');

  // Change to Fine preset (steps: 45, cfg: 4)
  elements.devSteps.value = '45';
  elements.devCfgScale.value = '4';
  context.window.updateCanvasSettings();
  assert.strictEqual(elements.canvasModelMeta.textContent, '精緻');

  // Change to Custom (steps: 25, cfg: 5)
  elements.devSteps.value = '25';
  elements.devCfgScale.value = '5';
  context.window.updateCanvasSettings();
  assert.strictEqual(elements.canvasModelMeta.textContent, '自訂');

  // When model is explicitly schnell and steps/cfg are empty, shows 草稿
  elements.devSteps.value = '';
  elements.devCfgScale.value = '';
  elements.model.value = 'schnell';
  context.window.updateCanvasSettings();
  assert.strictEqual(elements.canvasModelMeta.textContent, '草稿');

  // When model is dev and steps/cfg are empty, shows 平衡
  elements.model.value = 'dev';
  context.window.updateCanvasSettings();
  assert.strictEqual(elements.canvasModelMeta.textContent, '平衡');
});
