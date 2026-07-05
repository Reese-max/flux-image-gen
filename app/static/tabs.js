// 功能分頁：把「生成 / 靈感 / 改圖 / 歷史」拆成可點選切換的分頁，避免全部擠在同一頁。
// 純 DOM，ES5 相容（本專案靜態 JS 需通過 ES5 檢查）。功能：
//  - 切換時更新 ARIA 狀態、body[data-tab]（供 CSS 隱藏手機生成列等）、記住上次分頁
//  - URL hash 深連結（#generate/#ideas/#edit/#history）：可分享/加書籤、支援上一頁/下一頁
//  - 左右/上下/Home/End 方向鍵，以及數字鍵 1–4 快速切換
//  - 靈感卡「點一下直接出圖」會自動切回生成分頁看結果
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

  // 靈感分頁的卡片是「點一下直接出圖」，但結果/狀態顯示在生成分頁；因此點到任何
  // 會生成的靈感卡（內建 .idea、客製 .idea.custom-idea、精選 .idea）就自動切回
  // 生成分頁。用事件委派，涵蓋動態插入的卡片；編輯鈕(.card-edit)與新增/匯出等
  // 工具鈕沒有 .idea class，不會誤觸切頁。
  var ideasPanel = document.getElementById('panel-ideas');
  if (ideasPanel) {
    ideasPanel.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== ideasPanel) {
        if (node.classList && node.classList.contains('idea')) { activate('generate', false); return; }
        node = node.parentNode;
      }
    });
  }

  // 瀏覽器上一頁/下一頁或手動改網址 → 依 hash 切分頁。
  window.addEventListener('hashchange', function () {
    var name = location.hash.replace(/^#/, '');
    if (name && name !== current && isKnown(name)) { activate(name, false); }
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

  // 初始分頁優先序：URL hash > 上次記住的 > 第一個「生成」。
  var fromHash = location.hash.replace(/^#/, '');
  var saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { saved = null; }
  if (!(fromHash && activate(fromHash, false)) && !(saved && activate(saved, false))) {
    activate(nameOf(tabs[0]), false);
  }

  // 讓其他腳本可主動切換分頁。
  window.showTab = function (name) { return activate(name, false); };
})();
