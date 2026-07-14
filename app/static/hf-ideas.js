// Random inspiration panel backed by the existing curated prompt pack.
// The filename stays stable because prompt-pack.js lazy-loads this asset.
(function () {
  'use strict';

  var PACK_URL = '/static/prompt-pack.json';
  var SHOW = 10;
  var prompts = [];
  var pending = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function shuffle(items) {
    for (var i = items.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  function loadPrompts() {
    if (prompts.length) return Promise.resolve(prompts);
    if (pending) return pending;
    pending = fetch(PACK_URL, { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('prompt-pack HTTP ' + response.status);
        return response.json();
      })
      .then(function (pack) {
        ((pack && pack.categories) || []).forEach(function (category) {
          ((category && category.cards) || []).forEach(function (card) {
            if (card && card.en) prompts.push(card.en);
          });
        });
        if (!prompts.length) throw new Error('prompt pack is empty');
        return prompts;
      });
    return pending;
  }

  function usePrompt(prompt) {
    var app = window.ImageGenApp;
    if (app && typeof app.setPromptForReview === 'function') {
      app.setPromptForReview(prompt, '隨機精選提示詞');
    } else {
      var field = document.getElementById('prompt');
      if (field) field.value = prompt;
    }
  }

  function buildCard(prompt) {
    var card = el('button', 'idea-prompt');
    card.type = 'button';
    card.title = '使用這個提示詞';
    card.style.cssText = 'text-align:left;display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid rgba(255,255,255,0.1);border-radius:12px;background:rgba(255,255,255,0.03);cursor:pointer;color:inherit;font:inherit;line-height:1.4;';
    var text = el('span', null, prompt.length > 160 ? prompt.slice(0, 160) + '…' : prompt);
    text.style.cssText = 'font-size:0.86rem;opacity:0.92;';
    card.appendChild(text);
    var action = el('span', null, '用這個 →');
    action.style.cssText = 'font-size:0.74rem;opacity:0.6;align-self:flex-end;';
    card.appendChild(action);
    card.addEventListener('click', function () { usePrompt(prompt); });
    return card;
  }

  function showBatch(grid, status, button) {
    status.textContent = '載入精選提示詞…';
    button.disabled = true;
    loadPrompts()
      .then(function () {
        grid.textContent = '';
        shuffle(prompts.slice()).slice(0, SHOW).forEach(function (prompt) {
          grid.appendChild(buildCard(prompt));
        });
        status.textContent = '';
      })
      .catch(function () {
        status.textContent = '精選提示詞暫時無法載入，稍後再試。';
      })
      .then(function () { button.disabled = false; });
  }

  function mount() {
    var section = el('section', 'ideas hf-ideas');
    section.setAttribute('aria-label', '隨機靈感');
    var title = el('div', 'ideas-title');
    title.appendChild(document.createTextNode('🎲 隨機靈感'));
    title.appendChild(el('span', 'hint', '（從精選提示詞庫隨機抽取 · 不會自動消耗額度）'));
    section.appendChild(title);

    var controls = el('div');
    controls.style.cssText = 'display:flex;gap:8px;align-items:center;margin:8px 0;';
    var button = el('button', 'btn mini secondary', '🎲 抽一批靈感');
    button.type = 'button';
    var status = el('span', 'hint', '');
    controls.appendChild(button);
    controls.appendChild(status);
    section.appendChild(controls);

    var grid = el('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:6px;';
    section.appendChild(grid);
    button.addEventListener('click', function () {
      button.textContent = '🔄 換一批';
      showBatch(grid, status, button);
    });

    var anchor = document.querySelector('section.prompt-pack') || document.querySelector('section.ideas');
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', section);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
