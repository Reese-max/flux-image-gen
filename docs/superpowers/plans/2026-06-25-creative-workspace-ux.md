# Creative Workspace UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the next product layer for the image generator: artwork details, prompt version comparison, share/export cards, prompt enhancer, failure advice, history search/tags/favorites, and PWA/mobile polish, while explicitly excluding daily quota/cooldown/abuse-control work.

**Architecture:** Keep all new experience features browser-first and provider-agnostic. Extend the existing localStorage history model with backward-compatible metadata, add small pure JS modules for prompt enhancement and error advice, then connect them through thin DOM layers in `history-wall.js` and `app.js`. FastAPI and Cloudflare continue sharing static assets; Cloudflare sync remains a dedicated final task.

**Tech Stack:** FastAPI static app, vanilla ES5 browser JavaScript, localStorage, Node built-in test runner, Python pytest static checks, Cloudflare Workers static assets, Wrangler dry-run.

---

## Scope

Included:
- Artwork detail modal for history records.
- Prompt version chain and version comparison inside the detail modal.
- Share/export actions: copy share text, copy settings JSON, export artwork JSON, download image, optional hidden-prompt share mode.
- Rule-based prompt enhancer buttons: realistic, cinematic, product, cute, clean composition, fix AI artifacts.
- Failure advice mapped from backend error codes.
- History search, model/size filters, favorite filter, favorite toggle, tag display, tag editing.
- PWA/mobile polish: manifest, service worker, install metadata, mobile sticky action bar, responsive history/detail layout.
- FastAPI and Cloudflare static parity.

Excluded:
- Daily quota, cooldown, abuse prevention, Turnstile.
- Public gallery URLs, user accounts, server-side image storage.
- Batch 2/4 image generation.
- Image-to-image / style reference upload.
- Sending `negative_prompt` to NVIDIA.

Current constraints:
- Project root: `D:\Users\Administrator\Desktop\圖片生成`
- Current folder is not a Git repo; checkpoint steps list changed files instead of committing.
- Never read or print `.env`, `cloudflare/.dev.vars`, or API keys.
- Do not make successful real NVIDIA image-generation smoke calls during verification.

---

## File Map

Create:
- `app/static/prompt-enhancer.js` — pure rule-based prompt enhancer.
- `app/static/failure-advice.js` — pure error-code-to-advice mapper.
- `tests/frontend/prompt-enhancer.test.cjs`
- `tests/frontend/failure-advice.test.cjs`
- `app/static/manifest.webmanifest`
- `app/static/service-worker.js`

Modify:
- `app/static/history-store.js`
- `tests/frontend/history-store.test.cjs`
- `app/static/index.html`
- `app/static/app.js`
- `app/static/history-wall.js`
- `app/static/styles.css`
- `tests/test_static_ui.py`
- `app/main.py` for root PWA asset routes.
- `tests/test_app.py` for PWA routes.
- `cloudflare/public/*`
- `cloudflare/public/static/*`
- `cloudflare/package.json`
- `cloudflare/scripts/check-js.mjs`
- `cloudflare/tests/worker-transform.test.mjs`
- `README.md`
- `cloudflare/README.md`

---

### Task 1: History metadata model for versions, tags, favorites, and share fields

**Files:**
- Modify: `app/static/history-store.js`
- Modify: `tests/frontend/history-store.test.cjs`

- [ ] **Step 1: Write failing history metadata tests**

Append tests to `tests/frontend/history-store.test.cjs`:

```javascript
test('normalizeRecord adds version, tags, favorite, and share defaults', () => {
  const Store = loadHistoryStore();
  const record = Store.normalizeRecord({
    image: 'data:image/png;base64,abc',
    prompt: '  a cat  ',
    tags: ['  cute ', '', 'cat'],
    favorite: true,
    sourceRecordId: ' parent-1 ',
    versionGroupId: '',
    versionNumber: 3
  }, () => 'record-1');

  assert.equal(record.id, 'record-1');
  assert.equal(record.favorite, true);
  assert.deepEqual(record.tags, ['cute', 'cat']);
  assert.equal(record.sourceRecordId, 'parent-1');
  assert.equal(record.versionGroupId, 'record-1');
  assert.equal(record.versionNumber, 3);
});

test('createVersionRecord links to the parent version group and increments version', () => {
  const Store = loadHistoryStore();
  const parent = Store.normalizeRecord({
    id: 'parent-1',
    image: 'data:image/png;base64,parent',
    prompt: 'a cat',
    versionGroupId: 'group-1',
    versionNumber: 2
  });
  const records = [
    parent,
    Store.normalizeRecord({
      id: 'existing-v3',
      image: 'data:image/png;base64,v3',
      prompt: 'a cinematic cat',
      versionGroupId: 'group-1',
      versionNumber: 3
    })
  ];

  const version = Store.createVersionRecord(records, parent, {
    image: 'data:image/png;base64,new',
    prompt: 'a realistic cat'
  }, () => 'new-version');

  assert.equal(version.id, 'new-version');
  assert.equal(version.sourceRecordId, 'parent-1');
  assert.equal(version.versionGroupId, 'group-1');
  assert.equal(version.versionNumber, 4);
});

test('findVersionGroup returns records in version order', () => {
  const Store = loadHistoryStore();
  const records = [
    Store.normalizeRecord({ id: 'v2', image: 'data:image/png;base64,2', prompt: 'two', versionGroupId: 'g1', versionNumber: 2 }),
    Store.normalizeRecord({ id: 'other', image: 'data:image/png;base64,o', prompt: 'other', versionGroupId: 'g2', versionNumber: 1 }),
    Store.normalizeRecord({ id: 'v1', image: 'data:image/png;base64,1', prompt: 'one', versionGroupId: 'g1', versionNumber: 1 })
  ];

  assert.deepEqual(Store.findVersionGroup(records, records[0]).map((record) => record.id), ['v1', 'v2']);
});

test('updateRecordTags and toggleFavorite update only the target record', () => {
  const Store = loadHistoryStore();
  const records = [
    Store.normalizeRecord({ id: 'a', image: 'data:image/png;base64,a', prompt: 'a' }),
    Store.normalizeRecord({ id: 'b', image: 'data:image/png;base64,b', prompt: 'b' })
  ];

  const tagged = Store.updateRecordTags(records, 'a', 'cat, cute,,  product ');
  assert.deepEqual(tagged[0].tags, ['cat', 'cute', 'product']);
  assert.deepEqual(tagged[1].tags, []);

  const favorited = Store.toggleFavorite(tagged, 'b');
  assert.equal(favorited[0].favorite, false);
  assert.equal(favorited[1].favorite, true);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node --test tests\frontend\history-store.test.cjs
```

