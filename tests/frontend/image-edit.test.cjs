const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../../app/static/image-edit.js');

function loadImageEdit() {
  const source = fs.readFileSync(scriptPath, 'utf8');
  // 提供瀏覽器沒有、node 有的全域；不提供 document 讓 DOM 綁定自動略過。
  const context = vm.createContext({ FormData, Blob });
  vm.runInContext(source, context, { filename: scriptPath });
  assert.ok(context.ImageEdit, 'ImageEdit should be exposed on globalThis');
  return context.ImageEdit;
}

function assertDims(d, width, height) {
  // vm 回傳物件與測試在不同 realm，deepStrictEqual 會因 prototype 不同而失敗；逐欄位比較。
  assert.equal(d.width, width);
  assert.equal(d.height, height);
}

test('computeResizeDims shrinks large images to fit under the cap on the long edge', () => {
  const E = loadImageEdit();
  assertDims(E.computeResizeDims(1600, 900, 511), 511, 287);
  assertDims(E.computeResizeDims(900, 1600, 511), 287, 511);
});

test('computeResizeDims never upscales images already within the cap', () => {
  const E = loadImageEdit();
  assertDims(E.computeResizeDims(400, 300, 511), 400, 300);
  assertDims(E.computeResizeDims(511, 511, 511), 511, 511);
});

test('computeResizeDims keeps the long edge strictly under 512 for square-ish giants', () => {
  const E = loadImageEdit();
  const d = E.computeResizeDims(4096, 4096, 511);
  assert.ok(d.width < 512 && d.height < 512, `dims must be < 512, got ${JSON.stringify(d)}`);
});

test('validateEditSelection enforces the 1..MAX range', () => {
  const E = loadImageEdit();
  assert.equal(E.validateEditSelection(0).ok, false);
  assert.equal(E.validateEditSelection(E.MAX_EDIT_IMAGES + 1).ok, false);
  assert.equal(E.validateEditSelection(1).ok, true);
  assert.equal(E.validateEditSelection(E.MAX_EDIT_IMAGES).ok, true);
});

test('buildEditFormData appends prompt once and one repeated images field per blob', () => {
  const E = loadImageEdit();
  const blobs = [
    new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    new Blob([new Uint8Array([4, 5])], { type: 'image/png' }),
  ];
  const fd = E.buildEditFormData('make it green', blobs);
  assert.equal(fd.get('prompt'), 'make it green');
  assert.equal(fd.getAll('images').length, 2);
});

test('buildEditFormData coerces a null prompt to an empty string and tolerates no blobs', () => {
  const E = loadImageEdit();
  const fd = E.buildEditFormData(null, null);
  assert.equal(fd.get('prompt'), '');
  assert.equal(fd.getAll('images').length, 0);
});

test('mapEditResponse returns the image on a 200 with an image field', () => {
  const E = loadImageEdit();
  const r = E.mapEditResponse(true, 200, { image: 'data:image/png;base64,AAAA' });
  assert.equal(r.image, 'data:image/png;base64,AAAA');
  assert.equal(r.error, null);
});

test('mapEditResponse surfaces the backend error message verbatim (not a generic HTTP line)', () => {
  const E = loadImageEdit();
  const r = E.mapEditResponse(false, 503, { error: 'AI 改圖需要 Cloudflare Workers AI 設定' });
  assert.equal(r.image, null);
  assert.equal(r.error, 'AI 改圖需要 Cloudflare Workers AI 設定');
});

test('mapEditResponse falls back to a generic HTTP message when no error field is present', () => {
  const E = loadImageEdit();
  const r = E.mapEditResponse(false, 500, {});
  assert.equal(r.image, null);
  assert.match(r.error, /HTTP 500/);
});

test('mapEditResponse treats a 200 without an image as an error', () => {
  const E = loadImageEdit();
  const r = E.mapEditResponse(true, 200, {});
  assert.equal(r.image, null);
  assert.match(r.error, /HTTP 200/);
});
