(function (root) {
  'use strict';

  var STORAGE_KEY = 'aiImageProjects.v1';
  var COLLECTION_SCHEMA = 'ImageProjectCollection';
  var COLLECTION_VERSION = 1;
  var PROJECT_VERSION = 1;
  var MAX_PROJECTS = 32;
  var MAX_PROJECT_ITEMS = 240;

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function uniqueIds(value) {
    var raw = Array.isArray(value) ? value : [];
    var ids = [];
    var lookup = {};
    var i;
    var id;
    for (i = 0; i < raw.length; i += 1) {
      id = toText(raw[i]);
      if (!id || lookup[id]) { continue; }
      lookup[id] = true;
      ids.push(id);
      if (ids.length >= MAX_PROJECT_ITEMS) { break; }
    }
    return ids;
  }

  function defaultMakeId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    return 'project-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function getStorage(storage) {
    if (storage) { return storage; }
    try {
      if (root.localStorage) { return root.localStorage; }
    } catch (error) {
      return null;
    }
    return null;
  }

  function copyProject(project) {
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      records: project.records.slice(),
      promptCards: project.promptCards.slice(),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      version: project.version
    };
  }

  function normalizeProject(raw, makeId) {
    var source = raw || {};
    var id = toText(source.id);
    var name = toText(source.name);
    var now = new Date().toISOString();
    var idFactory = typeof makeId === 'function' ? makeId : defaultMakeId;

    if (!id) { id = toText(idFactory()); }
    if (!name) { throw new Error('專案名稱不可空白'); }

    return {
      id: id,
      name: name.slice(0, 48),
      description: toText(source.description).slice(0, 280),
      records: uniqueIds(source.records),
      promptCards: uniqueIds(source.promptCards),
      createdAt: toText(source.createdAt) || now,
      updatedAt: toText(source.updatedAt) || now,
      version: PROJECT_VERSION
    };
  }

  function normalizeProjectList(projects) {
    var normalized = [];
    if (!Array.isArray(projects)) { return normalized; }
    projects.forEach(function (project) {
      try {
        normalized.push(normalizeProject(project));
      } catch (error) {
        return;
      }
    });
    return normalized.slice(0, MAX_PROJECTS);
  }

  function parseProjects(text) {
    var parsed;
    var rawProjects;
    try {
      parsed = JSON.parse(toText(text));
    } catch (error) {
      return [];
    }

    if (Array.isArray(parsed)) {
      rawProjects = parsed;
    } else if (parsed && typeof parsed === 'object' && toText(parsed.schema) === COLLECTION_SCHEMA) {
      if (Number(parsed.version) !== COLLECTION_VERSION) { return []; }
      rawProjects = Array.isArray(parsed.projects) ? parsed.projects : [];
    } else {
      return [];
    }

    return normalizeProjectList(rawProjects);
  }

  function exportProjects(projects) {
    return {
      schema: COLLECTION_SCHEMA,
      version: COLLECTION_VERSION,
      exportedAt: new Date().toISOString(),
      projects: normalizeProjectList(projects)
    };
  }

  function dateScore(value) {
    var score = Date.parse(toText(value));
    return isFinite(score) ? score : 0;
  }

  function dropOldestProject(projects) {
    var list = projects.slice();
    var oldestIndex = 0;
    var oldestScore;
    var score;
    var i;
    if (!list.length) { return list; }
    oldestScore = dateScore(list[0].updatedAt || list[0].createdAt);
    for (i = 1; i < list.length; i += 1) {
      score = dateScore(list[i].updatedAt || list[i].createdAt);
      if (score < oldestScore) {
        oldestScore = score;
        oldestIndex = i;
      }
    }
    list.splice(oldestIndex, 1);
    return list;
  }

  function loadProjects(storage) {
    var store = getStorage(storage);
    var raw;
    if (!store || typeof store.getItem !== 'function') { return []; }
    try {
      raw = store.getItem(STORAGE_KEY);
    } catch (error) {
      return [];
    }
    if (!raw) { return []; }
    return parseProjects(raw);
  }

  function saveProjects(projects, storage) {
    var store = getStorage(storage);
    var normalized = normalizeProjectList(projects);
    var nextProjects = normalized.slice();
    if (!store || typeof store.setItem !== 'function') { return normalized; }
    while (true) {
      try {
        store.setItem(STORAGE_KEY, JSON.stringify(exportProjects(nextProjects)));
        return nextProjects;
      } catch (error) {
        if (!nextProjects.length) { return []; }
        nextProjects = dropOldestProject(nextProjects);
      }
    }
  }

  function upsertProject(projects, project) {
    var normalized = normalizeProject(project);
    var list = normalizeProjectList(projects);
    var updated = [];
    var replaced = false;
    list.forEach(function (item) {
      if (item.id === normalized.id) {
        updated.push(normalized);
        replaced = true;
      } else {
        updated.push(item);
      }
    });
    if (!replaced) { updated.unshift(normalized); }
    return updated.slice(0, MAX_PROJECTS);
  }

  function deleteProject(projects, id) {
    var targetId = toText(id);
    var nextProjects = [];
    normalizeProjectList(projects).forEach(function (project) {
      if (project.id !== targetId) { nextProjects.push(project); }
    });
    return nextProjects;
  }

  function addUnique(list, id) {
    var ids = uniqueIds(list);
    var targetId = toText(id);
    var i;
    if (!targetId) { return ids; }
    for (i = 0; i < ids.length; i += 1) {
      if (ids[i] === targetId) { return ids; }
    }
    ids.push(targetId);
    return ids.slice(0, MAX_PROJECT_ITEMS);
  }

  function removeId(list, id) {
    var targetId = toText(id);
    var ids = [];
    uniqueIds(list).forEach(function (item) {
      if (item !== targetId) { ids.push(item); }
    });
    return ids;
  }

  function patchProject(projects, id, patch) {
    var targetId = toText(id);
    var list = normalizeProjectList(projects);
    var updated = [];
    list.forEach(function (project) {
      var nextProject;
      if (project.id !== targetId) {
        updated.push(project);
        return;
      }
      nextProject = copyProject(project);
      if (patch && typeof patch === 'object') {
        if (Object.prototype.hasOwnProperty.call(patch, 'name')) { nextProject.name = patch.name; }
        if (Object.prototype.hasOwnProperty.call(patch, 'description')) { nextProject.description = patch.description; }
        if (Object.prototype.hasOwnProperty.call(patch, 'records')) { nextProject.records = patch.records; }
        if (Object.prototype.hasOwnProperty.call(patch, 'promptCards')) { nextProject.promptCards = patch.promptCards; }
      }
      nextProject.updatedAt = new Date().toISOString();
      updated.push(normalizeProject(nextProject));
    });
    return updated;
  }

  function addRecordToProject(projects, projectId, recordId) {
    var project = findProjectById(projects, projectId);
    if (!project) { return normalizeProjectList(projects); }
    return patchProject(projects, project.id, { records: addUnique(project.records, recordId) });
  }

  function addPromptCardToProject(projects, projectId, cardId) {
    var project = findProjectById(projects, projectId);
    if (!project) { return normalizeProjectList(projects); }
    return patchProject(projects, project.id, { promptCards: addUnique(project.promptCards, cardId) });
  }

  function removeRecordFromProject(projects, projectId, recordId) {
    var project = findProjectById(projects, projectId);
    if (!project) { return normalizeProjectList(projects); }
    return patchProject(projects, project.id, { records: removeId(project.records, recordId) });
  }

  function removePromptCardFromProject(projects, projectId, cardId) {
    var project = findProjectById(projects, projectId);
    if (!project) { return normalizeProjectList(projects); }
    return patchProject(projects, project.id, { promptCards: removeId(project.promptCards, cardId) });
  }

  function findProjectById(projects, id) {
    var targetId = toText(id);
    var list = normalizeProjectList(projects);
    var i;
    for (i = 0; i < list.length; i += 1) {
      if (list[i].id === targetId) { return list[i]; }
    }
    return null;
  }

  root.ImageProjectStore = {
    STORAGE_KEY: STORAGE_KEY,
    COLLECTION_SCHEMA: COLLECTION_SCHEMA,
    COLLECTION_VERSION: COLLECTION_VERSION,
    MAX_PROJECTS: MAX_PROJECTS,
    normalizeProject: normalizeProject,
    normalizeProjectList: normalizeProjectList,
    parseProjects: parseProjects,
    exportProjects: exportProjects,
    loadProjects: loadProjects,
    saveProjects: saveProjects,
    upsertProject: upsertProject,
    deleteProject: deleteProject,
    patchProject: patchProject,
    findProjectById: findProjectById,
    addRecordToProject: addRecordToProject,
    addPromptCardToProject: addPromptCardToProject,
    removeRecordFromProject: removeRecordFromProject,
    removePromptCardFromProject: removePromptCardFromProject
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
