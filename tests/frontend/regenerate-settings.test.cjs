// Issue #9 regression: every "regenerate from a stored record" path must reuse
// the record's own providerPrompt (compiled English prompt) when talking to
// /generate — never the raw Chinese description and never a stale prompt from
// another record.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const STATIC_DIR = path.resolve(__dirname, '../../app/static');
const load = (name) => fs.readFileSync(path.join(STATIC_DIR, name), 'utf8');

const USER_PROMPT = '一隻貓在草地上';
const PROVIDER_PROMPT = 'a fluffy cat on green grass, highly detailed';
const AVOID_TEXT = 'blurry';
const PROVIDER_WITH_AVOID = PROVIDER_PROMPT + ', avoid ' + AVOID_TEXT;
const EDITED_PROMPT = '一隻貓在桌上';
const EDITED_PROVIDER_PROMPT = 'a cat on a wooden table, highly detailed';
const EDITED_WITH_AVOID = EDITED_PROVIDER_PROMPT + ', avoid ' + AVOID_TEXT;

function setupEnvironment() {
  const listeners = {};
  const elements = {};
  const fetchCalls = [];

  function makeElement(id, tag = 'div') {
    const classList = new Set();
    const attrs = {};
    return {
      id: id,
      tagName: tag.toUpperCase(),
      textContent: '',
      className: '',
      hidden: false,
      value: '',
      checked: false,
      dataset: {},
      selectedIndex: 0,
      options: [{ text: 'opt', value: 'opt' }],
      firstChild: null,
      style: { setProperty: () => {} },
      classList: {
        add: (...cls) => cls.forEach((c) => classList.add(c)),
        remove: (...cls) => cls.forEach((c) => classList.delete(c)),
        toggle: (c, force) => {
          if (force === undefined) {
            classList.has(c) ? classList.delete(c) : classList.add(c);
          } else if (force) {
            classList.add(c);
          } else {
            classList.delete(c);
          }
        },
        contains: (c) => classList.has(c)
      },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => (attrs[k] !== undefined ? attrs[k] : null),
      removeAttribute: (k) => { delete attrs[k]; },
      appendChild: () => {},
      removeChild: () => {},
      remove: () => {},
      querySelector: () => null,
      addEventListener: (type, handler) => {
        listeners[id + ':' + type] = listeners[id + ':' + type] || [];
        listeners[id + ':' + type].push(handler);
      },
      focus: () => {},
      scrollIntoView: () => {},
      dispatchEvent: () => true
    };
  }

  for (const id of [
    'appToast', 'seedLockTooltip', 'seedLock', 'seedRandom', 'seedModeHint', 'seed',
    'status', 'prompt', 'plainPrompt', 'avoid', 'model', 'size', 'customWidth',
    'customHeight', 'devSteps', 'devCfgScale', 'stage', 'go', 'dl', 'resultActions',
    'historyDetailModal', 'historyDetailImage', 'historyDetailPrompt',
    'historyDetailProviderPrompt', 'historyDetailMeta', 'historyDetailQaReport',
    'historyVersionList', 'historyTagEditor', 'regenerateHistoryDetail',
    'closeHistoryDetail', 'historyGrid', 'historyEmpty', 'historyBatchBar',
    'historyFilters', 'historySearch', 'historyModelFilter', 'historySizeFilter',
    'historyDateFrom', 'historyDateTo', 'historyFavoritesOnly', 'historyCloudOnly',
    'selectVisibleHistory', 'deleteSelectedHistory', 'clearHistorySelection',
    'saveHistoryTags', 'hidePromptInShare', 'historyCloudSection', 'historyCloudMeta',
    'openHistoryCloudShare', 'openHistoryCloudDelete', 'historyStatus',
    'generationWorkspace', 'workspaceDivider', 'toggleGenerationControls',
    'promptStyle', 'batchCount', 'visionQa', 'effectPrompt', 'applyEffect',
    'advancedSettings', 'clearLocalData', 'closeLicensePolicy',
    'closePrivacyPolicy', 'copyPrompt', 'copySettings', 'customSizeFields',
    'devTuning', 'dismissPwaUpdate', 'generationPreview', 'mobileGenerate',
    'mobileGenerateBar', 'mobileGenerateSummary', 'openLicensePolicy',
    'openPrivacyPolicy', 'previewActual', 'previewFit', 'pwaUpdateNotice',
    'qualityPresetHint', 'random', 'regenerate', 'reloadPwa', 'resultHeading',
    'turnstileGate', 'turnstileStatus', 'turnstileWidget', 'useCase',
    'useComposition',
  ]) {
    elements[id] = makeElement(id, ['prompt', 'plainPrompt', 'avoid'].includes(id) ? 'textarea' : 'div');
  }

  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement('', tag),
    addEventListener: (type, handler) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    dispatchEvent: () => true,
    activeElement: null,
    body: makeElement('body', 'body'),
    head: makeElement('head', 'head')
  };

  const storeData = {};
  const windowObj = {
    document: document,
    addEventListener: () => {},
    localStorage: {
      getItem: (k) => (k in storeData ? storeData[k] : null),
      setItem: (k, v) => { storeData[k] = String(v); },
      removeItem: (k) => { delete storeData[k]; }
    },
    location: { href: 'http://localhost/', pathname: '/', hash: '', search: '' },
    requestAnimationFrame: (fn) => fn(),
    matchMedia: () => ({ matches: false }),
    confirm: () => true,
    showTab: () => true,
    ElapsedTimer: { start: () => ({ stop: () => 1 }) }
  };

  const fetchMock = (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    fetchCalls.push({ url: url, body: body });
    if (url === '/generate') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          image: 'data:image/png;base64,AAAA',
          provider: 'mock', model: 'schnell', width: 1024, height: 1024, seed: 777
        })
      });
    }
    if (url === '/prompt/transform') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ prompt: EDITED_PROVIDER_PROMPT, provider: 'mock-transform' })
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };

  const context = vm.createContext({
    window: windowObj,
    fetch: fetchMock,
    document: document,
    navigator: { userAgent: 'test' },
    performance: { now: () => 1000 },
    Event: class Event { constructor(t) { this.type = t; } },
    CustomEvent: class CustomEvent { constructor(t, o) { this.type = t; this.detail = o ? o.detail : null; } },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Blob: class Blob {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Uint8Array: Uint8Array
  });
  context.globalThis = windowObj;

  for (const file of ['generation-settings.js', 'app.js', 'history-store.js', 'history-wall.js']) {
    vm.runInContext(load(file), context, { filename: file });
  }
  context.GenerationSettings = windowObj.GenerationSettings;
  context.ImageHistoryStore = windowObj.ImageHistoryStore;

  const fire = (key) => (listeners[key] || []).forEach((fn) => fn());
  const tick = async (n) => {
    for (let i = 0; i < (n || 4); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const generateBodies = () => fetchCalls.filter((c) => c.url === '/generate').map((c) => c.body);
  const transformBodies = () => fetchCalls.filter((c) => c.url === '/prompt/transform').map((c) => c.body);

  return { windowObj, elements, listeners, fetchCalls, fire, tick, generateBodies, transformBodies };
}

const CAT_RECORD = {
  id: 'cat-1',
  image: 'data:image/png;base64,CAT',
  thumbnail: 'data:image/png;base64,CAT',
  prompt: USER_PROMPT,
  providerPrompt: PROVIDER_WITH_AVOID,
  avoid: AVOID_TEXT,
  model: 'schnell',
  size: 'square',
  steps: null,
  cfgScale: null,
  seed: 777,
  width: 1024,
  height: 1024,
  provider: 'mock',
  mode: 'normal'
};

async function generateOnce(env) {
  // Simulate the user having generated the cat through the normal flow.
  env.elements['plainPrompt'].value = USER_PROMPT;
  env.elements['prompt'].value = PROVIDER_PROMPT;
  env.elements['avoid'].value = AVOID_TEXT;
  const p = env.windowObj.ImageGenApp.generate();
  await env.tick();
  return p;
}

test('canvas 「🔁 再生一張」 reuses the stored provider prompt, not the Chinese description', async () => {
  const env = setupEnvironment();
  env.fire('DOMContentLoaded');
  await generateOnce(env);
  assert.equal(env.generateBodies().length, 1);
  assert.equal(env.generateBodies()[0].prompt, PROVIDER_WITH_AVOID);

  // The composer moved on; regenerate must restore the record settings itself.
  env.elements['plainPrompt'].value = '';
  env.elements['prompt'].value = '';
  env.elements['avoid'].value = '';
  env.fetchCalls.length = 0;

  env.fire('regenerate:click');
  await env.tick();

  const bodies = env.generateBodies();
  assert.equal(bodies.length, 1, 'expected exactly one /generate call');
  assert.equal(bodies[0].userPrompt, USER_PROMPT, 'recorded description must stay the original text');
  assert.equal(
    bodies[0].prompt,
    PROVIDER_WITH_AVOID,
    'regenerate must resend the stored provider prompt without re-appending avoid; got ' + JSON.stringify(bodies[0].prompt)
  );
});

test('history detail 「以此版本再生」 reuses the stored provider prompt', async () => {
  const env = setupEnvironment();
  const { ImageHistoryStore, ImageHistoryWall } = env.windowObj;
  ImageHistoryStore.saveRecords([CAT_RECORD]);
  env.fire('DOMContentLoaded');

  ImageHistoryWall.openHistoryDetail(CAT_RECORD);
  ImageHistoryWall.regenerateHistoryDetail();
  await env.tick();

  const bodies = env.generateBodies();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].userPrompt, USER_PROMPT);
  assert.equal(bodies[0].prompt, PROVIDER_WITH_AVOID);
});

