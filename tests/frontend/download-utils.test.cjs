const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../../app/static/download-utils.js');
const tinyPng = 'data:image/png;base64,iVBORw0KGgo=';

function loadDownloadUtils() {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const created = [];
  const revoked = [];
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options && options.type;
    }
  }
  const context = {
    Blob: FakeBlob,
    Uint8Array,
    atob(value) {
      return Buffer.from(value, 'base64').toString('binary');
    },
    decodeURIComponent,
    URL: {
      createObjectURL(blob) {
        created.push(blob);
        return 'blob:test-' + created.length;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      }
    },
    addEventListener() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    document: {
      body: {
        appendChild(node) {
          node.parentNode = this;
        },
        removeChild(node) {
          node.parentNode = null;
        }
      },
      createElement() {
        return {
          style: {},
          removeAttribute(name) {
            delete this[name];
          },
          click() {
            this.clicked = true;
          }
        };
      }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: scriptPath });
  return { api: context.ImageDownload, created, revoked };
}

test('data image downloads are converted to Blob object URLs', () => {
  const { api, created } = loadDownloadUtils();
  const link = {
    removeAttribute(name) {
      delete this[name];
    }
  };
  const href = api.prepareLink(link, tinyPng, 'picture.png');
  assert.equal(href, 'blob:test-1');
  assert.equal(link.href, 'blob:test-1');
  assert.equal(link.download, 'picture.png');
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'image/png');
  assert.ok(!link.href.startsWith('data:'));
});

test('replacing a prepared download revokes the previous object URL', () => {
  const { api, revoked } = loadDownloadUtils();
  const link = {
    removeAttribute(name) {
      delete this[name];
    }
  };
  api.prepareLink(link, tinyPng, 'first.png');
  api.prepareLink(link, tinyPng, 'second.png');
  assert.deepEqual(revoked, ['blob:test-1']);
  assert.equal(link.href, 'blob:test-2');
});

test('temporary history download clicks a Blob URL and cleans it up', () => {
  const { api, revoked } = loadDownloadUtils();
  api.trigger(tinyPng, 'history.png');
  assert.deepEqual(revoked, ['blob:test-1']);
});
