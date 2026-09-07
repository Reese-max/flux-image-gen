const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const historyWallPath = path.resolve(__dirname, '../../app/static/history-wall.js');

function loadHistoryWall() {
  const listeners = {};
  const created = [];
  const clicked = [];
  const scheduled = [];
  const revoked = [];
  const blobs = [];
  const body = {
    appendChild(node) {
      node.parentNode = body;
      created.push(node);
    },
    removeChild(node) {
      node.parentNode = null;
    },
  };
  const document = {
    body,
    getElementById: () => null,
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        parentNode: null,
        setAttribute() {},
        getAttribute() { return null; },
        addEventListener() {},
        appendChild() {},
        removeChild() {},
        classList: { add() {}, remove() {}, toggle() {} },
        click() { clicked.push(this); },
      };
    },
  };
  const windowObj = {
    document,
    URL: {
      createObjectURL(blob) {
        blobs.push(blob);
        return 'blob:test-' + blobs.length;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
  };
  const context = vm.createContext({
    window: windowObj,
    document,
    Blob,
    URL: windowObj.URL,
    setTimeout(fn, delay) {
      scheduled.push({ fn, delay });
      return scheduled.length;
    },
    console,
  });
  context.globalThis = windowObj;
  vm.runInContext(fs.readFileSync(historyWallPath, 'utf8'), context, { filename: historyWallPath });
  return { windowObj, clicked, scheduled, revoked, blobs };
}

test('JSON export clicks a blob link and defers URL revocation until download consumption', async () => {
  const loaded = loadHistoryWall();
  const result = loaded.windowObj.ImageHistoryWall.downloadJsonPayload(
    { schema: 'GenerationRecordCollection', version: 2, records: [{ id: 'one' }] },
    'history_backup.json',
  );

  assert.equal(result, true);
  assert.equal(loaded.blobs.length, 1);
  assert.equal(loaded.clicked.length, 1);
  assert.equal(loaded.clicked[0].download, 'history_backup.json');
  assert.equal(loaded.clicked[0].href, 'blob:test-1');
  assert.deepEqual(JSON.parse(await loaded.blobs[0].text()), {
    schema: 'GenerationRecordCollection',
    version: 2,
    records: [{ id: 'one' }],
  });
  assert.deepEqual(loaded.revoked, []);
  assert.equal(loaded.scheduled.length, 1);
  assert.equal(loaded.scheduled[0].delay, 30000);

  loaded.scheduled[0].fn();
  assert.deepEqual(loaded.revoked, ['blob:test-1']);
});
