// 功能分頁：「生成圖片 / AI 改圖 / 歷史作品」三個可點選切換的分頁。
// 純 DOM，ES5 相容（本專案靜態 JS 需通過 ES5 檢查）。功能：
//  - 切換時更新 ARIA 狀態、body[data-tab]（供 CSS 隱藏手機生成列等）、記住上次分頁
//  - URL hash 深連結（生成分頁使用乾淨根網址；#edit/#projects/#history 可分享/加書籤、支援上一頁/下一頁）
//  - 相容 hash：#ideas 導向生成分頁並捲動到靈感 section；#usage 顯示無 tab 按鈕的
//    站長工具 panel（footer「站長工具」連結也指到 #usage）
//  - 左右/上下/Home/End 方向鍵，以及數字鍵（依 tabs 數量動態）快速切換
//  - window.setHistoryCount(n)：更新歷史分頁上的數量徽章
(function () {
  'use strict';
  if (typeof document === 'undefined') { return; }

  var tablist = document.querySelector('.tabs[role="tablist"]');
  if (!tablist) { return; }
  var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
  if (!tabs.length) { return; }
  var STORAGE_KEY = 'imggen.activeTab';
  var current = null;
  // 「用量」panel 沒有 tab 按鈕（站長工具，從 footer #usage 直達），需個別管理顯示。
  var usagePanel = document.getElementById('panel-usage');
  // 靈感 section 已併入生成分頁；#ideas hash 相容導向時捲動到這裡。
  var ideasSection = document.getElementById('ideasSection');
  var FEATURE_SCRIPTS = {
    edit: ['/static/image-edit.js'],
    usage: ['/static/usage-dashboard.js']
  };
  var scriptLoads = {};
  var featureLoads = {};

  function loadScript(src) {
    if (scriptLoads[src]) { return scriptLoads[src]; }
    scriptLoads[src] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = function () {
        delete scriptLoads[src];
        reject(new Error('無法載入 ' + src));
      };
      document.head.appendChild(script);
    });
    return scriptLoads[src];
  }

  function loadFeatureScripts(name) {
    var sources = FEATURE_SCRIPTS[name] || [];
    var chain;
    if (!sources.length) { return Promise.resolve(); }
    if (featureLoads[name]) { return featureLoads[name]; }
    chain = Promise.resolve();
    sources.forEach(function (src) {
      chain = chain.then(function () { return loadScript(src); });
    });
    featureLoads[name] = chain.then(function () {
      var cachedHealth;
      if (name !== 'edit' || !window.ImageEdit) { return; }
      if (!window.ImageGenApp || typeof window.ImageGenApp.refreshProvider !== 'function') {
        window.ImageEdit.applyHealth({});
        return;
      }
      if (typeof window.ImageGenApp.getProviderHealth === 'function') {
        cachedHealth = window.ImageGenApp.getProviderHealth();
        if (cachedHealth) {
          window.ImageEdit.applyHealth(cachedHealth);
          return;
        }
      }
      return window.ImageGenApp.refreshProvider().then(function () {
        var button = document.getElementById('editGo');
        var status = document.getElementById('editStatus');
        if (button && button.disabled && !/尚未啟用 Workers AI 改圖/.test(status ? status.textContent : '')) {
          window.ImageEdit.applyHealth({});
        }
      });
    }).catch(function (error) {
      delete featureLoads[name];
      throw error;
    });
    return featureLoads[name];
  }

  function ensureFeatureScripts(name) {
    loadFeatureScripts(name).catch(function (error) {
      var statusIds = { edit: 'editStatus', projects: 'projectStatus', history: 'status', usage: 'usageStatus' };
      var status = document.getElementById(statusIds[name] || 'status');
      delete featureLoads[name];
      if (status) {
        status.textContent = '功能載入失敗，請重新整理後再試。';
        status.classList.add('fail');
      }
      if (window.console && console.error) { console.error(error); }
    });
  }

  window.ImageFeatureLoader = { load: loadFeatureScripts };

  function nameOf(tab) { return tab.getAttribute('data-tab'); }
  function panelFor(tab) { return document.getElementById(tab.getAttribute('aria-controls')); }
  function isKnown(name) {
    for (var i = 0; i < tabs.length; i++) { if (nameOf(tabs[i]) === name) { return true; } }
    return false;
  }

  function scrollToPanelStart(panel) {
    var panelRect;
    var tabsRect;
    var pageTop;
    var tabsHeight;
    var stickyTop = 0;
    if (!panel || typeof panel.getBoundingClientRect !== 'function' || typeof window.scrollTo !== 'function') { return; }
    panelRect = panel.getBoundingClientRect();
    tabsRect = typeof tablist.getBoundingClientRect === 'function' ? tablist.getBoundingClientRect() : null;
    pageTop = typeof window.pageYOffset === 'number' ? window.pageYOffset : ((document.documentElement && document.documentElement.scrollTop) || 0);
    tabsHeight = tabsRect && tabsRect.height ? tabsRect.height : (tablist.offsetHeight || 0);
    try { stickyTop = parseFloat(window.getComputedStyle(tablist).top) || 0; } catch (e) { stickyTop = 0; }
    window.scrollTo(0, Math.max(0, panelRect.top + pageTop - tabsHeight - stickyTop - 16));
  }

  function cleanUrl() {
    return location.pathname + location.search;
  }

  function updateUrlForTab(name) {
    if (name === 'generate') {
      if (!window.history || !window.history.replaceState || !window.history.pushState) {
        if (location.hash === '#generate') { location.hash = ''; }
        return;
      }
      if (location.hash === '#generate') {
        window.history.replaceState(null, '', cleanUrl());
      } else if (location.hash) {
        window.history.pushState(null, '', cleanUrl());
      }
      return;
    }
    if (name && ('#' + name) !== location.hash) { location.hash = name; }
  }

  // 套用分頁狀態（不含 hash 副作用），回傳是否成功切換。
  function activate(name, focusTab, options) {
    var activePanel = null;
    if (!isKnown(name)) { return false; }
    options = options || {};
    tabs.forEach(function (tab) {
      var isActive = nameOf(tab) === name;
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.setAttribute('tabindex', isActive ? '0' : '-1');
      tab.classList.toggle('is-active', isActive);
      var panel = panelFor(tab);
      if (panel) { panel.hidden = !isActive; }
      if (isActive) { activePanel = panel; }
      if (isActive && focusTab) { tab.focus(); }
    });
    // 用量 panel 不屬於任何 tab：切到任何一般分頁時一律隱藏（從 #usage 切回也適用）。
    if (usagePanel) { usagePanel.hidden = true; }
    current = name;
    document.body.setAttribute('data-tab', name);
    try { localStorage.setItem(STORAGE_KEY, name); } catch (e) { /* 隱私模式忽略 */ }
    // 讓 URL 反映目前分頁：生成分頁是根網址，其他分頁保留 hash 深連結。
    if (!options.keepHash) { updateUrlForTab(name); }
    if (!options.skipPanelScroll) { scrollToPanelStart(activePanel); }
    ensureFeatureScripts(name);
    return true;
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { activate(nameOf(tab), false); });
    tab.addEventListener('keydown', function (e) {
      var dir = 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { dir = 1; }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { dir = -1; }
      else if (e.key === 'Home') { activate(nameOf(tabs[0]), true); e.preventDefault(); return; }
      else if (e.key === 'End') { activate(nameOf(tabs[tabs.length - 1]), true); e.preventDefault(); return; }
      if (dir === 0) { return; }
      e.preventDefault();
      var next = (index + dir + tabs.length) % tabs.length;
      activate(nameOf(tabs[next]), true);
    });
  });

  // 數字鍵 1–4 快切（在輸入框/文字區/可編輯元素內不攔截，避免干擾打字）。
  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) { return; }
    var active = document.activeElement;
    if (active) {
      var tag = (active.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable) { return; }
    }
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= tabs.length) {
      e.preventDefault();
      activate(nameOf(tabs[n - 1]), true);
    }
  });

  // #ideas 相容導向：平滑捲動到生成分頁內的靈感 section（尊重 prefers-reduced-motion）。
  function scrollToIdeas() {
    if (!ideasSection || typeof ideasSection.scrollIntoView !== 'function') { return; }
    var reduced = false;
    try {
      reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { reduced = false; }
    try {
      ideasSection.scrollIntoView(reduced ? { block: 'start' } : { behavior: 'smooth', block: 'start' });
    } catch (e) {
      ideasSection.scrollIntoView();
    }
  }

  // 顯示「用量」panel（無 tab 按鈕）：隱藏所有一般 panel、tab 全部取消 active。
  // 不寫入 localStorage——站長工具不作為「上次分頁」記憶，重新整理回一般分頁。
  function showUsagePanel() {
    if (!usagePanel) { return false; }
    tabs.forEach(function (tab) {
      tab.setAttribute('aria-selected', 'false');
      tab.setAttribute('tabindex', '-1');
      tab.classList.remove('is-active');
      var panel = panelFor(tab);
      if (panel) { panel.hidden = true; }
    });
    usagePanel.hidden = false;
    current = 'usage';
    document.body.setAttribute('data-tab', 'usage');
    if (location.hash !== '#usage') { location.hash = 'usage'; }
    scrollToPanelStart(usagePanel);
    ensureFeatureScripts('usage');
    return true;
  }

  // hash 路由：一般分頁走 activate；#ideas 導向生成分頁＋捲動；#usage 顯示站長 panel。
  function applyHash(name, focusTab) {
    if (name === 'ideas') {
      var switched = activate('generate', false, { keepHash: true, skipPanelScroll: true });
      if (switched) { scrollToIdeas(); }
      return switched;
    }
    if (name === 'usage') { return showUsagePanel(); }
    return isKnown(name) ? activate(name, focusTab) : false;
  }

  // 瀏覽器上一頁/下一頁或手動改網址 → 依 hash 切分頁（含 #ideas/#usage 相容路由）。
  // hash 一律轉小寫，讓 #Ideas / #USAGE 之類也能命中；未知 hash 維持目前分頁，
  // 並用 replaceState 把無效 hash 清掉（不觸發 hashchange，也不污染上一頁紀錄）。
  window.addEventListener('hashchange', function () {
    var name = location.hash.replace(/^#/, '').toLowerCase();
    if (!name && current !== 'generate') {
      activate('generate', false);
      return;
    }
    if (name && name !== current) {
      if (!applyHash(name, false) && current && window.history && window.history.replaceState) {
        if (current === 'generate') {
          window.history.replaceState(null, '', cleanUrl());
        } else {
          window.history.replaceState(null, '', '#' + current);
        }
      }
    }
  });

  // 歷史分頁的數量徽章：由 history-wall 在每次渲染後呼叫。
  var historyBadge = document.getElementById('historyTabBadge');
  window.setHistoryCount = function (count) {
    if (!historyBadge) { return; }
    var n = parseInt(count, 10);
    if (n > 0) {
      historyBadge.textContent = n > 99 ? '99+' : String(n);
      historyBadge.hidden = false;
    } else {
      historyBadge.hidden = true;
    }
  };

  // 初始分頁優先序：URL hash（含 #ideas/#usage 相容路由）> 上次記住的 > 第一個「生成」。
  // 舊版 localStorage 可能存著 'ideas'/'usage'，isKnown 會擋下並回退到生成分頁。
  var fromHash = location.hash.replace(/^#/, '').toLowerCase();
  var saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { saved = null; }
  if (!(fromHash && applyHash(fromHash, false)) && !(saved && activate(saved, false, { skipPanelScroll: saved === 'generate' }))) {
    activate(nameOf(tabs[0]), false, { skipPanelScroll: true });
  }

  // 讓其他腳本可主動切換分頁（支援 'ideas'/'usage' 相容路由）。
  window.showTab = function (name) { return applyHash(String(name).toLowerCase(), false); };

  Array.prototype.slice.call(document.querySelectorAll('[data-open-history]')).forEach(function (button) {
    button.addEventListener('click', function () { activate('history', false); });
  });

  // 桌面畫布資訊列：同步目前畫質、尺寸、 Seed 模式與生成狀態。
  (function initCanvasMetadata() {
    var size = document.getElementById('size');
    var model = document.getElementById('model');
    var devSteps = document.getElementById('devSteps');
    var devCfgScale = document.getElementById('devCfgScale');
    var seed = document.getElementById('seed');
    var seedRandom = document.getElementById('seedRandom');
    var seedLock = document.getElementById('seedLock');
    var stage = document.getElementById('stage');
    var status = document.getElementById('status');
    var sizeMeta = document.getElementById('canvasSizeMeta');
    var modelMeta = document.getElementById('canvasModelMeta');
    var seedMeta = document.getElementById('canvasSeedMeta');
    var presetChip = document.getElementById('canvasPresetChip');
    var stateMeta = document.getElementById('canvasStateMeta');
    var statusbar = document.getElementById('canvasStatusbar');

    function selectedText(select) {
      return select && select.selectedIndex >= 0 ? select.options[select.selectedIndex].text : '';
    }
    function sizeText() {
      var text = selectedText(size);
      var match = text.match(/（([^）]+)）/);
      if (size && size.value === 'custom') {
        var width = document.getElementById('customWidth');
        var height = document.getElementById('customHeight');
        return (width ? width.value : '') + ' × ' + (height ? height.value : '');
      }
      return match ? match[1].replace('×', ' × ') : '自動尺寸';
    }
    function qualityText() {
      var steps = devSteps ? devSteps.value.trim() : '';
      var cfg = devCfgScale ? devCfgScale.value.trim() : '';
      if (!model || model.value !== 'dev') { return '快速草稿'; }
      if (!steps && !cfg) { return '平衡'; }
      if (steps === '10' && cfg === '3') { return '草稿'; }
      if (steps === '45' && cfg === '4') { return '精緻'; }
      return '自訂';
    }
    function updateSettings() {
      var currentSize = sizeText();
      var currentModel = qualityText();
      var locked = seedLock && seedLock.getAttribute('aria-pressed') === 'true';
      var currentSeed = locked && seed && seed.value ? 'Seed ' + seed.value : (locked ? 'Seed 鎖定' : 'Seed 自動');
      if (sizeMeta) { sizeMeta.textContent = currentSize; }
      if (presetChip) { presetChip.textContent = currentSize; }
      if (modelMeta) { modelMeta.textContent = currentModel; }
      if (seedMeta) { seedMeta.textContent = currentSeed; }
    }
    function updateState() {
      var busy = stage && stage.getAttribute('aria-busy') === 'true';
      var text = status ? status.textContent : '';
      var state = 'idle';
      var label = '待命';
      if (busy) { state = 'busy'; label = '生成中'; }
      else if (/完成/.test(text)) { state = 'done'; label = '完成'; }
      else if (/失敗|出錯|請先/.test(text)) { state = 'error'; label = '需要處理'; }
      if (stateMeta) { stateMeta.textContent = label; }
      if (statusbar) { statusbar.setAttribute('data-state', state); }
    }
    function bindChange(element) {
      if (!element) { return; }
      element.addEventListener('change', updateSettings);
      element.addEventListener('input', updateSettings);
      element.addEventListener('click', function () { window.setTimeout(updateSettings, 0); });
    }

    bindChange(size);
    bindChange(model);
    bindChange(devSteps);
    bindChange(devCfgScale);
    bindChange(seed);
    bindChange(seedRandom);
    bindChange(seedLock);
    bindChange(document.getElementById('customWidth'));
    bindChange(document.getElementById('customHeight'));
    document.addEventListener('imagegen:quality-changed', updateSettings);
    updateSettings();
    updateState();

    if (typeof MutationObserver !== 'undefined') {
      if (stage) {
        new MutationObserver(updateState).observe(stage, { attributes: true, attributeFilter: ['aria-busy'], childList: true, subtree: true });
      }
      if (status) {
        new MutationObserver(updateState).observe(status, { childList: true, subtree: true, characterData: true });
      }
      if (seedRandom) {
        new MutationObserver(updateSettings).observe(seedRandom, { attributes: true, attributeFilter: ['aria-pressed'] });
      }
      if (seedLock) {
        new MutationObserver(updateSettings).observe(seedLock, { attributes: true, attributeFilter: ['aria-pressed'] });
      }
    }
  })();
})();
