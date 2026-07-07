// Curated FLUX-tuned prompt pack. Self-mounting: fetches prompt-pack.json and
// renders a "精選提示詞" section after the ideas section. Clicking a card sets the
// model/size and fills the final prompt for review — same no-auto-spend behaviour as the
// built-in idea cards. No edits to the main app modules required.
(function () {
  'use strict';

  var PACK_URL = '/static/prompt-pack.json';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setSelect(id, value) {
    var select = document.getElementById(id);
    if (!select || !value) return;
    var hasOption = Array.prototype.some.call(select.options, function (opt) {
      return opt.value === value;
    });
    if (!hasOption) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyCard(card) {
    var app = window.ImageGenApp;
    setSelect('model', card.model);
    setSelect('size', card.size);
    if (app && typeof app.setPromptForReview === 'function') {
      app.setPromptForReview(card.en, '精選提示詞');
    } else if (app && typeof app.setPromptAndGenerate === 'function') {
      app.setPromptAndGenerate(card.en);
    } else {
      // Fallback: fill the prompt box if the app API isn't ready yet.
      var field = document.getElementById('prompt');
      if (field) field.value = card.en;
    }
  }

  function buildCard(card) {
    var button = el('button', 'idea');
    button.type = 'button';
    button.title = card.zh ? card.zh + '\n\n' + card.en : card.en;
    button.setAttribute('aria-label', (card.title || '精選提示詞') + (card.zh ? '：' + card.zh : ''));
    button.appendChild(el('span', 'emo', card.emoji || '✨'));
    button.appendChild(el('span', 'lbl', card.title || ''));
    button.addEventListener('click', function () {
      applyCard(card);
    });
    return button;
  }

  function render(pack) {
    var categories = (pack && pack.categories) || [];
    if (!categories.length) return;

    var section = el('section', 'ideas prompt-pack');
    section.setAttribute('aria-label', '精選提示詞');

    var title = el('div', 'ideas-title');
    title.appendChild(document.createTextNode('✨ 精選提示詞'));
    var hint = el('span', 'hint', '（為 FLUX 調校 · 點一下直接出圖）');
    title.appendChild(hint);
    section.appendChild(title);

    // Each category is collapsible (collapsed by default, first one open as a
    // preview) so 72 cards take ~12 compact rows instead of a tall wall.
    categories.forEach(function (category, index) {
      var cards = (category && category.cards) || [];
      if (!cards.length) return;
      var details = el('details', 'pack-cat');
      if (index === 0) { details.open = true; }
      var summary = el('summary', 'pack-group-label',
        (category.emoji ? category.emoji + ' ' : '') + (category.label || '') + ' (' + cards.length + ')');
      summary.style.cssText = 'cursor:pointer;margin:10px 0 6px;font-size:0.85rem;font-weight:600;opacity:0.75;';
      details.appendChild(summary);
      var grid = el('div', 'idea-grid');
      cards.forEach(function (card) {
        var withEmoji = card;
        if (!card.emoji && category.emoji) {
          withEmoji = {};
          for (var key in card) {
            if (Object.prototype.hasOwnProperty.call(card, key)) {
              withEmoji[key] = card[key];
            }
          }
          withEmoji.emoji = category.emoji;
        }
        grid.appendChild(buildCard(withEmoji));
      });
      details.appendChild(grid);
      section.appendChild(details);
    });

    var anchor = document.querySelector('section.ideas');
    if (anchor && anchor.parentNode) {
      anchor.insertAdjacentElement('afterend', section);
    } else {
      var stage = document.getElementById('stage');
      if (stage && stage.parentNode) {
        stage.parentNode.insertBefore(section, stage);
      } else {
        document.body.appendChild(section);
      }
    }
  }

  ready(function () {
    fetch(PACK_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('prompt-pack HTTP ' + res.status);
        return res.json();
      })
      .then(render)
      .catch(function (err) {
        // Non-fatal: the curated pack is an enhancement, not a core feature.
        if (window.console && console.warn) {
          console.warn('[prompt-pack] failed to load:', err && err.message);
        }
      });
  });

  // Load the optional live HF prompt-sampling panel without touching index.html.
  ready(function () {
    var s = document.createElement('script');
    s.src = '/static/hf-ideas.js';
    s.defer = true;
    document.head.appendChild(s);
  });
})();
