(function (root) {
  'use strict';

  var STORAGE_KEY = 'aiImageGenerationHistory.v1';
  var MAX_RECORDS = 12;
  var DEFAULT_MODEL = 'schnell';
  var DEFAULT_SIZE = 'square';

  function toText(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).trim();
  }

  function normalizeSeed(value) {
    var text = toText(value);
    var seed;

    if (!text) {
      return 0;
    }

    seed = Number(text);
    if (!isFinite(seed) || Math.floor(seed) !== seed) {
      return 0;
    }

    return seed;
  }

  function normalizeTags(value) {
    var raw;
    var tags = [];
    var i;
    var j;
    var tag;
    var exists;

    if (Array.isArray(value)) {
      raw = value;
    } else if (typeof value === 'string') {
      raw = value.split(',');
    } else {
      raw = [];
    }

    for (i = 0; i < raw.length; i += 1) {
      tag = toText(raw[i]).slice(0, 32);
      if (!tag) {
        continue;
      }

      exists = false;
      for (j = 0; j < tags.length; j += 1) {
        if (tags[j] === tag) {
          exists = true;
          break;
        }
      }
      if (exists) {
        continue;
      }

      tags.push(tag);
      if (tags.length >= 12) {
        break;
      }
    }

    return tags;
  }

  function normalizeBoolean(value) {
    return value === true;
  }

  function normalizeVersionNumber(value) {
    var number = Number(value);

    if (!isFinite(number) || Math.floor(number) !== number || number < 1) {
      return 1;
    }

    return number;
  }

  function copyRecord(record) {
    var copy = {};
    var key;

    for (key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        copy[key] = record[key];
      }
    }

    return copy;
  }

  function mergeRecord(record, patch) {
    var copy = copyRecord(record);
    var key;

    if (!patch || typeof patch !== 'object') {
      return copy;
    }

    for (key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        copy[key] = patch[key];
      }
    }

    return copy;
  }

  function defaultMakeId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    return 'history-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function getStorage(storage) {
    if (storage) {
      return storage;
    }

    try {
      if (root.localStorage) {
        return root.localStorage;
      }
    } catch (error) {
      return null;
    }

    return null;
  }

  function normalizeRecord(raw, makeId) {
    var source = raw || {};
    var image = toText(source.image);
    var prompt = toText(source.prompt);
    var id = toText(source.id);
    var idFactory = typeof makeId === 'function' ? makeId : defaultMakeId;

    if (!image) {
      throw new Error('缺少圖片資料');
    }
    if (!prompt) {
      throw new Error('缺少提示詞');
    }
    if (!id) {
      id = toText(idFactory());
    }

    return {
      id: id,
      image: image,
      thumbnail: toText(source.thumbnail) || image,
      prompt: prompt,
      providerPrompt: toText(source.providerPrompt) || prompt,
      avoid: toText(source.avoid),
      model: toText(source.model) || DEFAULT_MODEL,
      size: toText(source.size) || DEFAULT_SIZE,
      seed: normalizeSeed(source.seed),
      favorite: normalizeBoolean(source.favorite),
      tags: normalizeTags(source.tags),
      sourceRecordId: toText(source.sourceRecordId),
      versionGroupId: toText(source.versionGroupId) || id,
      versionNumber: normalizeVersionNumber(source.versionNumber),
      createdAt: toText(source.createdAt) || new Date().toISOString()
    };
  }

  function findRecordById(records, id) {
    var targetId = toText(id);
    var i;

    if (!targetId || !Array.isArray(records)) {
      return null;
    }

    for (i = 0; i < records.length; i += 1) {
      if (toText(records[i] && records[i].id) === targetId) {
        try {
          return normalizeRecord(records[i]);
        } catch (error) {
          return null;
        }
      }
    }

    return null;
  }

  function findVersionGroup(records, record) {
    var normalizedRecord;
    var versionGroupId;
    var group = [];

    if (!Array.isArray(records)) {
      return group;
    }

    try {
      normalizedRecord = normalizeRecord(record);
    } catch (error) {
      return group;
    }

    versionGroupId = normalizedRecord.versionGroupId;

    records.forEach(function (item) {
      var normalized;

      try {
        normalized = normalizeRecord(item);
      } catch (error) {
        return;
      }

      if (normalized.versionGroupId === versionGroupId) {
        group.push(normalized);
      }
    });

    group.sort(function (left, right) {
      if (left.versionNumber !== right.versionNumber) {
        return left.versionNumber - right.versionNumber;
      }
      if (left.createdAt < right.createdAt) {
        return -1;
      }
      if (left.createdAt > right.createdAt) {
        return 1;
      }
      if (left.id < right.id) {
        return -1;
      }
      if (left.id > right.id) {
        return 1;
      }
      return 0;
    });

    return group;
  }

  function createVersionRecord(records, parentRecord, rawRecord, makeId) {
    var parent = normalizeRecord(parentRecord);
    var group = findVersionGroup(records, parent);
    var maxVersion = parent.versionNumber;
    var source = mergeRecord(rawRecord || {}, {
      sourceRecordId: parent.id,
      versionGroupId: parent.versionGroupId || parent.id
    });

    group.forEach(function (record) {
      if (record.versionNumber > maxVersion) {
        maxVersion = record.versionNumber;
      }
    });

    source.versionNumber = maxVersion + 1;

    return normalizeRecord(source, makeId);
  }

  function updateRecord(records, id, patch) {
    var targetId = toText(id);
    var updated = [];

    if (!Array.isArray(records)) {
      return updated;
    }

    records.forEach(function (record) {
      var normalized;
      var nextRecord;

      try {
        normalized = normalizeRecord(record);
      } catch (error) {
        return;
      }

      if (targetId && normalized.id === targetId) {
        nextRecord = mergeRecord(normalized, patch);
        nextRecord.id = normalized.id;
        updated.push(normalizeRecord(nextRecord));
        return;
      }

      updated.push(normalized);
    });

    return updated.slice(0, MAX_RECORDS);
  }

  function updateRecordTags(records, id, tags) {
    return updateRecord(records, id, {
      tags: normalizeTags(tags)
    });
  }

  function toggleFavorite(records, id) {
    var targetId = toText(id);
    var updated = [];

    if (!Array.isArray(records)) {
      return updated;
    }

    records.forEach(function (record) {
      var normalized;
      var nextRecord;

      try {
        normalized = normalizeRecord(record);
      } catch (error) {
        return;
      }

      if (targetId && normalized.id === targetId) {
        nextRecord = copyRecord(normalized);
        nextRecord.favorite = !normalized.favorite;
        updated.push(normalizeRecord(nextRecord));
        return;
      }

      updated.push(normalized);
    });

    return updated.slice(0, MAX_RECORDS);
  }

  function parseRecords(text) {
    var parsed;
    var records;

    try {
      parsed = JSON.parse(toText(text));
    } catch (error) {
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    records = [];
    try {
      parsed.forEach(function (record) {
        records.push(normalizeRecord(record));
      });
    } catch (error) {
      return [];
    }

    return records.slice(0, MAX_RECORDS);
  }

  function normalizeRecordList(records) {
    var normalized = [];

    if (!Array.isArray(records)) {
      return normalized;
    }

    records.forEach(function (record) {
      try {
        normalized.push(normalizeRecord(record));
      } catch (error) {
        return;
      }
    });

    return normalized.slice(0, MAX_RECORDS);
  }

  function loadRecords(storage) {
    var store = getStorage(storage);
    var raw;

    if (!store || typeof store.getItem !== 'function') {
      return [];
    }

    try {
      raw = store.getItem(STORAGE_KEY);
    } catch (error) {
      return [];
    }

    if (!raw) {
      return [];
    }

    return parseRecords(raw);
  }

  function saveRecords(records, storage) {
    var store = getStorage(storage);
    var normalized = normalizeRecordList(records);
    var nextRecords = normalized.slice();

    if (!store || typeof store.setItem !== 'function') {
      return normalized;
    }

    while (true) {
      try {
        store.setItem(STORAGE_KEY, JSON.stringify(nextRecords));
        return nextRecords;
      } catch (error) {
        if (!nextRecords.length) {
          return [];
        }
        nextRecords.pop();
      }
    }
  }

  function addRecord(records, rawRecord, makeId) {
    var nextRecords = [normalizeRecord(rawRecord, makeId)];
    var existing = normalizeRecordList(records);

    existing.forEach(function (record) {
      nextRecords.push(record);
    });

    return nextRecords.slice(0, MAX_RECORDS);
  }

  function deleteRecord(records, id) {
    var targetId = toText(id);
    var nextRecords = [];

    if (!Array.isArray(records)) {
      return [];
    }

    records.forEach(function (record) {
      if (toText(record && record.id) === targetId) {
        return;
      }
      try {
        nextRecords.push(normalizeRecord(record));
      } catch (error) {
        return;
      }
    });

    return nextRecords.slice(0, MAX_RECORDS);
  }

  function clearRecords(storage) {
    var store = getStorage(storage);

    if (store && typeof store.removeItem === 'function') {
      try {
        store.removeItem(STORAGE_KEY);
      } catch (error) {
        return [];
      }
    }

    return [];
  }

  root.ImageHistoryStore = {
    STORAGE_KEY: STORAGE_KEY,
    MAX_RECORDS: MAX_RECORDS,
    normalizeRecord: normalizeRecord,
    parseRecords: parseRecords,
    loadRecords: loadRecords,
    saveRecords: saveRecords,
    addRecord: addRecord,
    deleteRecord: deleteRecord,
    findRecordById: findRecordById,
    findVersionGroup: findVersionGroup,
    createVersionRecord: createVersionRecord,
    updateRecordTags: updateRecordTags,
    toggleFavorite: toggleFavorite,
    updateRecord: updateRecord,
    clearRecords: clearRecords
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
