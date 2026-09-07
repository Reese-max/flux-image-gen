(function (root) {
  'use strict';

  var records = [];
  var recordWriteChain = Promise.resolve();
  var selectedRecordId = '';
  var selectedRecordIds = {};
  var filters = { query: '', model: '', size: '', dateFrom: '', dateTo: '', favoritesOnly: false, cloudOnly: false };

  function el(id) {
    return document.getElementById(id);
  }

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function clearNode(node) {
    while (node && node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function copyRecord(record) {
    var copy = {};
    var key;
    if (!record || typeof record !== 'object') { return copy; }
    for (key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        copy[key] = record[key];
      }
    }
    return copy;
  }

  function extensionFromImageData(image) {
    var source = toText(image).toLowerCase();
    if (source.indexOf('data:image/jpeg') === 0 || source.indexOf('data:image/jpg') === 0) { return '.jpg'; }
    if (source.indexOf('data:image/webp') === 0) { return '.webp'; }
    if (source.indexOf('data:image/gif') === 0) { return '.gif'; }
    return '.png';
  }

  function makeButton(label, className) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className || 'btn secondary';
    button.textContent = label;
    return button;
  }

  function makeAnchor(label, href, className) {
    var anchor = document.createElement('a');
    anchor.className = className || 'btn secondary';
    anchor.textContent = label;
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    return anchor;
  }

  function copyWithApp(text) {
    if (root.ImageGenApp && typeof root.ImageGenApp.copyText === 'function') {
      return root.ImageGenApp.copyText(text);
    }
    return Promise.reject(new Error('複製功能尚未就緒'));
  }

  function setAppStatus(text, cls) {
    if (root.ImageGenApp && typeof root.ImageGenApp.setStatus === 'function') {
      root.ImageGenApp.setStatus(text, cls);
    }
  }

  function safeStore(label, fn, fallback) {
    try {
      return fn();
    } catch (error) {
      setAppStatus(label, 'fail');
      return fallback;
    }
  }

  function confirmAction(message) {
    if (typeof root.confirm === 'function') {
      return root.confirm(message);
    }
    return true;
  }

  function getSelectedRecordIds() {
    var ids = [];
    var id;
    for (id in selectedRecordIds) {
      if (Object.prototype.hasOwnProperty.call(selectedRecordIds, id) && selectedRecordIds[id]) {
        ids.push(id);
      }
    }
    return ids;
  }

  function clearHistorySelection() {
    selectedRecordIds = {};
    updateBatchToolbar();
    renderHistoryWall();
  }

  function recordDateKey(record) {
    var createdAt = toText(record && record.createdAt);
    if (/^\d{4}-\d{2}-\d{2}/.test(createdAt)) {
      return createdAt.slice(0, 10);
    }
    return '';
  }

  function validateHistoryImageUrl(image) {
    var source = toText(image);
    if (source.indexOf('data:image/') === 0 || source.indexOf('http://') === 0 || source.indexOf('https://') === 0) {
      return source;
    }
    throw new Error('歷史圖片網址格式不正確');
  }

  function safeCloudUrl(value) {
    var source = toText(value);
    if (source.indexOf('https://') === 0 || source.indexOf('http://') === 0) { return source; }
    if (source.charAt(0) === '/' && source.indexOf('//') !== 0) { return source; }
    return '';
  }

  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) {
      return null;
    }
    var commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) { return null; }
    var meta = dataUrl.slice(0, commaIdx);
    var raw = dataUrl.slice(commaIdx + 1);
    var mimeMatch = meta.match(/data:([^;]+)/);
    var mime = (mimeMatch && mimeMatch[1]) || 'image/png';
    var isBase64 = meta.indexOf(';base64') !== -1;
    try {
      var binary = isBase64 ? atob(raw) : decodeURIComponent(raw);
      var len = binary.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: mime });
    } catch (_) {
      return null;
    }
  }

  function downloadHistoryImage(record) {
    var sourceRecord = record || getSelectedRecord();
    var id = toText(sourceRecord && sourceRecord.id) || Date.now().toString(36);
    var image;
    var ext;
    var filename;
    var blob;
    var link;
    var blobUrl;
    try {
      image = validateHistoryImageUrl(sourceRecord && sourceRecord.image);
    } catch (error) {
      setAppStatus('下載失敗：' + error.message, 'fail');
      return;
    }
    ext = extensionFromImageData(image);
    filename = 'history_' + id + ext;
    blob = dataUrlToBlob(image);
    link = document.createElement('a');
    if (blob && root.URL && typeof root.URL.createObjectURL === 'function') {
      blobUrl = root.URL.createObjectURL(blob);
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      setTimeout(function () {
        if (link.parentNode) {
          link.parentNode.removeChild(link);
        }
        try { root.URL.revokeObjectURL(blobUrl); } catch (_) {}
      }, 30000);
      return;
    }
    link.href = image;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      if (link.parentNode) {
        link.parentNode.removeChild(link);
      }
    }, 2000);
  }

  function regenerateHistoryImage(record) {
    openHistoryDetail(record);
  }

  function copyHistoryPrompt(record) {
    var sourceRecord = record || getSelectedRecord();
    copyWithApp(toText(sourceRecord && (sourceRecord.providerPrompt || sourceRecord.prompt))).then(function () {
      setAppStatus('已複製歷史提示詞', 'done');
    }).catch(function (error) {
      setAppStatus('複製失敗：' + error.message, 'fail');
    });
  }

  function findRecordById(id) {
    var targetId = toText(id);
    var i;
    if (!targetId) { return null; }
    if (root.ImageHistoryStore && typeof root.ImageHistoryStore.findRecordById === 'function') {
      return root.ImageHistoryStore.findRecordById(records, targetId);
    }
    for (i = 0; i < records.length; i += 1) {
      if (toText(records[i] && records[i].id) === targetId) {
        return records[i];
      }
    }
    return null;
  }

  function normalizeRecordForUi(record) {
    if (!record) { return null; }
    if (root.ImageHistoryStore && typeof root.ImageHistoryStore.normalizeRecord === 'function') {
      try {
        return root.ImageHistoryStore.normalizeRecord(record);
      } catch (error) {
        return null;
      }
    }
    return copyRecord(record);
  }

  function getSelectedRecord() {
    return normalizeRecordForUi(findRecordById(selectedRecordId));
  }

  function getRecordTags(record) {
    var raw = record && record.tags;
    var tags = [];
    var i;
    var tag;
    if (Array.isArray(raw)) {
      for (i = 0; i < raw.length; i += 1) {
        tag = toText(raw[i]);
        if (tag) { tags.push(tag); }
      }
      return tags;
    }
    if (typeof raw === 'string') {
      raw = raw.split(',');
      for (i = 0; i < raw.length; i += 1) {
        tag = toText(raw[i]);
        if (tag) { tags.push(tag); }
      }
    }
    return tags;
  }

  // size preset → 方形/橫向/直向 三向分類，對齊 index.html 的 historySizeFilter 選項值。
  function sizeOrientation(size) {
    switch (toText(size)) {
      case 'square': case 'landscape': case 'portrait':
        return toText(size);
      case 'ig_post':
        return 'square';
      case 'ppt_16_9': case 'youtube_thumb': case 'hero_21_9':
        return 'landscape';
      case 'ig_story': case 'mobile_wallpaper': case 'poster_3_4': case 'a4_illustration':
        return 'portrait';
      default:
        return 'square';
    }
  }

  // steps/cfgScale → 草稿/平衡/精緻/自訂 中文畫質檔（對齊 app.js QUALITY_PRESETS）。
  // 對一般使用者隱藏 schnell/dev 這種內部模型代號。
  function qualityLabel(record) {
    if (!record) { return '平衡'; }
    var steps = record.steps;
    var cfg = record.cfgScale;
    var hasSteps = steps !== null && steps !== undefined && steps !== '';
    var hasCfg = cfg !== null && cfg !== undefined && cfg !== '';
    if (!hasSteps && !hasCfg) {
      if (record.model === 'schnell') { return '草稿'; }
      return '平衡';
    }
    var s = Number(steps);
    var c = Number(cfg);
    if (s === 10 && c === 3) { return '草稿'; }
    if (s === 45 && c === 4) { return '精緻'; }
    return '自訂';
  }

  function recordMatchesFilters(record) {
    var sourceRecord = normalizeRecordForUi(record) || record;
    var query = toText(filters.query).toLowerCase();
    var tags = getRecordTags(sourceRecord);
    var tagText = '';
    var searchable;
    var i;
    if (!sourceRecord) { return false; }
    if (filters.model && qualityLabel(sourceRecord) !== filters.model) { return false; }
    if (filters.size && sizeOrientation(toText(sourceRecord.size)) !== filters.size) { return false; }
    if (filters.dateFrom && (!recordDateKey(sourceRecord) || recordDateKey(sourceRecord) < filters.dateFrom)) { return false; }
    if (filters.dateTo && (!recordDateKey(sourceRecord) || recordDateKey(sourceRecord) > filters.dateTo)) { return false; }
    if (filters.favoritesOnly && sourceRecord.favorite !== true) { return false; }
    if (filters.cloudOnly && !safeCloudUrl(sourceRecord.cloudShareUrl) && !safeCloudUrl(sourceRecord.cloudDeleteUrl)) { return false; }
    if (!query) { return true; }
    for (i = 0; i < tags.length; i += 1) {
      tagText += ' ' + tags[i];
    }
    searchable = [
      toText(sourceRecord.prompt),
      toText(sourceRecord.providerPrompt),
      toText(sourceRecord.provider),
      toText(sourceRecord.cloudShareUrl),
      toText(sourceRecord.cloudDeleteUrl),
      tagText
    ].join(' ').toLowerCase();
    return searchable.indexOf(query) !== -1;
  }

  function applyHistoryFilters() {
    var search = el('historySearch');
    var model = el('historyModelFilter');
    var size = el('historySizeFilter');
    var dateFrom = el('historyDateFrom');
    var dateTo = el('historyDateTo');
    var favoritesOnly = el('historyFavoritesOnly');
    var cloudOnly = el('historyCloudOnly');
    filters.query = search ? toText(search.value) : '';
    filters.model = model ? toText(model.value) : '';
    filters.size = size ? toText(size.value) : '';
    filters.dateFrom = dateFrom ? toText(dateFrom.value) : '';
    filters.dateTo = dateTo ? toText(dateTo.value) : '';
    filters.favoritesOnly = !!(favoritesOnly && favoritesOnly.checked);
    filters.cloudOnly = !!(cloudOnly && cloudOnly.checked);
    renderHistoryWall();
  }

  function getVisibleRecords() {
    var visibleRecords = [];
    var i;
    for (i = 0; i < records.length; i += 1) {
      if (recordMatchesFilters(records[i])) {
        visibleRecords.push(records[i]);
      }
    }
    return visibleRecords;
  }

  function updateBatchToolbar() {
    var toolbar = el('historyBatchBar');
    var filters = el('historyFilters');
    var clearHistoryButton = el('clearHistory');
    var exportAllButton = el('exportAllHistoryJson');
    var countNode = el('historySelectionCount');
    var deleteButton = el('deleteSelectedHistory');
    var clearButton = el('clearHistorySelection');
    var count = getSelectedRecordIds().length;
    if (toolbar) {
      toolbar.hidden = records.length === 0;
    }
    if (filters) {
      filters.hidden = records.length === 0;
    }
    if (clearHistoryButton) {
      clearHistoryButton.hidden = records.length === 0;
      clearHistoryButton.disabled = records.length === 0;
    }
    if (exportAllButton) {
      exportAllButton.hidden = records.length === 0;
      exportAllButton.disabled = records.length === 0;
    }
    if (countNode) {
      countNode.textContent = count ? '已選取 ' + String(count) + ' 筆歷史作品' : '尚未選取作品';
    }
    if (deleteButton) {
      deleteButton.disabled = count === 0;
    }
    if (clearButton) {
      clearButton.disabled = count === 0;
    }
  }

  function toggleHistorySelection(record, checked) {
    var sourceRecord = normalizeRecordForUi(record);
    if (!sourceRecord) { return; }
    if (checked) {
      selectedRecordIds[sourceRecord.id] = true;
    } else {
      delete selectedRecordIds[sourceRecord.id];
    }
    updateBatchToolbar();
  }

  function selectVisibleHistory() {
    var visibleRecords = getVisibleRecords();
    var i;
    for (i = 0; i < visibleRecords.length; i += 1) {
      selectedRecordIds[toText(visibleRecords[i] && visibleRecords[i].id)] = true;
    }
    renderHistoryWall();
    updateBatchToolbar();
  }

  function renderTagList(record) {
    var tags = getRecordTags(record);
    var list;
    var chip;
    var i;
    if (!tags.length) { return null; }
    list = document.createElement('div');
    list.className = 'history-tags';
    for (i = 0; i < tags.length; i += 1) {
      chip = document.createElement('span');
      chip.className = 'history-tag';
      chip.textContent = tags[i];
      list.appendChild(chip);
    }
    return list;
  }

  function formatHistoryMeta(record) {
    var parts = [];
    if (!record) { return ''; }
    parts.push('畫質：' + qualityLabel(record));
    parts.push('尺寸：' + (toText(record.size) || 'square'));
    parts.push('Seed：' + String(record.seed || 0));
    if (record.width && record.height) { parts.push('解析度：' + record.width + '×' + record.height); }
    if (record.provider) { parts.push('Provider：' + toText(record.provider)); }
    if (record.mode) { parts.push('模式：' + (record.mode === 'agent' ? '智慧體' : '一般')); }
    if (record.recommended) { parts.push('推薦圖'); }
    parts.push('版本：v' + String(record.versionNumber || 1));
    if (record.createdAt) { parts.push('建立：' + toText(record.createdAt)); }
    return parts.join(' · ');
  }

  function credentialStatusLabel(status) {
    var labels = {
      verified: '已驗證',
      present_untrusted: '存在但未受信任',
      invalid: '無效',
      absent: '未發現',
      unknown_after_transform: '轉換後未知',
      unsupported: '尚未支援檢查'
    };
    return labels[toText(status)] || '未知';
  }

  function receiptStatusLabel(status) {
    var labels = {
      valid: '有效，圖片與 receipt 相符',
      modified: '已修改或 receipt 不相符',
      unavailable: '無法在此瀏覽器重新計算',
      absent: '尚未建立'
    };
    return labels[toText(status)] || '尚未驗證';
  }

  function formatProvenanceStatus(record, verification) {
    var receipt = record && record.provenanceReceipt;
    var lines = [];
    if (!receipt) {
      return '本產品 receipt：尚未建立。Content Credentials：未提供檢查結果；缺少 credential 不代表是真人圖片。';
    }
    lines.push('本產品 receipt：' + receiptStatusLabel(verification && verification.status));
    if (receipt.receipt_hash) { lines.push('Receipt hash：' + receipt.receipt_hash); }
    if (receipt.output_sha256) { lines.push('Output SHA-256：' + receipt.output_sha256); }
    lines.push('Content Credentials：' + credentialStatusLabel(receipt.credential_status));
    if (receipt.operation === 'edit') { lines.push('流程：AI 編輯；來源圖 hash 已保存。'); }
    lines.push('缺少 credential 不代表是真人圖片；receipt 只描述本產品記錄的來源。');
    return lines.join('\n');
  }

  function refreshProvenanceStatus(record) {
    var sourceRecord = normalizeRecordForUi(record);
    var verifier = root.ProvenanceReceipt && root.ProvenanceReceipt.verifyRecord;
    if (!sourceRecord || !verifier) { return; }
    Promise.resolve(verifier(sourceRecord)).then(function (verification) {
      if (selectedRecordId === toText(sourceRecord.id)) {
        setDetailText('historyProvenanceStatus', formatProvenanceStatus(sourceRecord, verification));
      }
    }, function () {
      if (selectedRecordId === toText(sourceRecord.id)) {
        setDetailText('historyProvenanceStatus', formatProvenanceStatus(sourceRecord, { status: 'unavailable' }));
      }
    });
  }

  function formatQaReport(record) {
    var report = record && record.qaReport;
    var parts = [];
    var issues;
    var imageQuality;
    var qualityIssues;
    var visionQa;
    var visionIssues;
    var provider;
    var retry;
    if (!report) { return '尚未建立 QAReport'; }
    parts.push('Prompt 符合度：' + String(report.promptMatchScore || 0) + '/100');
    parts.push('構圖：' + String(report.compositionScore || 0) + '/100');
    parts.push('畫質：' + String(report.visualQualityScore || 0) + '/100');
    if (report.textAccuracyScore !== null && report.textAccuracyScore !== undefined) {
      parts.push('文字準確度：' + String(report.textAccuracyScore || 0) + '/100');
    }
    parts.push('建議：' + (toText(report.recommendation) || 'keep'));
    if (report.reason) { parts.push('原因：' + toText(report.reason)); }
    issues = Array.isArray(report.detectedIssues) ? report.detectedIssues : [];
    if (issues.length) { parts.push('偵測問題：' + issues.join('；')); }
    imageQuality = report.imageQuality;
    if (imageQuality) {
      qualityIssues = Array.isArray(imageQuality.issues) ? imageQuality.issues : [];
      if (imageQuality.checked === false) {
        parts.push('圖片檢查：未能讀取圖片標頭，建議人工確認');
      } else {
        parts.push(
          '圖片檢查：' +
          (toText(imageQuality.mime) || 'unknown') +
          ' · ' +
          String(imageQuality.width || 0) +
          '×' +
          String(imageQuality.height || 0) +
          ' · ' +
          String(Math.round(Number(imageQuality.byteSize || 0) / 1024)) +
          ' KB'
        );
      }
      if (qualityIssues.length) { parts.push('圖片檢查問題：' + qualityIssues.join('；')); }
    }
    visionQa = report.visionQa;
    if (visionQa) {
      if (visionQa.available === false) {
        parts.push('視覺 QA：暫時不可用，已使用本機 QA');
      } else {
        provider = visionQa.provider === 'gemini' ? 'Gemini' : (toText(visionQa.provider) || 'Vision');
        parts.push('視覺 QA：' + provider);
        if (visionQa.promptMatchScore !== undefined) { parts.push('視覺符合度：' + String(visionQa.promptMatchScore || 0) + '/100'); }
        if (visionQa.compositionScore !== undefined) { parts.push('視覺構圖：' + String(visionQa.compositionScore || 0) + '/100'); }
        if (visionQa.visualQualityScore !== undefined) { parts.push('視覺畫質：' + String(visionQa.visualQualityScore || 0) + '/100'); }
        if (visionQa.textAccuracyScore !== undefined && visionQa.textAccuracyScore !== null) {
          parts.push('視覺文字準確度：' + String(visionQa.textAccuracyScore || 0) + '/100');
        }
        if (visionQa.recommendation) { parts.push('視覺建議：' + toText(visionQa.recommendation)); }
        if (visionQa.reason) { parts.push('視覺原因：' + toText(visionQa.reason)); }
        visionIssues = Array.isArray(visionQa.detectedIssues) ? visionQa.detectedIssues : [];
        if (visionIssues.length) { parts.push('視覺 QA 問題：' + visionIssues.join('；')); }
      }
    }
    if (record.agentRecommendation) { parts.push('智慧體推薦：' + toText(record.agentRecommendation)); }
    retry = record.autoRetry;
    if (retry && retry.action && retry.action !== 'none') { parts.push('重試策略：' + toText(retry.message || retry.reason)); }
    return parts.join('\n');
  }

  function setDetailText(id, value) {
    var node = el(id);
    if (node) { node.textContent = toText(value); }
  }

  function renderCloudLinks(record) {
    var section = el('historyCloudSection');
    var meta = el('historyCloudMeta');
    var share = el('openHistoryCloudShare');
    var remove = el('openHistoryCloudDelete');
    var shareUrl = safeCloudUrl(record && record.cloudShareUrl);
    var deleteUrl = safeCloudUrl(record && record.cloudDeleteUrl);
    var parts = [];
    if (!section) { return; }
    if (!shareUrl && !deleteUrl) {
      section.hidden = true;
      if (share) { share.removeAttribute('href'); }
      if (remove) { remove.removeAttribute('href'); }
      return;
    }
    section.hidden = false;
    if (share) {
      share.hidden = !shareUrl;
      if (shareUrl) { share.href = shareUrl; } else { share.removeAttribute('href'); }
    }
    if (remove) {
      remove.hidden = !deleteUrl;
      if (deleteUrl) { remove.href = deleteUrl; } else { remove.removeAttribute('href'); }
    }
    parts.push('已保存到：' + (toText(record.cloudStorage) || 'R2'));
    parts.push('Prompt：' + (record.cloudPromptPublic ? '公開' : '隱藏'));
    if (record.cloudSavedAt) { parts.push('保存時間：' + toText(record.cloudSavedAt)); }
    if (meta) { meta.textContent = parts.join(' · '); }
  }

  function getCloudRecords() {
    var cloudRecords = [];
    var i;
    var record;
    for (i = 0; i < records.length; i += 1) {
      record = normalizeRecordForUi(records[i]);
      if (record && (safeCloudUrl(record.cloudShareUrl) || safeCloudUrl(record.cloudDeleteUrl))) {
        cloudRecords.push(record);
      }
    }
    return cloudRecords;
  }

  function copyCloudRecordLink(record, fieldName) {
    var sourceRecord = normalizeRecordForUi(record);
    var value = safeCloudUrl(sourceRecord && sourceRecord[fieldName]);
    if (!value) {
      setAppStatus('沒有可複製的雲端連結', 'warn');
      return;
    }
    copyWithApp(value).then(function () {
      setAppStatus(fieldName === 'cloudDeleteUrl' ? '已複製雲端刪除連結' : '已複製雲端分享連結', 'done');
    }).catch(function (error) {
      setAppStatus('複製失敗：' + error.message, 'fail');
    });
  }

  function appendCloudMeta(parent, label) {
    var item = document.createElement('span');
    item.textContent = label;
    parent.appendChild(item);
  }

  function createCloudRecordCard(record) {
    var card = document.createElement('article');
    var thumb = document.createElement('img');
    var body = document.createElement('div');
    var title = document.createElement('p');
    var meta = document.createElement('div');
    var actions = document.createElement('div');
    var shareUrl = safeCloudUrl(record.cloudShareUrl);
    var deleteUrl = safeCloudUrl(record.cloudDeleteUrl);
    var detail = makeButton('詳情', 'btn mini secondary');
    var copyShare = makeButton('複製分享', 'btn mini secondary');
    var copyDelete = makeButton('複製刪除', 'btn mini danger');
    var share;
    var remove;

    card.className = 'cloud-record-card';
    thumb.className = 'cloud-record-thumb';
    thumb.src = toText(record.thumbnail || record.image);
    thumb.alt = '雲端作品預覽';
    body.className = 'cloud-record-body';
    title.className = 'cloud-record-title';
    title.textContent = toText(record.prompt || record.providerPrompt) || '未命名雲端作品';
    meta.className = 'cloud-record-meta';
    appendCloudMeta(meta, record.cloudPromptPublic ? 'Prompt 公開' : 'Prompt 隱藏');
    appendCloudMeta(meta, toText(record.cloudStorage) || 'R2');
    if (record.cloudSavedAt) { appendCloudMeta(meta, '保存：' + toText(record.cloudSavedAt)); }
    actions.className = 'cloud-record-actions';

    detail.addEventListener('click', function () {
      openHistoryDetail(record);
    });
    actions.appendChild(detail);

    if (shareUrl) {
      share = makeAnchor('開啟分享頁', shareUrl, 'btn mini secondary');
      actions.appendChild(share);
      copyShare.addEventListener('click', function () { copyCloudRecordLink(record, 'cloudShareUrl'); });
      actions.appendChild(copyShare);
    }
    if (deleteUrl) {
      remove = makeAnchor('開啟刪除頁', deleteUrl, 'btn mini danger');
      actions.appendChild(remove);
      copyDelete.addEventListener('click', function () { copyCloudRecordLink(record, 'cloudDeleteUrl'); });
      actions.appendChild(copyDelete);
    }

    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(actions);
    card.appendChild(thumb);
    card.appendChild(body);
    return card;
  }

  function renderCloudLibrary() {
    var library = el('cloudLibrary');
    var list = el('cloudRecordList');
    // 面板已移除時提早收工，避免多做一次 getCloudRecords() 全掃描。
    if (!library || !list) { return; }
    var countNode = el('cloudLibraryCount');
    var cloudRecords = getCloudRecords();
    var empty;
    var i;
    clearNode(list);
    if (countNode) {
      countNode.textContent = String(cloudRecords.length) + ' 筆雲端作品';
    }
    if (!cloudRecords.length) {
      empty = document.createElement('div');
      empty.className = 'cloud-record-empty';
      empty.textContent = '尚無雲端作品。生成成功後點「存到雲端」，分享與刪除連結會保存在這裡。';
      list.appendChild(empty);
      return;
    }
    for (i = 0; i < cloudRecords.length; i += 1) {
      list.appendChild(createCloudRecordCard(cloudRecords[i]));
    }
  }

  function openHistoryDetail(record) {
    var sourceRecord = normalizeRecordForUi(record);
    var modal = el('historyDetailModal');
    var image = el('historyDetailImage');
    var tagEditor = el('historyTagEditor');
    var validatedImage;
    if (!sourceRecord || !modal) {
      setAppStatus('找不到作品詳情', 'fail');
      return;
    }
    selectedRecordId = toText(sourceRecord.id);
    if (image) {
      try {
        validatedImage = validateHistoryImageUrl(sourceRecord.image);
        image.src = validatedImage;
        image.alt = '歷史作品預覽';
      } catch (error) {
        image.removeAttribute('src');
        image.alt = '歷史作品圖片網址格式不正確';
      }
    }
    setDetailText('historyDetailPrompt', sourceRecord.prompt);
    setDetailText('historyDetailProviderPrompt', sourceRecord.providerPrompt);
    setDetailText('historyDetailMeta', formatHistoryMeta(sourceRecord));
    setDetailText('historyDetailQaReport', formatQaReport(sourceRecord));
    setDetailText('historyProvenanceStatus', formatProvenanceStatus(sourceRecord, null));
    renderCloudLinks(sourceRecord);
    if (tagEditor) {
      tagEditor.value = getRecordTags(sourceRecord).join(', ');
    }
    renderVersionList(sourceRecord);
    if (root.ModalA11y && typeof root.ModalA11y.open === 'function') {
      root.ModalA11y.open(modal, el('closeHistoryDetail'));
    } else {
      modal.hidden = false;
    }
    refreshProvenanceStatus(sourceRecord);
  }

  function closeHistoryDetail() {
    var modal = el('historyDetailModal');
    if (modal && root.ModalA11y && typeof root.ModalA11y.close === 'function') {
      root.ModalA11y.close(modal);
    } else if (modal) {
      modal.hidden = true;
    }
    selectedRecordId = '';
  }

  function renderVersionList(record) {
    var list = el('historyVersionList');
    var group = [];
    if (!list) { return; }
    clearNode(list);
    if (root.ImageHistoryStore && typeof root.ImageHistoryStore.findVersionGroup === 'function') {
      group = root.ImageHistoryStore.findVersionGroup(records, record);
    }
    if (!group.length) {
      group = record ? [record] : [];
    }
    group.forEach(function (version) {
      var chip = document.createElement('button');
      var label = 'v' + String(version.versionNumber || 1);
      chip.type = 'button';
      chip.className = 'version-chip' + (toText(version.id) === toText(record && record.id) ? ' is-active' : '');
      chip.textContent = label + ' · ' + qualityLabel(version) + ' · ' + (toText(version.size) || 'square');
      chip.addEventListener('click', function () {
        openHistoryDetail(version);
      });
      list.appendChild(chip);
    });
  }

  function buildShareText(record, hidePrompt) {
    var sourceRecord = normalizeRecordForUi(record);
    var lines = [];
    var cloudShareUrl;
    if (!sourceRecord) { return ''; }
    lines.push('AI 圖片作品');
    lines.push('畫質：' + qualityLabel(sourceRecord));
    lines.push('尺寸：' + (toText(sourceRecord.size) || 'square'));
    lines.push('Seed：' + String(sourceRecord.seed || 0));
    lines.push('版本：v' + String(sourceRecord.versionNumber || 1));
    if (sourceRecord.provider) { lines.push('Provider：' + toText(sourceRecord.provider)); }
    if (sourceRecord.provenanceReceipt) {
      lines.push('Provenance receipt：' + (toText(sourceRecord.provenanceReceipt.receipt_hash) || 'unavailable'));
      lines.push('Content Credentials：' + credentialStatusLabel(sourceRecord.provenanceReceipt.credential_status));
    }
    cloudShareUrl = safeCloudUrl(sourceRecord.cloudShareUrl);
    if (cloudShareUrl) { lines.push('雲端分享：' + cloudShareUrl); }
    if (!hidePrompt) {
      lines.push('中文描述：' + toText(sourceRecord.prompt));
      lines.push('英文提示詞：' + toText(sourceRecord.providerPrompt));
    }
    return lines.join('\n');
  }

  function copyHistoryShareText() {
    var record = getSelectedRecord();
    var hidePrompt = !!(el('hidePromptInShare') && el('hidePromptInShare').checked);
    if (!record) {
      setAppStatus('尚無可分享的作品', 'warn');
      return;
    }
    copyWithApp(buildShareText(record, hidePrompt)).then(function () {
      setAppStatus('已複製分享文案', 'done');
    }).catch(function (error) {
      setAppStatus('複製失敗：' + error.message, 'fail');
    });
  }

  function safeFilePart(value) {
    return (toText(value) || 'history').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) || 'history';
  }

  function downloadJsonPayload(payload, filename) {
    var blob;
    var url;
    var link;
    if (!root.URL || typeof root.URL.createObjectURL !== 'function') {
      return false;
    }
    blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    url = root.URL.createObjectURL(blob);
    link = document.createElement('a');
    link.href = url;
    link.download = filename;
    try {
      document.body.appendChild(link);
      link.click();
    } finally {
      if (link.parentNode) {
        link.parentNode.removeChild(link);
      }
      // Keep the object URL alive until the browser has consumed the download.
      // Revoking it in the same task cancels downloads in Chromium.
      setTimeout(function () {
        try { root.URL.revokeObjectURL(url); } catch (_) {}
      }, 30000);
    }
    return true;
  }

  function exportHistoryJson() {
    var record = getSelectedRecord();
    var normalized;
    if (!record) {
      setAppStatus('尚無可匯出的作品', 'warn');
      return;
    }
    normalized = normalizeRecordForUi(record);
    if (!normalized) {
      setAppStatus('作品資料格式不正確，無法匯出', 'fail');
      return;
    }
    if (root.confirm && !root.confirm('匯出的備份檔會包含完整中文描述、英文提示詞、畫面編號與設定，並可能包含雲端分享或刪除連結。公開分享前請先檢查內容，確定要匯出？')) {
      setAppStatus('已取消匯出作品 JSON', 'warn');
      return;
    }
    if (!downloadJsonPayload(normalized, 'history_' + safeFilePart(normalized.id) + '.json')) {
      setAppStatus('瀏覽器不支援匯出 JSON', 'fail');
      return;
    }
    setAppStatus('已匯出備份檔；檔案可能包含完整描述與雲端刪除連結，請勿公開分享此檔。', 'done');
  }

  function exportAllHistoryJson() {
    var normalized;
    if (!records.length) {
      setAppStatus('尚無可匯出的歷史作品', 'warn');
      return;
    }
    normalized = root.ImageHistoryStore && typeof root.ImageHistoryStore.exportRecordCollection === 'function'
      ? root.ImageHistoryStore.exportRecordCollection(records)
      : { schema: 'GenerationRecordCollection', version: 2, records: records };
    if (!confirmAction('匯出的備份檔會包含全部歷史作品、完整提示詞與設定，並可能包含雲端分享或刪除連結。公開分享前請先檢查內容，確定要匯出？')) {
      setAppStatus('已取消匯出全部歷史 JSON', 'warn');
      return;
    }
    if (!downloadJsonPayload(normalized, 'history_backup_' + new Date().toISOString().slice(0, 10) + '.json')) {
      setAppStatus('瀏覽器不支援匯出 JSON', 'fail');
      return;
    }
    setAppStatus('已匯出全部歷史備份檔；檔案可能包含完整描述與雲端刪除連結，請勿公開分享此檔。', 'done');
  }

  function switchToGenerateTab() {
    if (typeof root.showTab !== 'function' || !root.showTab('generate')) {
      setAppStatus('生成分頁尚未就緒', 'fail');
      return false;
    }
    return true;
  }

  function regenerateHistoryDetail() {
    var record = getSelectedRecord();
    if (!root.ImageGenApp || typeof root.ImageGenApp.setGenerationSettings !== 'function' || typeof root.ImageGenApp.generate !== 'function') {
      setAppStatus('再生功能尚未就緒', 'fail');
      return;
    }
    if (!record) {
      setAppStatus('尚無可再生的作品', 'warn');
      return;
    }
    if (!switchToGenerateTab()) { return; }
    if (typeof root.ImageGenApp.setSeedMode === 'function') {
      root.ImageGenApp.setSeedMode('random');
    }
    if (typeof root.ImageGenApp.setNextGenerationSourceRecord === 'function') {
      root.ImageGenApp.setNextGenerationSourceRecord(record.id);
    }
    root.ImageGenApp.setGenerationSettings({
      prompt: toText(record && (record.userPrompt || record.prompt)),
      providerPrompt: toText(record && record.providerPrompt),
      avoid: toText(record && (record.negativePrompt || record.avoid)),
      model: toText(record && record.model) || 'schnell',
      size: toText(record && record.size) || 'square',
      width: record && record.width,
      height: record && record.height,
      steps: record && record.steps,
      cfgScale: record && record.cfgScale,
      seed: 0
    });
    closeHistoryDetail();
    root.ImageGenApp.generate();
  }

  function deleteHistoryRecord(id) {
    var nextRecords;
    if (!root.ImageHistoryStore) { return; }
    nextRecords = safeStore('歷史記錄刪除失敗', function () {
      var deletedRecords = root.ImageHistoryStore.deleteRecord(records, id);
      return root.ImageHistoryStore.saveRecords(deletedRecords);
    }, null);
    if (!nextRecords) { return; }
    records = nextRecords;
    delete selectedRecordIds[toText(id)];
    renderHistoryWall();
  }

  function refreshSelectedRecord(recordId) {
    var modal = el('historyDetailModal');
    var refreshedRecord;
    if (!selectedRecordId || selectedRecordId !== toText(recordId) || !modal || modal.hidden) { return; }
    refreshedRecord = getSelectedRecord();
    if (refreshedRecord) {
      openHistoryDetail(refreshedRecord);
    }
  }

  function toggleHistoryFavorite(record) {
    var sourceRecord = normalizeRecordForUi(record);
    var nextRecords;
    if (!root.ImageHistoryStore || typeof root.ImageHistoryStore.toggleFavorite !== 'function') {
      setAppStatus('收藏功能尚未就緒', 'fail');
      return;
    }
    if (!sourceRecord) {
      setAppStatus('找不到可收藏的作品', 'warn');
      return;
    }
    nextRecords = safeStore('收藏狀態儲存失敗', function () {
      var favoritedRecords = root.ImageHistoryStore.toggleFavorite(records, sourceRecord.id);
      return root.ImageHistoryStore.saveRecords(favoritedRecords);
    }, null);
    if (!nextRecords) { return; }
    records = nextRecords;
    renderHistoryWall();
    refreshSelectedRecord(sourceRecord.id);
    setAppStatus(sourceRecord.favorite ? '已取消收藏' : '已加入收藏', 'done');
  }

  function saveHistoryTags() {
    var editor = el('historyTagEditor');
    var record = getSelectedRecord();
    var nextRecords;
    if (!editor) {
      setAppStatus('標籤輸入欄位尚未就緒', 'fail');
      return;
    }
    if (!root.ImageHistoryStore || typeof root.ImageHistoryStore.updateRecordTags !== 'function') {
      setAppStatus('標籤功能尚未就緒', 'fail');
      return;
    }
    if (!record) {
      setAppStatus('尚無可儲存標籤的作品', 'warn');
      return;
    }
    nextRecords = safeStore('標籤儲存失敗', function () {
      var taggedRecords = root.ImageHistoryStore.updateRecordTags(records, record.id, editor.value);
      return root.ImageHistoryStore.saveRecords(taggedRecords);
    }, null);
    if (!nextRecords) { return; }
    records = nextRecords;
    renderHistoryWall();
    refreshSelectedRecord(record.id);
    setAppStatus('已儲存標籤', 'done');
  }

  function appendMeta(parent, label) {
    var item = document.createElement('span');
    item.textContent = label;
    parent.appendChild(item);
  }

  function createHistoryCard(record) {
    var card = document.createElement('article');
    var select = document.createElement('input');
    var thumb = document.createElement('img');
    var body = document.createElement('div');
    var prompt = document.createElement('p');
    var meta = document.createElement('div');
    var tagList = renderTagList(record);
    var actions = document.createElement('div');
    var favorite = makeButton(record.favorite ? '★' : '☆', 'history-card-favorite' + (record.favorite ? ' is-active' : ''));
    var detail = makeButton('詳情', 'btn secondary');
    var remove = makeButton('刪除', 'btn secondary');

    card.className = 'history-card';
    select.type = 'checkbox';
    select.className = 'history-select';
    select.checked = selectedRecordIds[toText(record.id)] === true;
    select.setAttribute('aria-label', '選取這筆歷史作品');
    favorite.setAttribute('aria-label', record.favorite ? '取消收藏' : '加入收藏');
    favorite.setAttribute('aria-pressed', record.favorite ? 'true' : 'false');
    favorite.title = record.favorite ? '取消收藏' : '加入收藏';
    thumb.className = 'history-thumb';
    thumb.src = toText(record.thumbnail || record.image);
    thumb.alt = 'history image';
    body.className = 'history-body';
    prompt.className = 'history-prompt';
    prompt.textContent = toText(record.providerPrompt || record.prompt);
    meta.className = 'history-meta';
    appendMeta(meta, qualityLabel(record));
    appendMeta(meta, toText(record.size) || 'square');
    appendMeta(meta, 'seed ' + String(record.seed || 0));
    if (record.provider) { appendMeta(meta, toText(record.provider)); }
    actions.className = 'history-actions';

    card.addEventListener('click', function () { openHistoryDetail(record); });
    select.addEventListener('click', function (event) {
      event.stopPropagation();
    });
    select.addEventListener('change', function () {
      toggleHistorySelection(record, select.checked);
    });
    favorite.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleHistoryFavorite(record);
    });
    detail.addEventListener('click', function (event) {
      event.stopPropagation();
      openHistoryDetail(record);
    });
    remove.addEventListener('click', function (event) {
      event.stopPropagation();
      if (confirmAction('確定要刪除這張作品嗎？此動作無法復原（雲端作品不受影響）。')) {
        deleteHistoryRecord(record.id);
      }
    });

    actions.appendChild(detail);
    actions.appendChild(remove);
    body.appendChild(prompt);
    body.appendChild(meta);
    if (tagList) {
      body.appendChild(tagList);
    }
    body.appendChild(actions);
    card.appendChild(select);
    card.appendChild(favorite);
    card.appendChild(thumb);
    card.appendChild(body);
    return card;
  }

  function renderHistoryWall() {
    var grid = el('historyGrid');
    var empty;
    var startButton;
    var visibleRecords = [];
    var i;

    if (!grid) { return; }
    clearNode(grid);

    // 更新歷史分頁上的數量徽章（總數，與篩選無關）。
    if (typeof root.setHistoryCount === 'function') { root.setHistoryCount(records.length); }
    renderCloudLibrary();
    if (!records.length) {
      empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '尚無歷史記錄。成功生成圖片後會出現在這裡。';
      startButton = document.createElement('button');
      startButton.type = 'button';
      startButton.id = 'historyEmptyGenerate';
      startButton.className = 'btn primary history-empty-cta';
      startButton.textContent = '去生成第一張';
      startButton.addEventListener('click', function () {
        if (typeof root.showTab === 'function') { root.showTab('generate'); }
        if (typeof root.scrollToComposerAndFocus === 'function') {
          root.scrollToComposerAndFocus();
        } else if (el('plainPrompt')) {
          el('plainPrompt').focus();
        }
      });
      empty.appendChild(startButton);
      grid.appendChild(empty);
      updateBatchToolbar();
      return;
    }

    for (i = 0; i < records.length; i += 1) {
      if (recordMatchesFilters(records[i])) {
        visibleRecords.push(records[i]);
      }
    }

    if (!visibleRecords.length) {
      empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '沒有符合篩選條件的歷史記錄。';
      grid.appendChild(empty);
      updateBatchToolbar();
      return;
    }

    for (i = 0; i < visibleRecords.length; i += 1) {
      grid.appendChild(createHistoryCard(visibleRecords[i]));
    }
    updateBatchToolbar();
  }

  function loadHistoryWall() {
    if (!root.ImageHistoryStore) {
      records = [];
      renderHistoryWall();
      return;
    }
    records = safeStore('歷史記錄讀取失敗', function () {
      return root.ImageHistoryStore.loadRecords();
    }, []);
    renderHistoryWall();
  }

  function clearHistoryWall() {
    var nextRecords;
    if (!root.ImageHistoryStore) { return; }
    if (records.length && !confirmAction('確定要清空全部歷史記錄嗎？此動作無法復原。')) {
      setAppStatus('已取消清空歷史', 'warn');
      return;
    }
    nextRecords = safeStore('歷史記錄清除失敗', function () {
      return root.ImageHistoryStore.clearRecords();
    }, null);
    if (!nextRecords) { return; }
    records = nextRecords;
    selectedRecordIds = {};
    renderHistoryWall();
    setAppStatus('已清空歷史記錄', 'done');
  }

  function deleteSelectedHistoryRecords() {
    var ids = getSelectedRecordIds();
    var nextRecords;
    if (!ids.length) {
      setAppStatus('尚未選取要刪除的歷史作品', 'warn');
      return;
    }
    if (!root.ImageHistoryStore || typeof root.ImageHistoryStore.deleteRecords !== 'function') {
      setAppStatus('批次刪除功能尚未就緒', 'fail');
      return;
    }
    if (!confirmAction('確定要刪除已選取的 ' + String(ids.length) + ' 筆歷史作品嗎？此動作無法復原。')) {
      setAppStatus('已取消批次刪除', 'warn');
      return;
    }
    nextRecords = safeStore('批次刪除歷史記錄失敗', function () {
      var deletedRecords = root.ImageHistoryStore.deleteRecords(records, ids);
      return root.ImageHistoryStore.saveRecords(deletedRecords);
    }, null);
    if (!nextRecords) { return; }
    records = nextRecords;
    selectedRecordIds = {};
    renderHistoryWall();
    setAppStatus('已刪除選取的歷史作品', 'done');
  }

  function addGeneratedRecord(event) {
    if (!root.ImageHistoryStore || !event || !event.detail) { return; }
    // Batch results dispatch several events in one turn. Serializing the
    // async hash work keeps each event's parent lookup and localStorage write
    // based on the latest history instead of racing and dropping records.
    recordWriteChain = recordWriteChain.then(function () {
      var sourceRecordId = toText(event.detail.sourceRecordId);
      var parentRecord = sourceRecordId ? root.ImageHistoryStore.findRecordById(records, sourceRecordId) : null;
      var recordToAdd = event.detail;
      var addedRecords;
      var attach;
      if (sourceRecordId && parentRecord && typeof root.ImageHistoryStore.createVersionRecord === 'function') {
        recordToAdd = root.ImageHistoryStore.createVersionRecord(records, parentRecord, event.detail);
      }
      if (!toText(recordToAdd.id)) {
        // Batch event payloads intentionally omit ids. Reserve the id before
        // hashing so the receipt and persisted record refer to the same item.
        var identity = root.ImageHistoryStore.normalizeRecord(recordToAdd);
        recordToAdd = copyRecord(recordToAdd);
        recordToAdd.id = identity.id;
      }
      attach = root.ProvenanceReceipt && typeof root.ProvenanceReceipt.attachRecord === 'function'
        ? root.ProvenanceReceipt.attachRecord(recordToAdd, parentRecord)
        : Promise.resolve(recordToAdd);
      return Promise.resolve(attach).then(function (attachedRecord) {
        addedRecords = root.ImageHistoryStore.addRecord(records, attachedRecord);
        return root.ImageHistoryStore.saveRecords(addedRecords);
      });
    }).then(function (nextRecords) {
      if (!nextRecords) { return; }
      records = nextRecords;
      renderHistoryWall();
    }, function (error) {
      setAppStatus('歷史記錄儲存失敗：' + (error && error.message ? error.message : '未知錯誤'), 'fail');
    });
  }

  function reloadHistoryAfterRecordUpdate(event) {
    var recordId = toText(event && event.detail && event.detail.id);
    var refreshedRecord;
    loadHistoryWall();
    if (recordId && selectedRecordId === recordId && el('historyDetailModal') && !el('historyDetailModal').hidden) {
      refreshedRecord = getSelectedRecord();
      if (refreshedRecord) {
        openHistoryDetail(refreshedRecord);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var clearHistory = el('clearHistory');
    var closeDetail = el('closeHistoryDetail');
    var detailModal = el('historyDetailModal');
    var downloadDetail = el('downloadHistoryDetail');
    var copyPrompt = el('copyHistoryPrompt');
    var copyShare = el('copyHistoryShareText');
    var exportJson = el('exportHistoryJson');
    var exportAllJson = el('exportAllHistoryJson');
    var regenerateDetail = el('regenerateHistoryDetail');
    var useCompositionDetail = el('useCompositionDetail');
    var historySearch = el('historySearch');
    var historyModelFilter = el('historyModelFilter');
    var historySizeFilter = el('historySizeFilter');
    var historyDateFrom = el('historyDateFrom');
    var historyDateTo = el('historyDateTo');
    var historyFavoritesOnly = el('historyFavoritesOnly');
    var historyCloudOnly = el('historyCloudOnly');
    var selectVisible = el('selectVisibleHistory');
    var deleteSelected = el('deleteSelectedHistory');
    var clearSelection = el('clearHistorySelection');
    var saveTags = el('saveHistoryTags');
    loadHistoryWall();
    if (clearHistory) {
      clearHistory.addEventListener('click', clearHistoryWall);
    }
    if (closeDetail) {
      closeDetail.addEventListener('click', closeHistoryDetail);
    }
    if (detailModal) {
      detailModal.addEventListener('click', function (event) {
        if (event.target === detailModal) {
          closeHistoryDetail();
        }
      });
    }
    if (downloadDetail) {
      downloadDetail.addEventListener('click', function () { downloadHistoryImage(getSelectedRecord()); });
    }
    if (copyPrompt) {
      copyPrompt.addEventListener('click', function () { copyHistoryPrompt(getSelectedRecord()); });
    }
    if (copyShare) {
      copyShare.addEventListener('click', copyHistoryShareText);
    }
    if (exportJson) {
      exportJson.addEventListener('click', exportHistoryJson);
    }
    if (exportAllJson) {
      exportAllJson.addEventListener('click', exportAllHistoryJson);
    }
    if (regenerateDetail) {
      regenerateDetail.addEventListener('click', regenerateHistoryDetail);
    }
    if (useCompositionDetail) {
      useCompositionDetail.addEventListener('click', function () {
        var record = getSelectedRecord();
        if (!record) { return; }
        if (root.ImageGenApp && typeof root.ImageGenApp.lockCompositionFromRecord === 'function') {
          if (root.ImageGenApp.lockCompositionFromRecord(record)) {
            closeHistoryDetail();
          }
        }
      });
    }
    if (historySearch) {
      historySearch.addEventListener('input', applyHistoryFilters);
    }
    if (historyModelFilter) {
      historyModelFilter.addEventListener('change', applyHistoryFilters);
    }
    if (historySizeFilter) {
      historySizeFilter.addEventListener('change', applyHistoryFilters);
    }
    if (historyDateFrom) {
      historyDateFrom.addEventListener('change', applyHistoryFilters);
    }
    if (historyDateTo) {
      historyDateTo.addEventListener('change', applyHistoryFilters);
    }
    if (historyFavoritesOnly) {
      historyFavoritesOnly.addEventListener('change', applyHistoryFilters);
    }
    if (historyCloudOnly) {
      historyCloudOnly.addEventListener('change', applyHistoryFilters);
    }
    if (selectVisible) {
      selectVisible.addEventListener('click', selectVisibleHistory);
    }
    if (deleteSelected) {
      deleteSelected.addEventListener('click', deleteSelectedHistoryRecords);
    }
    if (clearSelection) {
      clearSelection.addEventListener('click', clearHistorySelection);
    }
    if (saveTags) {
      saveTags.addEventListener('click', saveHistoryTags);
    }
    applyHistoryFilters();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && el('historyDetailModal') && !el('historyDetailModal').hidden) {
      closeHistoryDetail();
    }
  });
  document.addEventListener('imagegen:generated', addGeneratedRecord);
  document.addEventListener('history-record-updated', reloadHistoryAfterRecordUpdate);

  root.ImageHistoryWall = {
    render: renderHistoryWall,
    downloadHistoryImage: downloadHistoryImage,
    regenerateHistoryImage: regenerateHistoryImage,
    openHistoryDetail: openHistoryDetail,
    closeHistoryDetail: closeHistoryDetail,
    renderVersionList: renderVersionList,
    buildShareText: buildShareText,
    copyHistoryShareText: copyHistoryShareText,
    exportHistoryJson: exportHistoryJson,
    exportAllHistoryJson: exportAllHistoryJson,
    downloadJsonPayload: downloadJsonPayload,
    regenerateHistoryDetail: regenerateHistoryDetail,
    recordMatchesFilters: recordMatchesFilters,
    applyHistoryFilters: applyHistoryFilters,
    selectVisibleHistory: selectVisibleHistory,
    clearHistorySelection: clearHistorySelection,
    deleteSelectedHistoryRecords: deleteSelectedHistoryRecords,
    toggleHistoryFavorite: toggleHistoryFavorite,
    saveHistoryTags: saveHistoryTags,
    renderCloudLinks: renderCloudLinks,
    renderCloudLibrary: renderCloudLibrary,
    getCloudRecords: getCloudRecords,
    reloadHistoryAfterRecordUpdate: reloadHistoryAfterRecordUpdate,
    renderTagList: renderTagList
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
