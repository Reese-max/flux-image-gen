const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const STATIC_DIR = path.resolve(__dirname, '../../app/static');
const USER_PROMPT = '一隻貓在草地上';
const PROVIDER_PROMPT = 'a fluffy cat on green grass, highly detailed';
const AVOID_TEXT = 'blurry';
const PROVIDER_WITH_AVOID = PROVIDER_PROMPT + ', avoid ' + AVOID_TEXT;
const EDITED_PROMPT = '一隻貓在木桌上';
const EDITED_PROVIDER_PROMPT = 'a cat on a wooden table, highly detailed';
const EDITED_WITH_AVOID = EDITED_PROVIDER_PROMPT + ', avoid ' + AVOID_TEXT;

function loadSource(name) {
  return fs.readFileSync(path.join(STATIC_DIR, name), 'utf8');
}

function setupEnvironment({ withHistory = false } = {}) {
  const listeners = {};
  const elements = {};
  const fetchCalls = [];
  const storage = {};

  function makeElement(id, tag = 'div') {
    const attributes = {};
    const classes = new Set();
    return {
      id,
      tagName: tag.toUpperCase(),
      value: '',
      textContent: '',
      className: '',
      hidden: false,
      disabled: false,
      checked: false,
      firstChild: null,
      parentNode: null,
      dataset: {},
      options: [{ value: 'square', text: 'square' }],
      selectedIndex: 0,
      style: { setProperty() {} },
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        toggle(name, force) {
          if (force === undefined) {
            if (classes.has(name)) classes.delete(name); else classes.add(name);
          } else if (force) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        },
        contains(name) { return classes.has(name); }
      },
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; },
      removeAttribute(name) { delete attributes[name]; },
      appendChild(child) { child.parentNode = this; return child; },
      removeChild() {},
      addEventListener(type, handler) {
        const key = id + ':' + type;
        listeners[key] = listeners[key] || [];
        listeners[key].push(handler);
      },
      querySelectorAll() { return []; },
      focus() {},
      scrollIntoView() {},
      click() {}
    };
  }

  [
    'appToast', 'seedLockTooltip', 'seedModeHint', 'seedRandom', 'seedLock', 'seed',
    'status', 'plainPrompt', 'prompt', 'avoid', 'model', 'size', 'customWidth',
    'customHeight', 'customSizeFields', 'devTuning', 'devSteps', 'devCfgScale',
    'stage', 'go', 'mobileGenerate', 'dl', 'resultActions', 'generationWorkspace',
    'workspaceDivider', 'toggleGenerationControls', 'previewFit', 'previewActual',
    'generationPreview', 'resultHeading', 'batchCount', 'visionQa', 'turnstileGate',
    'promptStyle', 'historyDetailModal', 'historyDetailImage', 'historyDetailPrompt',
    'historyDetailProviderPrompt', 'historyDetailMeta', 'historyDetailQaReport',
    'historyVersionList', 'historyTagEditor', 'historyGrid', 'historyEmpty',
    'historyFilters', 'historyBatchBar', 'historySearch', 'historyModelFilter',
    'historySizeFilter', 'historyDateFrom', 'historyDateTo', 'historyFavoritesOnly',
    'historyCloudOnly', 'clearHistory', 'closeHistoryDetail', 'regenerateHistoryDetail',
    'copyHistoryPrompt', 'copyHistoryShareText', 'exportHistoryJson',
    'useCompositionDetail', 'selectVisibleHistory', 'deleteSelectedHistory',
    'clearHistorySelection', 'saveHistoryTags', 'hidePromptInShare',
    'historyCloudSection', 'historyCloudMeta', 'openHistoryCloudShare',
    'openHistoryCloudDelete', 'provider-pill', 'provider-text', 'mobileGenerateBar',
    'mobileGenerateSummary', 'qualityPresetHint', 'effectPrompt', 'applyEffect',
    'advancedSettings', 'useCase', 'random', 'regenerate', 'copyPrompt', 'copySettings',
    'openPrivacyPolicy', 'closePrivacyPolicy', 'openLicensePolicy', 'closeLicensePolicy',
    'clearLocalData', 'reloadPwa', 'dismissPwaUpdate', 'pwaUpdateNotice',
    'turnstileStatus', 'turnstileWidget', 'historyStatus', 'customSizeFields'
  ].forEach((id) => {
    elements[id] = makeElement(id, ['plainPrompt', 'prompt', 'avoid'].includes(id) ? 'textarea' : 'div');
  });
  elements.model.value = 'schnell';
  elements.size.value = 'square';
  elements.batchCount.value = '1';
  elements.promptStyle.value = 'auto';
  elements.useCase.value = 'auto';
  elements.visionQa.checked = false;
  elements.historyDetailModal.hidden = true;

  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) { return makeElement('', tag); },
    addEventListener(type, handler) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    dispatchEvent(event) {
      (listeners[event.type] || []).forEach((handler) => handler(event));
      return true;
    },
    activeElement: null,
    body: makeElement('body', 'body'),
    head: makeElement('head', 'head')
  };

  function responseFor(url) {
    if (url === '/prompt/transform') {
      return { prompt: EDITED_PROVIDER_PROMPT, provider: 'test' };
    }
    if (url === '/generate') {
      return {
        image: 'data:image/png;base64,AAAA',
        thumbnail: 'data:image/png;base64,AAAA',
        provider: 'test',
        model: 'schnell',
        width: 1152,
        height: 1536,
        seed: 777
      };
    }
    if (url === '/api/health') {
      return { providerStatus: 'demo', provider: 'demo' };
    }
    return {};
  }

  function fetchMock(url, options) {
    const body = options && options.body ? JSON.parse(options.body) : null;
    fetchCalls.push({ url, body });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get() { return ''; } },
      json: () => Promise.resolve(responseFor(url))
    });
  }

  const windowObj = {
    document,
    fetch: fetchMock,
    addEventListener() {},
    localStorage: {
      getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
      setItem(key, value) { storage[key] = String(value); },
      removeItem(key) { delete storage[key]; }
    },
    location: { href: 'http://localhost/', pathname: '/', hash: '', search: '' },
    requestAnimationFrame(callback) { callback(); },
    matchMedia() { return { matches: false }; },
    confirm() { return true; },
    showTab() { return true; },
    ElapsedTimer: { start() { return { stop() { return 1; } }; } }
  };

  const context = vm.createContext({
    window: windowObj,
    document,
    fetch: fetchMock,
    navigator: { userAgent: 'test' },
    performance: { now: () => 1000 },
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent {
      constructor(type, options) { this.type = type; this.detail = options ? options.detail : null; }
    },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob: class Blob {},
    Uint8Array,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console
  });
  context.globalThis = windowObj;

  vm.runInContext(loadSource('generation-settings.js'), context);
  context.GenerationSettings = windowObj.GenerationSettings;
  vm.runInContext(loadSource('app.js'), context);
  if (withHistory) {
    vm.runInContext(loadSource('history-store.js'), context);
    context.ImageHistoryStore = windowObj.ImageHistoryStore;
    vm.runInContext(loadSource('history-wall.js'), context);
  }

  const fire = (key, event = {}) => (listeners[key] || []).forEach((handler) => handler(event));
  const tick = async (count = 6) => {
    for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const callsFor = (url) => fetchCalls.filter((call) => call.url === url).map((call) => call.body);

  return { context, windowObj, elements, storage, fetchCalls, fire, tick, callsFor };
}

