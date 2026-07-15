const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../../app/static/project-board.js');

function fakeElement(id) {
  return {
    id,
    children: [],
    hidden: false,
    disabled: false,
    textContent: '',
    className: '',
    value: '',
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children.splice(this.children.indexOf(child), 1);
      return child;
    },
    get firstChild() {
      return this.children[0] || null;
    },
    addEventListener() {}
  };
}

function loadBoard(projects) {
  const ids = [
    'createProject', 'deleteProject', 'projectDetail', 'projectDetailMeta',
    'projectDetailTitle', 'projectList', 'projectRecordList', 'projectCardList'
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, fakeElement(id)]));
  const document = {
    readyState: 'complete',
    getElementById(id) { return elements[id] || null; },
    createElement(tag) { return fakeElement(tag); },
    addEventListener() {}
  };
  const context = vm.createContext({
    console,
    document,
    ImageProjectStore: {
      loadProjects() { return projects; },
      findProjectById(items, id) { return items.find((item) => item.id === id) || null; }
    },
    ImageHistoryStore: { loadRecords() { return []; } },
    IdeaStore: { loadCards() { return []; } }
  });

  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath });
  return elements;
}

test('project detail stays hidden until a project exists', () => {
  const empty = loadBoard([]);
  assert.equal(empty.projectDetail.hidden, true);
  assert.equal(empty.projectList.children.length, 1);
  assert.equal(empty.projectRecordList.children.length, 0);
  assert.equal(empty.projectCardList.children.length, 0);

  const populated = loadBoard([{
    id: 'project-1',
    name: '品牌主視覺',
    description: '',
    records: [],
    promptCards: []
  }]);
  assert.equal(populated.projectDetail.hidden, false);
  assert.equal(populated.projectRecordList.children.length, 1);
  assert.equal(populated.projectCardList.children.length, 1);
});
