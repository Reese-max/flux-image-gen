// 來源收據（Provenance Receipt）＋ Content Credentials 檢測。
// ES5 相容（同 history-store.js），不依賴 crypto.subtle（保持同步 API）。
// 設計原則（issue #18）：
//  - 每個新 generation/edit record 產生 versioned receipt：output SHA-256、
//    provider/model/settings、createdAt、app/build version、lineage。
//  - credential 狀態誠實標示：verified / present_untrusted / invalid /
//    absent / unknown_after_transform / unsupported；本層只做結構檢測，
//    沒有 signer/trust-list 時絕不宣稱 verified。
//  - 公開/分享視圖走 allowlist，prompt 全文與任何 token/secret 永不輸出。
(function (root) {
  'use strict';

  var RECEIPT_SCHEMA_VERSION = 1;
  var APP_VERSION_FALLBACK = 'v1.4.0';
  var EDIT_INPUT_TRANSFORM = 'canvas-resize-png';

  var CREDENTIAL_STATUS = {
    VERIFIED: 'verified',
    PRESENT_UNTRUSTED: 'present_untrusted',
    INVALID: 'invalid',
    ABSENT: 'absent',
    UNKNOWN_AFTER_TRANSFORM: 'unknown_after_transform',
    UNSUPPORTED: 'unsupported'
  };
  var CREDENTIAL_STATUSES = {};
  (function () {
    var key;
    for (key in CREDENTIAL_STATUS) {
      if (CREDENTIAL_STATUS.hasOwnProperty(key)) { CREDENTIAL_STATUSES[CREDENTIAL_STATUS[key]] = true; }
    }
  })();
  var OUTPUT_HASH_STATUSES = { sha256: true, remote_url: true, unavailable: true };
  var RECEIPT_ACTIONS = { generate: true, edit: true, regenerate: true };

  // 公開 receipt 欄位 allowlist：promptHash、inputs、providerFields 一律不輸出。
  var PUBLIC_RECEIPT_FIELDS = [
    'schemaVersion', 'receiptHash', 'recordId', 'action', 'createdAt', 'appVersion',
    'provider', 'model', 'providerModelRevision', 'seed', 'size', 'steps', 'cfgScale',
    'mode', 'outputSha256', 'outputHashStatus', 'sourceRecordIds', 'parentReceiptHash',
    'versionGroupId', 'versionNumber', 'credentialStatus', 'credentialSignals',
    'credentialFormat', 'transforms'
  ];

  // 伺服器端 provenance block 的 allowlist（allowlist 而非 denylist，secret 進不來）。
  var SERVER_FIELD_ALLOWLIST = {
    outputSha256: true, credentialStatus: true, credentialSignals: true, format: true,
    inspection: true, inputImageHashes: true, model: true, provider: true,
    claimGenerator: true, digitalSourceType: true
  };

  var CREDENTIAL_STATUS_LABELS = {
    verified: '已驗證 Content Credentials 簽章',
    present_untrusted: '偵測到 Content Credentials（結構有效，未驗證簽章信任鏈）',
    invalid: '偵測到 credential 資料，但內容無效或已損毀',
    absent: '未偵測到 Content Credentials（不代表非 AI 產生）',
    unknown_after_transform: '輸出經過轉換／重新編碼，credential 狀態無法判定',
    unsupported: '圖片格式不支援 credential 檢測'
  };

  var C2PA_MARKERS = ['urn:c2pa', 'c2pa-manifest', 'c2pa.signature', 'c2pa.claim', 'caBX'];
  var AI_XMP_MARKERS = [
    'trainedAlgorithmicMedia',
    'compositeWithTrainedAlgorithmicMedia',
    'algorithmicallyEnhanced',
    'digitalSourceType'
  ];
  var XMP_HEADER = 'http://ns.adobe.com/xap/1.0/';

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  // ---- UTF-8 / SHA-256 -----------------------------------------------------

  function utf8Bytes(text) {
    var out = [];
    var i;
    var c;
    var c2;
    var str = String(text);
    for (i = 0; i < str.length; i += 1) {
      c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdfff) {
        c2 = 0;
        if (c <= 0xdbff && i + 1 < str.length) {
          c2 = str.charCodeAt(i + 1);
        }
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          i += 1;
          out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
          // Lone surrogate — Python str.encode() raises; emit U+FFFD so both
          // runtimes produce the same (defined) bytes.
          out.push(0xef, 0xbf, 0xbd);
        }
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  // bytes: Array-like (Uint8Array / Array) of 0..255
  function sha256Bytes(bytes) {
    var bitLen = bytes.length * 8;
    var hiLen = Math.floor(bitLen / 0x100000000);
    var total = bytes.length + 1 + 8;
    while (total % 64 !== 0) { total += 1; }
    var m = new Uint8Array(total);
    m.set(bytes);
    m[bytes.length] = 0x80;
    var t = total - 8;
    m[t] = (hiLen >>> 24) & 0xff; m[t + 1] = (hiLen >>> 16) & 0xff;
    m[t + 2] = (hiLen >>> 8) & 0xff; m[t + 3] = hiLen & 0xff;
    m[t + 4] = (bitLen >>> 24) & 0xff; m[t + 5] = (bitLen >>> 16) & 0xff;
    m[t + 6] = (bitLen >>> 8) & 0xff; m[t + 7] = bitLen & 0xff;

    var hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    var block;
    var i;
    var j;
    var s0;
    var s1;
    var a;
    var b;
    var c;
    var d;
    var e;
    var f;
    var g;
    var h;
    var t1;
    var t2;
    var ch;
    var maj;
    for (block = 0; block < total; block += 64) {
      for (i = 0; i < 16; i += 1) {
        j = block + i * 4;
        w[i] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3];
      }
      for (i = 16; i < 64; i += 1) {
        s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      a = hash[0]; b = hash[1]; c = hash[2]; d = hash[3];
      e = hash[4]; f = hash[5]; g = hash[6]; h = hash[7];
      for (i = 0; i < 64; i += 1) {
        s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        ch = (e & f) ^ (~e & g);
        t1 = (h + s1 + ch + SHA256_K[i] + w[i]) | 0;
        s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        maj = (a & b) ^ (a & c) ^ (b & c);
        t2 = (s0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      hash[0] = (hash[0] + a) | 0; hash[1] = (hash[1] + b) | 0;
      hash[2] = (hash[2] + c) | 0; hash[3] = (hash[3] + d) | 0;
      hash[4] = (hash[4] + e) | 0; hash[5] = (hash[5] + f) | 0;
      hash[6] = (hash[6] + g) | 0; hash[7] = (hash[7] + h) | 0;
    }
    var out = '';
    var hex = '0123456789abcdef';
    for (i = 0; i < 8; i += 1) {
      for (j = 28; j >= 0; j -= 4) {
        out += hex.charAt((hash[i] >>> j) & 0xf);
      }
    }
    return out;
  }

  function sha256Text(text) {
    return sha256Bytes(utf8Bytes(text));
  }

  // ---- byte helpers ---------------------------------------------------------

  function dataUrlBytes(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.slice(0, 5) !== 'data:') { return null; }
    var comma = dataUrl.indexOf(',');
    if (comma === -1) { return null; }
    var head = dataUrl.slice(5, comma);
    var mime = head.split(';')[0] || 'application/octet-stream';
    var payload = dataUrl.slice(comma + 1);
    var bin;
    if (head.indexOf(';base64') !== -1) {
      if (typeof atob !== 'function') { return null; }
      try { bin = atob(payload); } catch (error) { return null; }
    } else {
      try { bin = unescape(payload); } catch (error2) { return null; }
    }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) { bytes[i] = bin.charCodeAt(i) & 0xff; }
    return { mime: mime, bytes: bytes };
  }

  function bytesToStr(u8, start, end) {
    var out = '';
    var i;
    var limit = Math.min(end || u8.length, u8.length);
    for (i = start || 0; i < limit; i += 1) {
      out += String.fromCharCode(u8[i]);
    }
    return out;
  }

  function bytesContain(u8, needle, start) {
    var first = needle.charCodeAt(0);
    var i;
    var j;
    var n = needle.length;
    for (i = start || 0; i + n <= u8.length; i += 1) {
      if (u8[i] === first) {
        for (j = 1; j < n; j += 1) {
          if (u8[i + j] !== needle.charCodeAt(j)) { break; }
        }
        if (j === n) { return true; }
      }
    }
    return false;
  }

  function hasAnyMarker(u8, markers) {
    for (var i = 0; i < markers.length; i += 1) {
      if (bytesContain(u8, markers[i], 0)) { return true; }
    }
    return false;
  }

  function readU32BE(u8, pos) {
    return (u8[pos] * 0x1000000) + ((u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]);
  }

  function readU32LE(u8, pos) {
    return ((u8[pos + 3] * 0x1000000) + ((u8[pos + 2] << 16) | (u8[pos + 1] << 8) | u8[pos])) >>> 0;
  }

  function sniffImageFormat(u8) {
    if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47
        && u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a) {
      return 'png';
    }
    if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8) { return 'jpeg'; }
    if (u8.length >= 12 && bytesToStr(u8, 0, 4) === 'RIFF' && bytesToStr(u8, 8, 12) === 'WEBP') {
      return 'webp';
    }
    if (u8.length >= 6 && bytesToStr(u8, 0, 3) === 'GIF'
        && (bytesToStr(u8, 3, 6) === '87a' || bytesToStr(u8, 3, 6) === '89a')) {
      return 'gif';
    }
    return '';
  }

  function isTextChunkTag(tag) {
    return tag === 'iTXt' || tag === 'tEXt' || tag === 'zTXt';
  }

  function scanPng(u8) {
    var signals = [];
    var sawIend = false;
    var pos = 8;
    var len;
    var tag;
    var end;
    var payload;
    while (pos + 8 <= u8.length) {
      len = readU32BE(u8, pos);
      tag = bytesToStr(u8, pos + 4, pos + 8);
      end = pos + 8 + len + 4;
      if (end > u8.length) {
        if (tag === 'caBX') { signals.push('c2pa-manifest'); }
        else if (isTextChunkTag(tag) && hasAnyMarker(u8.subarray(pos), C2PA_MARKERS)) { signals.push('xmp-provenance'); }
        return { signals: signals, ok: false };
      }
      payload = u8.subarray(pos + 8, pos + 8 + len);
      if (tag === 'caBX') {
        signals.push('c2pa-manifest');
      } else if (isTextChunkTag(tag)
          && (hasAnyMarker(payload, C2PA_MARKERS)
            || (bytesContain(payload, XMP_HEADER, 0) && hasAnyMarker(payload, AI_XMP_MARKERS)))) {
        signals.push('xmp-provenance');
      }
      pos = end;
      if (tag === 'IEND') { sawIend = true; break; }
    }
    if (!sawIend && pos < u8.length) {
      if (hasAnyMarker(u8.subarray(pos), C2PA_MARKERS)) { signals.push('c2pa-manifest'); }
      return { signals: signals, ok: false };
    }
    return { signals: signals, ok: sawIend || pos === u8.length };
  }

  function scanJpeg(u8) {
    var signals = [];
    var pos = 2;
    var marker;
    var segLen;
    var payload;
    while (pos + 4 <= u8.length) {
      if (u8[pos] !== 0xff) { pos += 1; continue; }
      marker = u8[pos + 1];
      if (marker === 0xda) { break; }
      // 0xFF fill bytes before a marker and standalone TEM/SOI/EOI/RSTn carry
      // no length field — skip 2 bytes rather than misreading a size.
      if (marker === 0xff || marker === 0x01 || marker === 0xd8 || marker === 0xd9
          || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      segLen = (u8[pos + 2] << 8) | u8[pos + 3];
      if (segLen < 2 || pos + 2 + segLen > u8.length) {
        return { signals: signals, ok: false };
      }
      payload = u8.subarray(pos + 4, pos + 2 + segLen);
      if (marker === 0xeb && bytesContain(payload, 'JP', 0) && hasAnyMarker(payload, C2PA_MARKERS)) {
        signals.push('c2pa-manifest');
      } else if (marker === 0xe1
          && ((bytesContain(payload, XMP_HEADER, 0)
              && (hasAnyMarker(payload, AI_XMP_MARKERS) || hasAnyMarker(payload, C2PA_MARKERS)))
            || hasAnyMarker(payload, C2PA_MARKERS))) {
        signals.push('xmp-provenance');
      }
      pos += 2 + segLen;
    }
    if (pos + 4 > u8.length) { return { signals: signals, ok: false }; }
    return { signals: signals, ok: true };
  }

  function scanWebp(u8) {
    var signals = [];
    var pos = 12;
    var tag;
    var len;
    var end;
    var payload;
    while (pos + 8 <= u8.length) {
      tag = bytesToStr(u8, pos, pos + 4);
      len = readU32LE(u8, pos + 4);
      end = pos + 8 + len + (len & 1);
      if (end > u8.length) { return { signals: signals, ok: false }; }
      payload = u8.subarray(pos + 8, pos + 8 + len);
      if (tag === 'XMP ' && (hasAnyMarker(payload, AI_XMP_MARKERS) || hasAnyMarker(payload, C2PA_MARKERS))) {
        signals.push('xmp-provenance');
      }
      pos = end;
    }
    return { signals: signals, ok: true };
  }

  function scanGeneric(u8) {
    var signals = [];
    if (hasAnyMarker(u8, C2PA_MARKERS)) { signals.push('credential-bytes'); }
    if (bytesContain(u8, XMP_HEADER, 0) && (hasAnyMarker(u8, AI_XMP_MARKERS) || hasAnyMarker(u8, C2PA_MARKERS))) {
      signals.push('xmp-provenance');
    }
    return signals;
  }

  function credentialReport(status, format, signals, detail) {
    return { status: status, format: format, signals: signals, detail: detail };
  }

  // image: data URL 字串、Uint8Array/位元組陣列、或遠端 URL。
  function inspectCredential(image) {
    var decoded = null;
    var raw = null;
    if (image && typeof image.byteLength === 'number' && typeof image.length === 'number') {
      raw = image;
    } else if (typeof image === 'string') {
      decoded = dataUrlBytes(image);
      if (decoded) { raw = decoded.bytes; }
    }
    if (!raw) {
      return credentialReport(CREDENTIAL_STATUS.UNSUPPORTED, '', [], 'no-local-bytes');
    }
    var fmt = sniffImageFormat(raw);
    var scan;
    if (fmt === 'png') {
      scan = scanPng(raw);
    } else if (fmt === 'jpeg') {
      scan = scanJpeg(raw);
    } else if (fmt === 'webp') {
      scan = scanWebp(raw);
    } else if (fmt === 'gif') {
      scan = { signals: scanGeneric(raw), ok: true };
    } else {
      scan = { signals: scanGeneric(raw), ok: true };
      if (!scan.signals.length) {
        return credentialReport(CREDENTIAL_STATUS.UNSUPPORTED, '', [], 'unknown-format');
      }
      return credentialReport(CREDENTIAL_STATUS.PRESENT_UNTRUSTED, '', scan.signals, 'raw-marker-scan');
    }
    if (!scan.ok) {
      return credentialReport(CREDENTIAL_STATUS.INVALID, fmt, scan.signals, 'container-parse-failed');
    }
    if (scan.signals.length) {
      return credentialReport(CREDENTIAL_STATUS.PRESENT_UNTRUSTED, fmt, scan.signals, 'structural-only');
    }
    return credentialReport(CREDENTIAL_STATUS.ABSENT, fmt, [], 'no-credential-markers');
  }

  function hashImage(image) {
    var decoded;
    if (image && typeof image.byteLength === 'number' && typeof image.length === 'number') {
      return { sha256: sha256Bytes(image), status: 'sha256' };
    }
    decoded = dataUrlBytes(image);
    if (decoded) {
      return { sha256: sha256Bytes(decoded.bytes), status: 'sha256' };
    }
    if (typeof image === 'string'
        && (image.indexOf('http://') === 0 || image.indexOf('https://') === 0)) {
      return { sha256: '', status: 'remote_url' };
    }
    return { sha256: '', status: 'unavailable' };
  }

  // ---- normalization helpers -------------------------------------------------

  function cleanHex64(value) {
    var text = toText(value).toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : '';
  }

  function cleanStrList(value, limit, maxLen) {
    var out = [];
    var i;
    var text;
    if (!Array.isArray(value)) { return out; }
    for (i = 0; i < value.length; i += 1) {
      text = toText(value[i]).slice(0, maxLen || 120);
      if (text) { out.push(text); }
      if (out.length >= (limit || 16)) { break; }
    }
    return out;
  }

  function cleanHexList(value, limit) {
    var out = [];
    var i;
    var text;
    if (!Array.isArray(value)) { return out; }
    for (i = 0; i < value.length; i += 1) {
      text = cleanHex64(value[i]);
      if (text) { out.push(text); }
      if (out.length >= (limit || 16)) { break; }
    }
    return out;
  }

  function sanitizeProviderFields(raw) {
    var out = {};
    var key;
    var value;
    var cleaned;
    if (!raw || typeof raw !== 'object') { return out; }
    for (key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) { continue; }
      if (!SERVER_FIELD_ALLOWLIST[key]) { continue; }
      value = raw[key];
      if (key === 'outputSha256') {
        cleaned = cleanHex64(value);
        if (cleaned) { out[key] = cleaned; }
      } else if (key === 'credentialStatus') {
        if (CREDENTIAL_STATUSES[value]) { out[key] = value; }
      } else if (key === 'credentialSignals') {
        out[key] = cleanStrList(value);
      } else if (key === 'inputImageHashes') {
        out[key] = cleanHexList(value);
      } else {
        out[key] = toText(value).slice(0, 200);
      }
    }
    return out;
  }

  // ---- receipt ----------------------------------------------------------------

  function stableStringify(value) {
    var i;
    var keys;
    var parts;
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value === undefined ? null : value);
    }
    if (Array.isArray(value)) {
      parts = [];
      for (i = 0; i < value.length; i += 1) { parts.push(stableStringify(value[i])); }
      return '[' + parts.join(',') + ']';
    }
    keys = Object.keys(value).sort();
    parts = [];
    for (i = 0; i < keys.length; i += 1) {
      parts.push(JSON.stringify(keys[i]) + ':' + stableStringify(value[keys[i]]));
    }
    return '{' + parts.join(',') + '}';
  }

  function computeReceiptHash(receipt) {
    var body = {};
    var key;
    if (!receipt || typeof receipt !== 'object') { return ''; }
    for (key in receipt) {
      if (Object.prototype.hasOwnProperty.call(receipt, key) && key !== 'receiptHash') {
        body[key] = receipt[key];
      }
    }
    return sha256Text(stableStringify(body));
  }

  function verifyReceiptHash(receipt) {
    var stored = receipt && typeof receipt === 'object' ? cleanHex64(receipt.receiptHash) : '';
    if (!stored) { return false; }
    return computeReceiptHash(receipt) === stored;
  }

  function normalizeAction(source, action) {
    if (action && RECEIPT_ACTIONS[action]) { return action; }
    if (source) {
      if (toText(source.recordAction) === 'edit' || cleanHexList(source.editInputHashes).length) {
        return 'edit';
      }
      if (toText(source.sourceRecordId) || cleanStrList(source.sourceRecordIds).length) {
        return 'regenerate';
      }
    }
    return 'generate';
  }

  function resolveAppVersion(options) {
    var health = null;
    if (options && toText(options.appVersion)) { return toText(options.appVersion); }
    try {
      if (root.ImageGenApp && typeof root.ImageGenApp.getProviderHealth === 'function') {
        health = root.ImageGenApp.getProviderHealth();
      }
    } catch (error) {
      health = null;
    }
    if (health && toText(health.versionTag)) { return toText(health.versionTag); }
    return APP_VERSION_FALLBACK;
  }

  function buildInputEntry(digest, transform, status) {
    return {
      sha256: cleanHex64(digest),
      credentialStatus: CREDENTIAL_STATUSES[status] ? status : CREDENTIAL_STATUS.UNKNOWN_AFTER_TRANSFORM,
      transform: toText(transform) || EDIT_INPUT_TRANSFORM
    };
  }

  function buildReceipt(record, options) {
    var source = record && typeof record === 'object' ? record : {};
    var opts = options || {};
    var hashed = hashImage(source.image);
    var credential = inspectCredential(source.image);
    var parent = opts.parentReceipt && typeof opts.parentReceipt === 'object'
      ? normalizeReceipt(opts.parentReceipt)
      : null;
    var parentId = toText(source.sourceRecordId);
    var sourceIds = cleanStrList(source.sourceRecordIds);
    var inputHashes = cleanHexList(source.editInputHashes);
    var promptText = toText(source.userPrompt) || toText(source.prompt);
    var i;
    var inputs = [];
    var transforms = cleanStrList(opts.transforms || source.transforms, 8, 80);
    var action = normalizeAction(source, opts.action);
    var providerFields = { server: sanitizeProviderFields(opts.providerProvenance || source.providerProvenance) };

    if (!sourceIds.length && parentId) { sourceIds = [parentId]; }
    if (!inputHashes.length) { inputHashes = cleanHexList(source.inputImageHashes); }
    if (!inputHashes.length) { inputHashes = cleanHexList(opts.inputImageHashes); }
    for (i = 0; i < inputHashes.length; i += 1) {
      inputs.push(buildInputEntry(inputHashes[i], EDIT_INPUT_TRANSFORM, CREDENTIAL_STATUS.UNKNOWN_AFTER_TRANSFORM));
    }

    var receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      recordId: toText(source.id),
      action: action,
      createdAt: toText(source.createdAt) || toText(opts.now) || new Date().toISOString(),
      appVersion: resolveAppVersion(opts),
      provider: toText(source.provider),
      model: toText(source.model),
      providerModelRevision: toText(source.providerModelRevision),
      seed: isFiniteNumber(source.seed) ? Math.floor(source.seed) : 0,
      size: toText(source.size),
      steps: isFiniteNumber(source.steps) ? source.steps : null,
      cfgScale: isFiniteNumber(source.cfgScale) ? source.cfgScale : null,
      mode: toText(source.mode),
      promptSha256: promptText ? sha256Text(promptText) : '',
      promptPublic: false,
      outputSha256: hashed.sha256,
      outputHashStatus: hashed.status,
      sourceRecordIds: sourceIds,
      inputs: inputs,
      parentReceiptHash: parent ? cleanHex64(parent.receiptHash) : '',
      versionGroupId: toText(source.versionGroupId),
      versionNumber: isFiniteNumber(source.versionNumber) ? Math.max(1, Math.floor(source.versionNumber)) : 1,
      credentialStatus: credential.status,
      credentialSignals: credential.signals.slice(0),
      credentialFormat: credential.format,
      transforms: transforms,
      providerFields: providerFields
    };
    if (transforms.length
        && (receipt.credentialStatus === CREDENTIAL_STATUS.ABSENT
          || receipt.credentialStatus === CREDENTIAL_STATUS.PRESENT_UNTRUSTED
          || receipt.credentialStatus === CREDENTIAL_STATUS.VERIFIED)) {
      receipt.credentialStatus = CREDENTIAL_STATUS.UNKNOWN_AFTER_TRANSFORM;
    }
    receipt.receiptHash = computeReceiptHash(receipt);
    return receipt;
  }

  function normalizeReceipt(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
    if (raw.schemaVersion !== RECEIPT_SCHEMA_VERSION) { return null; }
    var recordId = toText(raw.recordId);
    var credentialStatus = toText(raw.credentialStatus);
    if (!recordId || !CREDENTIAL_STATUSES[credentialStatus]) { return null; }
    var inputs = [];
    var i;
    var item;
    var digest;
    if (Array.isArray(raw.inputs)) {
      for (i = 0; i < raw.inputs.length; i += 1) {
        item = raw.inputs[i];
        if (!item || typeof item !== 'object') { continue; }
        digest = cleanHex64(item.sha256);
        if (!digest) { continue; }
        inputs.push(buildInputEntry(digest, item.transform, item.credentialStatus));
      }
    }
    return {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      recordId: recordId,
      action: RECEIPT_ACTIONS[raw.action] ? raw.action : 'generate',
      createdAt: toText(raw.createdAt),
      appVersion: toText(raw.appVersion),
      provider: toText(raw.provider),
      model: toText(raw.model),
      providerModelRevision: toText(raw.providerModelRevision),
      seed: isFiniteNumber(raw.seed) ? Math.floor(raw.seed) : 0,
      size: toText(raw.size),
      steps: isFiniteNumber(raw.steps) ? raw.steps : null,
      cfgScale: isFiniteNumber(raw.cfgScale) ? raw.cfgScale : null,
      mode: toText(raw.mode),
      promptSha256: cleanHex64(raw.promptSha256),
      promptPublic: raw.promptPublic === true,
      outputSha256: cleanHex64(raw.outputSha256),
      outputHashStatus: OUTPUT_HASH_STATUSES[raw.outputHashStatus] ? raw.outputHashStatus : 'unavailable',
      sourceRecordIds: cleanStrList(raw.sourceRecordIds),
      inputs: inputs,
      parentReceiptHash: cleanHex64(raw.parentReceiptHash),
      versionGroupId: toText(raw.versionGroupId),
      versionNumber: isFiniteNumber(raw.versionNumber) ? Math.max(1, Math.floor(raw.versionNumber)) : 1,
      credentialStatus: credentialStatus,
      credentialSignals: cleanStrList(raw.credentialSignals),
      credentialFormat: toText(raw.credentialFormat),
      transforms: cleanStrList(raw.transforms, 8, 80),
      providerFields: {
        server: sanitizeProviderFields(raw.providerFields && raw.providerFields.server)
      },
      receiptHash: cleanHex64(raw.receiptHash)
    };
  }

  function verifyOutput(receipt, image) {
    var expected;
    var actual;
    if (!receipt || typeof receipt !== 'object') { return 'unavailable'; }
    expected = cleanHex64(receipt.outputSha256);
    if (!expected) { return 'unavailable'; }
    actual = hashImage(image);
    if (actual.status !== 'sha256') { return 'unavailable'; }
    return actual.sha256 === expected ? 'match' : 'mismatch';
  }

  function recordTransform(receipt, transform) {
    var updated = {};
    var key;
    var name = toText(transform).slice(0, 80);
    var transforms = [];
    if (!receipt || typeof receipt !== 'object' || !name) { return receipt || null; }
    for (key in receipt) {
      if (Object.prototype.hasOwnProperty.call(receipt, key)) { updated[key] = receipt[key]; }
    }
    if (Array.isArray(receipt.transforms)) {
      transforms = receipt.transforms.slice(0);
    }
    transforms.push(name);
    updated.transforms = transforms;
    updated.credentialStatus = CREDENTIAL_STATUS.UNKNOWN_AFTER_TRANSFORM;
    updated.receiptHash = computeReceiptHash(updated);
    return updated;
  }

  function publicReceipt(receipt) {
    var normalized = normalizeReceipt(receipt);
    var out = {};
    var i;
    var key;
    if (!normalized) { return null; }
    for (i = 0; i < PUBLIC_RECEIPT_FIELDS.length; i += 1) {
      key = PUBLIC_RECEIPT_FIELDS[i];
      if (Object.prototype.hasOwnProperty.call(normalized, key)) { out[key] = normalized[key]; }
    }
    return out;
  }

  function describeCredentialStatus(status) {
    var label = CREDENTIAL_STATUS_LABELS[toText(status)];
    return label || CREDENTIAL_STATUS_LABELS[CREDENTIAL_STATUS.UNSUPPORTED];
  }

  root.ImageProvenance = {
    RECEIPT_SCHEMA_VERSION: RECEIPT_SCHEMA_VERSION,
    APP_VERSION_FALLBACK: APP_VERSION_FALLBACK,
    EDIT_INPUT_TRANSFORM: EDIT_INPUT_TRANSFORM,
    CREDENTIAL_STATUS: CREDENTIAL_STATUS,
    PUBLIC_RECEIPT_FIELDS: PUBLIC_RECEIPT_FIELDS,
    sha256Bytes: sha256Bytes,
    sha256Text: sha256Text,
    utf8Bytes: utf8Bytes,
    dataUrlBytes: dataUrlBytes,
    hashImage: hashImage,
    sniffImageFormat: sniffImageFormat,
    inspectCredential: inspectCredential,
    sanitizeProviderFields: sanitizeProviderFields,
    stableStringify: stableStringify,
    computeReceiptHash: computeReceiptHash,
    verifyReceiptHash: verifyReceiptHash,
    buildReceipt: buildReceipt,
    normalizeReceipt: normalizeReceipt,
    verifyOutput: verifyOutput,
    recordTransform: recordTransform,
    publicReceipt: publicReceipt,
    describeCredentialStatus: describeCredentialStatus
  };
})(typeof window !== 'undefined' ? window : globalThis);