test('lock-composition then editing the description recompiles instead of posting a stale prompt', async () => {
  const env = setupEnvironment();
  env.fire('DOMContentLoaded');
  await generateOnce(env);

  const record = env.windowObj.ImageGenApp.getLastGeneration();
  assert.ok(record);
  env.fetchCalls.length = 0;

  // 🔧 以這張構圖再變化 → locks the seed, restores settings for tweaking.
  assert.equal(env.windowObj.ImageGenApp.lockCompositionFromRecord(record), true);

  // User edits the description, then generates the tweak.
  env.elements['plainPrompt'].value = EDITED_PROMPT;
  env.fire('plainPrompt:input');
  env.windowObj.ImageGenApp.generate();
  await env.tick();

  const transforms = env.transformBodies();
  const bodies = env.generateBodies();
  assert.equal(transforms.length, 1, 'edited description must be recompiled through /prompt/transform');
  assert.equal(transforms[0].source, EDITED_PROMPT);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].userPrompt, EDITED_PROMPT);
  assert.equal(
    bodies[0].prompt,
    EDITED_WITH_AVOID,
    'edited description must produce a fresh provider prompt; got ' + JSON.stringify(bodies[0].prompt)
  );
});

test('history regenerate then editing the description does not reuse the stale provider prompt', async () => {
  const env = setupEnvironment();
  const { ImageHistoryStore, ImageHistoryWall, ImageGenApp } = env.windowObj;
  ImageHistoryStore.saveRecords([CAT_RECORD]);
  env.fire('DOMContentLoaded');

  ImageHistoryWall.openHistoryDetail(CAT_RECORD);
  ImageHistoryWall.regenerateHistoryDetail();
  await env.tick();
  env.fetchCalls.length = 0;

  // After regenerating, editing the description must invalidate the restored prompt.
  env.elements['plainPrompt'].value = EDITED_PROMPT;
  env.fire('plainPrompt:input');
  ImageGenApp.generate();
  await env.tick();

  const transforms = env.transformBodies();
  const bodies = env.generateBodies();
  assert.equal(transforms.length, 1, 'edited description must be recompiled through /prompt/transform');
  assert.equal(transforms[0].source, EDITED_PROMPT);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].userPrompt, EDITED_PROMPT);
  assert.equal(bodies[0].prompt, EDITED_WITH_AVOID);
});
