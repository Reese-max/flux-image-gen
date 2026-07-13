(function (root) {
  'use strict';

  var projects = [];
  var activeProjectId = '';

  function el(id) { return document.getElementById(id); }

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function clearNode(node) {
    while (node && node.firstChild) { node.removeChild(node.firstChild); }
  }

  function setStatus(message, cls) {
    var node = el('projectStatus');
    if (node) {
      node.textContent = message || '';
      node.className = 'form-status' + (cls ? ' ' + cls : '');
      return;
    }
    if (root.ImageGenApp && typeof root.ImageGenApp.setStatus === 'function') {
      root.ImageGenApp.setStatus(message, cls);
    }
  }

  function safeStore(label, fn, fallback) {
    try {
      return fn();
    } catch (error) {
      setStatus(label + '：' + error.message, 'fail');
      return fallback;
    }
  }

  function getActiveProject() {
    if (!root.ImageProjectStore || typeof root.ImageProjectStore.findProjectById !== 'function') { return null; }
    return root.ImageProjectStore.findProjectById(projects, activeProjectId);
  }

  function findRecordById(records, id) {
    var targetId = toText(id);
    var i;
    for (i = 0; i < records.length; i += 1) {
      if (toText(records[i] && records[i].id) === targetId) { return records[i]; }
    }
    return null;
  }

  function findCardById(cards, id) {
    var targetId = toText(id);
    var i;
    for (i = 0; i < cards.length; i += 1) {
      if (toText(cards[i] && cards[i].id) === targetId) { return cards[i]; }
    }
    return null;
  }

  function loadRecords() {
    if (root.ImageHistoryStore && typeof root.ImageHistoryStore.loadRecords === 'function') {
      return root.ImageHistoryStore.loadRecords();
    }
    return [];
  }

  function loadCards() {
    if (root.IdeaStore && typeof root.IdeaStore.loadCards === 'function') {
      return root.IdeaStore.loadCards();
    }
    return [];
  }

  function switchToGenerateTab() {
    if (typeof root.showTab === 'function') {
      root.showTab('generate');
    }
  }

  function continueFromRecord(record) {
    var source = record || {};
    if (!root.ImageGenApp || typeof root.ImageGenApp.setGenerationSettings !== 'function' || typeof root.ImageGenApp.generate !== 'function') {
      setStatus('生成模組尚未就緒', 'fail');
      return;
    }
    root.ImageGenApp.setGenerationSettings({
      prompt: toText(source.userPrompt || source.prompt),
      providerPrompt: toText(source.providerPrompt),
      avoid: toText(source.negativePrompt || source.avoid),
      model: toText(source.model) || 'schnell',
      size: toText(source.size) || 'square',
      seed: source.seed || ''
    });
    switchToGenerateTab();
    root.ImageGenApp.generate();
  }

  function continueFromCard(card) {
    if (root.PromptCards && typeof root.PromptCards.generateFromCard === 'function') {
      switchToGenerateTab();
      root.PromptCards.generateFromCard(card);
      return;
    }
    setStatus('風格卡生成模組尚未就緒', 'fail');
  }

  function saveProjects(nextProjects) {
    if (!root.ImageProjectStore) { return; }
    projects = root.ImageProjectStore.saveProjects(nextProjects);
    if (!activeProjectId && projects.length) { activeProjectId = projects[0].id; }
    if (activeProjectId && !root.ImageProjectStore.findProjectById(projects, activeProjectId)) {
      activeProjectId = projects.length ? projects[0].id : '';
    }
    renderProjectBoard();
    renderProjectSelectors();
  }

  function createProject() {
    var name = el('projectName');
    var description = el('projectDescription');
    var project;
    var nextProjects;
    if (!root.ImageProjectStore) {
      setStatus('專案儲存模組未載入', 'fail');
      return;
    }
    try {
      project = root.ImageProjectStore.normalizeProject({
        name: name ? name.value : '',
        description: description ? description.value : ''
      });
      nextProjects = root.ImageProjectStore.upsertProject(projects, project);
      activeProjectId = project.id;
      saveProjects(nextProjects);
      if (name) { name.value = ''; }
      if (description) { description.value = ''; }
      setStatus('已建立專案：' + project.name, 'done');
    } catch (error) {
      setStatus(error.message, 'fail');
    }
  }

  function deleteActiveProject() {
    var project = getActiveProject();
    var nextProjects;
    if (!project || !root.ImageProjectStore) {
      setStatus('尚未選取專案', 'warn');
      return;
    }
    if (typeof root.confirm === 'function' && !root.confirm('確定要刪除專案「' + project.name + '」嗎？作品與風格卡本體不會被刪除。')) {
      setStatus('已取消刪除專案', 'warn');
      return;
    }
    nextProjects = root.ImageProjectStore.deleteProject(projects, project.id);
    activeProjectId = nextProjects.length ? nextProjects[0].id : '';
    saveProjects(nextProjects);
    setStatus('已刪除專案', 'done');
  }

  function addRecordToProject(recordId, projectId) {
    var targetProjectId = toText(projectId) || activeProjectId;
    var nextProjects;
    if (!root.ImageProjectStore) {
      setStatus('專案儲存模組未載入', 'fail');
      return false;
    }
    if (!targetProjectId) {
      setStatus('請先建立或選取專案', 'warn');
      return false;
    }
    nextProjects = root.ImageProjectStore.addRecordToProject(projects, targetProjectId, recordId);
    activeProjectId = targetProjectId;
    saveProjects(nextProjects);
    setStatus('已加入專案', 'done');
    return true;
  }

  function addPromptCardToProject(cardId, projectId) {
    var targetProjectId = toText(projectId) || activeProjectId;
    var nextProjects;
    if (!root.ImageProjectStore) {
      setStatus('專案儲存模組未載入', 'fail');
      return false;
    }
    if (!targetProjectId) {
      setStatus('請先建立或選取專案', 'warn');
      return false;
    }
    nextProjects = root.ImageProjectStore.addPromptCardToProject(projects, targetProjectId, cardId);
    activeProjectId = targetProjectId;
    saveProjects(nextProjects);
    setStatus('已加入專案', 'done');
    return true;
  }

  function removeProjectRecord(recordId) {
    var project = getActiveProject();
    if (!project || !root.ImageProjectStore) { return; }
    saveProjects(root.ImageProjectStore.removeRecordFromProject(projects, project.id, recordId));
  }

  function removeProjectCard(cardId) {
    var project = getActiveProject();
    if (!project || !root.ImageProjectStore) { return; }
    saveProjects(root.ImageProjectStore.removePromptCardFromProject(projects, project.id, cardId));
  }

  function renderProjectList() {
    var list = el('projectList');
    var empty;
    if (!list) { return; }
    clearNode(list);
    if (!projects.length) {
      empty = document.createElement('div');
      empty.className = 'project-empty';
      empty.textContent = '尚無專案。先建立一個主題，例如「品牌主視覺」或「角色設定集」。';
      list.appendChild(empty);
      return;
    }
    projects.forEach(function (project) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'project-chip' + (project.id === activeProjectId ? ' is-active' : '');
      button.textContent = project.name + ' · ' + String(project.records.length) + ' 作品 · ' + String(project.promptCards.length) + ' 卡';
      button.addEventListener('click', function () {
        activeProjectId = project.id;
        renderProjectBoard();
        renderProjectSelectors();
      });
      list.appendChild(button);
    });
  }

  function renderRecordItem(list, record) {
    var item = document.createElement('article');
    var image = document.createElement('img');
    var body = document.createElement('div');
    var title = document.createElement('strong');
    var meta = document.createElement('span');
    var actions = document.createElement('div');
    var generate = document.createElement('button');
    var remove = document.createElement('button');

    item.className = 'project-item';
    image.src = toText(record.thumbnail || record.image);
    image.alt = '專案作品預覽';
    title.textContent = toText(record.userPrompt || record.prompt || record.providerPrompt).slice(0, 80) || '未命名作品';
    meta.textContent = (toText(record.model) || 'schnell') + ' · ' + (toText(record.size) || 'square');
    actions.className = 'project-item-actions';
    generate.type = 'button';
    generate.className = 'btn mini secondary';
    generate.textContent = '從這張繼續生成';
    generate.addEventListener('click', function () { continueFromRecord(record); });
    remove.type = 'button';
    remove.className = 'btn mini secondary';
    remove.textContent = '移出專案';
    remove.addEventListener('click', function () { removeProjectRecord(record.id); });
    actions.appendChild(generate);
    actions.appendChild(remove);
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(actions);
    item.appendChild(image);
    item.appendChild(body);
    list.appendChild(item);
  }

  function renderCardItem(list, card) {
    var item = document.createElement('article');
    var icon = document.createElement('span');
    var body = document.createElement('div');
    var title = document.createElement('strong');
    var meta = document.createElement('span');
    var actions = document.createElement('div');
    var generate = document.createElement('button');
    var remove = document.createElement('button');

    item.className = 'project-item';
    icon.className = 'project-card-icon';
    icon.textContent = card.emoji || '✨';
    title.textContent = card.name;
    meta.textContent = (toText(card.modelPreset) || 'schnell') + ' · ' + (toText(card.sizePreset) || 'square');
    actions.className = 'project-item-actions';
    generate.type = 'button';
    generate.className = 'btn mini secondary';
    generate.textContent = '套用卡片生成';
    generate.addEventListener('click', function () { continueFromCard(card); });
    remove.type = 'button';
    remove.className = 'btn mini secondary';
    remove.textContent = '移出專案';
    remove.addEventListener('click', function () { removeProjectCard(card.id); });
    actions.appendChild(generate);
    actions.appendChild(remove);
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(actions);
    item.appendChild(icon);
    item.appendChild(body);
    list.appendChild(item);
  }

  function renderProjectDetail() {
    var project = getActiveProject();
    var title = el('projectDetailTitle');
    var meta = el('projectDetailMeta');
    var recordList = el('projectRecordList');
    var cardList = el('projectCardList');
    var records = loadRecords();
    var cards = loadCards();
    var empty;

    if (!recordList || !cardList) { return; }
    clearNode(recordList);
    clearNode(cardList);
    if (!project) {
      if (title) { title.textContent = '尚未選取專案'; }
      if (meta) { meta.textContent = '建立專案後，可以把作品與風格卡整理在一起。'; }
      empty = document.createElement('div');
      empty.className = 'project-empty';
      empty.textContent = '專案內容會出現在這裡。';
      recordList.appendChild(empty);
      return;
    }
    if (title) { title.textContent = project.name; }
    if (meta) {
      meta.textContent = (project.description || '無描述') + ' · ' + String(project.records.length) + ' 作品 · ' + String(project.promptCards.length) + ' 風格卡';
    }
    if (!project.records.length) {
      empty = document.createElement('div');
      empty.className = 'project-empty';
      empty.textContent = '尚未加入作品。可在歷史作品詳情中加入目前專案。';
      recordList.appendChild(empty);
    } else {
      project.records.forEach(function (recordId) {
        var record = findRecordById(records, recordId);
        if (record) { renderRecordItem(recordList, record); }
      });
    }
    if (!project.promptCards.length) {
      empty = document.createElement('div');
      empty.className = 'project-empty';
      empty.textContent = '尚未加入風格卡。可在風格卡上點「加入專案」。';
      cardList.appendChild(empty);
    } else {
      project.promptCards.forEach(function (cardId) {
        var card = findCardById(cards, cardId);
        if (card) { renderCardItem(cardList, card); }
      });
    }
  }

  function renderProjectSelectors() {
    var selects = [];
    var historySelect = el('historyProjectSelect');
    var i;
    if (historySelect) { selects.push(historySelect); }
    for (i = 0; i < selects.length; i += 1) {
      clearNode(selects[i]);
      projects.forEach(function (project) {
        var option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name;
        selects[i].appendChild(option);
      });
      selects[i].value = activeProjectId || (projects[0] && projects[0].id) || '';
    }
  }

  function renderProjectBoard() {
    var deleteButton = el('deleteProject');
    var hasActiveProject = Boolean(getActiveProject());
    if (deleteButton) {
      deleteButton.hidden = !hasActiveProject;
      deleteButton.disabled = !hasActiveProject;
    }
    renderProjectList();
    renderProjectDetail();
  }

  function loadProjectBoard() {
    if (!root.ImageProjectStore) {
      setStatus('專案儲存模組未載入', 'fail');
      return;
    }
    projects = safeStore('專案讀取失敗', function () {
      return root.ImageProjectStore.loadProjects();
    }, []);
    if (!activeProjectId && projects.length) { activeProjectId = projects[0].id; }
    renderProjectBoard();
    renderProjectSelectors();
  }

  function bindProjectEvents() {
    var createButton = el('createProject');
    var deleteButton = el('deleteProject');
    if (createButton) { createButton.addEventListener('click', createProject); }
    if (deleteButton) { deleteButton.addEventListener('click', deleteActiveProject); }
  }

  function initProjectBoard() {
    loadProjectBoard();
    bindProjectEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initProjectBoard);
  } else {
    initProjectBoard();
  }
  document.addEventListener('imagegen:generated', renderProjectBoard);

  root.ProjectBoard = {
    loadProjectBoard: loadProjectBoard,
    renderProjectBoard: renderProjectBoard,
    renderProjectSelectors: renderProjectSelectors,
    createProject: createProject,
    deleteActiveProject: deleteActiveProject,
    addRecordToProject: addRecordToProject,
    addPromptCardToProject: addPromptCardToProject,
    continueFromRecord: continueFromRecord,
    continueFromCard: continueFromCard
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
