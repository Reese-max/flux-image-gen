// 功能分頁：把「生成 / 改圖 / 歷史」拆成可點選切換的分頁，避免全部擠在同一頁。
// 純 DOM，ES5 相容（本專案靜態 JS 需通過 ES5 檢查）。切換時更新 ARIA 狀態、
// body[data-tab]（供 CSS 隱藏手機生成列等）、並記住上次分頁；支援左右方向鍵。
(function () {
  'use strict';
  if (typeof document === 'undefined') { return; }

  var tablist = document.querySelector('.tabs[role="tablist"]');
  if (!tablist) { return; }
  var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
  if (!tabs.length) { return; }
  var STORAGE_KEY = 'imggen.activeTab';

  function panelFor(tab) {
    return document.getElementById(tab.getAttribute('aria-controls'));
  }

  function activate(name, focusTab) {
    var matched = false;
    tabs.forEach(function (tab) {
      var isActive = tab.getAttribute('data-tab') === name;
      if (isActive) { matched = true; }
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.setAttribute('tabindex', isActive ? '0' : '-1');
      tab.classList.toggle('is-active', isActive);
      var panel = panelFor(tab);
      if (panel) { panel.hidden = !isActive; }
      if (isActive && focusTab) { tab.focus(); }
    });
    if (matched) {
      document.body.setAttribute('data-tab', name);
      try { localStorage.setItem(STORAGE_KEY, name); } catch (e) { /* 隱私模式忽略 */ }
    }
    return matched;
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () {
      activate(tab.getAttribute('data-tab'), false);
    });
    tab.addEventListener('keydown', function (e) {
      var dir = 0;
      if (e.key === 'ArrowRight' || e.key === 'Down' || e.key === 'ArrowDown') { dir = 1; }
      else if (e.key === 'ArrowLeft' || e.key === 'Up' || e.key === 'ArrowUp') { dir = -1; }
      else if (e.key === 'Home') { activate(tabs[0].getAttribute('data-tab'), true); e.preventDefault(); return; }
      else if (e.key === 'End') { activate(tabs[tabs.length - 1].getAttribute('data-tab'), true); e.preventDefault(); return; }
      if (dir === 0) { return; }
      e.preventDefault();
      var next = (index + dir + tabs.length) % tabs.length;
      activate(tabs[next].getAttribute('data-tab'), true);
    });
  });

  // 靈感分頁的卡片是「點一下直接出圖」，但結果/狀態顯示在生成分頁；因此點到任何
  // 會生成的靈感卡（內建 .idea、客製 .idea.custom-idea、精選 .idea）就自動切回
  // 生成分頁，讓使用者看得到產圖進度與結果。用事件委派，涵蓋動態插入的卡片；
  // 編輯鈕(.card-edit)與新增/匯出等工具鈕沒有 .idea class，不會誤觸切頁。
  var ideasPanel = document.getElementById('panel-ideas');
  if (ideasPanel) {
    ideasPanel.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== ideasPanel) {
        if (node.classList && node.classList.contains('idea')) {
          activate('generate', false);
          return;
        }
        node = node.parentNode;
      }
    });
  }

  // 還原上次選的分頁；失敗（或沒存過）就回到第一個「生成」。
  var saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { saved = null; }
  if (!saved || !activate(saved, false)) {
    activate(tabs[0].getAttribute('data-tab'), false);
  }

  // 讓其他腳本可主動切換分頁（例如未來從別頁跳回生成）。
  window.showTab = function (name) { return activate(name, false); };
})();
