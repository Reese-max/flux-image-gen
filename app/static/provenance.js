// Internal provenance receipts for generated and edited history records.
// This deliberately records hashes and allowlisted settings only. It does not
// claim to be a C2PA signer or validator; missing upstream credentials remain
// explicit in the receipt status.
(function (root) {
  'use strict';

  var RECEIPT_SCHEMA = 'ProvenanceReceipt';
  var RECEIPT_SCHEMA_VERSION = 1;
  var MAX_TEXT = 512;
  var MAX_ID = 160;
  var HASH_RE = /^[a-f0-9]{64}$/;
  var CREDENTIAL_STATUSES = {
    verified: true,
    present_untrusted: true,
    invalid: true,
    absent: true,
    unknown_after_transform: true,
    unsupported: true
  };

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function boundedText(value, limit) {
    return toText(value).slice(0, limit || MAX_TEXT);
  }

  function normalizeHash(value) {
    var hash = toText(value).toLowerCase();
    return HASH_RE.test(hash) ? hash : '';
  }

  function normalizeHashList(value) {
    var source = Array.isArray(value) ? value : [];
    var result = [];
    var i;
    var hash;
    for (i = 0; i < source.length && result.length < 4; i += 1) {
      hash = normalizeHash(source[i]);
      if (hash && result.indexOf(hash) === -1) { result.push(hash); }
    }
    return result;
  }

  function normalizeIdList(value) {
    var source = Array.isArray(value) ? value : [];
    var result = [];
    var i;
    var id;
    for (i = 0; i < source.length && result.length < 4; i += 1) {
      id = boundedText(source[i], MAX_ID);
      if (id && result.indexOf(id) === -1) { result.push(id); }
    }
    return result;
  }

  function normalizeOptionalNumber(value) {
    var number;
    if (value === null || value === undefined || value === '') { return null; }
    number = Number(value);
    if (!isFinite(number)) { return null; }
    return number;
  }

  function normalizeInteger(value, fallback) {
    var number = Number(value);
    if (!isFinite(number) || Math.floor(number) !== number || number < 0) {
      return fallback;
    }
    return number;
  }

  function normalizeVersionNumber(value) {
    var number = Number(value);
    if (!isFinite(number) || Math.floor(number) !== number || number < 1) { return 1; }
    return number;
  }

  function normalizeCredentialStatus(value, operation) {
    var status = toText(value);
    if (CREDENTIAL_STATUSES[status]) { return status; }
    return operation === 'edit' ? 'unknown_after_transform' : 'unsupported';
  }

  function normalizeTransform(value, operation) {
    var source = value && typeof value === 'object' ? value : {};
    var kind = boundedText(source.kind, 96);
    var effect = boundedText(source.credential_effect, 64);
    if (!kind) {
      kind = operation === 'edit' ? 'ai_edit' : 'none';
    }
    if (!effect) {
      effect = operation === 'edit' ? 'unknown_after_transform' : 'unchanged';
    }
    return {
      kind: kind,
      applied: source.applied === true,
      credential_effect: effect
    };
  }

  function normalizeReceipt(value) {
    var source = value && typeof value === 'object' ? value : null;
    var operation;
    var recordId;
    var receipt;
    if (!source) { return null; }
    operation = toText(source.operation) === 'edit' ? 'edit' : 'generate';
    recordId = boundedText(source.record_id, MAX_ID);
    if (!recordId) { return null; }
    receipt = {
      schema: RECEIPT_SCHEMA,
      receipt_schema_version: 1,
      record_id: recordId,
      operation: operation,
      source_record_ids: normalizeIdList(source.source_record_ids),
      input_image_hashes: normalizeHashList(source.input_image_hashes),
      provider: boundedText(source.provider),
      model: boundedText(source.model),
      provider_model_revision: boundedText(source.provider_model_revision),
      seed: normalizeInteger(source.seed, 0),
      size: boundedText(source.size, 96),
      steps: normalizeOptionalNumber(source.steps),
      cfg_scale: normalizeOptionalNumber(source.cfg_scale),
      mode: boundedText(source.mode, 32) || 'normal',
      prompt_sha256: normalizeHash(source.prompt_sha256),
      created_at: boundedText(source.created_at, 80),
      output_sha256: normalizeHash(source.output_sha256),
      parent_receipt_hash: normalizeHash(source.parent_receipt_hash),
      version_group_id: boundedText(source.version_group_id, MAX_ID),
      version_number: normalizeVersionNumber(source.version_number),
      app_build_version: boundedText(source.app_build_version),
      credential_status: normalizeCredentialStatus(source.credential_status, operation),
      transform: normalizeTransform(source.transform, operation),
      receipt_hash: normalizeHash(source.receipt_hash)
    };
    return receipt;
  }

  function getSubtle() {
    if (root.crypto && root.crypto.subtle && typeof root.crypto.subtle.digest === 'function') {
      return root.crypto.subtle;
    }
    return null;
  }

  function utf8Bytes(value) {
    var text = String(value);
    var encoder;
    var encoded;
    var bytes;
    var i;
    if (root.TextEncoder) {
      encoder = new root.TextEncoder();
      return encoder.encode(text);
    }
    encoded = unescape(encodeURIComponent(text));
    bytes = new Uint8Array(encoded.length);
    for (i = 0; i < encoded.length; i += 1) { bytes[i] = encoded.charCodeAt(i); }
    return bytes;
  }

  function bytesToHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var result = '';
    var i;
    for (i = 0; i < bytes.length; i += 1) {
      result += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return result;
  }

  function digestBytes(bytes) {
    var subtle = getSubtle();
    if (!subtle) { return Promise.resolve(''); }
    try {
      return Promise.resolve(subtle.digest('SHA-256', bytes)).then(bytesToHex, function () { return ''; });
    } catch (error) {
      return Promise.resolve('');
    }
  }

  function hashText(value) {
    return digestBytes(utf8Bytes(value));
  }

  function dataUrlBytes(value) {
    var source = toText(value);
    var comma = source.indexOf(',');
    var metadata;
    var raw;
    var decoder;
    var binary;
    var bytes;
    var i;
    if (source.indexOf('data:') !== 0 || comma < 0) { return null; }
    metadata = source.slice(0, comma).toLowerCase();
    raw = source.slice(comma + 1);
    try {
      if (metadata.indexOf(';base64') !== -1) {
        decoder = root.atob || (typeof atob === 'function' ? atob : null);
        if (!decoder) { return null; }
        binary = decoder(raw);
      } else {
        binary = decodeURIComponent(raw);
      }
      bytes = new Uint8Array(binary.length);
      for (i = 0; i < binary.length; i += 1) { bytes[i] = binary.charCodeAt(i); }
      return bytes;
    } catch (error) {
      return null;
    }
  }

  function hashDataUrl(value) {
    var bytes = dataUrlBytes(value);
    return bytes ? digestBytes(bytes) : Promise.resolve('');
  }

  function hashBlob(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') { return Promise.resolve(''); }
    try {
      return Promise.resolve(blob.arrayBuffer()).then(function (buffer) {
        return digestBytes(buffer);
      }, function () { return ''; });
    } catch (error) {
      return Promise.resolve('');
    }
  }

  function hashBlobs(blobs) {
    var source = Array.isArray(blobs) ? blobs : [];
    return Promise.all(source.slice(0, 4).map(hashBlob));
  }

  function copyRecord(record) {
    var copy = {};
    var key;
    for (key in (record || {})) {
      if (Object.prototype.hasOwnProperty.call(record, key)) { copy[key] = record[key]; }
    }
    return copy;
  }

  function withoutReceiptHash(receipt) {
    var copy = copyRecord(receipt);
    delete copy.receipt_hash;
    return copy;
  }

  function buildReceipt(record, parentRecord) {
    var source = record || {};
    var parent = parentRecord && parentRecord.provenanceReceipt;
    var operation = toText(source.operation) === 'edit' ? 'edit' : 'generate';
    var sourceIds = normalizeIdList(source.sourceRecordIds);
    var sourceRecordId = boundedText(source.sourceRecordId, MAX_ID);
    var inputHashes = normalizeHashList(source.inputImageSha256 || source.inputImageHashes);
    var prompt = boundedText(source.providerPrompt || source.prompt);
    var baseReceipt;
    if (sourceRecordId && sourceIds.indexOf(sourceRecordId) === -1) { sourceIds.push(sourceRecordId); }
    baseReceipt = {
      schema: RECEIPT_SCHEMA,
      receipt_schema_version: RECEIPT_SCHEMA_VERSION,
      record_id: boundedText(source.id, MAX_ID),
      operation: operation,
      source_record_ids: sourceIds,
      input_image_hashes: inputHashes,
      provider: boundedText(source.provider),
      model: boundedText(source.model),
      provider_model_revision: boundedText(source.providerModelRevision || source.modelRevision),
      seed: normalizeInteger(source.seed, 0),
      size: boundedText(source.size, 96),
      steps: normalizeOptionalNumber(source.steps),
      cfg_scale: normalizeOptionalNumber(source.cfgScale),
      mode: boundedText(source.mode, 32) || 'normal',
      prompt_sha256: '',
      created_at: boundedText(source.createdAt, 80) || new Date().toISOString(),
      output_sha256: '',
      parent_receipt_hash: parent ? normalizeHash(parent.receipt_hash) : '',
      version_group_id: boundedText(source.versionGroupId, MAX_ID) || boundedText(source.id, MAX_ID),
      version_number: normalizeVersionNumber(source.versionNumber),
      app_build_version: boundedText(source.appBuildVersion || root.__FLUX_APP_BUILD_VERSION || root.APP_BUILD_VERSION) || 'flux-image-gen',
      credential_status: normalizeCredentialStatus(source.credentialStatus, operation),
      transform: normalizeTransform(source.transform, operation),
      receipt_hash: ''
    };
    return Promise.all([hashText(prompt), hashDataUrl(source.image)]).then(function (hashes) {
      var outputHash = normalizeHash(hashes[1]) || normalizeHash(source.outputSha256);
      var promptHash = normalizeHash(hashes[0]) || normalizeHash(source.promptSha256);
      var receipt;
      baseReceipt.prompt_sha256 = promptHash;
      baseReceipt.output_sha256 = outputHash;
      receipt = normalizeReceipt(baseReceipt);
      return hashText(JSON.stringify(withoutReceiptHash(receipt))).then(function (receiptHash) {
        receipt.receipt_hash = normalizeHash(receiptHash);
        return receipt;
      });
    });
  }

  function attachRecord(record, parentRecord) {
    var source = copyRecord(record);
    var existing = normalizeReceipt(source.provenanceReceipt);
    if (existing && existing.record_id === boundedText(source.id, MAX_ID)) {
      source.provenanceReceipt = existing;
      return Promise.resolve(source);
    }
    return buildReceipt(source, parentRecord).then(function (receipt) {
      source.provenanceReceipt = receipt;
      return source;
    });
  }

  function verifyRecord(record) {
    var source = record || {};
    var receipt = normalizeReceipt(source.provenanceReceipt);
    var outputHashPromise;
    var receiptHashPromise;
    if (!receipt) {
      return Promise.resolve({ status: 'absent', credential_status: 'unsupported', receipt_hash_valid: false, output_hash_valid: false });
    }
    outputHashPromise = hashDataUrl(source.image);
    receiptHashPromise = receipt.receipt_hash
      ? hashText(JSON.stringify(withoutReceiptHash(receipt)))
      : Promise.resolve('');
    return Promise.all([outputHashPromise, receiptHashPromise]).then(function (hashes) {
      var actualOutput = normalizeHash(hashes[0]);
      var receiptHashValid = receipt.receipt_hash ? actualOutput !== '' && hashes[1] === receipt.receipt_hash : null;
      var outputHashValid = receipt.output_sha256 ? actualOutput !== '' && actualOutput === receipt.output_sha256 : null;
      var status = 'unavailable';
      if (receiptHashValid === false || outputHashValid === false) {
        status = 'modified';
      } else if (receiptHashValid === true && outputHashValid === true) {
        status = 'valid';
      }
      return {
        status: status,
        credential_status: receipt.credential_status,
        receipt_hash_valid: receiptHashValid,
        output_hash_valid: outputHashValid,
        output_sha256: actualOutput
      };
    });
  }

  root.ProvenanceReceipt = {
    SCHEMA: RECEIPT_SCHEMA,
    SCHEMA_VERSION: RECEIPT_SCHEMA_VERSION,
    CREDENTIAL_STATUSES: CREDENTIAL_STATUSES,
    normalizeHash: normalizeHash,
    normalizeReceipt: normalizeReceipt,
    hashText: hashText,
    hashDataUrl: hashDataUrl,
    hashBlob: hashBlob,
    hashBlobs: hashBlobs,
    buildReceipt: buildReceipt,
    attachRecord: attachRecord,
    verifyRecord: verifyRecord
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
