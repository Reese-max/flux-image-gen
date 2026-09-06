const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appScriptPath = path.resolve(__dirname, '../../app/static/app.js');

function loadAppHelpers() {
  const source = fs.readFileSync(appScriptPath, 'utf8');
  let revoked = [];
  const fakeURL = {
    createObjectURL(blob) {
      return 'blob:http://localhost/' + Math.random().toString(36).slice(2);
    },
    revokeObjectURL(url) {
      revoked.push(url);
    }
  };
  const fakeWindow = {
    URL: fakeURL,
    Blob,
    addEventListener() {},
    removeEventListener() {}
  };
  fakeWindow.window = fakeWindow;

  const context = vm.createContext({
    window: fakeWindow,
    URL: fakeURL,
    Blob,
    atob(b64) {
      return Buffer.from(b64, 'base64').toString('binary');
    },
    document: {
      getElementById() { return null; },
      addEventListener() {},
      querySelectorAll() { return []; }
    },
    navigator: {},
    performance: { now: () => Date.now() },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {}
  });
  vm.runInContext(source, context, { filename: appScriptPath });
  assert.ok(fakeWindow.ImageGenApp, 'ImageGenApp should be defined');
  return {
    app: fakeWindow.ImageGenApp,
    revoked,
    fakeURL
  };
}

test('dataUrlToBlob converts valid base64 PNG data URL to a Blob with image/png mime', async () => {
  const { app } = loadAppHelpers();
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const blob = app.dataUrlToBlob(tinyPng);
  assert.ok(blob, 'blob should be created');
  assert.equal(blob.type, 'image/png');
  const buffer = Buffer.from(await blob.arrayBuffer());
  assert.equal(buffer[0], 0x89);
  assert.equal(buffer[1], 0x50); // P
  assert.equal(buffer[2], 0x4e); // N
  assert.equal(buffer[3], 0x47); // G
});

test('dataUrlToBlob converts valid base64 JPEG data URL to a Blob with image/jpeg mime', async () => {
  const { app } = loadAppHelpers();
  const fakeJpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const blob = app.dataUrlToBlob(fakeJpg);
  assert.ok(blob, 'blob should be created');
  assert.equal(blob.type, 'image/jpeg');
  const buffer = Buffer.from(await blob.arrayBuffer());
  assert.equal(buffer[0], 0xff);
  assert.equal(buffer[1], 0xd8);
});

test('dataUrlToBlob returns null on invalid or non-data URL inputs', () => {
  const { app } = loadAppHelpers();
  assert.equal(app.dataUrlToBlob(null), null);
  assert.equal(app.dataUrlToBlob(''), null);
  assert.equal(app.dataUrlToBlob('https://example.com/image.png'), null);
  assert.equal(app.dataUrlToBlob('not-a-data-url'), null);
});

test('createDownloadUrl returns blob URL for data URL and manages target anchor _blobUrl lifecycle', () => {
  const { app, revoked } = loadAppHelpers();
  const anchor = {};
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const url1 = app.createDownloadUrl(dataUrl, anchor);
  assert.ok(url1.startsWith('blob:'), 'should return a blob url');
  assert.equal(anchor._blobUrl, url1);

  // Calling again should revoke previous url
  const url2 = app.createDownloadUrl(dataUrl, anchor);
  assert.ok(url2.startsWith('blob:'));
  assert.notEqual(url1, url2);
  assert.equal(anchor._blobUrl, url2);
  assert.ok(revoked.includes(url1), 'previous blob url should have been revoked');
});

test('createDownloadUrl returns original url if already http/https', () => {
  const { app } = loadAppHelpers();
  const httpUrl = 'https://example.com/photo.jpg';
  assert.equal(app.createDownloadUrl(httpUrl), httpUrl);
});
