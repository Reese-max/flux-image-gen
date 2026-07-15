// Curated FLUX-tuned prompt pack. Self-mounting: fetches prompt-pack.json and
// renders a "精選提示詞" section after the ideas section. Clicking a card sets the
// model/size and fills the final prompt for review — same no-auto-spend behaviour as the
// built-in idea cards. No edits to the main app modules required.
(function () {
  'use strict';

  var PACK_URL = '/static/prompt-pack.json';
  var TRANSPARENT_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  var lazyObserver = null;
  var hfIdeasRequested = false;

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

  function revealImage(img) {
    var source = img && img.getAttribute('data-src');
    if (!source) return;
    img.src = source;
    img.removeAttribute('data-src');
  }

  function observeLazyImages(root) {
    var images = (root || document).querySelectorAll('img[data-src]');
    if (!images.length) return;
    if (!window.IntersectionObserver) {
      Array.prototype.forEach.call(images, revealImage);
      return;
    }
    if (!lazyObserver) {
      lazyObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          lazyObserver.unobserve(entry.target);
          revealImage(entry.target);
        });
      }, { rootMargin: '100px 0px' });
    }
    Array.prototype.forEach.call(images, function (img) {
      if (!img.getAttribute('src')) {
        img.src = TRANSPARENT_PLACEHOLDER;
      }
      lazyObserver.observe(img);
    });
  }

  function loadHfIdeas() {
    if (hfIdeasRequested) return;
    hfIdeasRequested = true;
    var script = document.createElement('script');
    script.src = '/static/hf-ideas.js';
    script.defer = true;
    document.head.appendChild(script);
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

  function twoDigit(n) {
    return n < 10 ? '0' + n : String(n);
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
    if (card.preview) {
      var img = el('img', 'idea-thumb');
      img.width = 768;
      img.height = 768;
      img.setAttribute('data-src', card.preview);
      img.alt = card.title ? card.title + '範例圖' : '';
      img.loading = 'lazy';
      img.decoding = 'async';
      button.appendChild(img);
    } else {
      button.appendChild(el('span', 'emo', card.emoji || '✨'));
    }
    button.appendChild(el('span', 'lbl', card.title || ''));
    button.addEventListener('click', function () {
      applyCard(card);
    });
    return button;
  }

  function render(pack) {
    var categories = (pack && pack.categories) || [];
    var totalCards = 0;
    if (!categories.length) return;

    categories.forEach(function (category) {
      totalCards += ((category && category.cards) || []).length;
    });

    var section = el('section', 'ideas prompt-pack');
    section.setAttribute('aria-label', '精選提示詞');

    var title = el('div', 'ideas-title');
    title.appendChild(document.createTextNode('✦ 精選提示詞'));
    var hint = el('span', 'hint', '（展開後再選擇，不會自動消耗額度）');
    title.appendChild(hint);
    section.appendChild(title);

    var browser = el('details', 'prompt-pack-browser');
    var browserSummary = el('summary', 'pack-browser-summary', '瀏覽全部精選提示詞（' + totalCards + '）');
    var browserContent = el('div', 'prompt-pack-content');
    var mounted = false;
    browser.appendChild(browserSummary);
    browser.appendChild(browserContent);
    section.appendChild(browser);

    browser.addEventListener('toggle', function () {
      if (!browser.open || mounted) return;
      mounted = true;
      categories.forEach(function (category) {
        var cards = (category && category.cards) || [];
        var categoryMounted = false;
        if (!cards.length) return;
        var details = el('details', 'pack-cat');
        var summary = el('summary', 'pack-group-label',
          (category.emoji ? category.emoji + ' ' : '') + (category.label || '') + ' (' + cards.length + ')');
        details.appendChild(summary);
        details.addEventListener('toggle', function () {
          if (!details.open || categoryMounted) return;
          categoryMounted = true;
          var grid = el('div', 'idea-grid');
          cards.forEach(function (card, cardIndex) {
            var withEmoji = card;
            if (!card.emoji || !card.preview) {
              withEmoji = {};
              for (var key in card) {
                if (Object.prototype.hasOwnProperty.call(card, key)) {
                  withEmoji[key] = card[key];
                }
              }
              if (!card.emoji && category.emoji) {
                withEmoji.emoji = category.emoji;
              }
              if (!card.preview && category.key) {
                withEmoji.preview = '/static/examples/prompt-pack/' + category.key + '-' + twoDigit(cardIndex + 1) + '.webp';
              }
            }
            grid.appendChild(buildCard(withEmoji));
          });
          details.appendChild(grid);
          observeLazyImages(grid);
        });
        browserContent.appendChild(details);
      });
      loadHfIdeas();
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
    observeLazyImages(document);
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
})();
