# Prompt Tools, Custom Idea Cards, and User Tutorial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three user-facing features to the FastAPI image generator: Chinese plain-language prompt transformation, local custom idea cards, and an onboarding/help tutorial.

**Architecture:** Keep the current FastAPI + vanilla JS architecture. Backend owns prompt transformation through `/prompt/transform`; frontend owns local custom card storage through `localStorage`; tutorial is static client-side UI. The existing `/generate` NVIDIA path remains unchanged except that custom cards and transformed prompts feed into the same `#prompt` textarea and `generate()` function.

**Tech Stack:** Python 3.11, FastAPI, Pydantic, pytest, vanilla HTML/CSS/JS, browser `localStorage`, Node built-in `node --test` for pure frontend helper tests.

---

## Current context

Project root:

```text
D:\Users\Administrator\Desktop\圖片生成
```

Existing files:

```text
app/main.py                  # FastAPI app, /health, /generate
app/image_service.py         # NVIDIA/demo image provider
app/static/index.html        # single-page UI
app/static/app.js            # generation flow and built-in idea card click handlers
app/static/styles.css        # dark UI styles
tests/test_app.py            # FastAPI route tests
tests/test_image_service.py  # provider and image extraction tests
```

The project is not currently a git repository. Use test/smoke checkpoints after each task. If git is initialized later, run the git commands listed at the end of each task.

---

## Target file structure

```text
app/
  main.py                         # Modify: add /prompt/transform route
  prompt_transform.py             # Create: rule-based Chinese -> English prompt transformer

app/static/
  index.html                      # Modify: prompt tool UI, custom idea card UI, tutorial modal, script tags
  styles.css                      # Modify: styles for prompt tool, modal, custom cards, tutorial
  app.js                          # Modify: expose generate helpers for other scripts
  prompt-transform.js             # Create: calls /prompt/transform and fills #prompt
  idea-store.js                   # Create: pure custom card storage/validation helpers
  idea-cards.js                   # Create: custom card CRUD UI, import/export, click-to-generate
  tutorial.js                     # Create: onboarding modal and help button

tests/
  test_prompt_transform.py        # Create: backend transformer tests
  test_app.py                     # Modify: route tests for /prompt/transform
  test_static_ui.py               # Create: static HTML/JS integration checks
  frontend/
    idea-store.test.cjs           # Create: Node tests for pure custom card helper logic
```

---

### Task 1: Backend prompt transformer core

**Files:**
- Create: `app/prompt_transform.py`
- Create: `tests/test_prompt_transform.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_prompt_transform.py` with these behaviors:

```python
import unittest

from app.prompt_transform import transform_plain_prompt


class PromptTransformTests(unittest.TestCase):
    def test_transforms_plain_chinese_into_professional_english_prompt(self):
        result = transform_plain_prompt("一隻可愛柴犬在月球上吃拉麵，風格要可愛一點")
        self.assertEqual(result.provider, "rule_based")
        self.assertIn("Shiba Inu", result.prompt)
        self.assertIn("moon", result.prompt)
        self.assertIn("ramen", result.prompt)
        self.assertIn("adorable", result.prompt)
        self.assertIn("highly detailed", result.prompt)
        self.assertLessEqual(len(result.prompt), 900)

    def test_rejects_blank_source_text(self):
        with self.assertRaisesRegex(ValueError, "請先輸入白話描述"):
            transform_plain_prompt("   ")

    def test_applies_style_override_when_provided(self):
        result = transform_plain_prompt("台北夜市下雨的街景", style="cinematic")
        self.assertIn("Taipei night market", result.prompt)
        self.assertIn("rainy street scene", result.prompt)
        self.assertIn("cinematic lighting", result.prompt)
        self.assertIn("film still", result.prompt)

    def test_returns_warning_for_very_short_input(self):
        result = transform_plain_prompt("貓")
        self.assertIn("cat", result.prompt)
        self.assertIn("描述較短", result.warnings)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
cd "D:\Users\Administrator\Desktop\圖片生成"
python -m pytest tests/test_prompt_transform.py -q
```

Expected: fails with `ModuleNotFoundError: No module named 'app.prompt_transform'`.

- [ ] **Step 3: Implement `app/prompt_transform.py`**

Implement:

