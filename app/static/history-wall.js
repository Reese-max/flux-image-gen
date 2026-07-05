(function (root) {
  'use strict';

  var records = [];
  var selectedRecordId = '';
  var filters = { query: '', model: '', size: '', favoritesOnly: false };

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

  function validateHistoryImageUrl(image) {
    var source = toText(image);
    if (source.indexOf('data:image/') === 0 || source.indexOf('http://') === 0 || source.indexOf('https://') === 0) {
      return source;
    }
    throw new Error('歷史圖片網址格式不正確');
  }

  function downloadHistoryImage(record) {
    var link = document.createElement('a');
    var sourceRecord = record || getSelectedRecord();
    var id = toText(sourceRecord && sourceRecord.id) || Date.now().toString(36);
    var image;
    try {
      image = validateHistoryImageUrl(sourceRecord && sourceRecord.image);
    } catch (error) {
      setAppStatus('下載失敗：' + error.message, 'fail');
      return;
    }
    link.href = image;
    link.download = 'history_' + id + extensionFromImageData(link.href);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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

  function recordMatchesFilters(record) {
    var sourceRecord = normalizeRecordForUi(record) || record;
    var query = toText(filters.query).toLowerCase();
    var tags = getRecordTags(sourceRecord);
    var tagText = '';
    var searchable;
    var i;
    if (!sourceRecord) { return false; }
    if (filters.model && toText(sourceRecord.model) !== filters.model) { return false; }
    if (filters.size && toText(sourceRecord.size) !== filters.size) { return false; }
    if (filters.favoritesOnly && sourceRecord.favorite !== true) { return false; }
    if (!query) { return true; }
    for (i = 0; i < tags.length; i += 1) {
      tagText += ' ' + tags[i];
    }
    searchable = [
      toText(sourceRecord.prompt),
      toText(sourceRecord.providerPrompt),
      tagText
    ].join(' ').toLowerCase();
    return searchable.indexOf(query) !== -1;
  }

  function applyHistoryFilters() {
    var search = el('historySearch');
    var model = el('historyModelFilter');
    var size = el('historySizeFilter');
    var favoritesOnly = el('historyFavoritesOnly');
    filters.query = search ? toText(search.value) : '';
    filters.model = model ? toText(model.value) : '';
    filters.size = size ? toText(size.value) : '';
    filters.favoritesOnly = !!(favoritesOnly && favoritesOnly.checked);
    renderHistoryWall();
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
    parts.push('模型：' + (toText(record.model) || 'schnell'));
    parts.push('尺寸：' + (toText(record.size) || 'square'));
    parts.push('Seed：' + String(record.seed || 0));
    if (record.width && record.height) { parts.push('解析度：' + record.width + '×' + record.height); }
    if (record.provider) { parts.push('Provider：' + toText(record.provider)); }
    parts.push('版本：v' + String(record.versionNumber || 1));
    if (record.createdAt) { parts.push('建立：' + toText(record.createdAt)); }
    return parts.join(' · ');
  }

  function setDetailText(id, value) {
    var node = el(id);
    if (node) { node.textContent = toText(value); }
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
    if (tagEditor) {
      tagEditor.value = getRecordTags(sourceRecord).join(', ');
    }
    renderVersionList(sourceRecord);
    if (root.ModalA11y && typeof root.ModalA11y.open === 'function') {
      root.ModalA11y.open(modal, el('closeHistoryDetail'));
    } else {
      modal.hidden = false;
    }
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
      chip.textContent = label + ' · ' + (toText(version.model) || 'schnell') + ' · ' + (toText(version.size) || 'square');
      chip.addEventListener('click', function () {
        openHistoryDetail(version);
      });
      list.appendChild(chip);
    });
  }

  function buildShareText(record, hidePrompt) {
    var sourceRecord = normalizeRecordForUi(record);
    var lines = [];
    if (!sourceRecord) { return ''; }
    lines.push('AI 圖片作品');
    lines.push('模型：' + (toText(sourceRecord.model) || 'schnell'));
    lines.push('尺寸：' + (toText(sourceRecord.size) || 'square'));
    lines.push('Seed：' + String(sourceRecord.seed || 0));
    lines.push('版本：v' + String(sourceRecord.versionNumber || 1));
    if (sourceRecord.provider) { lines.push('Provider：' + toText(sourceRecord.provider)); }
    if (!hidePrompt) {
      lines.push('白話 prompt：' + toText(sourceRecord.prompt));
      lines.push('Provider prompt：' + toText(sourceRecord.providerPrompt));
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

  function exportHistoryJson() {
    var record = getSelectedRecord();
    var normalized;
    var blob;
    var url;
    var link;
    if (!record) {
      setAppStatus('尚無可匯出的作品', 'warn');
      return;
    }
    if (!root.URL || typeof root.URL.createObjectURL !== 'function') {
      setAppStatus('瀏覽器不支援匯出 JSON', 'fail');
      return;
    }
    normalized = normalizeRecordForUi(record);
    if (!normalized) {
      setAppStatus('作品資料格式不正確，無法匯出', 'fail');
      return;
    }
    blob = new Blob([JSON.stringify(normalized, null, 2)], { type: 'application/json' });
    url = root.URL.createObjectURL(blob);
    link = document.createElement('a');
    link.href = url;
    link.download = 'history_' + safeFilePart(normalized.id) + '.json';
    try {
      document.body.appendChild(link);
      link.click();
    } finally {
      if (link.parentNode) {
        link.parentNode.removeChild(link);
      }
      root.URL.revokeObjectURL(url);
    }
    setAppStatus('已匯出作品 JSON', 'done');
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
    if (typeof root.ImageGenApp.setNextGenerationSourceRecord === 'function') {
      root.ImageGenApp.setNextGenerationSourceRecord(record.id);
    }
    root.ImageGenApp.setGenerationSettings({
      prompt: toText(record && record.prompt),
      avoid: toText(record && record.avoid),
      model: toText(record && record.model) || 'schnell',
      size: toText(record && record.size) || 'square',
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
    appendMeta(meta, toText(record.model) || 'schnell');
    appendMeta(meta, toText(record.size) || 'square');
    appendMeta(meta, 'seed ' + String(record.seed || 0));
    if (record.provider) { appendMeta(meta, toText(record.provider)); }
    actions.className = 'history-actions';

    card.addEventListener('click', function () { openHistoryDetail(record); });
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
      deleteHistoryRecord(record.id);
    });

    actions.appendChild(detail);
    actions.appendChild(remove);
    body.appendChild(prompt);
    body.appendChild(meta);
    if (tagList) {
      body.appendChild(tagList);
    }
    body.appendChild(actions);
    card.appendChild(favorite);
    card.appendChild(thumb);
    card.appendChild(body);
    return card;
  }

  function renderHistoryWall() {
    var grid = el('historyGrid');
    var empty;
    var visibleRecords = [];
    var i;

    if (!grid) { return; }
    clearNode(grid);

    // 更新歷史分頁上的數量徽章（總數，與篩選無關）。
    if (typeof root.setHistoryCount === 'function') { root.setHistoryCount(records.length); }

    if (!records.length) {
      empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '尚無歷史記錄。成功生成圖片後會出現在這裡。';
      grid.appendChild(empty);
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
      return;
    }

    for (i = 0; i < visibleRecords.length; i += 1) {
      grid.appendChild(createHistoryCard(visibleRecords[i]));
    }
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
    nextRecords = safeStore('歷史記錄清除失敗', function () {
      return root.ImageHistoryStore.clearRecords();
    }, null);
    if (!nextRecords) { return; }
    records = nextRecords;
    renderHistoryWall();
    setAppStatus('已清空歷史記錄', 'done');
  }

  function addGeneratedRecord(event) {
    var nextRecords;
    if (!root.ImageHistoryStore || !event || !event.detail) { return; }
    nextRecords = safeStore('歷史記錄儲存失敗', function () {
      var sourceRecordId = toText(event.detail.sourceRecordId);
      var parentRecord = sourceRecordId ? root.ImageHistoryStore.findRecordById(records, sourceRecordId) : null;
      var recordToAdd = event.detail;
      var addedRecords;
      if (sourceRecordId && parentRecord && typeof root.ImageHistoryStore.createVersionRecord === 'function') {
        recordToAdd = root.ImageHistoryStore.createVersionRecord(records, parentRecord, event.detail);
      }
      addedRecords = root.ImageHistoryStore.addRecord(records, recordToAdd);
      return root.ImageHistoryStore.saveRecords(addedRecords);
    }, null);
    if (!nextRecords) { return; }
    records = nextRecords;
    renderHistoryWall();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var clearHistory = el('clearHistory');
    var closeDetail = el('closeHistoryDetail');
    var detailModal = el('historyDetailModal');
    var downloadDetail = el('downloadHistoryDetail');
    var copyPrompt = el('copyHistoryPrompt');
    var copyShare = el('copyHistoryShareText');
    var exportJson = el('exportHistoryJson');
    var regenerateDetail = el('regenerateHistoryDetail');
    var useCompositionDetail = el('useCompositionDetail');
    var historySearch = el('historySearch');
    var historyModelFilter = el('historyModelFilter');
    var historySizeFilter = el('historySizeFilter');
    var historyFavoritesOnly = el('historyFavoritesOnly');
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
    if (historyFavoritesOnly) {
      historyFavoritesOnly.addEventListener('change', applyHistoryFilters);
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
    regenerateHistoryDetail: regenerateHistoryDetail,
    recordMatchesFilters: recordMatchesFilters,
    applyHistoryFilters: applyHistoryFilters,
    toggleHistoryFavorite: toggleHistoryFavorite,
    saveHistoryTags: saveHistoryTags,
    renderTagList: renderTagList
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
