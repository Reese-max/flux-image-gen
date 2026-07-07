const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../../app/static/project-store.js');

function readProjectStoreSource() {
  return fs.readFileSync(scriptPath, 'utf8');
}

function loadProjectStore() {
  const source = readProjectStoreSource();
  const context = vm.createContext({ console });
  vm.runInContext(source, context, { filename: scriptPath });
  assert.ok(context.ImageProjectStore, 'ImageProjectStore should be exposed');
  return context.ImageProjectStore;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStorage(initialValue) {
  const calls = { getItem: [], setItem: [] };
  return {
    calls,
    getItem(key) {
      calls.getItem.push(key);
      return initialValue;
    },
    setItem(key, value) {
      calls.setItem.push([key, value]);
    }
  };
}

test('normalizeProject trims fields, injects ids, and deduplicates linked items', () => {
  const Store = loadProjectStore();
  const project = Store.normalizeProject({
    id: ' ',
    name: '  品牌主視覺  ',
    description: '  官網與社群素材  ',
    records: ['r1', 'r1', '', 'r2'],
    promptCards: ['c1', 'c1', 'c2'],
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z'
  }, () => 'project-1');

  assert.deepEqual(plain(project), {
    id: 'project-1',
    name: '品牌主視覺',
    description: '官網與社群素材',
    records: ['r1', 'r2'],
    promptCards: ['c1', 'c2'],
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    version: 1
  });
});

test('normalizeProject rejects blank names', () => {
  const Store = loadProjectStore();

  assert.throws(
    () => Store.normalizeProject({ name: '   ' }, () => 'project-1'),
    /專案名稱不可空白/
  );
});

test('parseProjects accepts legacy arrays and versioned collections', () => {
  const Store = loadProjectStore();
  const legacy = Store.parseProjects(JSON.stringify([{ id: 'p1', name: '舊專案' }]));
  const collection = Store.parseProjects(JSON.stringify({
    schema: Store.COLLECTION_SCHEMA,
    version: Store.COLLECTION_VERSION,
    projects: [{ id: 'p2', name: '新專案' }]
  }));

  assert.equal(legacy[0].id, 'p1');
  assert.equal(collection[0].id, 'p2');
  assert.deepEqual(plain(Store.parseProjects(JSON.stringify({
    schema: Store.COLLECTION_SCHEMA,
    version: 999,
    projects: [{ id: 'bad', name: '不支援' }]
  }))), []);
});

test('saveProjects writes a versioned collection', () => {
  const Store = loadProjectStore();
  const storage = createStorage(null);
  const result = Store.saveProjects([{ id: 'p1', name: '專案 A' }], storage);
  const saved = JSON.parse(storage.calls.setItem[0][1]);

  assert.equal(storage.calls.setItem[0][0], Store.STORAGE_KEY);
  assert.equal(saved.schema, Store.COLLECTION_SCHEMA);
  assert.equal(saved.version, Store.COLLECTION_VERSION);
  assert.deepEqual(saved.projects, plain(result));
});

test('saveProjects drops oldest projects on quota failure and keeps newer projects', () => {
  const Store = loadProjectStore();
  const attempts = [];
  const storage = {
    setItem(key, value) {
      const parsed = JSON.parse(value);
      attempts.push({ key, ids: parsed.projects.map((project) => project.id) });
      if (parsed.projects.length > 2) {
        throw new Error('quota exceeded');
      }
    }
  };
  const result = Store.saveProjects([
    { id: 'old-project', name: '舊專案', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'mid-project', name: '中專案', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'new-project', name: '新專案', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }
  ], storage);

  assert.deepEqual(attempts.map((attempt) => attempt.ids), [
    ['old-project', 'mid-project', 'new-project'],
    ['mid-project', 'new-project']
  ]);
  assert.deepEqual(plain(result.map((project) => project.id)), ['mid-project', 'new-project']);
});

test('project item helpers add and remove records and prompt cards without duplicates', () => {
  const Store = loadProjectStore();
  let projects = [Store.normalizeProject({ id: 'p1', name: '專案 A', records: ['r1'], promptCards: ['c1'] })];

  projects = Store.addRecordToProject(projects, 'p1', 'r2');
  projects = Store.addRecordToProject(projects, 'p1', 'r2');
  projects = Store.addPromptCardToProject(projects, 'p1', 'c2');
  projects = Store.addPromptCardToProject(projects, 'p1', 'c2');

  assert.deepEqual(plain(projects[0].records), ['r1', 'r2']);
  assert.deepEqual(plain(projects[0].promptCards), ['c1', 'c2']);

  projects = Store.removeRecordFromProject(projects, 'p1', 'r1');
  projects = Store.removePromptCardFromProject(projects, 'p1', 'c1');
  assert.deepEqual(plain(projects[0].records), ['r2']);
  assert.deepEqual(plain(projects[0].promptCards), ['c2']);
});

test('upsertProject replaces existing projects and deleteProject removes by id', () => {
  const Store = loadProjectStore();
  let projects = Store.upsertProject([], { id: 'p1', name: '初版' });
  projects = Store.upsertProject(projects, { id: 'p1', name: '改名' });
  projects = Store.upsertProject(projects, { id: 'p2', name: '第二個' });

  assert.equal(projects.length, 2);
  assert.equal(Store.findProjectById(projects, 'p1').name, '改名');
  assert.deepEqual(plain(Store.deleteProject(projects, 'p1').map((project) => project.id)), ['p2']);
});

test('source remains ES5-friendly for static browser support', () => {
  const source = readProjectStoreSource();

  assert.doesNotMatch(source, /Number\.isFinite/);
  assert.doesNotMatch(source, /=>/);
  assert.doesNotMatch(source, /\?\./);
  assert.doesNotMatch(source, /\bconst\b/);
  assert.doesNotMatch(source, /\blet\b/);
});
