const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const historyWallPath = path.resolve(__dirname, '../../app/static/history-wall.js');

function loadHistoryWall(records = []) {
  const documentListeners = {};
  const elements = new Map();
  const created = [];
  const clicked = [];
  const scheduled = [];
  const revoked = [];
  const blobs = [];
  const statuses = [];
  function makeElement(tag) {
    const handlers = {};
    return {
      tagName: tag.toUpperCase(),
      parentNode: null,
      hidden: false,
      handlers,
      setAttribute() {},
      getAttribute() { return null; },
      removeAttribute() {},
      addEventListener(type, handler) { handlers[type] = handler; },
      dispatch(type, event) {
        if (handlers[type]) {
          handlers[type](event || { target: this });
        }
      },
      appendChild() {},
      removeChild() {},
      classList: { add() {}, remove() {}, toggle() {} },
      click() { clicked.push(this); },
    };
  }
  const body = {
    appendChild(node) {
      node.parentNode = body;
      created.push(node);
    },
    removeChild(node) {
      node.parentNode = null;
    },
  };
  const detailModal = makeElement('div');
  elements.set('historyDetailModal', detailModal);
  const exportOneButton = makeElement('button');
  elements.set('exportHistoryJson', exportOneButton);
  const exportAllButton = makeElement('button');
  elements.set('exportAllHistoryJson', exportAllButton);
  const document = {
    body,
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener(type, handler) {
      if (!documentListeners[type]) {
        documentListeners[type] = [];
      }
      documentListeners[type].push(handler);
    },
    createElement(tag) {
      return makeElement(tag);
    },
  };
  const windowObj = {
    document,
    confirm() { return true; },
    ImageHistoryStore: {
      loadRecords() { return records.map((record) => ({ ...record })); },
      normalizeRecord(record) { return { ...record }; },
      findRecordById(items, id) {
        return items.find((record) => record.id === id) || null;
      },
      exportRecordCollection(items) {
        return {
          schema: 'GenerationRecordCollection',
          version: 2,
          migratedAt: '2026-10-02T00:00:00.000Z',
          records: items.map((record) => ({ ...record })),
        };
      },
    },
    ImageGenApp: {
      setStatus(message, type) { statuses.push({ message, type }); },
    },
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
  function dispatchDocumentEvent(type, event = {}) {
    (documentListeners[type] || []).forEach((handler) => handler(event));
  }
  return {
    windowObj,
    clicked,
    scheduled,
    revoked,
    blobs,
    statuses,
    elements,
    dispatchDocumentEvent,
  };
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

test('single-work JSON export downloads the selected record with its settings and metadata', async () => {
  const record = {
    id: 'record-one',
    prompt: '晨霧中的山景',
    providerPrompt: 'mountains in morning mist',
    negativePrompt: 'blurry',
    model: 'dev',
    size: 'portrait',
    steps: 28,
    cfgScale: 5,
    seed: 123,
    provider: 'nvidia',
    createdAt: '2026-10-02T00:00:00.000Z',
    image: 'data:image/png;base64,aGVsbG8=',
    cloudShareUrl: 'https://example.invalid/share/record-one',
  };
  const loaded = loadHistoryWall([record]);
  loaded.dispatchDocumentEvent('DOMContentLoaded');
  loaded.windowObj.ImageHistoryWall.openHistoryDetail(record);
  loaded.elements.get('exportHistoryJson').dispatch('click');

  assert.equal(loaded.blobs.length, 1);
  assert.equal(loaded.clicked.length, 1);
  assert.equal(loaded.clicked[0].download, 'history_record-one.json');
  assert.equal(loaded.clicked[0].href, 'blob:test-1');
  assert.deepEqual(JSON.parse(await loaded.blobs[0].text()), record);
  assert.match(loaded.statuses.at(-1).message, /已匯出備份檔/);
});

test('export-all control downloads a versioned backup containing every history record', async () => {
  const records = [
    {
      id: 'record-one',
      prompt: '第一張',
      providerPrompt: 'first image',
      model: 'dev',
      size: 'square',
      seed: 11,
      provider: 'nvidia',
      image: 'data:image/png;base64,b25l',
    },
    {
      id: 'record-two',
      prompt: '第二張',
      providerPrompt: 'second image',
      model: 'pro',
      size: 'landscape',
      seed: 22,
      provider: 'workers-ai',
      image: 'data:image/jpeg;base64,dHdv',
    },
  ];
  const loaded = loadHistoryWall(records);
  loaded.dispatchDocumentEvent('DOMContentLoaded');
  loaded.elements.get('exportAllHistoryJson').dispatch('click');

  assert.equal(loaded.blobs.length, 1);
  assert.equal(loaded.clicked.length, 1);
  assert.match(loaded.clicked[0].download, /^history_backup_\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(loaded.clicked[0].href, 'blob:test-1');
  assert.deepEqual(JSON.parse(await loaded.blobs[0].text()), {
    schema: 'GenerationRecordCollection',
    version: 2,
    migratedAt: '2026-10-02T00:00:00.000Z',
    records,
  });
  assert.match(loaded.statuses.at(-1).message, /已匯出全部歷史備份檔/);
});
