// 功能分頁：「生成圖片 / AI 改圖 / 專案 / 歷史作品」四個可點選切換的分頁。
// 純 DOM，ES5 相容（本專案靜態 JS 需通過 ES5 檢查）。功能：
//  - 切換時更新 ARIA 狀態、body[data-tab]（供 CSS 隱藏手機生成列等）、記住上次分頁
//  - URL hash 深連結（#generate/#edit/#projects/#history）：可分享/加書籤、支援上一頁/下一頁
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

  function nameOf(tab) { return tab.getAttribute('data-tab'); }
  function panelFor(tab) { return document.getElementById(tab.getAttribute('aria-controls')); }
  function isKnown(name) {
    for (var i = 0; i < tabs.length; i++) { if (nameOf(tabs[i]) === name) { return true; } }
    return false;
  }

  // 套用分頁狀態（不含 hash 副作用），回傳是否成功切換。
  function activate(name, focusTab) {
    if (!isKnown(name)) { return false; }
    tabs.forEach(function (tab) {
      var isActive = nameOf(tab) === name;
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.setAttribute('tabindex', isActive ? '0' : '-1');
      tab.classList.toggle('is-active', isActive);
      var panel = panelFor(tab);
      if (panel) { panel.hidden = !isActive; }
      if (isActive && focusTab) { tab.focus(); }
    });
    // 用量 panel 不屬於任何 tab：切到任何一般分頁時一律隱藏（從 #usage 切回也適用）。
    if (usagePanel) { usagePanel.hidden = true; }
    current = name;
    document.body.setAttribute('data-tab', name);
    try { localStorage.setItem(STORAGE_KEY, name); } catch (e) { /* 隱私模式忽略 */ }
    // 讓 URL 反映目前分頁（可分享/加書籤/上一頁）；只在不同時才寫，避免 hashchange 迴圈。
    if (name && ('#' + name) !== location.hash) { location.hash = name; }
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
    return true;
  }

  // hash 路由：一般分頁走 activate；#ideas 導向生成分頁＋捲動；#usage 顯示站長 panel。
  function applyHash(name, focusTab) {
    if (name === 'ideas') {
      var switched = activate('generate', false);
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
    if (name && name !== current) {
      if (!applyHash(name, false) && current && window.history && window.history.replaceState) {
        window.history.replaceState(null, '', '#' + current);
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
  if (!(fromHash && applyHash(fromHash, false)) && !(saved && activate(saved, false))) {
    activate(nameOf(tabs[0]), false);
  }

  // 讓其他腳本可主動切換分頁（支援 'ideas'/'usage' 相容路由）。
  window.showTab = function (name) { return applyHash(String(name).toLowerCase(), false); };
})();
