const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appJsPath = path.resolve(__dirname, '../../app/static/app.js');
const appJsSource = fs.readFileSync(appJsPath, 'utf8');

function setupEnvironment(options = {}) {
  const isOldBrowser = options.isOldBrowser || false;
  const elements = {};
  const sessionStorageStore = {};

  function makeElement(id, tag = 'div') {
    const classList = new Set();
    const attrs = {};
    const elem = {
      id: id,
      tagName: tag.toUpperCase(),
      textContent: '',
      className: '',
      hidden: false,
      style: {},
      parentNode: null,
      children: [],
      classList: {
        add: (...cls) => cls.forEach(c => classList.add(c)),
        remove: (...cls) => cls.forEach(c => classList.delete(c)),
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
      getAttribute: (k) => attrs[k] !== undefined ? attrs[k] : null,
      removeAttribute: (k) => { delete attrs[k]; },
      appendChild: (child) => {
        child.parentNode = elem;
        elem.children.push(child);
      },
      removeChild: (child) => {
        child.parentNode = null;
        const idx = elem.children.indexOf(child);
        if (idx !== -1) elem.children.splice(idx, 1);
      },
      insertBefore: (newNode, refNode) => {
        newNode.parentNode = elem;
        const idx = elem.children.indexOf(refNode);
        if (idx !== -1) {
          elem.children.splice(idx, 0, newNode);
        } else {
          elem.children.push(newNode);
        }
      },
      remove: () => {
        if (elem.parentNode) {
          elem.parentNode.removeChild(elem);
        }
      },
      addEventListener: () => {},
      focus: () => {}
    };
    return elem;
  }

  const body = makeElement('body', 'body');
  const main = makeElement('main', 'main');
  body.appendChild(main);

  const oldbrowser = makeElement('oldbrowser');
  oldbrowser.hidden = true;
  oldbrowser.setAttribute('aria-hidden', 'true');
  main.appendChild(oldbrowser);
  elements['oldbrowser'] = oldbrowser;

  const demoNotice = makeElement('demo-notice');
  demoNotice.hidden = true;
  demoNotice.setAttribute('aria-hidden', 'true');
  main.appendChild(demoNotice);
  elements['demo-notice'] = demoNotice;

  const hero = makeElement('hero', 'header');
  hero.className = 'hero';
  main.appendChild(hero);
  elements['hero'] = hero;

  const pwaUpdateNotice = makeElement('pwaUpdateNotice');
  pwaUpdateNotice.hidden = true;
  pwaUpdateNotice.setAttribute('aria-hidden', 'true');
  main.appendChild(pwaUpdateNotice);
  elements['pwaUpdateNotice'] = pwaUpdateNotice;

  const reloadPwa = makeElement('reloadPwa', 'button');
  elements['reloadPwa'] = reloadPwa;

  const dismissPwaUpdate = makeElement('dismissPwaUpdate', 'button');
  elements['dismissPwaUpdate'] = dismissPwaUpdate;

  const go = makeElement('go', 'button');
  elements['go'] = go;

  // standard fields to prevent app.js init errors
  elements['status'] = makeElement('status');
  elements['plainPrompt'] = makeElement('plainPrompt', 'textarea');
  elements['prompt'] = makeElement('prompt', 'textarea');
  elements['avoid'] = makeElement('avoid', 'textarea');
  elements['model'] = makeElement('model', 'select');
  elements['size'] = makeElement('size', 'select');
  elements['seed'] = makeElement('seed', 'input');
  elements['seedRandom'] = makeElement('seedRandom', 'button');
  elements['seedLock'] = makeElement('seedLock', 'button');
  elements['appToast'] = makeElement('appToast');
  elements['stage'] = makeElement('stage');
  elements['provider-pill'] = makeElement('provider-pill');
  elements['provider-text'] = makeElement('provider-text');

  const document = {
    body: body,
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel === '.hero') return hero;
      if (sel === '.topbar') return null;
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => makeElement('', tag),
    addEventListener: () => {},
    dispatchEvent: () => true
  };

  const windowObj = {
    document: document,
    addEventListener: () => {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    sessionStorage: {
      getItem: (k) => sessionStorageStore[k] || null,
      setItem: (k, v) => { sessionStorageStore[k] = String(v); },
      removeItem: (k) => { delete sessionStorageStore[k]; }
    },
    location: { href: 'http://localhost/', pathname: '/', hash: '', search: '', reload: () => { windowObj._reloaded = true; } },
    Blob: isOldBrowser ? undefined : class Blob {},
    URL: isOldBrowser ? undefined : { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    CustomEvent: isOldBrowser ? undefined : class CustomEvent { constructor(t, o) { this.type = t; this.detail = o ? o.detail : null; } },
    Uint8Array: isOldBrowser ? undefined : Uint8Array,
    JSON: JSON,
    fetch: isOldBrowser ? undefined : () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    Promise: isOldBrowser ? undefined : Promise
  };

  const context = vm.createContext({
    window: windowObj,
    document: document,
    navigator: { userAgent: 'test-agent' },
    performance: { now: () => 1000 },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval
  });
  context.globalThis = windowObj;

  vm.runInContext(appJsSource, context, { filename: appJsPath });
  return { context, window: windowObj, elements, main, sessionStorageStore };
}

test('Issue #5: modern browsers cleanly remove #oldbrowser from DOM', () => {
  const { elements, main } = setupEnvironment({ isOldBrowser: false });
  // In modern browsers, #oldbrowser must be unmounted/removed from parent
  assert.equal(elements['oldbrowser'].parentNode, null);
  assert.ok(!main.children.includes(elements['oldbrowser']));
});

test('Issue #5: truly outdated browsers display #oldbrowser and disable generate button', () => {
  const { elements } = setupEnvironment({ isOldBrowser: true });
  assert.equal(elements['oldbrowser'].hidden, false);
  assert.equal(elements['oldbrowser'].style.display, 'block');
  assert.equal(elements['go'].disabled, true);
  assert.equal(elements['go'].textContent, '不支援');
});

test('Issue #5: showDemoNotice(false) completely removes demo banner from DOM', () => {
  const { window, elements, main } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;

  // Real provider ready -> showDemoNotice(false)
  ImageGenApp.showDemoNotice(false);
  assert.equal(elements['demo-notice'].parentNode, null);
  assert.equal(elements['demo-notice'].hidden, true);
  assert.equal(elements['demo-notice'].getAttribute('aria-hidden'), 'true');
  assert.ok(!main.children.includes(elements['demo-notice']));

  // If switched back to demo mode -> showDemoNotice(true) re-attaches before .hero
  ImageGenApp.showDemoNotice(true);
  assert.ok(elements['demo-notice'].parentNode !== null);
  assert.equal(elements['demo-notice'].hidden, false);
  assert.equal(elements['demo-notice'].getAttribute('aria-hidden'), null);
});

test('Issue #5: dismissPwaUpdateNotice hides notice and persists session dismissal', () => {
  const { window, elements, sessionStorageStore } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;

  // Show notice first
  ImageGenApp.showPwaUpdateNotice({ waiting: null });
  assert.equal(elements['pwaUpdateNotice'].hidden, false);

  // Dismiss it
  ImageGenApp.dismissPwaUpdateNotice();
  assert.equal(elements['pwaUpdateNotice'].hidden, true);
  assert.equal(elements['pwaUpdateNotice'].getAttribute('aria-hidden'), 'true');
  assert.equal(sessionStorageStore['fluxi_pwa_update_dismissed'], 'true');

  // Next registration/event in the same session does not re-show it
  ImageGenApp.showPwaUpdateNotice({ waiting: null });
  assert.equal(elements['pwaUpdateNotice'].hidden, true);
});

test('Issue #5: reloadPwaVersion hides notice, clears session flag, and posts SKIP_WAITING', () => {
  const { window, elements, sessionStorageStore } = setupEnvironment();
  const ImageGenApp = window.ImageGenApp;

  let messagePosted = null;
  const mockRegistration = {
    waiting: {
      postMessage: (msg) => { messagePosted = msg; }
    }
  };

  sessionStorageStore['fluxi_pwa_update_dismissed'] = 'true';
  ImageGenApp.showPwaUpdateNotice(mockRegistration);
  ImageGenApp.reloadPwaVersion();

  assert.equal(elements['pwaUpdateNotice'].hidden, true);
  assert.equal(sessionStorageStore['fluxi_pwa_update_dismissed'], undefined);
  assert.equal(messagePosted && messagePosted.type, 'SKIP_WAITING');
});