async function generateInitialImage(env) {
  env.elements.plainPrompt.value = USER_PROMPT;
  env.elements.prompt.value = PROVIDER_PROMPT;
  env.elements.avoid.value = AVOID_TEXT;
  env.elements.size.value = 'custom';
  env.elements.customWidth.value = '1152';
  env.elements.customHeight.value = '1536';
  env.elements.devSteps.value = '45';
  env.elements.devCfgScale.value = '4';
  await env.windowObj.ImageGenApp.generate();
  await env.tick();
}

test('regenerate restores the selected image prompt and complete generation settings', async () => {
  const env = setupEnvironment();
  env.fire('DOMContentLoaded');
  await generateInitialImage(env);
  assert.equal(env.callsFor('/generate').length, 1, JSON.stringify({ calls: env.fetchCalls, status: env.elements.status.textContent }));
  assert.deepEqual(env.callsFor('/generate')[0], {
    prompt: PROVIDER_WITH_AVOID,
    userPrompt: USER_PROMPT,
    model: 'schnell',
    size: 'custom',
    width: 1152,
    height: 1536,
    seed: env.callsFor('/generate')[0].seed,
    steps: 45,
    cfgScale: 4,
    visionQa: false,
    turnstileToken: ''
  });

  env.elements.plainPrompt.value = '動漫女孩肖像';
  env.elements.prompt.value = 'anime girl portrait';
  env.elements.avoid.value = '';
  env.elements.size.value = 'square';
  env.elements.customWidth.value = '1024';
  env.elements.customHeight.value = '1024';
  env.elements.devSteps.value = '10';
  env.elements.devCfgScale.value = '3';
  env.fetchCalls.length = 0;
  env.fire('regenerate:click');
  await env.tick();

  const body = env.callsFor('/generate')[0];
  assert.equal(body.userPrompt, USER_PROMPT);
  assert.equal(body.prompt, PROVIDER_WITH_AVOID);
  assert.equal(body.size, 'custom');
  assert.equal(body.width, 1152);
  assert.equal(body.height, 1536);
  assert.equal(body.steps, 45);
  assert.equal(body.cfgScale, 4);
});

