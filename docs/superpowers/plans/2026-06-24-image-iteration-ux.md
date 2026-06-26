# Image Iteration UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first high-CP iteration UX wave: browser history wall, one-click regenerate, copy settings, stronger progress feedback, seed control, and a safe exclude-description helper.

**Architecture:** Keep provider-facing API compatible: `/generate` accepts `prompt`, `model`, `size`, and optional `seed`; exclude text is merged into the final prompt on the frontend instead of being sent as `negative_prompt`. Split browser logic into pure helper/store files and thin DOM modules so FastAPI and Cloudflare can share the same static assets. Keep Worker and FastAPI response shapes aligned by returning `seed`.

**Tech Stack:** FastAPI, Python dataclasses, vanilla ES5 browser JavaScript, Node built-in test runner, Cloudflare Workers, Wrangler.

---

## Scope

Included:
- History wall persisted in browser `localStorage`, newest first, with image, thumbnail, prompt, model, size, seed, download, regenerate, delete, and clear-all actions.
- Result action row: regenerate, copy settings, copy prompt.
- Seed input. Empty input and `0` mean random; positive integers are forwarded to NVIDIA and returned.
- Model-aware progress copy while keeping the existing skeleton and timer.
- Safe exclude-description helper: append `avoid ...` terms to `prompt`; do not send unsupported `negative_prompt`.

Excluded:
- Batch 2/4 image generation.
- Image-to-image or style reference upload.
- Server-side gallery persistence.

NVIDIA docs constraint:
- FLUX.1-dev / schnell API docs list `seed`, but not `negative_prompt`; `samples` is documented as `1`.
- Dev: `https://docs.api.nvidia.com/nim/reference/black-forest-labs-flux_1-dev-infer`
- Schnell: `https://docs.api.nvidia.com/nim/reference/black-forest-labs-flux_1-schnell-infer`

Current folder is not a Git repo, so checkpoint steps record changed files instead of committing. If later executed inside Git, commit by task.

## File Map

Create:
- `app/static/generation-settings.js` — pure helper: seed parsing, exclude prompt composition, settings serialization.
- `app/static/history-store.js` — pure localStorage store for generated history.
- `app/static/history-wall.js` — DOM renderer/binder for the history wall.
- `tests/frontend/generation-settings.test.cjs`
- `tests/frontend/history-store.test.cjs`

Modify:
- `app/image_service.py`
- `app/main.py`
- `tests/test_image_service.py`
- `tests/test_app.py`
- `app/static/index.html`
- `app/static/app.js`
- `app/static/styles.css`
- `tests/test_static_ui.py`
- `cloudflare/src/index.js`
- `cloudflare/tests/worker-transform.test.mjs`
- `cloudflare/package.json`
- `cloudflare/public/index.html`
- `cloudflare/public/static/*`
- `README.md`
- `cloudflare/README.md`

---

### Task 1: Add pure generation settings helper

**Files:**
- Create: `app/static/generation-settings.js`
- Create: `tests/frontend/generation-settings.test.cjs`

- [ ] **Step 1: Write the failing test**

