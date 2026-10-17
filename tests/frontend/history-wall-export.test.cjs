const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('artwork JSON download removes capabilities without changing private storage or receipt', async () => {
  let downloaded;
  let stored;
  const listeners = {};
  const body = {
    appendChild(link) { link.parentNode = body; },
    removeChild(link) { link.parentNode = null; }
  };
  const modal = { hidden: true };
  const context = vm.createContext({
    console, Blob,
    URL: class extends URL {
      static createObjectURL(blob) { downloaded = blob; return 'blob:test-download'; }
      static revokeObjectURL() {}
    },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    confirm: () => true,
    localStorage: { setItem(key, value) { stored = value; } },
    document: {
      body,
      getElementById: id => id === 'historyDetailModal' ? modal : null,
      createElement: () => ({ click() {} }),
      addEventListener(type, handler) { listeners[type] = handler; }
    }
  });
  for (const name of ['provenance.js', 'history-store.js', 'history-wall.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/static', name), 'utf8'), context);
  }
  const raw = {
    id: 'export-click', prompt: 'synthetic prompt',
    image: 'data:image/png;base64,aW1hZ2U=',
    cloudShareUrl: 'https://example.invalid/share?api_key=fake-share-capability&view=public',
    cloudDeleteUrl: 'https://example.invalid/delete?deleteToken=fake-delete-capability'
  };
  listeners['imagegen:generated']({ detail: raw });
  const privateRecord = JSON.parse(stored).records[0];
  context.ImageHistoryWall.openHistoryDetail(privateRecord);
  context.ImageHistoryWall.exportHistoryJson();
  assert.ok(downloaded, 'the actual download must be created');
  const text = await downloaded.text();
  assert.doesNotMatch(text, /fake-(share|delete)-capability/);
  const exported = JSON.parse(text);
  assert.equal(exported.cloudDeleteUrl, '');
  assert.equal(exported.cloudShareUrl, 'https://example.invalid/share?view=public');
  assert.deepEqual(exported.provenance, privateRecord.provenance);
  assert.equal(JSON.parse(stored).records[0].cloudDeleteUrl, raw.cloudDeleteUrl);
});
