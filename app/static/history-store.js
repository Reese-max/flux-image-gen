(function (root) {
  'use strict';

  var STORAGE_KEY = 'aiImageGenerationHistory.v1';
  var COLLECTION_SCHEMA = 'GenerationRecordCollection';
  var COLLECTION_VERSION = 2;
  var RECORD_SCHEMA_VERSION = 2;
  var MAX_RECORDS = 48;
  var DEFAULT_MODEL = 'schnell';
  var DEFAULT_SIZE = 'square';

  function toText(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).trim();
  }

  function sanitizeMetadataValue(value, kind, fallback) {
    var helper = root.ProvenanceReceipt;
    var result;
    if (helper && typeof helper.sanitizeMetadataValue === 'function') {
      result = helper.sanitizeMetadataValue(value, kind);
      return result || (fallback || '');
    }
    result = toText(value);
    if (!result || /[?#\\]/.test(result) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(result)) {
      return fallback || '';
    }
    if (/(?:api[_-]?key|token|secret|password|bearer|authorization|signature|signed)/i.test(result)) {
      return fallback || '';
    }
    if (kind === 'provider' && !/^(?:demo|nvidia|workers-ai|pollinations|gemini|gemini-fallback|rule-based|edit|blocked|unknown)$/.test(result.toLowerCase())) {
      return fallback || '';
    }
    if (kind === 'mode' && result !== 'normal' && result !== 'agent') { return fallback || ''; }
    return result.slice(0, kind === 'id' ? 160 : 512);
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

  // Keep provenance receipts strict when importing old/local JSON. The
  // dedicated ProvenanceReceipt helper performs the full normalization in the
  // browser; this fallback keeps history-store safe when tested or loaded on
  // its own.
  function normalizeProvenanceReceipt(value) {
    var helper = root.ProvenanceReceipt;
    var source = value && typeof value === 'object' ? value : null;
    var operation;
    var hashes;
    var ids;
    var receipt;
    var i;
    var item;
    var claimedStatus;
    var canonicalStatus;
    if (helper && typeof helper.normalizeReceipt === 'function') {
      return helper.normalizeReceipt(value);
    }
    if (!source || !sanitizeMetadataValue(source.record_id, 'id')) { return null; }
    operation = toText(source.operation) === 'edit' ? 'edit' : 'generate';
    hashes = [];
    ids = [];
    if (Array.isArray(source.input_image_hashes)) {
      for (i = 0; i < source.input_image_hashes.length && hashes.length < 4; i += 1) {
        item = toText(source.input_image_hashes[i]).toLowerCase();
        if (/^[a-f0-9]{64}$/.test(item) && hashes.indexOf(item) === -1) { hashes.push(item); }
      }
    }
    if (Array.isArray(source.source_record_ids)) {
      for (i = 0; i < source.source_record_ids.length && ids.length < 4; i += 1) {
        item = sanitizeMetadataValue(source.source_record_ids[i], 'id');
        if (item && ids.indexOf(item) === -1) { ids.push(item); }
      }
    }
    claimedStatus = toText(source.credential_status);
    canonicalStatus = /^(?:verified|present_untrusted|invalid|absent|unknown_after_transform|unsupported)$/.test(claimedStatus)
      ? claimedStatus
      : (operation === 'edit' ? 'unknown_after_transform' : 'unsupported');
    receipt = {
      schema: 'ProvenanceReceipt',
      receipt_schema_version: 1,
      record_id: sanitizeMetadataValue(source.record_id, 'id'),
      operation: operation,
      source_record_ids: ids,
      input_image_hashes: hashes,
      provider: sanitizeMetadataValue(source.provider, 'provider'),
      model: sanitizeMetadataValue(source.model, 'model'),
      provider_model_revision: sanitizeMetadataValue(source.provider_model_revision, 'model'),
      seed: normalizeSeed(source.seed),
      size: sanitizeMetadataValue(source.size, 'identifier'),
      steps: typeof source.steps === 'number' && isFinite(source.steps) ? source.steps : null,
      cfg_scale: typeof source.cfg_scale === 'number' && isFinite(source.cfg_scale) ? source.cfg_scale : null,
      mode: sanitizeMetadataValue(source.mode, 'mode', 'normal'),
      prompt_sha256: /^[a-f0-9]{64}$/i.test(toText(source.prompt_sha256)) ? toText(source.prompt_sha256).toLowerCase() : '',
      created_at: sanitizeMetadataValue(source.created_at, 'timestamp'),
      output_sha256: /^[a-f0-9]{64}$/i.test(toText(source.output_sha256)) ? toText(source.output_sha256).toLowerCase() : '',
      parent_receipt_hash: /^[a-f0-9]{64}$/i.test(toText(source.parent_receipt_hash)) ? toText(source.parent_receipt_hash).toLowerCase() : '',
      version_group_id: sanitizeMetadataValue(source.version_group_id, 'id'),
      version_number: normalizeVersionNumber(source.version_number),
      app_build_version: sanitizeMetadataValue(source.app_build_version, 'build'),
      // Keep the persisted canonical status stable so its receipt_hash can be
      // checked after reload. Current-image C2PA verification is separate and
      // is never inferred from this imported value.
      credential_status: canonicalStatus,
      transform: {
        kind: toText(source.transform && source.transform.kind).slice(0, 96) || (operation === 'edit' ? 'ai_edit' : 'none'),
        applied: !!(source.transform && source.transform.applied),
        credential_effect: toText(source.transform && source.transform.credential_effect).slice(0, 64) || (operation === 'edit' ? 'unknown_after_transform' : 'unchanged')
      },
      receipt_hash: /^[a-f0-9]{64}$/i.test(toText(source.receipt_hash)) ? toText(source.receipt_hash).toLowerCase() : ''
    };
    return receipt;
  }

  function normalizeRecord(raw, makeId) {
    var source = raw || {};
    var imageUrl = toText(source.imageUrl);
    var localImageData = toText(source.localImageData);
    var image = toText(source.image) || localImageData || imageUrl;
    var prompt = toText(source.userPrompt) || toText(source.prompt);
    var negativePrompt = toText(source.negativePrompt) || toText(source.avoid);
    var id = sanitizeMetadataValue(source.id, 'id');
    var idFactory = typeof makeId === 'function' ? makeId : defaultMakeId;
    var provenanceReceipt;
    var normalized;

    if (!image) {
      throw new Error('缺少圖片資料');
    }
    if (!prompt) {
      throw new Error('缺少提示詞');
    }
    if (!id) {
      id = toText(idFactory());
    }

    normalized = {
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
      model: sanitizeMetadataValue(source.model, 'model', DEFAULT_MODEL),
      size: sanitizeMetadataValue(source.size, 'identifier', DEFAULT_SIZE) || DEFAULT_SIZE,
      steps: typeof source.steps === 'number' && isFinite(source.steps) ? source.steps : null,
      cfgScale: typeof source.cfgScale === 'number' && isFinite(source.cfgScale) ? source.cfgScale : null,
      seed: normalizeSeed(source.seed),
      width: normalizeDimension(source.width),
      height: normalizeDimension(source.height),
      imageUrl: imageUrl || (image.indexOf('http://') === 0 || image.indexOf('https://') === 0 ? image : ''),
      localImageData: localImageData || (image.indexOf('data:image/') === 0 ? image : ''),
      provider: sanitizeMetadataValue(source.provider, 'provider'),
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
      cloudStorage: sanitizeMetadataValue(source.cloudStorage, 'identifier'),
      sourceRecordId: sanitizeMetadataValue(source.sourceRecordId, 'id'),
      versionGroupId: sanitizeMetadataValue(source.versionGroupId, 'id') || id,
      versionNumber: normalizeVersionNumber(source.versionNumber),
      createdAt: sanitizeMetadataValue(source.createdAt, 'timestamp') || new Date().toISOString()
    };
    provenanceReceipt = normalizeProvenanceReceipt(source.provenanceReceipt);
    if (provenanceReceipt) {
      normalized.provenanceReceipt = provenanceReceipt;
    }
    return normalized;
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
    clearRecords: clearRecords
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
