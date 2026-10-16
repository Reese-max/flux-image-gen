// Local, unsigned audit receipts. A matching hash never proves authorship or truth.
(function (root) {
  'use strict';
  var STATUSES = ['verified', 'present_untrusted', 'invalid', 'absent', 'unknown_after_transform', 'unsupported'];
  var HASH = /^[a-f0-9]{64}$/;
  var APP_VERSION = 'Fluxi/1.4-provenance.1';

  function identifier(value) {
    var text = typeof value === 'string' ? value : '';
    return /^[a-z0-9@_. /-]{1,160}$/i.test(text) && !/https?:|token|secret|api.?key/i.test(text) && redactText(text) === text ? text : '';
  }
  function digest(value) { return HASH.test(value) ? value : ''; }
  function number(value) { return typeof value === 'number' && isFinite(value) ? value : null; }
  function status(value) { return STATUSES.indexOf(value) >= 0 ? value : 'unsupported'; }
  function redactText(value) {
    return String(value || '').replace(/https?:\/\/[^\s<>"']*[?][^\s<>"']*/gi, '[redacted-url]')
      .replace(/\b(?:api[_ -]?key|(?:turnstile|delete|access|refresh)?[_ -]?token|authorization|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
      .replace(/\b(?:sk-(?:proj-)?|nvapi-|ghp_|github_pat_|hf_)[a-z0-9_-]{20,}\b/gi, '[redacted]');
  }
  function canonical(value) {
    if (Array.isArray(value)) { return '[' + value.map(canonical).join(',') + ']'; }
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + canonical(value[key]); }).join(',') + '}';
    }
    return JSON.stringify(value);
  }
  function sha256(value) {
    var bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return Promise.resolve(bytes && typeof bytes.arrayBuffer === 'function' ? bytes.arrayBuffer() : bytes).then(function (data) {
      return root.crypto.subtle.digest('SHA-256', data);
    }).then(function (hash) {
      return Array.prototype.map.call(new Uint8Array(hash), function (n) { return ('0' + n.toString(16)).slice(-2); }).join('');
    });
  }
  function imageBlob(image) {
    // Do not resolve provider URLs: signed URLs and remote verifiers are not receipt data.
    if (image && typeof image.arrayBuffer === 'function') { return image; }
    var match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(String(image || ''));
    if (!match || match[2].length > 32 * 1024 * 1024) { throw new Error('需要本機原始圖片 bytes 才能驗證來源'); }
    var binary = atob(match[2]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
    return new Blob([bytes], { type: match[1] });
  }
  function resolveOutputImage(image) {
    if (!/^https:\/\//i.test(image)) { return Promise.resolve(image); }
    // Browser CORS fetch only: no server URL proxy, cookies, referrer or redirects.
    var url = new URL(image);
    if (url.username || url.password) { return Promise.reject(new Error('Unsupported image URL')); }
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    var chunks = [];
    var size = 0;
    return root.fetch(image, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal }).then(function (response) {
      var type = (response.headers.get('content-type') || '').split(';')[0];
      if (!response.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type) || Number(response.headers.get('content-length')) > 24 * 1024 * 1024) {
        throw new Error('Unsupported image response');
      }
      var reader = response.body.getReader();
      function read() {
        return reader.read().then(function (part) {
          if (part.done) { return new Blob(chunks, { type: type }).arrayBuffer(); }
          size += part.value.length;
          if (size > 24 * 1024 * 1024) { reader.cancel(); throw new Error('Image too large'); }
          chunks.push(part.value);
          return read();
        });
      }
      return read().then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        for (var i = 0; i < bytes.length; i += 32768) { binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); }
        return 'data:' + type + ';base64,' + btoa(binary);
      });
    }).then(function (result) { clearTimeout(timer); return result; }, function () {
      clearTimeout(timer); throw new Error('Original image bytes unavailable');
    });
  }
  function credential(value) {
    var source = value || {};
    var codes = Array.isArray(source.codes) ? source.codes.filter(function (code) { return /^[a-z][a-z0-9.]{0,100}$/i.test(code); }).slice(0, 32) : [];
    var result = status(source.status);
    if (codes.some(function (code) { return /\.(mismatch|invalid|malformed|revoked)$/.test(code); })) { result = 'invalid'; }
    return { status: result, codes: codes };
  }
  function inspectCredentials(blob, options) {
    var opts = options || {};
    var timer;
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve({ status: 'unsupported', codes: [] }); }, Math.min(15000, opts.timeoutMs || 15000));
    });
    var inspection = Promise.resolve().then(function () {
      if (opts.inspect) {
        return opts.inspect(blob);
      } else if (root.C2paInspector) {
        return root.C2paInspector.inspect(blob);
      }
      // Without a validator, even apparent absence must not be asserted.
      return { status: 'unsupported', codes: [] };
    });
    return Promise.race([inspection, timeout]).then(credential).catch(function () {
      return { status: 'unsupported', codes: [] };
    }).then(function (result) {
      clearTimeout(timer);
      if (opts.transformed && result.status === 'absent') { result.status = 'unknown_after_transform'; }
      return result;
    });
  }
  function normalizeInputs(inputs) {
    return (Array.isArray(inputs) ? inputs : []).slice(0, 4).map(function (input) {
      var transformed = input.transform === 'resize_reencode';
      return {
        original_sha256: digest(input.original_sha256), submitted_sha256: digest(input.submitted_sha256),
        original_credential_status: status(input.original_credential_status || input.credential_status),
        credential_status: transformed ? 'unknown_after_transform' : status(input.credential_status),
        transform: transformed ? 'resize_reencode' : 'none'
      };
    }).filter(function (input) { return input.original_sha256 && input.submitted_sha256; });
  }
  function normalizeReceipt(source) {
    if (!source || source.receipt_schema_version !== 1) { return null; }
    var settings = source.settings || {};
    return {
      receipt_schema_version: 1,
      record_id: identifier(source.record_id),
      source_record_ids: (Array.isArray(source.source_record_ids) ? source.source_record_ids : []).map(identifier).filter(Boolean).slice(0, 4),
      inputs: normalizeInputs(source.inputs),
      provider: identifier(source.provider), model: identifier(source.model),
      settings: { seed: number(settings.seed), size: identifier(settings.size), width: number(settings.width) || 0,
        height: number(settings.height) || 0, steps: number(settings.steps), cfg: number(settings.cfg),
        mode: ['generate', 'edit', 'regenerate'].indexOf(settings.mode) >= 0 ? settings.mode : 'generate' },
      prompt_sha256: digest(source.prompt_sha256), provider_prompt_sha256: digest(source.provider_prompt_sha256),
      created_at: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(source.created_at) ? source.created_at : '',
      output_sha256: digest(source.output_sha256), parent_receipt_sha256: digest(source.parent_receipt_sha256),
      version_group_id: identifier(source.version_group_id), version_number: number(source.version_number),
      app_version: identifier(source.app_version), build_version: identifier(source.build_version),
      provider_provenance: { model_revision: identifier(source.provider_provenance && source.provider_provenance.model_revision) },
      credential: credential(source.credential), receipt_sha256: digest(source.receipt_sha256)
    };
  }
  function receiptHash(receipt) {
    var content = normalizeReceipt(receipt);
    delete content.receipt_sha256;
    return sha256(canonical(content));
  }
  function pendingReceipt(record, options) {
    var opts = options || {};
    var parent = opts.parent;
    var inputs = normalizeInputs(opts.inputs);
    var operation = opts.operation || (record.sourceRecordId ? 'regenerate' : 'generate');
    var effective = record.providerProvenance || {};
    var health = root.ImageGenApp && root.ImageGenApp.getProviderHealth ? root.ImageGenApp.getProviderHealth() : {};
    return normalizeReceipt({
      receipt_schema_version: 1, record_id: record.id,
      source_record_ids: opts.sourceRecordIds || (record.sourceRecordId ? [record.sourceRecordId] : []), inputs: inputs,
      provider: record.provider, model: effective.model_id || record.model,
      settings: { seed: record.seed, size: record.size, width: record.width, height: record.height,
        steps: Object.prototype.hasOwnProperty.call(effective, 'steps') ? effective.steps : record.steps,
        cfg: Object.prototype.hasOwnProperty.call(effective, 'cfg_scale') ? effective.cfg_scale : record.cfgScale, mode: operation },
      created_at: record.createdAt,
      parent_receipt_sha256: parent && parent.provenance && parent.provenance.receipt_sha256,
      version_group_id: record.versionGroupId || record.id, version_number: record.versionNumber || 1,
        app_version: APP_VERSION, build_version: opts.buildVersion || (health && (health.versionId || health.versionTag)),
        provider_provenance: record.providerProvenance
    });
  }
  function createReceipt(record, options) {
    var opts = options || {};
    var receipt = pendingReceipt(record, opts);
    var blob;
    try { blob = imageBlob(record.image); } catch (error) { blob = null; }
    return Promise.all([blob ? inspectCredentials(blob, { inspect: opts.inspect, transformed: receipt.settings.mode === 'edit' }) : { status: 'unsupported', codes: [] },
      sha256(record.userPrompt || record.prompt || ''), sha256(record.providerPrompt || record.prompt || ''), blob ? sha256(blob) : ''
    ]).then(function (values) {
      receipt.credential = values[0]; receipt.prompt_sha256 = values[1]; receipt.provider_prompt_sha256 = values[2]; receipt.output_sha256 = values[3];
      return receiptHash(receipt).then(function (hash) { receipt.receipt_sha256 = hash; return receipt; });
    });
  }
  function verifyReceipt(record) {
    var receipt = normalizeReceipt(record && record.provenance);
    if (!receipt || !receipt.output_sha256 || !receipt.receipt_sha256) { return Promise.resolve({ status: 'unavailable', credential_status: 'unsupported' }); }
    return Promise.resolve().then(function () {
      var blob = imageBlob(record.image);
      return Promise.all([receiptHash(receipt), sha256(blob), inspectCredentials(blob, { transformed: receipt.settings.mode === 'edit' })]);
    }).then(function (hashes) {
      var valid = receipt.record_id === record.id && receipt.receipt_sha256 === hashes[0] && receipt.output_sha256 === hashes[1];
      return { status: valid ? 'hash_verified' : 'modified', credential_status: valid ? hashes[2].status : 'invalid' };
    }).catch(function () { return { status: 'unavailable', credential_status: 'unsupported' }; });
  }
  function exportArtwork(record, options) {
    var result = {};
    ['id', 'schemaVersion', 'provider', 'model', 'size', 'seed', 'width', 'height', 'steps', 'cfgScale',
      'sourceRecordId', 'versionGroupId', 'versionNumber', 'createdAt'].forEach(function (key) {
      var value = record[key];
      if (typeof value === 'number' || (key === 'createdAt' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) || identifier(value)) { result[key] = value; }
    });
    if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(record.image)) { result.image = record.image; }
    result.prompt = options && options.promptPublic === true ? redactText(record.prompt) : '[private]';
    if (options && options.promptPublic === true) { result.providerPrompt = redactText(record.providerPrompt); }
    result.provenance = normalizeReceipt(record.provenance);
    return result;
  }
  function publicProvenance(raw, bytes) {
    var receipt = normalizeReceipt(raw);
    if (!receipt) { return Promise.reject(new Error('Invalid provenance receipt')); }
    return Promise.all([receiptHash(receipt), sha256(bytes)]).then(function (hashes) {
      if (receipt.receipt_sha256 !== hashes[0] || receipt.output_sha256 !== hashes[1]) { throw new Error('Provenance receipt/output hash mismatch'); }
      return {
      receipt_schema_version: receipt.receipt_schema_version, record_id: receipt.record_id,
      provider: receipt.provider, model: receipt.model, output_sha256: receipt.output_sha256,
      receipt_sha256: receipt.receipt_sha256,
      // A browser's claimed issuer trust is not server-side C2PA verification.
      credential_status: receipt.credential.status === 'verified' ? 'present_untrusted' : receipt.credential.status,
      version_group_id: receipt.version_group_id, version_number: receipt.version_number,
      source_record_ids: receipt.source_record_ids, parent_receipt_sha256: receipt.parent_receipt_sha256,
      created_at: receipt.created_at, app_version: receipt.app_version, build_version: receipt.build_version
      };
    });
  }
  root.ImageProvenance = { sha256: sha256, imageBlob: imageBlob, normalizeReceipt: normalizeReceipt,
    createReceipt: createReceipt, pendingReceipt: pendingReceipt, resolveOutputImage: resolveOutputImage, verifyReceipt: verifyReceipt, inspectCredentials: inspectCredentials,
    exportArtwork: exportArtwork, publicProvenance: publicProvenance, redactText: redactText };
})(typeof globalThis !== 'undefined' ? globalThis : this);