Expected: FAIL because metadata helpers and fields are missing.

- [ ] **Step 3: Extend history store**

In `app/static/history-store.js`, add ES5-friendly helpers:

```javascript
function normalizeTags(value) {
  var raw = Array.isArray(value) ? value : toText(value).split(',');
  var seen = {};
  var tags = [];
  raw.forEach(function (item) {
    var tag = toText(item).slice(0, 32);
    if (!tag || seen[tag]) { return; }
    seen[tag] = true;
    tags.push(tag);
  });
  return tags.slice(0, 12);
}

function normalizeBoolean(value) {
  return value === true;
}

function normalizeVersionNumber(value) {
  var number = parseInt(value, 10);
  if (!isFinite(number) || number < 1) { return 1; }
  return number;
}
```

Update `normalizeRecord(raw, makeId)` to include:

```javascript
favorite: normalizeBoolean(source.favorite),
tags: normalizeTags(source.tags),
sourceRecordId: toText(source.sourceRecordId),
versionGroupId: toText(source.versionGroupId) || id,
versionNumber: normalizeVersionNumber(source.versionNumber)
```

Add exported functions:

```javascript
function findRecordById(records, id) { ... }
function findVersionGroup(records, record) { ... }
function createVersionRecord(records, parentRecord, rawRecord, makeId) { ... }
function updateRecordTags(records, id, tags) { ... }
function toggleFavorite(records, id) { ... }
function updateRecord(records, id, patch) { ... }
```

Implementation rules:
- `findVersionGroup` sorts ascending by `versionNumber`, then `createdAt`.
- `createVersionRecord` copies parent `versionGroupId`, sets `sourceRecordId=parent.id`, and sets `versionNumber=max(group)+1`.
- Update helpers must not mutate input records.
- Keep old records backward-compatible: existing history with no new fields must load.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
node --test tests\frontend\history-store.test.cjs
```

Expected: all history store tests pass.

- [ ] **Step 5: Checkpoint**

Changed files:

```text
app/static/history-store.js
tests/frontend/history-store.test.cjs
```

---

### Task 2: Prompt enhancer and failure advice pure modules

**Files:**
- Create: `app/static/prompt-enhancer.js`
- Create: `app/static/failure-advice.js`
- Create: `tests/frontend/prompt-enhancer.test.cjs`
- Create: `tests/frontend/failure-advice.test.cjs`

- [ ] **Step 1: Write failing prompt enhancer tests**

Create `tests/frontend/prompt-enhancer.test.cjs`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPromptEnhancer() {
  const sourcePath = path.resolve(__dirname, '../../app/static/prompt-enhancer.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return context.PromptEnhancer;
}

test('enhancePrompt appends cinematic modifiers without duplicating', () => {
  const enhancer = loadPromptEnhancer();
  const result = enhancer.enhancePrompt('a cat portrait', 'cinematic');
  assert.match(result.prompt, /a cat portrait/);
  assert.match(result.prompt, /cinematic lighting/);
  assert.match(result.prompt, /film still/);
  assert.equal(result.mode, 'cinematic');
});

test('enhancePrompt supports artifact repair mode', () => {
  const enhancer = loadPromptEnhancer();
  const result = enhancer.enhancePrompt('a hand holding a cup', 'fix_artifacts');
  assert.match(result.prompt, /avoid extra fingers/);
  assert.match(result.prompt, /sharp details/);
});

test('enhancePrompt rejects blank prompt', () => {
  const enhancer = loadPromptEnhancer();
  assert.throws(() => enhancer.enhancePrompt('   ', 'realistic'), /請先輸入提示詞/);
});

test('listModes exposes user-facing labels', () => {
  const enhancer = loadPromptEnhancer();
  const modes = enhancer.listModes();
  assert.ok(modes.some((mode) => mode.id === 'realistic' && mode.label));
  assert.ok(modes.some((mode) => mode.id === 'clean'));
});
```