Create `tests/frontend/generation-settings.test.cjs`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGenerationSettings() {
  const sourcePath = path.resolve(__dirname, '../../app/static/generation-settings.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return context.GenerationSettings;
}

test('normalizeSeed treats blank and zero as random seed zero', () => {
  const GenerationSettings = loadGenerationSettings();
  assert.equal(GenerationSettings.normalizeSeed(''), 0);
  assert.equal(GenerationSettings.normalizeSeed('   '), 0);
  assert.equal(GenerationSettings.normalizeSeed('0'), 0);
});

test('normalizeSeed accepts positive integer strings', () => {
  const GenerationSettings = loadGenerationSettings();
  assert.equal(GenerationSettings.normalizeSeed('12345'), 12345);
});

test('normalizeSeed rejects invalid input', () => {
  const GenerationSettings = loadGenerationSettings();
  assert.throws(() => GenerationSettings.normalizeSeed('-1'), /seed 必須是 0 到 2147483647 之間的整數/);
  assert.throws(() => GenerationSettings.normalizeSeed('1.5'), /seed 必須是 0 到 2147483647 之間的整數/);
  assert.throws(() => GenerationSettings.normalizeSeed('abc'), /seed 必須是 0 到 2147483647 之間的整數/);
});

test('buildProviderPrompt appends avoid text without negative_prompt field', () => {
  const GenerationSettings = loadGenerationSettings();
  assert.equal(
    GenerationSettings.buildProviderPrompt('a portrait photo', 'blurry, extra fingers'),
    'a portrait photo, avoid blurry, extra fingers'
  );
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test tests\frontend\generation-settings.test.cjs
```

Expected: FAIL because `app/static/generation-settings.js` does not exist.

- [ ] **Step 3: Implement helper**

Create `app/static/generation-settings.js`:

```javascript
(function (root) {
  'use strict';

  var MAX_SEED = 2147483647;

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function normalizeSeed(value) {
    var text = toText(value);
    var seed;
    if (!text) { return 0; }
    if (!/^\d+$/.test(text)) {
      throw new Error('seed 必須是 0 到 2147483647 之間的整數');
    }
    seed = Number(text);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
      throw new Error('seed 必須是 0 到 2147483647 之間的整數');
    }
    return seed;
  }

  function buildProviderPrompt(prompt, avoidText) {
    var base = toText(prompt);
    var avoid = toText(avoidText);
    return avoid ? base + ', avoid ' + avoid : base;
  }

  function serializeSettings(settings) {
    var source = settings || {};
    return {
      prompt: toText(source.prompt),
      avoid: toText(source.avoid),
      providerPrompt: buildProviderPrompt(source.prompt, source.avoid),
      model: toText(source.model) || 'schnell',
      size: toText(source.size) || 'square',
      seed: normalizeSeed(source.seed)
    };
  }

  root.GenerationSettings = {
    MAX_SEED: MAX_SEED,
    normalizeSeed: normalizeSeed,
    buildProviderPrompt: buildProviderPrompt,
    serializeSettings: serializeSettings
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
node --test tests\frontend\generation-settings.test.cjs
```

Expected: all tests pass.

- [ ] **Step 5: Checkpoint**

Record:

```text
app/static/generation-settings.js
tests/frontend/generation-settings.test.cjs
```

---

### Task 2: Add seed support to FastAPI backend

**Files:**
- Modify: `app/image_service.py`
- Modify: `app/main.py`
- Modify: `tests/test_image_service.py`
- Modify: `tests/test_app.py`

- [ ] **Step 1: Write failing tests**

Add to `tests/test_app.py`:

```python
    def test_generate_accepts_seed_and_returns_it(self):
        response = self.client.post(
            "/generate",
            json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square", "seed": 12345},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["seed"], 12345)

    def test_generate_rejects_invalid_seed(self):
        response = self.client.post(
            "/generate",
            json={"prompt": "a cute corgi astronaut", "model": "schnell", "size": "square", "seed": -1},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "bad_request")
```

Add to `tests/test_image_service.py`:

```python
    def test_validate_seed_accepts_none_zero_and_positive_integer(self):
        from app.image_service import validate_seed

        self.assertIsNone(validate_seed(None))
        self.assertEqual(validate_seed(0), 0)
        self.assertEqual(validate_seed(12345), 12345)

    def test_validate_seed_rejects_invalid_values(self):
        from app.image_service import validate_seed

        with self.assertRaisesRegex(ValueError, "seed 必須是 0 到 2147483647 之間的整數"):
            validate_seed(-1)
        with self.assertRaisesRegex(ValueError, "seed 必須是 0 到 2147483647 之間的整數"):
            validate_seed(2147483648)
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
python -m pytest tests\test_app.py::AppRouteTests::test_generate_accepts_seed_and_returns_it tests\test_app.py::AppRouteTests::test_generate_rejects_invalid_seed tests\test_image_service.py::ImageServiceTests::test_validate_seed_accepts_none_zero_and_positive_integer tests\test_image_service.py::ImageServiceTests::test_validate_seed_rejects_invalid_values -q
```

Expected: FAIL because `seed` is not accepted/returned and `validate_seed` is missing.

- [ ] **Step 3: Implement seed validation and response**

In `app/image_service.py`, add:

```python
MAX_SEED = 2147483647

def validate_seed(seed: int | None) -> int | None:
    if seed is None:
        return None
    if not isinstance(seed, int) or seed < 0 or seed > MAX_SEED:
        raise ValueError("seed 必須是 0 到 2147483647 之間的整數")
    return seed

def resolve_seed(request_seed: int | None, model: str, settings: Settings) -> int:
    validated = validate_seed(request_seed)
    if validated is not None:
        return validated
    return settings.nvidia_dev_seed if model == "dev" else settings.nvidia_schnell_seed
```

Update dataclasses:

```python
@dataclass(frozen=True)
class GenerationRequest:
    prompt: str
    model: str = "schnell"
    size: str = "square"
    seed: int | None = None

@dataclass(frozen=True)
class GenerationResult:
    image: str
    provider: str
    model: str
    width: int
    height: int
    seed: int
```

In both `DemoProvider.generate()` and `NvidiaProvider.generate()`:

```python
seed = resolve_seed(request.seed, model, self.settings)
```

For NVIDIA payload:

```python
payload: dict[str, Any] = {
    "prompt": prompt,
    "width": width,
    "height": height,
    "seed": seed,
}
```

Return `GenerationResult(..., seed=seed)`.

In `app/main.py`, update `GeneratePayload` and response:

```python
class GeneratePayload(BaseModel):
    prompt: str
    model: str = "schnell"
    size: str = "square"
    seed: int | None = None
```

```python
GenerationRequest(prompt=payload.prompt, model=payload.model, size=payload.size, seed=payload.seed)
```

```python
"seed": result.seed,
```

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
python -m pytest tests\test_app.py tests\test_image_service.py -q
```

Expected: all selected tests pass.

---

### Task 3: Add seed support to Cloudflare Worker

**Files:**
- Modify: `cloudflare/src/index.js`
- Modify: `cloudflare/tests/worker-transform.test.mjs`

- [ ] **Step 1: Write failing Worker tests**

Add to `cloudflare/tests/worker-transform.test.mjs`:

```javascript
test('POST /generate forwards explicit seed to NVIDIA and returns it', async () => {
  const originalFetch = globalThis.fetch;
  let providerPayload;

  globalThis.fetch = async function (_url, init) {
    providerPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: 12345 }),
      fakeEnv({ NVIDIA_API_KEY: 'test-key' })
    );
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(providerPayload.seed, 12345);
    assert.equal(data.seed, 12345);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /generate rejects invalid seed before provider access', async () => {
  const response = await worker.fetch(
    jsonRequest('/generate', { prompt: 'a cat', model: 'schnell', size: 'square', seed: -1 }),
    fakeEnv({ NVIDIA_API_KEY: 'test-key' })
  );
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.equal(data.code, 'bad_request');
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
cd cloudflare
npm test
```

Expected: FAIL because Worker ignores request seed and response lacks `seed`.

- [ ] **Step 3: Implement Worker seed support**

In `cloudflare/src/index.js`, add:

```javascript
const MAX_SEED = 2147483647;

function validateSeed(seed) {
  if (seed === undefined || seed === null || seed === '') return 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new HttpError('seed 必須是 0 到 2147483647 之間的整數', 400, 'bad_request');
  }
  return seed;
}
```

Inside `handleGenerate`:

```javascript
let prompt, model, size, width, height, seed;
```

```javascript
seed = validateSeed(payload.seed);
```

```javascript
const body = { prompt, width, height, seed };
```

```javascript
return json({ image, provider: 'nvidia', model, width, height, seed });
```

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
cd cloudflare
npm test
```

Expected: all Worker tests pass.

---

### Task 4: Add history store

**Files:**
- Create: `app/static/history-store.js`
- Create: `tests/frontend/history-store.test.cjs`

- [ ] **Step 1: Write failing store tests**

Create `tests/frontend/history-store.test.cjs`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHistoryStore() {
  const sourcePath = path.resolve(__dirname, '../../app/static/history-store.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  return context.ImageHistoryStore;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('normalizeRecord trims fields and applies defaults', () => {
  const Store = loadHistoryStore();
  const record = Store.normalizeRecord({
    image: 'data:image/png;base64,abc',
    thumbnail: 'data:image/png;base64,thumb',
    prompt: '  a cat  ',
    providerPrompt: '  a cat, avoid blurry  ',
    avoid: ' blurry ',
    seed: 123
  }, () => 'history-id-1');
  assert.equal(record.id, 'history-id-1');
  assert.equal(record.prompt, 'a cat');
  assert.equal(record.providerPrompt, 'a cat, avoid blurry');
  assert.equal(record.model, 'schnell');
  assert.equal(record.size, 'square');
});

test('normalizeRecord rejects missing image or prompt', () => {
  const Store = loadHistoryStore();
  assert.throws(() => Store.normalizeRecord({ prompt: 'a cat' }, () => 'id'), /缺少圖片資料/);
  assert.throws(() => Store.normalizeRecord({ image: 'data:image/png;base64,abc' }, () => 'id'), /缺少提示詞/);
});

test('addRecord prepends and limits records', () => {
  const Store = loadHistoryStore();
  let records = [];
  for (let i = 0; i < Store.MAX_RECORDS + 2; i += 1) {
    records = Store.addRecord(records, { image: 'data:image/png;base64,' + i, prompt: 'prompt ' + i }, () => 'id-' + i);
  }
  assert.equal(records.length, Store.MAX_RECORDS);
  assert.equal(records[0].prompt, 'prompt ' + (Store.MAX_RECORDS + 1));
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test tests\frontend\history-store.test.cjs
```

Expected: FAIL because the store file does not exist.

- [ ] **Step 3: Implement store**

Create `app/static/history-store.js` with these exported functions on `root.ImageHistoryStore`:

```javascript
STORAGE_KEY: 'aiImageGenerationHistory.v1'
MAX_RECORDS: 12
normalizeRecord(raw, makeId)
loadRecords(storage)
saveRecords(records, storage)
addRecord(records, rawRecord, makeId)
deleteRecord(records, id)
clearRecords(storage)
```

Implementation requirements:
- Same IIFE pattern as `idea-store.js`.
- `normalizeRecord` requires `image` and `prompt`.
- Defaults: `thumbnail=image`, `model='schnell'`, `size='square'`, `seed=0`, `createdAt=new Date().toISOString()`.
- `saveRecords` catches localStorage quota errors and drops oldest records until save succeeds.
- `deleteRecord` and `clearRecords` never throw.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
node --test tests\frontend\history-store.test.cjs
```

Expected: all tests pass.

---

### Task 5: Add UI shell and static wiring

**Files:**
- Modify: `app/static/index.html`
- Modify: `app/static/styles.css`
- Modify: `tests/test_static_ui.py`

- [ ] **Step 1: Write failing static UI test**

Add to `tests/test_static_ui.py`:

```python
def test_iteration_ux_ui_is_wired():
    html = read_static("index.html")
    styles = read_static("styles.css")
    assert 'id="seed"' in html
    assert 'id="avoid"' in html
    assert 'id="resultActions"' in html
    assert 'id="regenerate"' in html
    assert 'id="copySettings"' in html
    assert 'id="copyPrompt"' in html
    assert 'id="historyWall"' in html
    assert 'id="historyGrid"' in html
    assert 'id="clearHistory"' in html
    assert 'src="/static/generation-settings.js"' in html
    assert 'src="/static/history-store.js"' in html
    assert 'src="/static/history-wall.js"' in html
    assert ".result-actions" in styles
    assert ".history-wall" in styles
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
python -m pytest tests\test_static_ui.py::test_iteration_ux_ui_is_wired -q
```

Expected: FAIL because new UI elements are absent.

- [ ] **Step 3: Update HTML**

Add after final prompt textarea:

```html
<div class="prompt-controls advanced-controls" aria-label="進階生成設定">
  <label class="field">
    <span class="field-label">Seed（選填）</span>
    <input id="seed" class="text-input" type="number" min="0" max="2147483647" step="1" inputmode="numeric" placeholder="0 表示隨機">
  </label>
  <label class="field field-wide">
    <span class="field-label">排除描述輔助</span>
    <input id="avoid" class="text-input" type="text" maxlength="240" placeholder="例如：blurry, extra fingers, low quality">
  </label>
</div>
```

Add after `stage`:

```html
<div id="resultActions" class="result-actions" hidden>
  <button id="regenerate" class="btn secondary" type="button">🔁 再生一張</button>
  <button id="copySettings" class="btn secondary" type="button">📋 複製這組設定</button>
  <button id="copyPrompt" class="btn secondary" type="button">複製提示詞</button>
</div>

<section id="historyWall" class="history-wall glass" aria-label="歷史記錄牆">
  <div class="history-head">
    <div>
      <div class="ideas-title">🖼️ 歷史記錄牆<span class="hint">（存在這台瀏覽器）</span></div>
      <p class="custom-ideas-copy">保留最近生成的圖片，可重新下載、複製提示詞或再生。</p>
    </div>
    <button id="clearHistory" class="btn mini secondary" type="button">清空歷史</button>
  </div>
  <div id="historyGrid" class="history-grid" aria-live="polite"></div>
</section>
```

Script order:

```html
<script src="/static/generation-settings.js"></script>
<script src="/static/app.js"></script>
<script src="/static/prompt-transform.js"></script>
<script src="/static/idea-store.js"></script>
<script src="/static/idea-cards.js"></script>
<script src="/static/history-store.js"></script>
<script src="/static/history-wall.js"></script>
<script src="/static/tutorial.js"></script>
```

- [ ] **Step 4: Add CSS**

Append styles for:

```css
.advanced-controls {}
.field-wide {}
.text-input {}
.result-actions {}
.history-wall {}
.history-head {}
.history-grid {}
.history-card {}
.history-thumb {}
.history-body {}
.history-prompt {}
.history-meta {}
.history-actions {}
.history-empty {}
```

Use the same glass/dark visual language as `.custom-ideas`, `.idea`, and `.modal`.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
python -m pytest tests\test_static_ui.py::test_iteration_ux_ui_is_wired -q
```

Expected: pass.

---

### Task 6: Integrate app actions and history wall

**Files:**
- Create: `app/static/history-wall.js`
- Modify: `app/static/app.js`
- Modify: `tests/test_static_ui.py`

- [ ] **Step 1: Write failing static integration test**

Add to `tests/test_static_ui.py`:

```python
def test_iteration_ux_scripts_integrate_with_app():
    app_js = read_static("app.js")
    history_wall_js = read_static("history-wall.js")
    assert "GenerationSettings.serializeSettings" in app_js
    assert "seed: settings.seed" in app_js
    assert "imagegen:generated" in app_js
    assert "model === 'dev'" in app_js
    assert "copySettings" in app_js
    assert "regenerate" in app_js
    assert "ImageHistoryStore.loadRecords" in history_wall_js
    assert "downloadHistoryImage" in history_wall_js
    assert "regenerateHistoryImage" in history_wall_js
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
python -m pytest tests\test_static_ui.py::test_iteration_ux_scripts_integrate_with_app -q
```

Expected: FAIL.

- [ ] **Step 3: Update `app/static/app.js`**

Add:

```javascript
var lastGeneration = null;

function getGenerationSettings(){
  return window.GenerationSettings.serializeSettings({
    prompt: el('prompt').value,
    avoid: el('avoid') ? el('avoid').value : '',
    model: el('model').value,
    size: el('size').value,
    seed: el('seed') ? el('seed').value : ''
  });
}

function setGenerationSettings(settings){
  var source = settings || {};
  if(source.prompt !== undefined){ el('prompt').value = source.prompt; }
  if(el('avoid') && source.avoid !== undefined){ el('avoid').value = source.avoid; }
  if(source.model){ el('model').value = source.model; }
  if(source.size){ el('size').value = source.size; }
  if(el('seed') && source.seed !== undefined){ el('seed').value = String(source.seed || ''); }
}

function modelProgressLabel(model){
  return model === 'dev' ? '高品質模型通常較久，請稍候' : '快速模型生成中';
}
```

In `generate()`, build:

```javascript
var settings = getGenerationSettings();
var prompt = settings.providerPrompt;
var model = settings.model;
var size = settings.size;
```

Fetch body:

```javascript
body: JSON.stringify({prompt: prompt, model: model, size: size, seed: settings.seed})
```

On success:

```javascript
lastGeneration = {
  image: image,
  thumbnail: image,
  prompt: settings.prompt,
  providerPrompt: prompt,
  avoid: settings.avoid,
  model: model,
  size: size,
  seed: data.seed || settings.seed,
  width: data.width,
  height: data.height,
  provider: data.provider
};
document.dispatchEvent(new CustomEvent('imagegen:generated', { detail: lastGeneration }));
```

Add copy/regenerate helpers and bind `regenerate`, `copySettings`, `copyPrompt`.

Expose:

```javascript
window.ImageGenApp = {
  generate: generate,
  setPromptAndGenerate: setPromptAndGenerate,
  setGenerationSettings: setGenerationSettings,
  copyText: copyText,
  setStatus: setStatus,
  el: el
};
```

- [ ] **Step 4: Create `history-wall.js`**

Implement:

```javascript
(function (root) {
  'use strict';
  var records = [];

  function byId(id) {
    return document.getElementById(id);
  }

  function downloadHistoryImage(record) {
    var link = document.createElement('a');
    link.href = record.image;
    link.download = 'history_' + record.id + '.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function regenerateHistoryImage(record) {
    root.ImageGenApp.setGenerationSettings({
      prompt: record.prompt,
      avoid: record.avoid,
      model: record.model,
      size: record.size,
      seed: 0
    });
    root.ImageGenApp.generate();
  }

  function renderHistory() {
    var grid = byId('historyGrid');
    if (!grid) { return; }
    grid.textContent = '';
    records.forEach(function (record) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-card';
      button.textContent = record.prompt + ' · seed ' + record.seed;
      button.addEventListener('click', function () { regenerateHistoryImage(record); });
      grid.appendChild(button);
    });
  }
  function addGeneratedRecord(event) {
    records = root.ImageHistoryStore.addRecord(records, event.detail);
    records = root.ImageHistoryStore.saveRecords(records);
    renderHistory();
  }

  document.addEventListener('DOMContentLoaded', function () {
    records = root.ImageHistoryStore.loadRecords();
    renderHistory();
    document.addEventListener('imagegen:generated', addGeneratedRecord);
    document.getElementById('clearHistory').addEventListener('click', function () {
      records = root.ImageHistoryStore.clearRecords();
      renderHistory();
    });
  });

  root.ImageHistoryWall = {
    renderHistory: renderHistory,
    downloadHistoryImage: downloadHistoryImage,
    regenerateHistoryImage: regenerateHistoryImage
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
python -m pytest tests\test_static_ui.py -q
node --test tests\frontend\idea-store.test.cjs tests\frontend\generation-settings.test.cjs tests\frontend\history-store.test.cjs
```

Expected: all tests pass.

---

### Task 7: Sync static assets and tests to Cloudflare

**Files:**
- Modify: `cloudflare/public/index.html`
- Modify/Create: `cloudflare/public/static/generation-settings.js`
- Modify/Create: `cloudflare/public/static/history-store.js`
- Modify/Create: `cloudflare/public/static/history-wall.js`
- Modify: `cloudflare/public/static/app.js`
- Modify: `cloudflare/public/static/styles.css`
- Modify: `cloudflare/package.json`
- Modify: `cloudflare/tests/worker-transform.test.mjs`

- [ ] **Step 1: Copy static assets**

Run:

```powershell
Copy-Item -LiteralPath 'app\static\index.html' -Destination 'cloudflare\public\index.html' -Force
Copy-Item -LiteralPath 'app\static\app.js','app\static\generation-settings.js','app\static\prompt-transform.js','app\static\idea-store.js','app\static\idea-cards.js','app\static\history-store.js','app\static\history-wall.js','app\static\tutorial.js','app\static\styles.css' -Destination 'cloudflare\public\static' -Force
```

- [ ] **Step 2: Update `cloudflare/package.json` check script**

Include:

```json
"check": "node --check src/index.js && node --check public/static/generation-settings.js && node --check public/static/app.js && node --check public/static/prompt-transform.js && node --check public/static/idea-store.js && node --check public/static/idea-cards.js && node --check public/static/history-store.js && node --check public/static/history-wall.js && node --check public/static/tutorial.js"
```

- [ ] **Step 3: Extend Cloudflare static shell test**

In `cloudflare/tests/worker-transform.test.mjs`, assert:

```javascript
assert.match(html, /id="seed"/);
assert.match(html, /id="avoid"/);
assert.match(html, /id="historyGrid"/);
assert.match(html, /src="\/static\/generation-settings\.js"/);
assert.match(html, /src="\/static\/history-store\.js"/);
assert.match(html, /src="\/static\/history-wall\.js"/);
```

- [ ] **Step 4: Verify Cloudflare**

Run:

```powershell
cd cloudflare
npm test
npm run check
```

Expected: all tests pass and syntax checks succeed.

- [ ] **Step 5: Wrangler dry-run**

Run:

```powershell
cd cloudflare
$out = npx wrangler deploy --dry-run 2>&1 | Out-String
$out
if ($out -like '*--dry-run: exiting now.*' -and $out -like '*assets directory*') { exit 0 }
exit 1
```

Expected: output lists `env.ASSETS` and `env.NVIDIA_BASE_URL`.

---

### Task 8: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `cloudflare/README.md`

- [ ] **Step 1: Update docs**

Add to both README files:

```markdown
## 迭代體驗功能

- 歷史記錄牆：最近生成的圖片會存在瀏覽器 localStorage，可下載、複製提示詞、再生。
- 一鍵再生：結果圖與歷史記錄都能用同一組設定重跑；再生預設使用 seed 0 取得新變化。
- 複製設定：可複製 prompt、排除描述、模型、尺寸與 seed。
- Seed 控制：0 或空白代表隨機；固定正整數可重現或微調同一構圖。
- 排除描述輔助：前端會把排除詞合併到 prompt，不會送 NVIDIA 未支援的 negative_prompt 欄位。
```

- [ ] **Step 2: Full verification**

Run:

```powershell
python -m pytest -q
node --test tests\frontend\idea-store.test.cjs tests\frontend\generation-settings.test.cjs tests\frontend\history-store.test.cjs
cd cloudflare
npm test
npm run check
```

Expected:

```text
All Python tests pass.
All Node frontend tests pass.
All Cloudflare tests and syntax checks pass.
```

- [ ] **Step 3: Manual UI checklist**

Verify:

```text
1. Seed field accepts 12345 and generation succeeds.
2. Exclude helper appends avoid text; no negative_prompt network field exists.
3. Result actions appear after success.
4. Copy prompt writes provider prompt.
5. Copy settings writes prompt/model/size/seed JSON.
6. Regenerate starts a new request and uses seed 0.
7. History wall shows newest image first.
8. Reload keeps history wall.
9. History download saves an image.
10. Clear history empties the wall.
```

---

## Self-Review

Spec coverage:
- History wall: Tasks 4, 5, 6, 7, 8.
- One-click regenerate / copy settings: Tasks 5, 6.
- Progress feeling: Task 6.
- Seed control: Tasks 1, 2, 3, 5, 6, 7.
- Safe negative-prompt alternative: Tasks 1, 5, 6, 8.
- Cloudflare parity: Tasks 3, 7.

Placeholder scan:
- No incomplete requirement markers are present.
- Each task includes concrete files, commands, and expected results.

Type consistency:
- Frontend settings use `prompt`, `avoid`, `providerPrompt`, `model`, `size`, `seed`.
- Backend response includes `seed` in both FastAPI and Cloudflare.
- History records use `image`, `thumbnail`, `prompt`, `providerPrompt`, `avoid`, `model`, `size`, `seed`, `createdAt`.
