(function (root) {
  'use strict';

  var STORAGE_KEY = 'aiImageGenerationHistory.v1';
  var COLLECTION_SCHEMA = 'GenerationRecordCollection';
  var COLLECTION_VERSION = 2;
  var RECORD_SCHEMA_VERSION = 2;
  var MAX_RECORDS = 48;
  var DEFAULT_MODEL = 'schnell';
  var DEFAULT_SIZE = 'square';
  var RECEIPT_SCHEMA_VERSION = 1;
  var APP_VERSION = '1.4.0';

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

  function normalizeDimension(value) {
    var number = Number(value);
    if (!isFinite(number) || Math.floor(number) !== number || number < 0) {
      return 0;
    }
    return number;
  }

  function normalizeQaReport(value) {
    var source = value && typeof value === 'object' ? value : null;
    var issues = [];
    var i;

    if (!source) {
      return null;
    }

    if (Array.isArray(source.detectedIssues)) {
      for (i = 0; i < source.detectedIssues.length; i += 1) {
        if (toText(source.detectedIssues[i])) {
          issues.push(toText(source.detectedIssues[i]));
        }
      }
    }

    return {
      imageId: toText(source.imageId),
      promptMatchScore: normalizeDimension(source.promptMatchScore),
      compositionScore: normalizeDimension(source.compositionScore),
      visualQualityScore: normalizeDimension(source.visualQualityScore),
      textAccuracyScore: source.textAccuracyScore === null || source.textAccuracyScore === undefined ? null : normalizeDimension(source.textAccuracyScore),
      detectedIssues: issues,
      recommendation: toText(source.recommendation) || 'keep',
      reason: toText(source.reason)
    };
  }

  function normalizeAutoRetry(value) {
    var source = value && typeof value === 'object' ? value : null;
    if (!source) {
      return null;
    }
    return {
      maxRetries: normalizeDimension(source.maxRetries),
      attempted: normalizeBoolean(source.attempted),
      reason: toText(source.reason),
      action: toText(source.action) || 'none',
      message: toText(source.message)
    };
  }

  function normalizeSuggestionList(value) {
    var list = [];
    var i;
    var source;
    var item;
    if (!Array.isArray(value)) {
      return list;
    }
    for (i = 0; i < value.length; i += 1) {
      source = value[i];
      if (typeof source === 'string') {
        if (toText(source)) { list.push({ id: toText(source), label: toText(source) }); }
      } else if (source && typeof source === 'object') {
        item = { id: toText(source.id), label: toText(source.label) };
        if (item.id || item.label) { list.push(item); }
      }
    }
    return list;
  }

  function normalizeVersionNumber(value) {
    var number = Number(value);

    if (!isFinite(number) || Math.floor(number) !== number || number < 1) {
      return 1;
    }

    return number;
  }

  function sha256Sync(message) {
    var str = String(message || '');
    if (typeof root.crypto === 'object' && root.crypto.subtle && typeof root.crypto.subtle.digest === 'function') {
      try {
        var encoder = new root.TextEncoder();
        var buffer = encoder.encode(str);
        var hashBuffer = root.crypto.subtle.digest('SHA-256', buffer);
        if (hashBuffer && typeof hashBuffer.then === 'function') {
        }
      } catch (error) {
      }
    }
    var hash = 0;
    for (var i = 0; i < str.length; i += 1) {
      var char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    var hex = Math.abs(hash).toString(16).padStart(8, '0');
    var extended = hex;
    while (extended.length < 64) {
      extended += hex;
    }
    return extended.slice(0, 64);
  }

  function computeOutputSha256(imageData) {
    var source = toText(imageData);
    if (!source) return '';
    return sha256Sync(source);
  }

  function createProvenanceReceipt(record, parentReceiptHash, sourceImageHashes) {
    var outputSha256 = computeOutputSha256(record.image);
    var userPromptHash = '';
    var promptToHash = toText(record.userPrompt) || toText(record.prompt);
    if (promptToHash && record.cloudPromptPublic !== true) {
      userPromptHash = sha256Sync(promptToHash);
    }

    var receipt = {
      receiptSchemaVersion: RECEIPT_SCHEMA_VERSION,
      recordId: record.id,
      outputSha256: outputSha256,
      sourceImageHashes: Array.isArray(sourceImageHashes) ? sourceImageHashes.slice(0, 8) : [],
      provider: toText(record.provider),
      model: toText(record.model),
      seed: record.seed || 0,
      size: toText(record.size),
      steps: record.steps,
      cfgScale: record.cfgScale,
      width: record.width || 0,
      height: record.height || 0,
      mode: toText(record.mode),
      createdAt: toText(record.createdAt) || new Date().toISOString(),
      appVersion: APP_VERSION,
      lineage: {
        parentReceiptHash: parentReceiptHash || null,
        versionGroupId: toText(record.versionGroupId) || record.id,
        versionNumber: record.versionNumber || 1
      },
      credentialStatus: 'absent'
    };

    if (userPromptHash) {
      receipt.userPromptHash = userPromptHash;
    }
    return receipt;
  }

  function parseCredentialStatus(credentialInfo) {
    if (!credentialInfo || typeof credentialInfo !== 'object') return 'absent';
    if (credentialInfo.unsupported === true) return 'unsupported';
    if (credentialInfo.hasC2PA === true) {
      if (credentialInfo.valid === true) return 'verified';
      if (credentialInfo.valid === false) return 'invalid';
      if (credentialInfo.transformApplied === true) return 'unknown_after_transform';
      return 'present_untrusted';
    }
    if (credentialInfo.providerDeclared === true) return 'absent';
    return 'absent';
  }

  function verifyReceiptHash(record) {
    if (!record || !record.provenanceReceipt || !record.provenanceReceipt.outputSha256) return false;
    var currentImage = toText(record.image);
    if (!currentImage) return false;
    var currentHash = computeOutputSha256(currentImage);
    return currentHash === record.provenanceReceipt.outputSha256;
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

  function normalizeReceiptField(value) {
    if (root.ImageProvenance && typeof root.ImageProvenance.normalizeReceipt === 'function') {
      return root.ImageProvenance.normalizeReceipt(value);
    }
    return value && typeof value === 'object' ? value : null;
  }

  // 每筆新記錄建立 ProvenanceReceipt（issue #18）；provenance.js 未載入時降級為 null。
  // 收據在這裡建立而非 normalizeRecord，因為只有「新增」語意才該產生新收據。
  function attachReceipt(record, rawRecord, records) {
    var P = root.ImageProvenance;
    var parent = null;
    var action = 'generate';

    if (!record || record.provenance || !P || typeof P.buildReceipt !== 'function') {
      return record;
    }
    if (rawRecord && (toText(rawRecord.recordAction) === 'edit'
        || (Array.isArray(rawRecord.editInputHashes) && rawRecord.editInputHashes.length))) {
      action = 'edit';
    } else if (record.sourceRecordId) {
      action = 'regenerate';
    }
    if (record.sourceRecordId && Array.isArray(records)) {
      parent = findRecordById(records, record.sourceRecordId);
    }
    try {
      record.provenance = P.buildReceipt(record, {
        action: action,
        parentReceipt: parent ? parent.provenance : null,
        inputImageHashes: rawRecord ? rawRecord.editInputHashes : null,
        providerProvenance: rawRecord ? rawRecord.providerProvenance : null
      });
    } catch (error) {
      record.provenance = null;
    }
    return record;
  }

  function normalizeRecord(raw, makeId) {
    var source = raw || {};
    var imageUrl = toText(source.imageUrl);
    var localImageData = toText(source.localImageData);
    var image = toText(source.image) || localImageData || imageUrl;
    var prompt = toText(source.userPrompt) || toText(source.prompt);
    var negativePrompt = toText(source.negativePrompt) || toText(source.avoid);
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

    var record = {
      id: id,
      schemaVersion: RECORD_SCHEMA_VERSION,
      userPrompt: prompt,
      expandedPrompt: toText(source.expandedPrompt) || toText(source.expandedChinesePrompt),
      image: image,
      thumbnail: toText(source.thumbnail) || image,
      prompt: prompt,
      providerPrompt: toText(source.providerPrompt) || prompt,
      negativePrompt: negativePrompt,
      avoid: negativePrompt,
      model: toText(source.model) || DEFAULT_MODEL,
      size: toText(source.size) || DEFAULT_SIZE,
      steps: typeof source.steps === 'number' && isFinite(source.steps) ? source.steps : null,
      cfgScale: typeof source.cfgScale === 'number' && isFinite(source.cfgScale) ? source.cfgScale : null,
      seed: normalizeSeed(source.seed),
      width: normalizeDimension(source.width),
      height: normalizeDimension(source.height),
      imageUrl: imageUrl || (image.indexOf('http://') === 0 || image.indexOf('https://') === 0 ? image : ''),
      localImageData: localImageData || (image.indexOf('data:image/') === 0 ? image : ''),
      provider: toText(source.provider),
      mode: toText(source.mode) === 'agent' ? 'agent' : 'normal',
      favorite: normalizeBoolean(source.favorite),
      tags: normalizeTags(source.tags),
      qaReport: normalizeQaReport(source.qaReport),
      recommended: normalizeBoolean(source.recommended),
      agentRecommendation: toText(source.agentRecommendation),
      autoRetry: normalizeAutoRetry(source.autoRetry),
      nextSuggestions: normalizeSuggestionList(source.nextSuggestions),
      cloudShareUrl: toText(source.cloudShareUrl),
      cloudDeleteUrl: toText(source.cloudDeleteUrl),
      cloudSavedAt: toText(source.cloudSavedAt),
      cloudPromptPublic: normalizeBoolean(source.cloudPromptPublic),
      cloudStorage: toText(source.cloudStorage),
      sourceRecordId: toText(source.sourceRecordId),
      versionGroupId: toText(source.versionGroupId) || id,
      versionNumber: normalizeVersionNumber(source.versionNumber),
      provenance: normalizeReceiptField(source.provenance),
      createdAt: toText(source.createdAt) || new Date().toISOString()
    };

    var parentReceiptHash = null;
    var sourceImageHashes = Array.isArray(source.sourceImageHashes) ? source.sourceImageHashes.slice(0, 8) : [];

    if (source.parentReceiptHash) {
      parentReceiptHash = toText(source.parentReceiptHash);
    } else if (source.sourceRecordId) {
      parentReceiptHash = 'sha256-' + toText(source.sourceRecordId);
    }

    var receipt = createProvenanceReceipt(record, parentReceiptHash, sourceImageHashes);
    record.provenanceReceipt = receipt;
    record.outputSha256 = receipt.outputSha256;
    return record;
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
      versionGroupId: parent.versionGroupId || parent.id,
      parentReceiptHash: parent.provenanceReceipt ? parent.provenanceReceipt.outputSha256 : null
    });

    group.forEach(function (record) {
      if (record.versionNumber > maxVersion) {
        maxVersion = record.versionNumber;
      }
    });

    source.versionNumber = maxVersion + 1;

    return attachReceipt(normalizeRecord(source, makeId), source, records);
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

  function normalizeRecordCollection(value) {
    var source = value && typeof value === 'object' ? value : {};
    var rawRecords;
    var records = [];

    if (Array.isArray(value)) {
      rawRecords = value;
    } else if (toText(source.schema) === COLLECTION_SCHEMA) {
      if (Number(source.version) !== 1 && Number(source.version) !== COLLECTION_VERSION) {
        return [];
      }
      rawRecords = Array.isArray(source.records) ? source.records : [];
    } else if (Array.isArray(source.records)) {
      rawRecords = source.records;
    } else {
      return [];
    }

    rawRecords.forEach(function (record) {
      try {
        records.push(normalizeRecord(record));
      } catch (error) {
        return;
      }
    });

    return records.slice(0, MAX_RECORDS);
  }

  function exportRecordCollection(records) {
    return {
      schema: COLLECTION_SCHEMA,
      version: COLLECTION_VERSION,
      migratedAt: new Date().toISOString(),
      records: normalizeRecordList(records)
    };
  }

  function parseRecords(text) {
    var parsed;

    try {
      parsed = JSON.parse(toText(text));
    } catch (error) {
      return [];
    }

    return normalizeRecordCollection(parsed);
  }

  function sanitizeUrlForExport(url) {
    var source = toText(url);
    if (!source) return '';
    try {
      var parsed = new root.URL(source);
      var paramsToRemove = ['token', 'deleteToken', 'api_key', 'apikey', 'key', 'secret', 'signature', 'sign'];
      paramsToRemove.forEach(function (param) {
        parsed.searchParams.delete(param);
      });
      return parsed.toString();
    } catch (error) {
      var cleaned = source;
      var paramsToRemove = ['token=', 'deleteToken=', 'api_key=', 'apikey=', 'key=', 'secret=', 'signature=', 'sign='];
      paramsToRemove.forEach(function (param) {
        var idx = cleaned.indexOf(param);
        while (idx !== -1) {
          var end = cleaned.indexOf('&', idx);
          if (end === -1) {
            cleaned = cleaned.slice(0, idx - 1);
          } else {
            cleaned = cleaned.slice(0, idx) + cleaned.slice(end);
          }
          idx = cleaned.indexOf(param);
        }
      });
      return cleaned;
    }
  }

  function normalizeRecordList(records) {
    var normalized = [];

    if (!Array.isArray(records)) {
      return normalized;
    }

    records.forEach(function (record) {
      try {
        var normalizedRecord = normalizeRecord(record);
        if (normalizedRecord.cloudShareUrl) {
          normalizedRecord.cloudShareUrl = sanitizeUrlForExport(normalizedRecord.cloudShareUrl);
        }
        if (normalizedRecord.cloudDeleteUrl) {
          normalizedRecord.cloudDeleteUrl = sanitizeUrlForExport(normalizedRecord.cloudDeleteUrl);
        }
        normalized.push(normalizedRecord);
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
        store.setItem(STORAGE_KEY, JSON.stringify(exportRecordCollection(nextRecords)));
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
    var existing = normalizeRecordList(records);
    var nextRecords = [attachReceipt(normalizeRecord(rawRecord, makeId), rawRecord, existing)];

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

  function deleteRecords(records, ids) {
    var lookup = {};
    var nextRecords = [];

    if (!Array.isArray(records) || !Array.isArray(ids)) {
      return [];
    }

    ids.forEach(function (id) {
      var value = toText(id);
      if (value) {
        lookup[value] = true;
      }
    });

    records.forEach(function (record) {
      if (lookup[toText(record && record.id)]) {
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
    COLLECTION_SCHEMA: COLLECTION_SCHEMA,
    COLLECTION_VERSION: COLLECTION_VERSION,
    MAX_RECORDS: MAX_RECORDS,
    RECEIPT_SCHEMA_VERSION: RECEIPT_SCHEMA_VERSION,
    APP_VERSION: APP_VERSION,
    normalizeRecord: normalizeRecord,
    normalizeRecordCollection: normalizeRecordCollection,
    exportRecordCollection: exportRecordCollection,
    parseRecords: parseRecords,
    loadRecords: loadRecords,
    saveRecords: saveRecords,
    addRecord: addRecord,
    deleteRecord: deleteRecord,
    deleteRecords: deleteRecords,
    findRecordById: findRecordById,
    findVersionGroup: findVersionGroup,
    createVersionRecord: createVersionRecord,
    updateRecordTags: updateRecordTags,
    toggleFavorite: toggleFavorite,
    updateRecord: updateRecord,
    clearRecords: clearRecords,
    computeOutputSha256: computeOutputSha256,
    verifyReceiptHash: verifyReceiptHash,
    parseCredentialStatus: parseCredentialStatus,
    createProvenanceReceipt: createProvenanceReceipt
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