- [ ] **Step 2: Write failing failure advice tests**

Create `tests/frontend/failure-advice.test.cjs`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFailureAdvice() {
  const sourcePath = path.resolve(__dirname, '../../app/static/failure-advice.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return context.FailureAdvice;
}

test('getAdvice returns content filtered guidance', () => {
  const advice = loadFailureAdvice().getAdvice('content_filtered');
  assert.match(advice.title, /內容安全/);
  assert.ok(advice.steps.length >= 2);
});

test('getAdvice returns timeout guidance', () => {
  const advice = loadFailureAdvice().getAdvice('timeout');
  assert.match(advice.steps.join(' '), /schnell/);
});

test('getAdvice returns fallback guidance for unknown code', () => {
  const advice = loadFailureAdvice().getAdvice('unexpected_code');
  assert.equal(advice.code, 'unexpected_code');
  assert.match(advice.title, /產圖失敗/);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
node --test tests\frontend\prompt-enhancer.test.cjs tests\frontend\failure-advice.test.cjs
```

Expected: FAIL because both modules do not exist.

- [ ] **Step 4: Implement `prompt-enhancer.js`**

Create `app/static/prompt-enhancer.js`:

```javascript
(function (root) {
  'use strict';

  var MODES = [
    { id: 'realistic', label: '更寫實', modifiers: ['photorealistic', 'natural lighting', 'realistic textures'] },
    { id: 'cinematic', label: '更電影感', modifiers: ['cinematic lighting', 'film still', 'dramatic atmosphere'] },
    { id: 'product', label: '商業產品照', modifiers: ['studio product photography', 'clean background', 'commercial lighting'] },
    { id: 'cute', label: '更可愛', modifiers: ['adorable', 'soft rounded shapes', 'warm pastel colors'] },
    { id: 'clean', label: '更乾淨構圖', modifiers: ['clean composition', 'minimal background', 'clear subject focus'] },
    { id: 'fix_artifacts', label: '修正常見瑕疵', modifiers: ['sharp details', 'avoid blurry details', 'avoid extra fingers', 'avoid distorted hands'] }
  ];

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function findMode(modeId) {
    var id = toText(modeId) || 'clean';
    var i;
    for (i = 0; i < MODES.length; i += 1) {
      if (MODES[i].id === id) { return MODES[i]; }
    }
    return MODES[4];
  }

  function appendUnique(base, modifiers) {
    var parts = base.split(',').map(toText).filter(Boolean);
    var seen = {};
    var out = [];
    var i;
    parts.concat(modifiers).forEach(function (part) {
      var key = part.toLowerCase();
      if (seen[key]) { return; }
      seen[key] = true;
      out.push(part);
    });
    return out.join(', ');
  }

  function enhancePrompt(prompt, modeId) {
    var base = toText(prompt);
    var mode = findMode(modeId);
    if (!base) { throw new Error('請先輸入提示詞'); }
    return { prompt: appendUnique(base, mode.modifiers), mode: mode.id, label: mode.label };
  }

  function listModes() {
    return MODES.map(function (mode) {
      return { id: mode.id, label: mode.label };
    });
  }

  root.PromptEnhancer = {
    enhancePrompt: enhancePrompt,
    listModes: listModes
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 5: Implement `failure-advice.js`**

Create `app/static/failure-advice.js`:

```javascript
(function (root) {
  'use strict';

  var MAP = {
    content_filtered: {
      title: '內容安全過濾',
      steps: ['把描述改得更中性。', '移除可能敏感或具體暴力的詞。', '保留構圖、風格、光線等安全描述。']
    },
    rate_limited: {
      title: '叫用太頻繁',
      steps: ['稍候再試。', '先複製目前設定，避免重打。']
    },
    timeout: {
      title: '產圖逾時',
      steps: ['先改用 schnell 模型測試構圖。', '縮短 prompt 或換一個 seed。']
    },
    bad_provider_response: {
      title: '影像服務回應異常',
      steps: ['重試一次。', '如果持續失敗，改用較短 prompt 或稍後再試。']
    },
    missing_api_key: {
      title: '缺少 NVIDIA 金鑰',
      steps: ['本機請設定 NVIDIA_API_KEY。', 'Cloudflare 請使用 wrangler secret put NVIDIA_API_KEY。']
    },
    bad_request: {
      title: '請求格式需要調整',
      steps: ['確認 prompt 不為空。', '確認 seed 是 0 到 2147483647 的整數。']
    }
  };

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function getAdvice(code) {
    var key = toText(code) || 'unknown';
    var advice = MAP[key] || {
      title: '產圖失敗',
      steps: ['請稍後重試。', '也可以換 seed、縮短 prompt，或改用 schnell 模型。']
    };
    return { code: key, title: advice.title, steps: advice.steps.slice() };
  }

  root.FailureAdvice = { getAdvice: getAdvice };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 6: Run tests and verify GREEN**

Run:

```powershell
node --test tests\frontend\prompt-enhancer.test.cjs tests\frontend\failure-advice.test.cjs
```

Expected: all tests pass.

---

### Task 3: Wire prompt enhancer and failure advice into app shell

**Files:**
- Modify: `app/static/index.html`
- Modify: `app/static/app.js`
- Modify: `app/static/styles.css`
- Modify: `tests/test_static_ui.py`

- [ ] **Step 1: Write failing static wiring tests**

Append to `tests/test_static_ui.py`:

```python
def test_prompt_enhancer_and_failure_advice_are_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="promptEnhancer"' in html
    assert 'data-enhance-mode="realistic"' in html
    assert 'data-enhance-mode="cinematic"' in html
    assert 'data-enhance-mode="product"' in html
    assert 'data-enhance-mode="cute"' in html
    assert 'data-enhance-mode="clean"' in html
    assert 'data-enhance-mode="fix_artifacts"' in html
    assert 'src="/static/prompt-enhancer.js"' in html
    assert 'src="/static/failure-advice.js"' in html
    assert 'PromptEnhancer.enhancePrompt' in app_js
    assert 'FailureAdvice.getAdvice' in app_js
    assert 'renderFailureAdvice' in app_js
    assert '.prompt-enhancer' in styles
    assert '.failure-advice' in styles
```

- [ ] **Step 2: Run test and verify RED**

Run:

```powershell
python -m pytest tests\test_static_ui.py::test_prompt_enhancer_and_failure_advice_are_wired -q
```

Expected: FAIL because UI and scripts are not wired.

- [ ] **Step 3: Add prompt enhancer UI and script tags**

In `app/static/index.html`, after the final prompt textarea and before advanced controls, add:

```html
<div id="promptEnhancer" class="prompt-enhancer" aria-label="Prompt 強化器">
  <span class="field-label">快速強化</span>
  <div class="enhance-actions">
    <button class="btn mini secondary" type="button" data-enhance-mode="realistic">更寫實</button>
    <button class="btn mini secondary" type="button" data-enhance-mode="cinematic">電影感</button>
    <button class="btn mini secondary" type="button" data-enhance-mode="product">產品照</button>
    <button class="btn mini secondary" type="button" data-enhance-mode="cute">更可愛</button>
    <button class="btn mini secondary" type="button" data-enhance-mode="clean">乾淨構圖</button>
    <button class="btn mini secondary" type="button" data-enhance-mode="fix_artifacts">修正常見瑕疵</button>
  </div>
</div>
```

In script order, ensure:

```html
<script src="/static/generation-settings.js"></script>
<script src="/static/prompt-enhancer.js"></script>
<script src="/static/failure-advice.js"></script>
<script src="/static/app.js"></script>
```

- [ ] **Step 4: Wire app behavior**

In `app/static/app.js`, add:

```javascript
function renderFailureAdvice(code){
  var advice;
  var stage = el('stage');
  var box;
  var title;
  var list;
  if(!window.FailureAdvice || !stage){ return; }
  advice = window.FailureAdvice.getAdvice(code);
  box = document.createElement('div');
  title = document.createElement('strong');
  list = document.createElement('ul');
  box.className = 'failure-advice';
  title.textContent = advice.title;
  advice.steps.forEach(function(step){
    var item = document.createElement('li');
    item.textContent = step;
    list.appendChild(item);
  });
  box.appendChild(title);
  box.appendChild(list);
  stage.appendChild(box);
}

function applyPromptEnhancement(mode){
  var promptField = el('prompt');
  var result;
  if(!window.PromptEnhancer || !promptField){ return; }
  try{
    result = window.PromptEnhancer.enhancePrompt(promptField.value, mode);
    promptField.value = result.prompt;
    setStatus('已套用：' + result.label, 'done');
  }catch(error){
    setStatus(error.message, 'fail');
  }
}
```

When handling failed generation, call:

```javascript
renderFailureAdvice(data && data.code ? data.code : 'unknown');
```

For caught exceptions without backend JSON, call:

```javascript
renderFailureAdvice('network_error');
```

In `DOMContentLoaded`, bind enhancer buttons:

```javascript
Array.prototype.forEach.call(document.querySelectorAll('[data-enhance-mode]'), function(button){
  button.addEventListener('click', function(){
    applyPromptEnhancement(button.getAttribute('data-enhance-mode'));
  });
});
```

- [ ] **Step 5: Add styles**

Append to `app/static/styles.css`:

```css
.prompt-enhancer {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.enhance-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.failure-advice {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid rgba(248, 113, 113, 0.28);
  border-radius: 16px;
  background: rgba(127, 29, 29, 0.22);
  color: #fecaca;
  text-align: left;
}

.failure-advice ul {
  margin: 8px 0 0;
  padding-left: 20px;
}
```

- [ ] **Step 6: Run tests and syntax checks**

Run:

```powershell
python -m pytest tests\test_static_ui.py -q
node --check app\static\app.js
node --check app\static\prompt-enhancer.js
node --check app\static\failure-advice.js
```

Expected: all pass.

---

### Task 4: Artwork detail modal, share actions, and version comparison

**Files:**
- Modify: `app/static/index.html`
- Modify: `app/static/history-wall.js`
- Modify: `app/static/app.js`
- Modify: `app/static/styles.css`
- Modify: `tests/test_static_ui.py`

- [ ] **Step 1: Write failing static detail tests**

Append to `tests/test_static_ui.py`:

```python
def test_history_detail_share_and_versions_are_wired():
    html = read_static("index.html")
    history_wall_js = read_static("history-wall.js")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'id="historyDetailModal"' in html
    assert 'id="historyDetailImage"' in html
    assert 'id="historyDetailPrompt"' in html
    assert 'id="historyDetailProviderPrompt"' in html
    assert 'id="historyVersionList"' in html
    assert 'id="copyHistoryShareText"' in html
    assert 'id="exportHistoryJson"' in html
    assert 'id="hidePromptInShare"' in html
    assert 'openHistoryDetail' in history_wall_js
    assert 'renderVersionList' in history_wall_js
    assert 'copyHistoryShareText' in history_wall_js
    assert 'exportHistoryJson' in history_wall_js
    assert 'sourceRecordId' in app_js
    assert '.history-detail' in styles
    assert '.version-list' in styles
```

- [ ] **Step 2: Run test and verify RED**

Run:

```powershell
python -m pytest tests\test_static_ui.py::test_history_detail_share_and_versions_are_wired -q
```

Expected: FAIL.

- [ ] **Step 3: Add modal HTML**

In `app/static/index.html`, near existing modals, add:

```html
<div id="historyDetailModal" class="modal-backdrop" hidden>
  <div class="modal history-detail" role="dialog" aria-modal="true" aria-labelledby="historyDetailTitle">
    <div class="modal-head">
      <h2 id="historyDetailTitle">作品詳情</h2>
      <button id="closeHistoryDetail" class="icon-btn" type="button" aria-label="關閉作品詳情">×</button>
    </div>
    <img id="historyDetailImage" class="history-detail-image" alt="歷史作品預覽">
    <div class="history-detail-grid">
      <section>
        <h3>白話／使用者提示詞</h3>
        <p id="historyDetailPrompt"></p>
      </section>
      <section>
        <h3>最終 provider prompt</h3>
        <p id="historyDetailProviderPrompt"></p>
      </section>
      <section>
        <h3>設定</h3>
        <p id="historyDetailMeta"></p>
      </section>
      <section>
        <h3>版本</h3>
        <div id="historyVersionList" class="version-list"></div>
      </section>
    </div>
    <label class="tutorial-check" for="hidePromptInShare">
      <input id="hidePromptInShare" type="checkbox">
      <span>分享時隱藏 prompt</span>
    </label>
    <div class="modal-actions">
      <button id="downloadHistoryDetail" class="btn secondary" type="button">下載圖片</button>
      <button id="copyHistoryPrompt" class="btn secondary" type="button">複製 prompt</button>
      <button id="copyHistoryShareText" class="btn secondary" type="button">複製分享文案</button>
      <button id="exportHistoryJson" class="btn secondary" type="button">匯出作品 JSON</button>
      <button id="regenerateHistoryDetail" class="btn primary" type="button">以此版本再生</button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Extend app generation context for version creation**

In `app/static/app.js`, add:

```javascript
var pendingSourceRecordId = '';

function setNextGenerationSourceRecord(id){
  pendingSourceRecordId = id || '';
}
```

When creating `generatedRecord`, include:

```javascript
sourceRecordId: pendingSourceRecordId
```

After dispatching generated event, clear:

```javascript
pendingSourceRecordId = '';
```

Expose:

```javascript
setNextGenerationSourceRecord: setNextGenerationSourceRecord
```

- [ ] **Step 5: Extend `history-wall.js` detail behavior**

Implement these functions:

```javascript
var selectedRecordId = '';

function getSelectedRecord() { ... }
function openHistoryDetail(record) { ... }
function closeHistoryDetail() { ... }
function renderVersionList(record) { ... }
function buildShareText(record, hidePrompt) { ... }
function copyHistoryShareText() { ... }
function exportHistoryJson() { ... }
function regenerateHistoryDetail() { ... }
```

Rules:
- Clicking a history thumbnail/button opens detail modal instead of immediately regenerating.
- Detail modal uses `textContent` for prompt/meta.
- Version list uses `ImageHistoryStore.findVersionGroup(records, record)`.
- `regenerateHistoryDetail()` calls `ImageGenApp.setNextGenerationSourceRecord(record.id)`, then sets generation settings and calls `generate()`.
- `addGeneratedRecord()` must use `ImageHistoryStore.createVersionRecord(records, parentRecord, event.detail)` when `event.detail.sourceRecordId` is present and parent exists; otherwise use `addRecord`.
- Export JSON must create a Blob with one normalized record and click a temporary link.
- Copy share text respects `hidePromptInShare`.

- [ ] **Step 6: Add styles**

Append:

```css
.history-detail {
  max-width: min(920px, calc(100vw - 24px));
}

.history-detail-image {
  width: 100%;
  max-height: 48vh;
  object-fit: contain;
  border-radius: 18px;
  background: rgba(15, 23, 42, 0.72);
}

.history-detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin-top: 14px;
}

.version-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.version-chip {
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 999px;
  padding: 8px 10px;
  background: rgba(15, 23, 42, 0.62);
  color: #e2e8f0;
}

.version-chip.is-active {
  border-color: rgba(96, 165, 250, 0.72);
  color: #bfdbfe;
}
```

- [ ] **Step 7: Run tests**

Run:

```powershell
python -m pytest tests\test_static_ui.py -q
node --check app\static\app.js
node --check app\static\history-wall.js
node --test tests\frontend\history-store.test.cjs
```

Expected: all pass.

---

### Task 5: History search, filters, favorites, and tag editing

**Files:**
- Modify: `app/static/index.html`
- Modify: `app/static/history-wall.js`
- Modify: `app/static/styles.css`
- Modify: `tests/test_static_ui.py`

- [ ] **Step 1: Write failing static filter tests**

Append:

```python
def test_history_search_filters_tags_and_favorites_are_wired():
    html = read_static("index.html")
    history_wall_js = read_static("history-wall.js")
    styles = read_static("styles.css")

    assert 'id="historySearch"' in html
    assert 'id="historyModelFilter"' in html
    assert 'id="historySizeFilter"' in html
    assert 'id="historyFavoritesOnly"' in html
    assert 'id="historyTagEditor"' in html
    assert 'applyHistoryFilters' in history_wall_js
    assert 'toggleHistoryFavorite' in history_wall_js
    assert 'saveHistoryTags' in history_wall_js
    assert 'history-card-favorite' in history_wall_js
    assert '.history-filters' in styles
    assert '.history-tags' in styles
    assert '.history-card-favorite' in styles
```

- [ ] **Step 2: Run test and verify RED**

Run:

```powershell
python -m pytest tests\test_static_ui.py::test_history_search_filters_tags_and_favorites_are_wired -q
```

Expected: FAIL.

- [ ] **Step 3: Add filter UI**

In `historyWall` header area in `app/static/index.html`, add:

```html
<div class="history-filters" aria-label="歷史篩選">
  <input id="historySearch" class="text-input" type="search" placeholder="搜尋 prompt 或標籤">
  <select id="historyModelFilter" class="text-input">
    <option value="">所有模型</option>
    <option value="schnell">schnell</option>
    <option value="dev">dev</option>
  </select>
  <select id="historySizeFilter" class="text-input">
    <option value="">所有尺寸</option>
    <option value="square">方形</option>
    <option value="landscape">橫向</option>
    <option value="portrait">直向</option>
  </select>
  <label class="tutorial-check" for="historyFavoritesOnly">
    <input id="historyFavoritesOnly" type="checkbox">
    <span>只看收藏</span>
  </label>
</div>
```

In detail modal, add a tag editor section:

```html
<label class="form-field" for="historyTagEditor">
  <span>標籤</span>
  <input id="historyTagEditor" class="text-input" type="text" placeholder="用逗號分隔，例如：角色, 產品, 靈感">
</label>
<button id="saveHistoryTags" class="btn secondary" type="button">儲存標籤</button>
```

- [ ] **Step 4: Implement filter and favorite behavior**

In `history-wall.js`, add:

```javascript
var filters = { query: '', model: '', size: '', favoritesOnly: false };

function recordMatchesFilters(record) { ... }
function applyHistoryFilters() { ... }
function toggleHistoryFavorite(record) { ... }
function saveHistoryTags() { ... }
function renderTagList(record) { ... }
```

Rules:
- Search checks `prompt`, `providerPrompt`, and `tags`.
- Model/size exact match if filter has value.
- Favorites only shows `record.favorite === true`.
- Star button on card calls `ImageHistoryStore.toggleFavorite`, saves records, re-renders, and keeps current filters.
- Tag editor saves comma-separated tags via `ImageHistoryStore.updateRecordTags`.
- Detail modal refreshes selected record after tag/favorite updates.

- [ ] **Step 5: Add styles**

Append:

```css
.history-filters {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) repeat(2, minmax(120px, 180px)) auto;
  gap: 10px;
  margin: 14px 0;
}

.history-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.history-tag {
  border-radius: 999px;
  padding: 4px 8px;
  background: rgba(59, 130, 246, 0.16);
  color: #bfdbfe;
  font-size: 0.75rem;
}

.history-card-favorite {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
}
```

- [ ] **Step 6: Run tests**

Run:

```powershell
python -m pytest tests\test_static_ui.py -q
node --check app\static\history-wall.js
```

Expected: all pass.

---

### Task 6: PWA and mobile polish

**Files:**
- Create: `app/static/manifest.webmanifest`
- Create: `app/static/service-worker.js`
- Modify: `app/static/index.html`
- Modify: `app/static/app.js`
- Modify: `app/static/styles.css`
- Modify: `app/main.py`
- Modify: `tests/test_app.py`
- Modify: `tests/test_static_ui.py`

- [ ] **Step 1: Write failing PWA route/static tests**

Add to `tests/test_app.py`:

```python
    def test_manifest_route_serves_webmanifest(self):
        response = self.client.get("/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertIn("application/manifest+json", response.headers["content-type"])
        self.assertIn("AI 圖片產生器", response.text)

    def test_service_worker_route_serves_js_with_scope_header(self):
        response = self.client.get("/service-worker.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("javascript", response.headers["content-type"])
        self.assertEqual(response.headers.get("service-worker-allowed"), "/")
```

Add to `tests/test_static_ui.py`:

```python
def test_pwa_and_mobile_ui_are_wired():
    html = read_static("index.html")
    app_js = read_static("app.js")
    styles = read_static("styles.css")

    assert 'rel="manifest"' in html
    assert 'href="/manifest.webmanifest"' in html
    assert 'id="mobileGenerateBar"' in html
    assert 'registerServiceWorker' in app_js
    assert "serviceWorker.register('/service-worker.js'" in app_js
    assert '.mobile-generate-bar' in styles
    assert '@media (max-width: 720px)' in styles
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
python -m pytest tests\test_app.py::AppRouteTests::test_manifest_route_serves_webmanifest tests\test_app.py::AppRouteTests::test_service_worker_route_serves_js_with_scope_header tests\test_static_ui.py::test_pwa_and_mobile_ui_are_wired -q
```

Expected: FAIL.

- [ ] **Step 3: Add PWA files**

Create `app/static/manifest.webmanifest`:

```json
{
  "name": "AI 圖片產生器",
  "short_name": "AI 生圖",
  "description": "白話中文轉提示詞、生成圖片、管理歷史作品。",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0a0b0f",
  "theme_color": "#0a0b0f",
  "icons": [
    {
      "src": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='28' fill='%230a0b0f'/%3E%3Ctext x='64' y='82' font-size='64' text-anchor='middle'%3E%E2%9C%A6%3C/text%3E%3C/svg%3E",
      "sizes": "128x128",
      "type": "image/svg+xml",
      "purpose": "any"
    }
  ]
}
```

Create `app/static/service-worker.js`:

```javascript
var CACHE_NAME = 'ai-image-generator-static-v1';
var STATIC_URLS = [
  '/',
  '/static/styles.css',
  '/static/generation-settings.js',
  '/static/prompt-enhancer.js',
  '/static/failure-advice.js',
  '/static/app.js',
  '/static/prompt-transform.js',
  '/static/idea-store.js',
  '/static/idea-cards.js',
  '/static/history-store.js',
  '/static/history-wall.js',
  '/static/tutorial.js'
];

self.addEventListener('install', function(event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function(cache) {
    return cache.addAll(STATIC_URLS);
  }));
});

self.addEventListener('activate', function(event) {
  event.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(key) {
      return key !== CACHE_NAME;
    }).map(function(key) {
      return caches.delete(key);
    }));
  }));
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') { return; }
  event.respondWith(caches.match(event.request).then(function(cached) {
    return cached || fetch(event.request);
  }));
});
```

- [ ] **Step 4: Add FastAPI root PWA routes**

In `app/main.py`, add:

```python
@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/service-worker.js")
def service_worker():
    return FileResponse(
        STATIC_DIR / "service-worker.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )
```

- [ ] **Step 5: Wire HTML and app registration**

In `app/static/index.html` `<head>`, add:

```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/manifest.webmanifest">
```

Near end of `<main>`, add:

```html
<div id="mobileGenerateBar" class="mobile-generate-bar" hidden>
  <button id="mobileGenerate" class="btn primary" type="button">🎨 生成圖片</button>
</div>
```

In `app/static/app.js`, add:

```javascript
function registerServiceWorker(){
  if(!('serviceWorker' in navigator)){ return; }
  navigator.serviceWorker.register('/service-worker.js').catch(function(){});
}
```

In `DOMContentLoaded`, add:

```javascript
registerServiceWorker();
if(el('mobileGenerate')){ el('mobileGenerate').addEventListener('click', generate); }
if(el('mobileGenerateBar')){ el('mobileGenerateBar').hidden = false; }
```

- [ ] **Step 6: Add mobile styles**

Append:

```css
.mobile-generate-bar {
  display: none;
}

@media (max-width: 720px) {
  .shell {
    padding-bottom: 92px;
  }

  .mobile-generate-bar {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: calc(12px + env(safe-area-inset-bottom));
    z-index: 40;
    display: block;
    padding: 10px;
    border: 1px solid rgba(148, 163, 184, 0.22);
    border-radius: 22px;
    background: rgba(15, 23, 42, 0.82);
    backdrop-filter: blur(18px);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.36);
  }

  .mobile-generate-bar[hidden] {
    display: none;
  }

  .mobile-generate-bar .btn {
    width: 100%;
  }

  .history-filters {
    grid-template-columns: 1fr;
  }

  .history-detail-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 7: Run tests**

Run:

```powershell
python -m pytest tests\test_app.py tests\test_static_ui.py -q
node --check app\static\app.js
node --check app\static\service-worker.js
```

Expected: all pass.

---

### Task 7: Cloudflare sync for v1.4 static and PWA assets

**Files:**
- Modify: `cloudflare/public/index.html`
- Modify: `cloudflare/public/static/*`
- Create: `cloudflare/public/manifest.webmanifest`
- Create: `cloudflare/public/service-worker.js`
- Modify: `cloudflare/tests/worker-transform.test.mjs`
- Modify: `cloudflare/scripts/check-js.mjs` if root service worker is not covered.

- [ ] **Step 1: Write failing Cloudflare static tests**

In `cloudflare/tests/worker-transform.test.mjs`, extend static tests:

```javascript
test('Cloudflare static shell includes v1.4 workspace and PWA assets', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const manifest = await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
  const serviceWorker = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');

  assert.match(html, /id="historyDetailModal"/);
  assert.match(html, /id="promptEnhancer"/);
  assert.match(html, /id="historySearch"/);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /src="\/static\/prompt-enhancer\.js"/);
  assert.match(html, /src="\/static\/failure-advice\.js"/);
  assert.match(manifest, /AI 圖片產生器/);
  assert.match(serviceWorker, /CACHE_NAME/);
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```powershell
cd cloudflare
npm test
```

Expected: FAIL until assets are synced.

- [ ] **Step 3: Copy assets**

Run from project root:

```powershell
Copy-Item -LiteralPath 'app\static\index.html' -Destination 'cloudflare\public\index.html' -Force
Copy-Item -LiteralPath 'app\static\manifest.webmanifest' -Destination 'cloudflare\public\manifest.webmanifest' -Force
Copy-Item -LiteralPath 'app\static\service-worker.js' -Destination 'cloudflare\public\service-worker.js' -Force
Copy-Item -LiteralPath 'app\static\app.js','app\static\generation-settings.js','app\static\prompt-enhancer.js','app\static\failure-advice.js','app\static\prompt-transform.js','app\static\idea-store.js','app\static\idea-cards.js','app\static\history-store.js','app\static\history-wall.js','app\static\tutorial.js','app\static\styles.css' -Destination 'cloudflare\public\static' -Force
```

- [ ] **Step 4: Update JS syntax scanner**

Ensure `cloudflare/scripts/check-js.mjs` scans:
- `src`
- `public/static`
- `tests`
- `public/service-worker.js`

If it only scans directories, add explicit root files:

```javascript
const ROOT_JS_FILES = ['public/service-worker.js'];
```

Then include existing files that exist.

- [ ] **Step 5: Run Cloudflare tests and dry-run**

Run:

```powershell
cd cloudflare
npm test
npm run check
$out = npx wrangler deploy --dry-run 2>&1 | Out-String
$out
if ($out -like '*--dry-run: exiting now.*' -and $out -like '*assets directory*') { exit 0 }
exit 1
```

Expected: all pass.

---

### Task 8: Documentation, full verification, and final subagent review

**Files:**
- Modify: `README.md`
- Modify: `cloudflare/README.md`

- [ ] **Step 1: Update docs**

Add to `README.md` and `cloudflare/README.md`:

```markdown
## v1.4 作品管理與分享

- 作品詳情面板：查看圖片、白話描述、最終 prompt、排除描述、model、size、seed、provider、生成時間。
- Prompt 版本比較：從歷史作品再生時會形成版本鏈，可切換比較不同 prompt / seed / model。
- 分享卡片：可複製分享文案、複製設定 JSON、匯出作品 JSON、下載圖片；可選擇分享時隱藏 prompt。
- Prompt 強化器：提供更寫實、電影感、產品照、可愛、乾淨構圖、修正常見瑕疵等規則式強化，不增加 API 成本。
- 失敗修正建議：依 `content_filtered`、`rate_limited`、`timeout`、`bad_provider_response`、`missing_api_key` 等錯誤提供下一步建議。
- 歷史搜尋與標籤：可搜尋 prompt、篩選 model/size、收藏星號、編輯標籤。
- PWA / 手機體驗：提供 manifest、service worker、手機底部生成列與響應式歷史牆。

不包含每日額度、冷卻、防濫用、帳號系統或公開作品牆。
```

- [ ] **Step 2: Full verification**

Run:

```powershell
python -m pytest -q
node --test tests\frontend\idea-store.test.cjs tests\frontend\generation-settings.test.cjs tests\frontend\history-store.test.cjs tests\frontend\prompt-enhancer.test.cjs tests\frontend\failure-advice.test.cjs
cd cloudflare
npm test
npm run check
```

Run Wrangler dry-run:

```powershell
$out = npx wrangler deploy --dry-run 2>&1 | Out-String
$out
if ($out -like '*--dry-run: exiting now.*' -and $out -like '*assets directory*') { exit 0 }
exit 1
```

- [ ] **Step 3: Local smoke without real generation**

Allowed smoke:
- `GET /health`
- `POST /prompt/transform` with simple source
- `POST /generate` blank prompt only

Do not run successful real NVIDIA image generation.

- [ ] **Step 4: Final review**

Dispatch a final review subagent to check:
- No `negative_prompt`.
- No quota/cooldown/abuse-control feature was added.
- No secrets in docs or code.
- FastAPI and Cloudflare static hashes match.
- PWA routes work in FastAPI and assets exist in Cloudflare.
- All tests pass.

---

## Self-Review

Spec coverage:
- Artwork details: Task 4.
- Prompt version comparison: Tasks 1 and 4.
- Share card/export: Task 4 and Task 8 docs.
- Prompt enhancer: Tasks 2 and 3.
- Failure advice: Tasks 2 and 3.
- History search/tags/favorites: Tasks 1 and 5.
- PWA/mobile: Task 6.
- Cloudflare sync: Task 7.
- Docs/full verification: Task 8.
- Excluded daily quota/cooldown/abuse prevention: explicitly excluded in scope and final review.

Placeholder scan:
- No `TBD`, `TODO`, or open-ended placeholder requirements.
- Every task has concrete files, tests, commands, and expected outcomes.

Type consistency:
- History metadata uses `favorite`, `tags`, `sourceRecordId`, `versionGroupId`, and `versionNumber` across store and UI.
- Prompt enhancer exposes `PromptEnhancer.enhancePrompt()` and `PromptEnhancer.listModes()`.
- Failure advice exposes `FailureAdvice.getAdvice()`.
- PWA assets are rooted at `/manifest.webmanifest` and `/service-worker.js` for service-worker scope correctness.

