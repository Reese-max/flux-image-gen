// Optional "隨機靈感（即時）" panel: samples prompts live from a public Hugging Face
// dataset (Gustavosta/Stable-Diffusion-Prompts, ~82k rows). The HF datasets-server
// sends open CORS and needs no API key, so this is pure front-end — no Worker proxy,
// no edits to the main app modules.
//
// These are Stable-Diffusion-style community prompts, so we (a) clean them toward
// FLUX's natural-language preference and (b) filter unsafe / junk text client-side.
(function () {
  'use strict';

  var DATASET = 'Gustavosta/Stable-Diffusion-Prompts';
  var FIELD = 'Prompt';
  var TOTAL = 81910;
  var FETCH = 100;  // HF cold queries are slow (~10s), so fetch a big slice once...
  var SHOW = 10;    // ...and hand out SHOW at a time from a client-side pool.
  var BASE = 'https://datasets-server.huggingface.co/rows';
  var pool = [];    // cleaned prompts waiting to be shown (refilled only when low)

  // Drop any prompt whose raw text contains these (NSFW / unwanted) terms.
  var BLOCK = /\b(nsfw|nude|nudes|naked|nudity|sex|sexual|sexy|porn|pornographic|nipple|nipples|breast|breasts|boob|boobs|cleavage|lingerie|underwear|panties|bikini|topless|bottomless|erotic|hentai|explicit|seductive|provocative|fetish|bdsm|bondage|gore|gory|nazi|swastika|loli|shota)\b/i;

  // SD boilerplate tokens we strip (FLUX does not need them and they hurt quality).
  var DROP_TOKEN = /^(highly detailed|extremely detailed|very detailed|super detailed|intricate|intricate details?|fine details?|elegant|sharp focus|in sharp focus|smooth|8k|4k|2k|uhd|hd|fhd|highres|high res|hi res|absurdres|masterpiece|best quality|high quality|trending on artstation|artstation|concept art|digital painting|digital art|matte painting|illustration|octane render|unreal engine|cinematic lighting|volumetric lighting|global illumination|award winning|award-winning|deviantart|cgsociety|hyperrealistic|hyper realistic|photorealistic|photo realistic|ultra realistic|realistic|raw photo|4k uhd|symmetrical|symmetry|detailed)$/i;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function cleanPrompt(raw) {
    var t = String(raw || '');
    t = t.replace(/<\s*(lora|lyco|hypernet|embedding)\s*:[^>]*>/gi, ' ');
    t = t.replace(/\(([^():]+):\s*[\d.]+\)/g, '$1'); // (thing:1.2) -> thing
    t = t.replace(/[\[\]{}|]/g, ' ');
    t = t.replace(/[()]/g, ' ');
    t = t.replace(/\s+-\s+/g, '-');                 // sci - fi -> sci-fi
    t = t.replace(/\b(\d)\s+d\b/gi, '$1d');         // 3 d -> 3d
    t = t.replace(/\btrending on [a-z0-9 .&]+/gi, ' '); // drop "trending on artstation/deviantart/..."
    t = t.replace(/\s+by\s+[a-z][a-z.\- ]+$/i, ' ');   // drop a trailing "by Artist Name"
    var parts = t.split(',').map(function (p) { return p.trim(); }).filter(function (p) {
      // Drop boilerplate tokens and pure artist-attribution segments ("by artgerm").
      return p && !DROP_TOKEN.test(p) && !/^by\s+[a-z]/i.test(p);
    });
    return parts.join(', ')
      .replace(/\s{2,}/g, ' ')
      .replace(/(,\s*){2,}/g, ', ')
      .replace(/^[,\s]+|[,\s]+$/g, '');
  }

  function usable(raw) {
    if (!raw || BLOCK.test(raw)) return false;
    var cleaned = cleanPrompt(raw);
    if (cleaned.length < 15 || cleaned.length > 600) return false;
    if (!/[a-z]/i.test(cleaned)) return false;
    return cleaned;
  }

  function usePrompt(prompt) {
    var app = window.ImageGenApp;
    if (app && typeof app.setPromptAndGenerate === 'function') {
      app.setPromptAndGenerate(prompt);
    } else {
      var field = document.getElementById('prompt');
      if (field) field.value = prompt;
    }
  }

  function buildCard(prompt) {
    var card = el('button', 'idea-prompt');
    card.type = 'button';
    card.style.cssText = 'text-align:left;display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid rgba(255,255,255,0.1);border-radius:12px;background:rgba(255,255,255,0.03);cursor:pointer;color:inherit;font:inherit;line-height:1.4;';
    card.title = '用這個提示詞（已轉 FLUX 風格）';
    var text = el('span', null, prompt.length > 160 ? prompt.slice(0, 160) + '…' : prompt);
    text.style.cssText = 'font-size:0.86rem;opacity:0.92;';
    card.appendChild(text);
    var go = el('span', null, '用這個 →');
    go.style.cssText = 'font-size:0.74rem;opacity:0.6;align-self:flex-end;';
    card.appendChild(go);
    card.addEventListener('click', function () { usePrompt(prompt); });
    return card;
  }

  function randomOffset() {
    return Math.floor(Math.random() * (TOTAL - FETCH));
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function refillPool() {
    var offset = randomOffset();
    var url = BASE + '?dataset=' + encodeURIComponent(DATASET) + '&config=default&split=train&offset=' + offset + '&length=' + FETCH;
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HF HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var rows = (data && data.rows) || [];
        var seen = {};
        var fresh = [];
        rows.forEach(function (r) {
          var raw = r && r.row && r.row[FIELD];
          var cleaned = usable(raw);
          if (!cleaned) return;
          var key = cleaned.toLowerCase().slice(0, 40);
          if (seen[key]) return;
          seen[key] = 1;
          fresh.push(cleaned);
        });
        pool = shuffle(pool.concat(fresh));
      });
  }

  function renderFromPool(grid) {
    grid.textContent = '';
    pool.splice(0, SHOW).forEach(function (p) { grid.appendChild(buildCard(p)); });
  }

  function showBatch(grid, status, btn) {
    // Instant when the pool still has cards; only the first click (and ~every
    // 10th) pays the slow Hugging Face cold-query cost.
    if (pool.length >= SHOW) {
      renderFromPool(grid);
      status.textContent = '';
      return;
    }
    status.textContent = pool.length ? '載入更多…' : '抽取中…（第一次查詢可能要幾秒）';
    btn.disabled = true;
    refillPool()
      .then(function () {
        if (!pool.length) {
          status.textContent = '這批沒有合適的，再按一次試試。';
          return;
        }
        renderFromPool(grid);
        status.textContent = '';
      })
      .catch(function (err) {
        status.textContent = '抽取失敗（Hugging Face 暫時無法連線），稍後再試。';
        if (window.console && console.warn) console.warn('[hf-ideas]', err && err.message);
      })
      .then(function () { btn.disabled = false; });
  }

  function mount() {
    var section = el('section', 'ideas hf-ideas');
    section.setAttribute('aria-label', '隨機靈感');

    var title = el('div', 'ideas-title');
    title.appendChild(document.createTextNode('🎲 隨機靈感'));
    title.appendChild(el('span', 'hint', '（即時抽自社群提示詞庫 · 已轉 FLUX 風格 · 出圖僅供參考）'));
    section.appendChild(title);

    var controls = el('div');
    controls.style.cssText = 'display:flex;gap:8px;align-items:center;margin:8px 0;';
    var btn = el('button', 'btn mini secondary', '🎲 抽一批靈感');
    btn.type = 'button';
    var status = el('span', 'hint', '');
    controls.appendChild(btn);
    controls.appendChild(status);
    section.appendChild(controls);

    var grid = el('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:6px;';
    section.appendChild(grid);

    btn.addEventListener('click', function () {
      btn.textContent = '🔄 換一批';
      showBatch(grid, status, btn);
    });

    var anchor = document.querySelector('section.prompt-pack') || document.querySelector('section.ideas');
    if (anchor && anchor.parentNode) {
      anchor.insertAdjacentElement('afterend', section);
    } else {
      document.body.appendChild(section);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