test('editing a restored history prompt recompiles it for the new description', async () => {
  const env = setupEnvironment();
  env.fire('DOMContentLoaded');
  await generateInitialImage(env);
  env.elements.plainPrompt.value = '動漫女孩肖像';
  env.fetchCalls.length = 0;
  env.fire('regenerate:click');
  await env.tick();
  env.fetchCalls.length = 0;

  env.elements.plainPrompt.value = EDITED_PROMPT;
  env.fire('plainPrompt:input');
  await env.windowObj.ImageGenApp.generate();
  await env.tick();

  assert.equal(env.callsFor('/prompt/transform').length, 1);
  assert.equal(env.callsFor('/prompt/transform')[0].source, EDITED_PROMPT);
  assert.equal(env.callsFor('/generate').length, 1);
  assert.equal(env.callsFor('/generate')[0].userPrompt, EDITED_PROMPT);
  assert.equal(env.callsFor('/generate')[0].prompt, EDITED_WITH_AVOID);
});

test('composition regeneration restores the selected record prompt and settings', async () => {
  const env = setupEnvironment();
  env.fire('DOMContentLoaded');
  const record = {
    id: 'composition-history',
    prompt: USER_PROMPT,
    providerPrompt: PROVIDER_WITH_AVOID,
    avoid: AVOID_TEXT,
    model: 'schnell',
    size: 'custom',
    width: 1152,
    height: 1536,
    steps: 45,
    cfgScale: 4,
    seed: 42
  };

  assert.equal(env.windowObj.ImageGenApp.lockCompositionFromRecord(record), true);
  await env.windowObj.ImageGenApp.generate();
  await env.tick();

  const body = env.callsFor('/generate')[0];
  assert.equal(body.userPrompt, USER_PROMPT);
  assert.equal(body.prompt, PROVIDER_WITH_AVOID);
  assert.equal(body.size, 'custom');
  assert.equal(body.width, 1152);
  assert.equal(body.height, 1536);
  assert.equal(body.seed, 42);
  assert.equal(body.steps, 45);
  assert.equal(body.cfgScale, 4);
});

test('history detail regeneration uses the selected record provider prompt', async () => {
  const env = setupEnvironment({ withHistory: true });
  const record = {
    id: 'cat-history',
    image: 'data:image/png;base64,CAT',
    prompt: USER_PROMPT,
    providerPrompt: PROVIDER_WITH_AVOID,
    avoid: AVOID_TEXT,
    model: 'schnell',
    size: 'square',
    seed: 42
  };
  env.windowObj.ImageHistoryStore.saveRecords([record]);
  env.fire('DOMContentLoaded');
  env.windowObj.ImageHistoryWall.openHistoryDetail(record);
  env.fetchCalls.length = 0;
  env.windowObj.ImageHistoryWall.regenerateHistoryDetail();
  await env.tick();

  const body = env.callsFor('/generate')[0];
  assert.equal(body.userPrompt, USER_PROMPT);
  assert.equal(body.prompt, PROVIDER_WITH_AVOID);
  assert.equal(body.size, 'ig_post');
});
