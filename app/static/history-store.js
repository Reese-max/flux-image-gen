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

  function computeOutputSha256(imageData) {
    var P = root.ImageProvenance;
    return P && typeof P.hashImage === 'function' ? P.hashImage(imageData).sha256 : '';
  }

  function legacyReceipt(receipt, record) {
    if (!receipt) { return null; }
    var hashes = [];
    receipt.inputs.forEach(function (input) { hashes.push(input.sha256); });
    var legacy = {
      receiptSchemaVersion: receipt.schemaVersion,
      recordId: receipt.recordId,
      outputSha256: receipt.outputSha256,
      outputHashStatus: receipt.outputHashStatus,
      receiptHash: receipt.receiptHash,
      sourceImageHashes: hashes,
      provider: receipt.provider,
      model: receipt.model,
      seed: receipt.seed,
      size: receipt.size,
      steps: receipt.steps,
      cfgScale: receipt.cfgScale,
      width: record.width || 0,
      height: record.height || 0,
      mode: receipt.mode,
      createdAt: receipt.createdAt,
      appVersion: receipt.appVersion,
      lineage: {
        parentReceiptHash: receipt.parentReceiptHash || null,
        versionGroupId: receipt.versionGroupId,
        versionNumber: receipt.versionNumber
      },
      credentialStatus: receipt.credentialStatus
    };
    if (record.cloudPromptPublic !== true && receipt.promptSha256) {
      legacy.userPromptHash = receipt.promptSha256;
    }
    return legacy;
  }

  function createProvenanceReceipt(record, parentReceiptHash, sourceImageHashes) {
    var P = root.ImageProvenance;
    if (!P || typeof P.buildReceipt !== 'function') { return null; }
    var receipt = P.buildReceipt(record, { inputImageHashes: sourceImageHashes });
    if (/^[a-f0-9]{64}$/i.test(toText(parentReceiptHash))) {
      receipt.parentReceiptHash = toText(parentReceiptHash).toLowerCase();
      receipt.receiptHash = P.computeReceiptHash(receipt);
    }
    return legacyReceipt(receipt, record);
  }

  function parseCredentialStatus(credentialInfo) {
    if (!credentialInfo || typeof credentialInfo !== 'object') { return 'absent'; }
    if (credentialInfo.unsupported === true) { return 'unsupported'; }
    if (credentialInfo.hasC2PA === true) {
      if (credentialInfo.transformApplied === true) { return 'unknown_after_transform'; }
      if (credentialInfo.valid === false) { return 'invalid'; }
      // A boolean is no signer certificate or trust-chain verification.
      return 'present_untrusted';
    }
    return 'absent';
  }

  function verifyReceiptHash(record) {
    var P = root.ImageProvenance;
    return !!(P && record && record.provenance
      && P.verifyReceiptHash(record.provenance)
      && P.verifyOutput(record.provenance, record.image) === 'match');
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
      provenanceUnavailable: normalizeBoolean(source.provenanceUnavailable),
      createdAt: toText(source.createdAt) || new Date().toISOString()
    };

    var P = root.ImageProvenance;
    var receipt = null;
    if (P && typeof P.buildReceipt === 'function') {
      receipt = P.normalizeReceipt(source.provenance);
      if (!receipt && source.provenance == null && !record.provenanceUnavailable) {
        receipt = P.buildReceipt(mergeRecord(record, {
          recordAction: source.recordAction,
          editInputHashes: source.editInputHashes || source.inputImageHashes || source.sourceImageHashes,
          sourceRecordIds: source.sourceRecordIds,
          providerModelRevision: source.providerModelRevision,
          providerProvenance: source.providerProvenance,
          transforms: source.transforms
        }), { parentReceipt: source.parentProvenance });
      } else if (!receipt) {
        // Keep the failed-import state across normalize/save/load/export cycles.
        record.provenanceUnavailable = true;
      }
      if (receipt) {
        // Imported claims cannot supply a trust chain; do not reseal the claim.
        if (receipt.credentialStatus === 'verified') {
          receipt.credentialStatus = P.inspectCredential(record.image).status;
        }
        receipt.inputs.forEach(function (input) {
          if (input.credentialStatus === 'verified') {
            input.credentialStatus = 'present_untrusted';
          }
        });
      }
      if (receipt && receipt.recordId !== record.id) { receipt.receiptHash = ''; }
    } else {
      // A transient module failure must not erase private lineage or tamper evidence.
      try {
        receipt = source.provenance == null ? null : JSON.parse(JSON.stringify(source.provenance));
      } catch (error) {
        receipt = null;
      }
      record.provenanceUnavailable = true;
    }
    record.provenance = receipt;
    record.provenanceReceipt = P ? legacyReceipt(receipt, record) : null;
    record.outputSha256 = P && receipt ? receipt.outputSha256 : '';
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
      parentProvenance: parent.provenance,
      recordAction: rawRecord && rawRecord.recordAction ? rawRecord.recordAction : 'regenerate'
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

  function recordCollection(records, forExport) {
    var normalized = normalizeRecordList(records);
    if (forExport) {
      normalized.forEach(function (record) {
        record.cloudShareUrl = sanitizeUrlForExport(record.cloudShareUrl);
        // Delete URLs may carry capability secrets in either path or query.
        record.cloudDeleteUrl = '';
        if (!root.ImageProvenance) {
          // Unvalidated private receipts are retained in storage, not exported as claims.
          record.provenance = null;
          record.provenanceReceipt = null;
          record.outputSha256 = '';
          record.provenanceUnavailable = true;
        }
      });
    }
    return {
      schema: COLLECTION_SCHEMA,
      version: COLLECTION_VERSION,
      migratedAt: new Date().toISOString(),
      records: normalized
    };
  }

  function exportRecordCollection(records) {
    return recordCollection(records, true);
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
    if (!source) { return ''; }
    try {
      var parsed = new root.URL(source);
      var remove = [];
      parsed.searchParams.forEach(function (value, key) {
        if (/^(token|deletetoken|api_key|apikey|key|secret|signature|sign|access_token|authorization)$/i.test(key)) {
          remove.push(key);
        }
      });
      remove.forEach(function (key) { parsed.searchParams.delete(key); });
      parsed.hash = '';
      return parsed.toString();
    } catch (error) {
      // Older browsers without URL support export the public path only.
      return source.split(/[?#]/)[0];
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
        store.setItem(STORAGE_KEY, JSON.stringify(recordCollection(nextRecords, false)));
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
    var nextRecords = [normalizeRecord(rawRecord, makeId)];

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
