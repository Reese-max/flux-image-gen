// Internal provenance receipts for generated and edited history records.
//
// A receipt records the application's own input/output lineage. A receipt
// hash is an integrity check and is deliberately kept separate from C2PA
// credential verification. Only a result returned by the maintained C2PA
// reader below can produce a `verified` credential status.
(function (root) {
  'use strict';

  var RECEIPT_SCHEMA = 'ProvenanceReceipt';
  var RECEIPT_SCHEMA_VERSION = 2;
  var MAX_TEXT = 512;
  var MAX_PROMPT = 10000;
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
  var DEFAULT_C2PA_SETTINGS = {
    verify: { verifyTrust: false },
    cawgTrust: { verifyTrustList: false }
  };
  var C2PA_PROMPT_HASH_MODE = 'full_canonical_utf8_v1';
  var c2paPromises = {};
  // Validation results are runtime capabilities, never receipt data. Keep
  // their identity private so JSON import/export cannot manufacture a trusted
  // result by copying a marker field.
  var validationWeakMap = typeof WeakMap === 'function' ? new WeakMap() : null;
  var validationList = [];

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

  function hasSensitiveValue(value) {
    return /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|bearer|authorization|cookie|delete[_-]?token|signature|signed|private[_-]?key)/i.test(value);
  }

  // Receipt metadata may be imported from a local JSON file or supplied by a
  // provider response. Keep identifiers useful for diagnostics while
  // refusing URL/query/credential shaped values that could expose a token in
  // a receipt, export, or share message.
  function sanitizeMetadataValue(value, kind) {
    var text = toText(value);
    var max = kind === 'id' ? MAX_ID : MAX_TEXT;
    var allowed;
    if (!text || text.length > max || hasSensitiveValue(text)) { return ''; }
    if (/[?#\\]/.test(text) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(text)) { return ''; }
    if (kind === 'timestamp') {
      return /^[0-9TtZz:.,+\- ]+$/.test(text) ? text : '';
    }
    if (kind === 'provider') {
      allowed = {
        demo: true,
        nvidia: true,
        'workers-ai': true,
        pollinations: true,
        gemini: true,
        'gemini-fallback': true,
        'rule-based': true,
        edit: true,
        blocked: true,
        unknown: true
      };
      return allowed[text.toLowerCase()] ? text.toLowerCase() : '';
    }
    if (kind === 'mode') {
      return text === 'agent' || text === 'normal' ? text : '';
    }
    // Model identifiers may contain the @cf/ namespace and a slash. A
    // leading @ is permitted, but URI schemes, spaces and other punctuation
    // outside this small identifier alphabet are not.
    if (kind === 'model') {
      return /^@?[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,511}$/.test(text) ? text : '';
    }
    if (kind === 'id') {
      return /^[A-Za-z0-9][A-Za-z0-9._:@+\-/]{0,159}$/.test(text) ? text : '';
    }
    allowed = /^[A-Za-z0-9][A-Za-z0-9._:@+\-/]{0,511}$/;
    return allowed.test(text) ? text : '';
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
      id = sanitizeMetadataValue(source[i], 'id');
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

  function isCredentialStatus(value) {
    return CREDENTIAL_STATUSES[toText(value)] === true;
  }

  function rememberValidation(value, input, blob, inputHash) {
    var proof;
    var i;
    if (!value || typeof value !== 'object') { return value; }
    proof = { input: input, blob: blob || null, input_hash: inputHash || '' };
    if (validationWeakMap) {
      validationWeakMap.set(value, proof);
      return value;
    }
    for (i = 0; i < validationList.length; i += 1) {
      if (validationList[i].value === value) {
        validationList[i].proof = proof;
        return value;
      }
    }
    validationList.push({ value: value, proof: proof });
    // Bound the legacy fallback so a long lived page cannot retain every
    // historical result when WeakMap is unavailable.
    if (validationList.length > 32) { validationList.shift(); }
    return value;
  }

  function validationProof(value) {
    var i;
    if (!value || typeof value !== 'object') { return null; }
    if (validationWeakMap) { return validationWeakMap.get(value) || null; }
    for (i = 0; i < validationList.length; i += 1) {
      if (validationList[i].value === value) { return validationList[i].proof; }
    }
    return null;
  }

  function normalizeCredentialStatus(value, operation) {
    var status = normalizeClaimStatus(value);
    // This is the immutable canonical receipt field. Runtime validator output
    // is supplied by inspectCredential/verifyRecord separately; normalizing a
    // persisted receipt must never rewrite this field and invalidate its hash.
    if (status) { return status; }
    return operation === 'edit' ? 'unknown_after_transform' : 'unsupported';
  }

  function normalizeClaimStatus(value) {
    var status = toText(value);
    return isCredentialStatus(status) ? status : '';
  }

  function normalizeStageList(value) {
    var source = Array.isArray(value) ? value : [];
    var result = [];
    var allowed = {
      browser_resize_reencode: true,
      ai_edit: true,
      download_reencode: true,
      unknown: true
    };
    var i;
    var stage;
    for (i = 0; i < source.length && result.length < 4; i += 1) {
      stage = toText(source[i]);
      if (allowed[stage] && result.indexOf(stage) === -1) { result.push(stage); }
    }
    return result;
  }

  function normalizeTransform(value, operation) {
    var source = value && typeof value === 'object' ? value : {};
    var kind = toText(source.kind);
    var effect = toText(source.credential_effect);
    var stages = normalizeStageList(source.stages);
    var hasApplied = Object.prototype.hasOwnProperty.call(source, 'applied');
    var allowedKinds = {
      none: true,
      ai_edit: true,
      browser_resize_reencode_then_ai_edit: true,
      browser_resize_reencode: true,
      download_reencode: true,
      unknown: true
    };
    var allowedEffects = {
      unchanged: true,
      preserved: true,
      invalidated: true,
      unknown_after_transform: true
    };
    if (!allowedKinds[kind]) { kind = operation === 'edit' ? 'ai_edit' : 'none'; }
    if (!allowedEffects[effect]) { effect = operation === 'edit' ? 'unknown_after_transform' : 'unchanged'; }
    if (!stages.length && operation === 'edit') { stages = ['ai_edit']; }
    return {
      kind: kind,
      applied: hasApplied ? source.applied === true : operation === 'edit',
      credential_effect: effect,
      stages: stages
    };
  }

  function normalizeReceipt(value, validation) {
    var source = value && typeof value === 'object' ? value : null;
    var operation;
    var recordId;
    var version;
    var receipt;
    var claim;
    var transform;
    if (!source) { return null; }
    operation = toText(source.operation) === 'edit' ? 'edit' : 'generate';
    recordId = sanitizeMetadataValue(source.record_id, 'id');
    if (!recordId) { return null; }
    version = Number(source.receipt_schema_version) === 2 ? 2 : 1;
    claim = normalizeClaimStatus(source.credential_claim_status || source.credential_status);
    transform = normalizeTransform(source.transform, operation);
    if (version === 1) { delete transform.stages; }
    receipt = {
      schema: RECEIPT_SCHEMA,
      receipt_schema_version: version,
      record_id: recordId,
      operation: operation,
      source_record_ids: normalizeIdList(source.source_record_ids),
      input_image_hashes: normalizeHashList(source.input_image_hashes),
      provider: sanitizeMetadataValue(source.provider, 'provider'),
      model: sanitizeMetadataValue(source.model, 'model'),
      provider_model_revision: sanitizeMetadataValue(source.provider_model_revision, 'model'),
      seed: normalizeInteger(source.seed, 0),
      size: sanitizeMetadataValue(source.size, 'identifier'),
      steps: normalizeOptionalNumber(source.steps),
      cfg_scale: normalizeOptionalNumber(source.cfg_scale),
      mode: sanitizeMetadataValue(source.mode, 'mode') || 'normal',
      prompt_sha256: normalizeHash(source.prompt_sha256),
      created_at: sanitizeMetadataValue(source.created_at, 'timestamp'),
      output_sha256: normalizeHash(source.output_sha256),
      parent_receipt_hash: normalizeHash(source.parent_receipt_hash),
      version_group_id: sanitizeMetadataValue(source.version_group_id, 'id'),
      version_number: normalizeVersionNumber(source.version_number),
      app_build_version: sanitizeMetadataValue(source.app_build_version, 'build'),
      credential_status: normalizeCredentialStatus(source.credential_status, operation),
      transform: transform,
      receipt_hash: normalizeHash(source.receipt_hash)
    };
    if (version === 2) {
      receipt.user_prompt_sha256 = normalizeHash(source.user_prompt_sha256);
      receipt.prompt_hash_mode = toText(source.prompt_hash_mode) === C2PA_PROMPT_HASH_MODE
        ? C2PA_PROMPT_HASH_MODE
        : 'legacy_bounded_utf8_v1';
      receipt.original_input_image_hashes = normalizeHashList(source.original_input_image_hashes);
      receipt.input_hash_scope = toText(source.input_hash_scope) === 'original_upload' ? 'original_upload' : 'provider_input';
      receipt.credential_claim_status = claim;
    }
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

  function digestBytesDetailed(bytes) {
    var subtle = getSubtle();
    if (!subtle) {
      return Promise.resolve({ available: false, hash: '', reason: 'crypto_unavailable' });
    }
    try {
      return Promise.resolve(subtle.digest('SHA-256', bytes)).then(function (buffer) {
        return { available: true, hash: bytesToHex(buffer), reason: '' };
      }, function () {
        return { available: false, hash: '', reason: 'crypto_unavailable' };
      });
    } catch (error) {
      return Promise.resolve({ available: false, hash: '', reason: 'crypto_unavailable' });
    }
  }

  function digestBytes(bytes) {
    return digestBytesDetailed(bytes).then(function (result) { return result.hash; });
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
      return {
        bytes: bytes,
        mime: (metadata.slice(5).split(';')[0] || 'application/octet-stream').toLowerCase()
      };
    } catch (error) {
      return null;
    }
  }

  function hashDataUrlDetailed(value) {
    var parsed = dataUrlBytes(value);
    if (!parsed) {
      return Promise.resolve({ available: false, hash: '', reason: toText(value).indexOf('http') === 0 ? 'remote_url' : 'image_bytes_unavailable' });
    }
    return digestBytesDetailed(parsed.bytes);
  }

  function hashDataUrl(value) {
    return hashDataUrlDetailed(value).then(function (result) { return result.hash; });
  }

  function hashBlobDetailed(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') {
      return Promise.resolve({ available: false, hash: '', reason: 'image_bytes_unavailable' });
    }
    try {
      return Promise.resolve(blob.arrayBuffer()).then(function (buffer) {
        return digestBytesDetailed(buffer);
      }, function () {
        return { available: false, hash: '', reason: 'image_bytes_unavailable' };
      });
    } catch (error) {
      return Promise.resolve({ available: false, hash: '', reason: 'image_bytes_unavailable' });
    }
  }

  function hashBlob(blob) {
    return hashBlobDetailed(blob).then(function (result) { return result.hash; });
  }

  function hashInputDetailed(input) {
    if (input && typeof input.arrayBuffer === 'function') {
      return hashBlobDetailed(input);
    }
    return hashDataUrlDetailed(input);
  }

  function validationMatchesInput(validation, input) {
    var proof = validationProof(validation);
    if (!proof) { return Promise.resolve(false); }
    if (proof.input === input) { return Promise.resolve(true); }
    if (typeof proof.input === 'string' && typeof input === 'string' && toText(proof.input) === toText(input)) {
      return Promise.resolve(true);
    }
    if (!proof.input_hash) { return Promise.resolve(false); }
    return hashInputDetailed(input).then(function (result) {
      return !!(result.available && result.hash === proof.input_hash);
    }, function () {
      return false;
    });
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

  function promptText(record) {
    var source = record || {};
    var providerPrompt = toText(source.providerPrompt);
    return providerPrompt || toText(source.prompt);
  }

  function userPromptText(record) {
    var source = record || {};
    return toText(source.prompt) || toText(source.userPrompt);
  }

  function buildReceipt(record, parentRecord, credentialVerification) {
    var source = record || {};
    var parent = parentRecord && parentRecord.provenanceReceipt;
    var operation = toText(source.operation) === 'edit' ? 'edit' : 'generate';
    var sourceIds = normalizeIdList(source.sourceRecordIds);
    var sourceRecordId = sanitizeMetadataValue(source.sourceRecordId, 'id');
    var inputHashes = normalizeHashList(source.inputImageSha256 || source.inputImageHashes);
    var originalHashes = normalizeHashList(source.originalInputImageSha256 || source.originalInputImageHashes);
    var prompt = promptText(source).slice(0, MAX_PROMPT);
    var userPrompt = userPromptText(source).slice(0, MAX_PROMPT);
    var recordId = sanitizeMetadataValue(source.id, 'id');
    var transform = normalizeTransform(source.transform, operation);
    var baseReceipt;
    if (!recordId) { recordId = 'history-' + Date.now().toString(36); }
    if (sourceRecordId && sourceIds.indexOf(sourceRecordId) === -1) { sourceIds.push(sourceRecordId); }
    baseReceipt = {
      schema: RECEIPT_SCHEMA,
      receipt_schema_version: RECEIPT_SCHEMA_VERSION,
      record_id: recordId,
      operation: operation,
      source_record_ids: sourceIds,
      input_image_hashes: inputHashes,
      provider: sanitizeMetadataValue(source.provider, 'provider'),
      model: sanitizeMetadataValue(source.model, 'model'),
      provider_model_revision: sanitizeMetadataValue(source.providerModelRevision || source.modelRevision, 'model'),
      seed: normalizeInteger(source.seed, 0),
      size: sanitizeMetadataValue(source.size, 'identifier'),
      steps: normalizeOptionalNumber(source.steps),
      cfg_scale: normalizeOptionalNumber(source.cfgScale),
      mode: sanitizeMetadataValue(source.mode, 'mode') || 'normal',
      prompt_sha256: '',
      user_prompt_sha256: '',
      prompt_hash_mode: C2PA_PROMPT_HASH_MODE,
      created_at: sanitizeMetadataValue(source.createdAt, 'timestamp') || new Date().toISOString(),
      output_sha256: '',
      parent_receipt_hash: parent ? normalizeHash(parent.receipt_hash) : '',
      version_group_id: sanitizeMetadataValue(source.versionGroupId, 'id') || recordId,
      version_number: normalizeVersionNumber(source.versionNumber),
      app_build_version: sanitizeMetadataValue(source.appBuildVersion || root.__FLUX_APP_BUILD_VERSION || root.APP_BUILD_VERSION, 'build') || 'flux-image-gen',
      credential_status: 'unsupported',
      credential_claim_status: normalizeClaimStatus(source.credentialStatus),
      transform: transform,
      original_input_image_hashes: originalHashes,
      input_hash_scope: 'provider_input',
      receipt_hash: ''
    };
    return validationMatchesInput(credentialVerification, source.image).then(function (validationIsForImage) {
      if (validationIsForImage && isCredentialStatus(credentialVerification.status)) {
        baseReceipt.credential_status = operation === 'edit' && credentialVerification.status === 'unsupported'
          ? 'unknown_after_transform'
          : credentialVerification.status;
      } else if (operation === 'edit') {
        baseReceipt.credential_status = 'unknown_after_transform';
      }
      return Promise.all([
        digestBytesDetailed(utf8Bytes(prompt)),
        digestBytesDetailed(utf8Bytes(userPrompt)),
        hashDataUrlDetailed(source.image)
      ]).then(function (results) {
        var promptResult = results[0];
        var userPromptResult = results[1];
        var outputResult = results[2];
        var receipt;
        baseReceipt.prompt_sha256 = normalizeHash(promptResult.hash) || normalizeHash(source.promptSha256);
        baseReceipt.user_prompt_sha256 = normalizeHash(userPromptResult.hash) || normalizeHash(source.userPromptSha256);
        baseReceipt.output_sha256 = normalizeHash(outputResult.hash) || normalizeHash(source.outputSha256);
        // Normalize once to establish the immutable canonical payload. Later
        // reload/import paths must hash this same shape, including its claim
        // status, while current-image validation remains a separate result.
        receipt = normalizeReceipt(baseReceipt);
        return digestBytesDetailed(utf8Bytes(JSON.stringify(withoutReceiptHash(receipt)))).then(function (receiptResult) {
          receipt.receipt_hash = normalizeHash(receiptResult.hash);
          return receipt;
        });
      });
    });
  }

  function c2paBlobFromInput(input) {
    var parsed;
    var BlobCtor = root.Blob;
    if (!BlobCtor) { return Promise.resolve({ blob: null, reason: 'blob_unavailable' }); }
    if (input && typeof input.arrayBuffer === 'function') {
      return Promise.resolve(input).then(function (blob) {
        return { blob: blob, input: input, reason: '' };
      });
    }
    if (typeof input !== 'string') { return Promise.resolve({ blob: null, input: input, reason: 'unsupported_input' }); }
    parsed = dataUrlBytes(input);
    if (!parsed) {
      return Promise.resolve({ blob: null, input: input, reason: /^https?:\/\//i.test(input) ? 'remote_url' : 'image_bytes_unavailable' });
    }
    try {
      return Promise.resolve({ blob: new BlobCtor([parsed.bytes], { type: parsed.mime }), input: input, reason: '' });
    } catch (error) {
      return Promise.resolve({ blob: null, input: input, reason: 'blob_unavailable' });
    }
  }

  function cloneSettings(value) {
    var source = value && typeof value === 'object' ? value : DEFAULT_C2PA_SETTINGS;
    var copy = {};
    var key;
    for (key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        copy[key] = source[key] && typeof source[key] === 'object' ? copyRecord(source[key]) : source[key];
      }
    }
    return copy;
  }

  function c2paConfig(settings) {
    var config = { wasmSrc: '/static/c2pa_bg.wasm', settings: cloneSettings(settings) };
    var location = root.location;
    var URLCtor = root.URL || (typeof URL === 'function' ? URL : null);
    if (location && location.href && URLCtor) {
      try {
        config.wasmSrc = new URLCtor('/static/c2pa_bg.wasm', location.href).toString();
        // c2pa-web requires an HTTPS module worker for strict CSP. On local
        // HTTP replay we intentionally omit workerSrc so the SDK's inline test
        // worker can run; production HTTPS receives the copied official worker.
        if (location.protocol === 'https:') {
          config.workerSrc = new URLCtor('/static/c2pa-worker.js', location.href);
        }
      } catch (error) {
        // Keep the relative WASM path for a minimal non-DOM test context.
      }
    }
    return config;
  }

  function getC2pa(settings) {
    var helper = root.FluxC2paWeb;
    var key;
    if (!helper || typeof helper.createC2pa !== 'function') {
      return Promise.reject(new Error('C2PA SDK unavailable'));
    }
    key = settings ? JSON.stringify(settings) : 'default';
    if (!c2paPromises[key]) {
      try {
        c2paPromises[key] = Promise.resolve(helper.createC2pa(c2paConfig(settings || DEFAULT_C2PA_SETTINGS)));
      } catch (error) {
        c2paPromises[key] = Promise.reject(error);
      }
    }
    return c2paPromises[key];
  }

  function hasValidationFailure(store) {
    var statuses = store && Array.isArray(store.validation_status) ? store.validation_status : [];
    var results = store && store.validation_results;
    var active = results && results.activeManifest;
    var i;
    if (store && store.validation_state === 'Invalid') { return true; }
    if (active && Array.isArray(active.failure) && active.failure.length) { return true; }
    for (i = 0; i < statuses.length; i += 1) {
      if (statuses[i] && statuses[i].success === false) { return true; }
    }
    return false;
  }

  function credentialStatusFromStore(store, settings) {
    var statuses = store && Array.isArray(store.validation_status) ? store.validation_status : [];
    var results = store && store.validation_results;
    var active = results && results.activeManifest;
    var successes = active && Array.isArray(active.success) ? active.success : [];
    var failures = active && Array.isArray(active.failure) ? active.failure : [];
    var trustRequested = !!(settings && settings.verify && settings.verify.verifyTrust === true);
    var trusted = false;
    var invalid = false;
    var i;
    var code;
    var url;
    if (!store) { return 'absent'; }
    // C2PA assets may carry a separate CAWG identity assertion. The official
    // test fixture intentionally leaves that assertion untrusted while its
    // primary c2pa.signature is trusted. Only the primary signed manifest may
    // mint our verified badge; a CAWG-only untrusted status remains metadata
    // context and does not downgrade the trusted C2PA signature.
    for (i = 0; i < successes.length; i += 1) {
      code = toText(successes[i] && successes[i].code);
      url = toText(successes[i] && successes[i].url);
      if (code === 'signingCredential.trusted' && /c2pa\.signature(?:$|[?#])/.test(url)) {
        trusted = true;
      }
    }
    for (i = 0; i < failures.length; i += 1) {
      code = toText(failures[i] && failures[i].code);
      url = toText(failures[i] && failures[i].url);
      if (code === 'signingCredential.untrusted' && /c2pa\.signature(?:$|[?#])/.test(url)) {
        trusted = false;
      }
      if (code !== 'signingCredential.untrusted' || /c2pa\.signature(?:$|[?#])/.test(url)) {
        invalid = invalid || code !== 'signingCredential.untrusted';
      }
    }
    for (i = 0; i < statuses.length; i += 1) {
      code = toText(statuses[i] && statuses[i].code);
      url = toText(statuses[i] && statuses[i].url);
      if (code === 'signingCredential.untrusted' && /c2pa\.signature(?:$|[?#])/.test(url)) {
        trusted = false;
      }
      if (code && code !== 'signingCredential.untrusted') { invalid = true; }
    }
    if (store.validation_state === 'Invalid' || invalid) { return 'invalid'; }
    if (trustRequested && trusted) { return 'verified'; }
    return 'present_untrusted';
  }

  function classifyC2paError(error) {
    var message = toText(error && error.message ? error.message : error);
    if (/UnknownAlgorithm|C2pa\(|signature|hash|manifest|malformed|invalid/i.test(message)) { return 'invalid'; }
    if (/Unsupported format|AssetTooLarge/i.test(message)) { return 'unsupported'; }
    return 'unsupported';
  }

  // `settings` is intentionally an internal test hook. Production callers
  // use the default no-trust-anchor settings; fixture tests can pass official
  // test anchors to prove trusted/untrusted mapping without shipping them as
  // application trust.
  function inspectCredential(input, options) {
    var settings = options && options.settings ? options.settings : DEFAULT_C2PA_SETTINGS;
    var requested = !!(settings && settings.verify && settings.verify.verifyTrust === true);
    return c2paBlobFromInput(input).then(function (prepared) {
      if (!prepared.blob) {
        return rememberValidation({ status: 'unsupported', reason: prepared.reason }, prepared.input, null, '');
      }
      return hashBlobDetailed(prepared.blob).then(function (inputHash) {
        var exactInputHash = inputHash.available ? inputHash.hash : '';
        var remember = function (result) {
          return rememberValidation(result, prepared.input, prepared.blob, exactInputHash);
        };
        return getC2pa(settings).then(function (sdk) {
          var reader;
          return Promise.resolve().then(function () {
            return sdk.reader.fromBlob(prepared.blob.type || 'application/octet-stream', prepared.blob);
          }).then(function (createdReader) {
            reader = createdReader;
            if (!reader) { return remember({ status: 'absent', reason: 'no_manifest' }); }
            return reader.manifestStore().then(function (store) {
              var status = credentialStatusFromStore(store, settings);
              var result = {
                status: status,
                reason: status === 'verified' ? 'trusted_c2pa_manifest' : 'c2pa_manifest',
                validation_state: toText(store && store.validation_state),
                trust_requested: requested
              };
              return Promise.resolve(reader.free && reader.free()).then(function () {
                return remember(result);
              });
            });
          }).catch(function (error) {
            if (reader && typeof reader.free === 'function') {
              return Promise.resolve(reader.free()).catch(function () {}).then(function () {
                return remember({ status: classifyC2paError(error), reason: 'c2pa_reader_error' });
              });
            }
            return remember({ status: classifyC2paError(error), reason: 'c2pa_reader_error' });
          });
        }).catch(function (error) {
          return remember({ status: 'unsupported', reason: /SDK unavailable/i.test(toText(error && error.message)) ? 'sdk_unavailable' : 'c2pa_runtime_unavailable' });
        });
      });
    });
  }

  function attachRecord(record, parentRecord) {
    var source = copyRecord(record);
    var existing = normalizeReceipt(source.provenanceReceipt);
    if (existing && existing.record_id === sanitizeMetadataValue(source.id, 'id')) {
      source.provenanceReceipt = existing;
      return Promise.resolve(source);
    }
    // The validator is best-effort for history writes, but it is the only
    // source allowed to mint `verified`. Runtime failures become an explicit
    // unsupported/unknown status in the receipt.
    return inspectCredential(source.image).then(function (validation) {
      return buildReceipt(source, parentRecord, validation).then(function (receipt) {
        source.provenanceReceipt = receipt;
        return source;
      });
    }, function () {
      return buildReceipt(source, parentRecord).then(function (receipt) {
        source.provenanceReceipt = receipt;
        return source;
      });
    });
  }

  function verifyRecord(record) {
    var source = record || {};
    var receipt = normalizeReceipt(source.provenanceReceipt);
    var outputHashPromise;
    var receiptHashPromise;
    var credentialPromise;
    if (!receipt) {
      return inspectCredential(source.image).then(function (credential) {
        return { status: 'absent', credential_status: credential.status, receipt_hash_valid: false, output_hash_valid: false, credential_verification: credential };
      }, function () {
        return { status: 'absent', credential_status: 'unsupported', receipt_hash_valid: false, output_hash_valid: false };
      });
    }
    outputHashPromise = hashDataUrlDetailed(source.image);
    receiptHashPromise = receipt.receipt_hash
      ? digestBytesDetailed(utf8Bytes(JSON.stringify(withoutReceiptHash(receipt))))
      : Promise.resolve({ available: false, hash: '', reason: 'receipt_hash_absent' });
    credentialPromise = inspectCredential(source.image).catch(function () {
      return { status: 'unsupported', reason: 'c2pa_runtime_unavailable' };
    });
    return Promise.all([outputHashPromise, receiptHashPromise, credentialPromise]).then(function (results) {
      var output = results[0];
      var receiptHash = results[1];
      var credential = results[2];
      var actualOutput = normalizeHash(output.hash);
      var receiptHashValid = receipt.receipt_hash
        ? (receiptHash.available ? receiptHash.hash === receipt.receipt_hash : null)
        : null;
      var outputHashValid = receipt.output_sha256
        ? (output.available ? actualOutput === receipt.output_sha256 : null)
        : null;
      var status = 'unavailable';
      var unavailableReason = output.reason || receiptHash.reason || '';
      if (receiptHashValid === false || outputHashValid === false) {
        status = 'modified';
      } else if (output.reason === 'crypto_unavailable' || receiptHash.reason === 'crypto_unavailable') {
        status = 'unknown';
      } else if (receiptHashValid === true && outputHashValid === true) {
        status = 'valid';
      }
      return {
        status: status,
        credential_status: credential && isCredentialStatus(credential.status) ? credential.status : 'unsupported',
        credential_verification: credential,
        receipt_hash_valid: receiptHashValid,
        output_hash_valid: outputHashValid,
        output_sha256: actualOutput,
        unavailable_reason: status === 'unavailable' || status === 'unknown' ? unavailableReason : ''
      };
    });
  }

  root.ProvenanceReceipt = {
    SCHEMA: RECEIPT_SCHEMA,
    SCHEMA_VERSION: RECEIPT_SCHEMA_VERSION,
    CREDENTIAL_STATUSES: CREDENTIAL_STATUSES,
    PROMPT_HASH_MODE: C2PA_PROMPT_HASH_MODE,
    normalizeHash: normalizeHash,
    sanitizeMetadataValue: sanitizeMetadataValue,
    normalizeReceipt: normalizeReceipt,
    hashText: hashText,
    hashDataUrl: hashDataUrl,
    hashBlob: hashBlob,
    hashBlobs: hashBlobs,
    buildReceipt: buildReceipt,
    attachRecord: attachRecord,
    inspectCredential: inspectCredential,
    verifyRecord: verifyRecord
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