```python
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class PromptTransformResult:
    source: str
    prompt: str
    provider: str = "rule_based"
    warnings: list[str] = field(default_factory=list)


PHRASE_TRANSLATIONS: tuple[tuple[str, str], ...] = (
    ("柴犬", "Shiba Inu"),
    ("柯基", "corgi"),
    ("貓", "cat"),
    ("狗", "dog"),
    ("恐龍", "dinosaur"),
    ("機甲", "mecha robot"),
    ("機器人", "robot"),
    ("太空", "deep space"),
    ("月球", "moon"),
    ("火星", "Mars"),
    ("拉麵", "ramen"),
    ("珍奶", "bubble tea"),
    ("台北夜市", "Taipei night market"),
    ("夜市", "night market"),
    ("下雨", "rainy"),
    ("雨天", "rainy"),
    ("街景", "street scene"),
    ("水墨", "traditional Chinese ink painting"),
    ("山水", "misty mountain landscape"),
    ("賽博龐克", "cyberpunk"),
    ("賽博", "cyberpunk"),
    ("可愛", "cute and adorable"),
    ("寫實", "photorealistic"),
    ("電影感", "cinematic"),
    ("產品照", "studio product photography"),
    ("動漫", "anime style"),
    ("漫畫", "manga panel"),
    ("插畫", "illustration"),
)

STYLE_PRESETS: dict[str, tuple[str, ...]] = {
    "auto": ("professional image generation prompt", "highly detailed", "balanced composition", "vibrant colors"),
    "cute": ("adorable character design", "soft warm lighting", "playful atmosphere", "highly detailed"),
    "cinematic": ("cinematic lighting", "film still", "dramatic composition", "shallow depth of field"),
    "realistic": ("photorealistic", "natural lighting", "realistic texture detail", "85mm lens"),
    "anime": ("anime style", "expressive character design", "clean linework", "vivid colors"),
    "product": ("studio product photography", "clean background", "premium lighting", "sharp focus"),
}

CHINESE_PUNCTUATION = re.compile(r"[，。！？、；：（）「」『』]\s*")
WHITESPACE = re.compile(r"\s+")


def transform_plain_prompt(source: str, style: str = "auto") -> PromptTransformResult:
    cleaned = WHITESPACE.sub(" ", source.strip())
    if not cleaned:
        raise ValueError("請先輸入白話描述")
    if len(cleaned) > 2000:
        raise ValueError("白話描述太長，請縮短到 2000 字以內")

    warnings: list[str] = []
    if len(cleaned) < 4:
        warnings.append("描述較短")

    translated = _translate_known_phrases(cleaned)
    translated = _normalize_english_prompt(translated)
    style_key = style if style in STYLE_PRESETS else "auto"
    prompt_parts = [translated, *STYLE_PRESETS[style_key], "best quality", "clear subject", "no watermark"]
    prompt = ", ".join(_dedupe_terms(prompt_parts))[:900].rstrip(" ,")
    return PromptTransformResult(source=cleaned, prompt=prompt, warnings=warnings)


def _translate_known_phrases(text: str) -> str:
    result = text
    for zh, en in PHRASE_TRANSLATIONS:
        result = result.replace(zh, f" {en} ")
    result = CHINESE_PUNCTUATION.sub(", ", result)
    return WHITESPACE.sub(" ", result).strip(" ,")


def _normalize_english_prompt(text: str) -> str:
    text = text.replace("一隻", "a ").replace("一個", "a ").replace("一張", "a ")
    text = text.replace("在", " in ").replace("上", " on ").replace("吃", " eating ")
    text = text.replace("風格要", " style should be ").replace("一點", "")
    text = WHITESPACE.sub(" ", text).strip(" ,")
    if not re.search(r"[A-Za-z]", text):
        text = f"A visually rich scene inspired by: {text}"
    return text[0].upper() + text[1:] if text else text


def _dedupe_terms(items: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for item in items:
        normalized = item.strip()
        key = normalized.lower()
        if normalized and key not in seen:
            output.append(normalized)
            seen.add(key)
    return output
```

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
python -m pytest tests/test_prompt_transform.py -q
python -m pytest -q
```

Expected: new transformer tests pass and existing tests still pass.

If git is available:

```powershell
git add app/prompt_transform.py tests/test_prompt_transform.py
git commit -m "feat: add rule-based prompt transformer"
```

---

### Task 2: Prompt transformation API route

**Files:**
- Modify: `app/main.py`
- Modify: `tests/test_app.py`

- [ ] **Step 1: Add failing route tests**

Append to `tests/test_app.py` inside `AppRouteTests`:

```python
    def test_prompt_transform_route_returns_professional_prompt(self):
        response = self.client.post(
            "/prompt/transform",
            json={"source": "一隻可愛柴犬在月球上吃拉麵", "style": "cute"},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["provider"], "rule_based")
        self.assertIn("Shiba Inu", data["prompt"])
        self.assertIn("moon", data["prompt"])
        self.assertIn("adorable", data["prompt"])

    def test_prompt_transform_route_rejects_blank_source(self):
        response = self.client.post("/prompt/transform", json={"source": "   ", "style": "auto"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
python -m pytest tests/test_app.py::AppRouteTests::test_prompt_transform_route_returns_professional_prompt -q
```

Expected: fails because `/prompt/transform` returns 404.

- [ ] **Step 3: Implement route**

In `app/main.py`, add:

```python
from .prompt_transform import transform_plain_prompt
```

Add model after `GeneratePayload`:

```python
class PromptTransformPayload(BaseModel):
    source: str
    style: str = "auto"
```

Add route:

```python
@app.post("/prompt/transform")
def prompt_transform(payload: PromptTransformPayload):
    try:
        result = transform_plain_prompt(payload.source, style=payload.style)
    except ValueError as exc:
        return JSONResponse({"error": str(exc), "code": "bad_request"}, status_code=400)
    return {
        "source": result.source,
        "prompt": result.prompt,
        "provider": result.provider,
        "warnings": result.warnings,
    }
```

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
python -m pytest tests/test_app.py tests/test_prompt_transform.py -q
python -m pytest -q
```

If git is available:

```powershell
git add app/main.py tests/test_app.py
git commit -m "feat: expose prompt transform API"
```

---

### Task 3: Prompt transformation UI

**Files:**
- Modify: `app/static/index.html`
- Modify: `app/static/styles.css`
- Modify: `app/static/app.js`
- Create: `app/static/prompt-transform.js`
- Create: `tests/test_static_ui.py`

- [ ] **Step 1: Add failing static UI tests**

Create `tests/test_static_ui.py`:

```python
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "app" / "static" / "index.html"
APP_JS = ROOT / "app" / "static" / "app.js"
PROMPT_JS = ROOT / "app" / "static" / "prompt-transform.js"
IDEA_JS = ROOT / "app" / "static" / "idea-cards.js"
TUTORIAL_JS = ROOT / "app" / "static" / "tutorial.js"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_prompt_transform_ui_is_wired():
    html = read(INDEX)
    assert 'id="plainPrompt"' in html
    assert 'id="promptStyle"' in html
    assert 'id="transformPrompt"' in html
    assert 'src="/static/prompt-transform.js"' in html
    js = read(PROMPT_JS)
    assert "fetch('/prompt/transform'" in js
    assert "plainPrompt" in js
    assert "transformPrompt" in js


def test_app_exposes_generation_helpers_for_feature_scripts():
    js = read(APP_JS)
    assert "window.ImageGenApp" in js
    assert "setPromptAndGenerate" in js
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
python -m pytest tests/test_static_ui.py::test_prompt_transform_ui_is_wired -q
```

Expected: fails because the UI and JS file do not exist.

- [ ] **Step 3: Add UI markup**

In `app/static/index.html`, inside `<section class="composer">` before the existing `#prompt` textarea, insert:

```html
      <section class="prompt-tool" aria-label="提示詞轉換工具">
        <div class="section-heading">
          <div>
            <h2>✨ 白話中文轉專業英文提示詞</h2>
            <p>先用中文描述想法，再轉成適合 FLUX 的英文 prompt。</p>
          </div>
        </div>
        <textarea id="plainPrompt" placeholder="例如：一隻可愛柴犬在月球上吃拉麵，畫面要有電影感"></textarea>
        <div class="controls prompt-controls">
          <div class="field">
            <label for="promptStyle">提示詞風格</label>
            <select id="promptStyle">
              <option value="auto">自動判斷</option>
              <option value="cute">可愛角色</option>
              <option value="cinematic">電影感</option>
              <option value="realistic">寫實攝影</option>
              <option value="anime">動漫插畫</option>
              <option value="product">產品照</option>
            </select>
          </div>
          <button id="transformPrompt" class="btn secondary" type="button">✨ 轉成英文提示詞</button>
        </div>
        <div id="transformStatus" class="status" aria-live="polite"></div>
      </section>

      <label class="final-prompt-label" for="prompt">專業英文提示詞（可手動修改）</label>
```

Replace the existing prompt textarea placeholder with:

```html
      <textarea id="prompt" placeholder="Professional English prompt will appear here, or type your own prompt directly."></textarea>
```

Add script tag after `app.js`:

```html
  <script src="/static/prompt-transform.js"></script>
```

- [ ] **Step 4: Expose app helpers**

In `app/static/app.js`, after `generate()` and before `DOMContentLoaded`, add:

```javascript
function setPromptAndGenerate(prompt){
  el('prompt').value = prompt;
  generate();
}

window.ImageGenApp = {
  generate: generate,
  setPromptAndGenerate: setPromptAndGenerate,
  setStatus: setStatus,
  el: el
};
```

- [ ] **Step 5: Create `prompt-transform.js`**

Create `app/static/prompt-transform.js`:

```javascript
(function(){
  function get(id){ return document.getElementById(id); }

  function setTransformStatus(text, cls){
    var target = get('transformStatus');
    if(!target){ return; }
    target.textContent = text;
    target.className = 'status' + (cls ? ' ' + cls : '');
  }

  async function transformPrompt(){
    var plain = get('plainPrompt');
    var finalPrompt = get('prompt');
    var style = get('promptStyle');
    var button = get('transformPrompt');
    var source = plain.value.trim();
    if(!source){
      setTransformStatus('請先輸入白話中文描述', 'fail');
      plain.focus();
      return;
    }
    button.disabled = true;
    button.textContent = '轉換中…';
    setTransformStatus('正在整理成專業英文提示詞…', 'busy');
    try{
      var response = await fetch('/prompt/transform', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source: source, style: style.value})
      });
      var data = await response.json();
      if(!response.ok){ throw new Error(data.error || ('HTTP ' + response.status)); }
      finalPrompt.value = data.prompt;
      var note = data.warnings && data.warnings.length ? '（提醒：' + data.warnings.join('、') + '）' : '';
      setTransformStatus('✅ 已轉成英文提示詞 ' + note, 'done');
      finalPrompt.focus();
    }catch(err){
      setTransformStatus('❌ 轉換失敗：' + err.message, 'fail');
    }finally{
      button.disabled = false;
      button.textContent = '✨ 轉成英文提示詞';
    }
  }

  document.addEventListener('DOMContentLoaded', function(){
    var button = get('transformPrompt');
    var plain = get('plainPrompt');
    if(button){ button.addEventListener('click', transformPrompt); }
    if(plain){
      plain.addEventListener('keydown', function(event){
        if((event.metaKey || event.ctrlKey) && event.key === 'Enter'){ transformPrompt(); }
      });
    }
  });
})();
```

- [ ] **Step 6: Add CSS**

Append to `app/static/styles.css`:

```css
.prompt-tool { margin-bottom: 18px; padding: 16px; border: 1px solid #1e293b; border-radius: 16px; background: rgba(15, 23, 42, .72); }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.section-heading h2 { margin: 0 0 4px; font-size: 17px; line-height: 1.3; }
.section-heading p { margin: 0; color: var(--muted); font-size: 13px; }
.prompt-controls { align-items: flex-end; }
.btn.secondary { flex: 0 1 auto; min-width: 190px; background: linear-gradient(135deg, #0ea5e9, #6366f1); }
.final-prompt-label { display: inline-block; margin-bottom: 8px; color: var(--muted); font-size: 13px; font-weight: 700; }
@media (max-width: 560px) { .btn.secondary { width: 100%; min-width: 0; } }
```

- [ ] **Step 7: Verify**

Run:

```powershell
python -m pytest tests/test_static_ui.py::test_prompt_transform_ui_is_wired tests/test_static_ui.py::test_app_exposes_generation_helpers_for_feature_scripts -q
python -m pytest -q
```

If git is available:

```powershell
git add app/static/index.html app/static/styles.css app/static/app.js app/static/prompt-transform.js tests/test_static_ui.py
git commit -m "feat: add prompt transform UI"
```

---

### Task 4: Custom idea card storage helpers

**Files:**
- Create: `app/static/idea-store.js`
- Create: `tests/frontend/idea-store.test.cjs`

- [ ] **Step 1: Add failing Node tests**

Create `tests/frontend/idea-store.test.cjs`:

```javascript
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadStore(){
  const file = path.join(__dirname, '..', '..', 'app', 'static', 'idea-store.js');
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = { console, globalThis: {} };
  sandbox.window = sandbox.globalThis;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.globalThis.IdeaStore;
}

test('normalizeCard trims input and assigns id', () => {
  const store = loadStore();
  const card = store.normalizeCard({ emoji: ' 🐶 ', title: ' 月球柴犬 ', promptZh: ' 柴犬在月球 ', promptEn: '' }, () => 'fixed-id');
  assert.equal(card.id, 'fixed-id');
  assert.equal(card.emoji, '🐶');
  assert.equal(card.title, '月球柴犬');
  assert.equal(card.promptZh, '柴犬在月球');
  assert.equal(card.promptEn, '');
  assert.equal(card.model, 'schnell');
  assert.equal(card.size, 'square');
});

test('normalizeCard rejects incomplete cards', () => {
  const store = loadStore();
  assert.throws(() => store.normalizeCard({ emoji: '✨', title: '', promptZh: '貓' }), /請輸入卡片名稱/);
  assert.throws(() => store.normalizeCard({ emoji: '✨', title: '空卡', promptZh: '', promptEn: '' }), /請輸入中文描述或英文提示詞/);
});

test('parseImportedCards validates JSON arrays', () => {
  const store = loadStore();
  const cards = store.parseImportedCards(JSON.stringify([{ emoji: '🌃', title: '夜市', promptEn: 'Taipei night market' }]));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '夜市');
  assert.throws(() => store.parseImportedCards('{broken'), /匯入資料不是有效 JSON/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test tests/frontend/idea-store.test.cjs
```

Expected: fails because `app/static/idea-store.js` does not exist.

- [ ] **Step 3: Implement `idea-store.js`**

Create `app/static/idea-store.js` with functions:

```javascript
(function(root){
  var STORAGE_KEY = 'aiImageCustomIdeaCards.v1';
  function idFactory(){ return 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function clean(value){ return String(value || '').trim(); }
  function normalizeCard(raw, makeId){
    var maker = makeId || idFactory;
    var title = clean(raw.title);
    var promptZh = clean(raw.promptZh);
    var promptEn = clean(raw.promptEn);
    if(!title){ throw new Error('請輸入卡片名稱'); }
    if(!promptZh && !promptEn){ throw new Error('請輸入中文描述或英文提示詞'); }
    return {
      id: clean(raw.id) || maker(),
      emoji: clean(raw.emoji) || '✨',
      title: title.slice(0, 24),
      promptZh: promptZh.slice(0, 500),
      promptEn: promptEn.slice(0, 1000),
      model: clean(raw.model) || 'schnell',
      size: clean(raw.size) || 'square'
    };
  }
  function parseImportedCards(text){
    var parsed;
    try{ parsed = JSON.parse(text); }catch(err){ throw new Error('匯入資料不是有效 JSON'); }
    if(!Array.isArray(parsed)){ throw new Error('匯入資料必須是卡片陣列'); }
    return parsed.map(function(card){ return normalizeCard(card); });
  }
  function loadCards(storage){
    var target = storage || root.localStorage;
    if(!target){ return []; }
    var raw = target.getItem(STORAGE_KEY);
    return raw ? parseImportedCards(raw) : [];
  }
  function saveCards(cards, storage){
    var target = storage || root.localStorage;
    if(target){ target.setItem(STORAGE_KEY, JSON.stringify(cards.map(function(card){ return normalizeCard(card); }))); }
  }
  function upsertCard(cards, card){
    var normalized = normalizeCard(card);
    var found = false;
    var next = cards.map(function(existing){
      if(existing.id === normalized.id){ found = true; return normalized; }
      return existing;
    });
    if(!found){ next.push(normalized); }
    return next;
  }
  function deleteCard(cards, id){ return cards.filter(function(card){ return card.id !== id; }); }
  root.IdeaStore = { STORAGE_KEY: STORAGE_KEY, normalizeCard: normalizeCard, parseImportedCards: parseImportedCards, loadCards: loadCards, saveCards: saveCards, upsertCard: upsertCard, deleteCard: deleteCard };
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
node --test tests/frontend/idea-store.test.cjs
```

If git is available:

```powershell
git add app/static/idea-store.js tests/frontend/idea-store.test.cjs
git commit -m "feat: add custom idea card store"
```

---

### Task 5: Custom idea card UI and click-to-generate

**Files:**
- Modify: `app/static/index.html`
- Modify: `app/static/styles.css`
- Create: `app/static/idea-cards.js`
- Modify: `tests/test_static_ui.py`

- [ ] **Step 1: Add failing static UI test**

Append to `tests/test_static_ui.py`:

```python
def test_custom_idea_card_ui_is_wired():
    html = read(INDEX)
    assert 'id="customIdeaGrid"' in html
    assert 'id="addIdea"' in html
    assert 'id="ideaEditor"' in html
    assert 'src="/static/idea-store.js"' in html
    assert 'src="/static/idea-cards.js"' in html
    js = read(IDEA_JS)
    assert "IdeaStore.loadCards" in js
    assert "customIdeaGrid" in js
    assert "ImageGenApp.setPromptAndGenerate" in js
    assert "fetch('/prompt/transform'" in js
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
python -m pytest tests/test_static_ui.py::test_custom_idea_card_ui_is_wired -q
```

Expected: fails because custom card UI and script do not exist.

- [ ] **Step 3: Add custom card UI**

In `index.html`, inside `.ideas` after the built-in `.idea-grid`, add:

```html
        <div class="custom-ideas-head">
          <div>
            <div class="ideas-title">⭐ 我的客製梗卡</div>
            <p class="mini-copy">儲存在這台瀏覽器，可匯出 JSON 備份。</p>
          </div>
          <div class="mini-actions">
            <button id="addIdea" class="mini-btn" type="button">＋新增</button>
            <button id="exportIdeas" class="mini-btn" type="button">匯出</button>
            <label class="mini-btn file-btn" for="importIdeas">匯入</label>
            <input id="importIdeas" type="file" accept="application/json" hidden>
          </div>
        </div>
        <div id="customIdeaGrid" class="idea-grid custom-grid" aria-live="polite"></div>
```

Before `</main>`, add this editor modal:

```html
    <div id="ideaEditor" class="modal-backdrop" hidden>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="ideaEditorTitle">
        <div class="modal-head">
          <h2 id="ideaEditorTitle">新增客製梗卡</h2>
          <button id="closeIdeaEditor" class="icon-btn" type="button" aria-label="關閉">×</button>
        </div>
        <form id="ideaForm" class="idea-form">
          <input id="ideaId" type="hidden">
          <div class="form-row two-col">
            <label>Emoji
              <input id="ideaEmoji" maxlength="4" value="✨">
            </label>
            <label>卡片名稱
              <input id="ideaTitle" maxlength="24" placeholder="例如：月球柴犬">
            </label>
          </div>
          <label>中文白話描述
            <textarea id="ideaPromptZh" placeholder="例如：一隻可愛柴犬在月球上吃拉麵"></textarea>
          </label>
          <label>英文提示詞（可留空，點卡片時會自動轉換）
            <textarea id="ideaPromptEn" placeholder="A cute Shiba Inu eating ramen on the moon..."></textarea>
          </label>
          <div class="form-row two-col">
            <label>模型
              <select id="ideaModel">
                <option value="schnell">FLUX.1-schnell</option>
                <option value="dev">FLUX.1-dev</option>
              </select>
            </label>
            <label>尺寸
              <select id="ideaSize">
                <option value="square">方形</option>
                <option value="landscape">橫向</option>
                <option value="portrait">直向</option>
              </select>
            </label>
          </div>
          <div id="ideaEditorStatus" class="status"></div>
          <div class="modal-actions">
            <button id="deleteIdea" class="btn danger" type="button">刪除</button>
            <button class="btn secondary" type="submit">儲存卡片</button>
          </div>
        </form>
      </section>
    </div>
```

Add scripts after `prompt-transform.js`:

```html
  <script src="/static/idea-store.js"></script>
  <script src="/static/idea-cards.js"></script>
```

- [ ] **Step 4: Implement `idea-cards.js`**

Create `app/static/idea-cards.js` with these concrete functions:

```javascript
(function(){
  var cards = [];
  function get(id){ return document.getElementById(id); }
  function setEditorStatus(text, cls){
    var node = get('ideaEditorStatus');
    if(node){ node.textContent = text; node.className = 'status' + (cls ? ' ' + cls : ''); }
  }
  function openEditor(card){
    get('ideaEditor').hidden = false;
    get('ideaEditorTitle').textContent = card ? '編輯客製梗卡' : '新增客製梗卡';
    get('ideaId').value = card ? card.id : '';
    get('ideaEmoji').value = card ? card.emoji : '✨';
    get('ideaTitle').value = card ? card.title : '';
    get('ideaPromptZh').value = card ? card.promptZh : '';
    get('ideaPromptEn').value = card ? card.promptEn : '';
    get('ideaModel').value = card ? card.model : 'schnell';
    get('ideaSize').value = card ? card.size : 'square';
    get('deleteIdea').hidden = !card;
    setEditorStatus('', '');
    get('ideaTitle').focus();
  }
  function closeEditor(){ get('ideaEditor').hidden = true; }
  function cardFromForm(){
    return window.IdeaStore.normalizeCard({
      id: get('ideaId').value,
      emoji: get('ideaEmoji').value,
      title: get('ideaTitle').value,
      promptZh: get('ideaPromptZh').value,
      promptEn: get('ideaPromptEn').value,
      model: get('ideaModel').value,
      size: get('ideaSize').value
    });
  }
  function saveCards(){ window.IdeaStore.saveCards(cards); }
  function renderCards(){
    var grid = get('customIdeaGrid');
    grid.innerHTML = '';
    if(cards.length === 0){
      var empty = document.createElement('div');
      empty.className = 'empty-card';
      empty.textContent = '還沒有客製梗卡，按「＋新增」建立第一張。';
      grid.appendChild(empty);
      return;
    }
    cards.forEach(function(card){
      var wrap = document.createElement('div');
      wrap.className = 'custom-idea-wrap';
      var button = document.createElement('button');
      button.className = 'idea custom-idea';
      button.type = 'button';
      button.innerHTML = '<span class="emo"></span><span class="idea-label"></span>';
      button.querySelector('.emo').textContent = card.emoji;
      button.querySelector('.idea-label').textContent = card.title;
      button.addEventListener('click', function(){ runCard(card); });
      var edit = document.createElement('button');
      edit.className = 'edit-card';
      edit.type = 'button';
      edit.textContent = '編輯';
      edit.addEventListener('click', function(event){ event.stopPropagation(); openEditor(card); });
      wrap.appendChild(button);
      wrap.appendChild(edit);
      grid.appendChild(wrap);
    });
  }
  async function runCard(card){
    get('model').value = card.model;
    get('size').value = card.size;
    if(card.promptEn){ window.ImageGenApp.setPromptAndGenerate(card.promptEn); return; }
    try{
      window.ImageGenApp.setStatus('✨ 正在把客製梗卡轉成英文提示詞…', 'busy');
      var response = await fetch('/prompt/transform', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source: card.promptZh, style: 'auto'})
      });
      var data = await response.json();
      if(!response.ok){ throw new Error(data.error || ('HTTP ' + response.status)); }
      window.ImageGenApp.setPromptAndGenerate(data.prompt);
    }catch(err){
      window.ImageGenApp.setStatus('❌ 客製梗卡轉換失敗：' + err.message, 'fail');
    }
  }
  function exportCards(){
    var blob = new Blob([JSON.stringify(cards, null, 2)], {type: 'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'custom-idea-cards.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  function importCards(file){
    var reader = new FileReader();
    reader.onload = function(){
      try{
        cards = window.IdeaStore.parseImportedCards(String(reader.result || ''));
        saveCards();
        renderCards();
      }catch(err){ window.ImageGenApp.setStatus('❌ 匯入失敗：' + err.message, 'fail'); }
    };
    reader.readAsText(file, 'utf-8');
  }
  document.addEventListener('DOMContentLoaded', function(){
    cards = window.IdeaStore.loadCards();
    renderCards();
    get('addIdea').addEventListener('click', function(){ openEditor(null); });
    get('closeIdeaEditor').addEventListener('click', closeEditor);
    get('exportIdeas').addEventListener('click', exportCards);
    get('importIdeas').addEventListener('change', function(event){
      if(event.target.files && event.target.files[0]){ importCards(event.target.files[0]); }
      event.target.value = '';
    });
    get('ideaForm').addEventListener('submit', function(event){
      event.preventDefault();
      try{
        cards = window.IdeaStore.upsertCard(cards, cardFromForm());
        saveCards();
        renderCards();
        closeEditor();
      }catch(err){ setEditorStatus(err.message, 'fail'); }
    });
    get('deleteIdea').addEventListener('click', function(){
      cards = window.IdeaStore.deleteCard(cards, get('ideaId').value);
      saveCards();
      renderCards();
      closeEditor();
    });
  });
})();
```

- [ ] **Step 5: Add CSS**

Append to `app/static/styles.css`:

```css
.custom-ideas-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin: 18px 0 10px; }
.mini-copy { margin: 3px 0 0; color: #64748b; font-size: 12px; }
.mini-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.mini-btn, .edit-card, .icon-btn { border: 1px solid var(--line); background: #111827; color: #cbd5e1; border-radius: 10px; padding: 8px 10px; font-family: var(--font); font-size: 12px; cursor: pointer; }
.file-btn { display: inline-flex; align-items: center; }
.custom-idea-wrap { position: relative; }
.custom-idea { width: 100%; min-height: 82px; }
.edit-card { position: absolute; right: 6px; top: 6px; padding: 3px 6px; opacity: .82; }
.empty-card { grid-column: 1 / -1; border: 1px dashed var(--line); border-radius: 12px; color: #64748b; padding: 16px; text-align: center; font-size: 13px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(2, 6, 23, .78); }
.modal-backdrop[hidden] { display: none; }
.modal-card { width: min(680px, 100%); max-height: min(760px, 92vh); overflow: auto; border: 1px solid #334155; border-radius: 18px; background: #0f172a; box-shadow: 0 24px 80px rgba(0,0,0,.45); padding: 18px; }
.modal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.modal-head h2 { margin: 0; font-size: 18px; }
.idea-form { display: grid; gap: 12px; }
.idea-form label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; font-weight: 700; }
.idea-form input, .idea-form textarea { width: 100%; border: 1px solid var(--line); border-radius: 10px; background: #020617; color: var(--text); padding: 10px 12px; font-family: var(--font); font-size: 14px; }
.idea-form textarea { min-height: 74px; resize: vertical; }
.form-row.two-col { display: grid; grid-template-columns: 120px 1fr; gap: 12px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
.btn.danger { flex: 0 0 auto; background: linear-gradient(135deg, #ef4444, #b91c1c); }
@media (max-width: 560px) {
  .custom-ideas-head { align-items: flex-start; flex-direction: column; }
  .form-row.two-col { grid-template-columns: 1fr; }
  .modal-actions { flex-direction: column; }
}
```

- [ ] **Step 6: Verify**

Run:

```powershell
python -m pytest tests/test_static_ui.py::test_custom_idea_card_ui_is_wired -q
node --test tests/frontend/idea-store.test.cjs
python -m pytest -q
```

If git is available:

```powershell
git add app/static/index.html app/static/styles.css app/static/idea-cards.js tests/test_static_ui.py
git commit -m "feat: add custom idea card UI"
```

---

### Task 6: User tutorial and help entry point

**Files:**
- Modify: `app/static/index.html`
- Modify: `app/static/styles.css`
- Create: `app/static/tutorial.js`
- Modify: `tests/test_static_ui.py`

- [ ] **Step 1: Add failing static tutorial test**

Append to `tests/test_static_ui.py`:

```python
def test_tutorial_ui_is_wired():
    html = read(INDEX)
    assert 'id="openTutorial"' in html
    assert 'id="tutorialModal"' in html
    assert 'data-tutorial-step="1"' in html
    assert 'data-tutorial-step="4"' in html
    assert 'src="/static/tutorial.js"' in html
    js = read(TUTORIAL_JS)
    assert "aiImageTutorialSeen.v1" in js
    assert "openTutorial" in js
    assert "tutorialModal" in js
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
python -m pytest tests/test_static_ui.py::test_tutorial_ui_is_wired -q
```

Expected: fails because tutorial UI does not exist.

- [ ] **Step 3: Add tutorial UI**

Inside `<header class="hero">`, add:

```html
      <button id="openTutorial" class="mini-btn help-btn" type="button">？教學</button>
```

Before `</main>`, add this tutorial modal:

```html
    <div id="tutorialModal" class="modal-backdrop" hidden>
      <section class="modal-card tutorial-card" role="dialog" aria-modal="true" aria-labelledby="tutorialTitle">
        <div class="modal-head">
          <h2 id="tutorialTitle">快速教學</h2>
          <button id="closeTutorial" class="icon-btn" type="button" aria-label="關閉">×</button>
        </div>
        <ol class="tutorial-list">
          <li data-tutorial-step="1">
            <strong>輸入白話中文</strong>
            <span>例如：「一隻貓在太空喝珍奶，風格可愛」。</span>
          </li>
          <li data-tutorial-step="2">
            <strong>轉成專業英文提示詞</strong>
            <span>按「轉成英文提示詞」，系統會整理成更適合 FLUX 的 prompt。</span>
          </li>
          <li data-tutorial-step="3">
            <strong>選模型與尺寸</strong>
            <span>schnell 較快，dev 品質較高但較慢；尺寸可選方形、橫向或直向。</span>
          </li>
          <li data-tutorial-step="4">
            <strong>生成、下載、收藏梗卡</strong>
            <span>生成後可下載圖片，也能把常用想法存成客製梗卡。</span>
          </li>
        </ol>
        <label class="tutorial-check">
          <input id="dontShowTutorialAgain" type="checkbox">
          下次不要自動顯示
        </label>
        <div class="modal-actions">
          <button id="finishTutorial" class="btn secondary" type="button">開始使用</button>
        </div>
      </section>
    </div>
```

Add script after `idea-cards.js`:

```html
  <script src="/static/tutorial.js"></script>
```

- [ ] **Step 4: Create `tutorial.js`**

Create `app/static/tutorial.js`:

```javascript
(function(){
  var STORAGE_KEY = 'aiImageTutorialSeen.v1';
  function get(id){ return document.getElementById(id); }
  function openTutorial(){
    get('tutorialModal').hidden = false;
    get('finishTutorial').focus();
  }
  function closeTutorial(markSeen){
    if(markSeen || get('dontShowTutorialAgain').checked){ localStorage.setItem(STORAGE_KEY, 'true'); }
    get('tutorialModal').hidden = true;
  }
  document.addEventListener('DOMContentLoaded', function(){
    get('openTutorial').addEventListener('click', openTutorial);
    get('closeTutorial').addEventListener('click', function(){ closeTutorial(false); });
    get('finishTutorial').addEventListener('click', function(){ closeTutorial(true); });
    get('tutorialModal').addEventListener('click', function(event){
      if(event.target === get('tutorialModal')){ closeTutorial(false); }
    });
    if(localStorage.getItem(STORAGE_KEY) !== 'true'){ window.setTimeout(openTutorial, 350); }
  });
})();
```

- [ ] **Step 5: Add CSS**

Append to `app/static/styles.css`:

```css
.help-btn { white-space: nowrap; }
.tutorial-card { max-width: 620px; }
.tutorial-list { display: grid; gap: 12px; margin: 0 0 16px; padding-left: 22px; }
.tutorial-list li { color: #cbd5e1; line-height: 1.6; }
.tutorial-list strong { display: block; color: #e2e8f0; margin-bottom: 2px; }
.tutorial-list span { color: #94a3b8; font-size: 14px; }
.tutorial-check { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 16px; color: #94a3b8; font-size: 13px; }
```

- [ ] **Step 6: Verify**

Run:

```powershell
python -m pytest tests/test_static_ui.py::test_tutorial_ui_is_wired -q
python -m pytest -q
```

If git is available:

```powershell
git add app/static/index.html app/static/styles.css app/static/tutorial.js tests/test_static_ui.py
git commit -m "feat: add onboarding tutorial"
```

---

### Task 7: Documentation and full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the new features**

Add a README section covering:

```text
1. 白話中文轉專業英文提示詞：POST /prompt/transform。
2. 客製梗卡：localStorage 儲存，支援新增、編輯、刪除、匯出、匯入。
3. 使用者教學：首次自動顯示，也可按「？教學」開啟。
```

- [ ] **Step 2: Run full automated verification**

Run:

```powershell
cd "D:\Users\Administrator\Desktop\圖片生成"
python -m pytest -q
node --test tests/frontend/idea-store.test.cjs
```

Expected: all Python tests pass and all Node tests pass.

- [ ] **Step 3: Restart local app on port 8001**

Run:

```powershell
cd "D:\Users\Administrator\Desktop\圖片生成"
$serverPid = if(Test-Path .\server.pid){ (Get-Content .\server.pid -Raw).Trim() } else { "" }
if($serverPid -match '^\d+$'){
  $proc = Get-Process -Id ([int]$serverPid) -ErrorAction SilentlyContinue
  if($proc){ Stop-Process -Id $proc.Id -Force }
}
Start-Process -FilePath python -ArgumentList @('-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8001','--env-file','.env') -WorkingDirectory "D:\Users\Administrator\Desktop\圖片生成" -WindowStyle Hidden -RedirectStandardOutput "D:\Users\Administrator\Desktop\圖片生成\logs\uvicorn.out.log" -RedirectStandardError "D:\Users\Administrator\Desktop\圖片生成\logs\uvicorn.err.log" -PassThru | ForEach-Object { $_.Id | Set-Content .\server.pid -Encoding ASCII }
```

- [ ] **Step 4: HTTP smoke test**

Run:

```powershell
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8001/health' -TimeoutSec 5
$transform = Invoke-RestMethod -Uri 'http://127.0.0.1:8001/prompt/transform' -Method Post -ContentType 'application/json' -Body '{"source":"一隻可愛柴犬在月球上吃拉麵","style":"cute"}' -TimeoutSec 10
$generateBody = @{ prompt=$transform.prompt; model='schnell'; size='square' } | ConvertTo-Json -Compress
$gen = Invoke-RestMethod -Uri 'http://127.0.0.1:8001/generate' -Method Post -ContentType 'application/json' -Body $generateBody -TimeoutSec 150
[pscustomobject]@{
  health_status = $health.status
  provider = $health.provider
  transformed_contains_shiba = ($transform.prompt -like '*Shiba Inu*')
  generate_provider = $gen.provider
  image_prefix = $gen.image.Substring(0, [Math]::Min(40, $gen.image.Length))
  width = $gen.width
  height = $gen.height
} | Format-List
```

Expected:

```text
health_status: ok
provider: nvidia
transformed_contains_shiba: True
generate_provider: nvidia
image_prefix starts with data:image/
width: 1024
height: 1024
```

- [ ] **Step 5: Manual browser QA**

Open:

```text
http://127.0.0.1:8001
```

Check:

```text
1. First load shows tutorial modal.
2. Press 「開始使用」; modal closes.
3. Press 「？教學」; modal opens again.
4. Enter 「一隻可愛柴犬在月球上吃拉麵」 in the plain Chinese field.
5. Press 「轉成英文提示詞」; English prompt appears in main prompt textarea.
6. Press 「生成圖片」; NVIDIA image appears.
7. Press 「＋新增」 in 我的客製梗卡.
8. Save a card with emoji 🐶, title 月球柴犬, Chinese prompt 柴犬在月球吃拉麵.
9. Click the new card; it transforms if needed and generates.
10. Export cards; JSON file downloads.
11. Delete card; grid updates.
12. Import the exported JSON; card returns.
```

If git is available:

```powershell
git add README.md
git commit -m "docs: document prompt tools and custom cards"
```

---

## Self-review

- Prompt transformation: covered by Task 1, Task 2, Task 3.
- Custom idea cards: covered by Task 4 and Task 5.
- User tutorial: covered by Task 6.
- Documentation, app restart, HTTP smoke test, and manual QA: covered by Task 7.
- Existing `/generate` JSON contract stays unchanged.
- New custom cards are local-first and do not require account, database, or server migration.
