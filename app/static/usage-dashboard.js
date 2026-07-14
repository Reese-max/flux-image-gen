// 成本 Dashboard：讀取 /api/usage 並以站長可讀摘要呈現。
// 前端只顯示聚合指標；API 回應不得包含 prompt、圖片內容、完整 IP 或金鑰。
(function (root) {
  'use strict';
  if (typeof document === 'undefined') { return; }

  var panel = document.getElementById('usageDashboard');
  if (!panel) { return; }

  var els = {
    date: document.getElementById('usageDate'),
    refresh: document.getElementById('refreshUsage'),
    status: document.getElementById('usageStatus'),
    generatedImages: document.getElementById('usageGeneratedImages'),
    failedRequests: document.getElementById('usageFailedRequests'),
    successRequests: document.getElementById('usageSuccessRequests'),
    estimatedCost: document.getElementById('usageEstimatedCost'),
    averageMs: document.getElementById('usageAverageMs'),
    errorRate: document.getElementById('usageErrorRate'),
    totalRequests: document.getElementById('usageTotalRequests'),
    totalAttempts: document.getElementById('usageTotalAttempts'),
    alerts: document.getElementById('usageAlerts'),
    byModel: document.getElementById('usageByModel'),
    byProvider: document.getElementById('usageByProvider'),
    byRoute: document.getElementById('usageByRoute'),
    byError: document.getElementById('usageByError'),
    galleryToken: document.getElementById('galleryAdminToken'),
    galleryRefresh: document.getElementById('refreshGalleryAdmin'),
    galleryNext: document.getElementById('galleryAdminNext'),
    galleryStatus: document.getElementById('galleryAdminStatus'),
    galleryCount: document.getElementById('galleryAdminCount'),
    galleryList: document.getElementById('galleryAdminList'),
    gallerySearch: document.getElementById('galleryAdminSearch'),
    galleryVisibility: document.getElementById('galleryAdminVisibility'),
    galleryPromptPublic: document.getElementById('galleryAdminPromptPublic'),
    galleryModel: document.getElementById('galleryAdminModel')
  };
  var loadedOnce = false;
  var galleryCursor = '';
  var galleryItems = [];
  var galleryLoading = false;

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function setStatus(message, kind) {
    if (!els.status) { return; }
    els.status.textContent = message || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setGalleryStatus(message, kind) {
    if (!els.galleryStatus) { return; }
    els.galleryStatus.textContent = message || '';
    els.galleryStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setText(node, value) {
    if (node) { node.textContent = value; }
  }

  function numberText(value) {
    var n = Number(value || 0);
    return String(Math.round(n));
  }

  function costText(value) {
    var n = Number(value || 0);
    return '$' + n.toFixed(4);
  }

  function percentText(value) {
    var n = Number(value || 0);
    return (n * 100).toFixed(1) + '%';
  }

  function msText(value) {
    var n = Number(value || 0);
    if (n >= 1000) { return (n / 1000).toFixed(1) + ' 秒'; }
    return Math.round(n) + ' ms';
  }

  function clearNode(node) {
    if (!node) { return; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function appendCell(row, text, className) {
    var cell = document.createElement('span');
    if (className) { cell.className = className; }
    cell.textContent = text;
    row.appendChild(cell);
  }

  function renderEmpty(node, text) {
    clearNode(node);
    var empty = document.createElement('p');
    empty.className = 'usage-empty';
    empty.textContent = text || '尚無資料';
    node.appendChild(empty);
  }

  function safeGalleryUrl(value) {
    var text = typeof value === 'string' ? value : '';
    if (text.indexOf('/gallery/') === 0 || text.indexOf('/share/') === 0) { return text; }
    return '';
  }

  function formatDateTime(value) {
    if (!value) { return '未知時間'; }
    var date = new Date(value);
    if (isNaN(date.getTime())) { return String(value); }
    return date.toLocaleString('zh-TW', { hour12: false });
  }

  function appendGalleryMeta(row, text) {
    var item = document.createElement('span');
    item.textContent = text;
    row.appendChild(item);
  }

  function appendGalleryLink(row, label, href) {
    var safeUrl = safeGalleryUrl(href);
    if (!safeUrl) { return; }
    var link = document.createElement('a');
    link.className = 'btn mini secondary';
    link.href = safeUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = label;
    row.appendChild(link);
  }

  function copyGalleryAdminUrl(value, label) {
    var safeUrl = safeGalleryUrl(value);
    var textArea;
    if (!safeUrl) {
      setGalleryStatus('無法複製：連結格式不安全或不存在。', 'fail');
      return;
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(safeUrl)
        .then(function () { setGalleryStatus('已複製' + label + '連結。', 'done'); })
        .catch(function () { setGalleryStatus('複製失敗，請手動開啟連結後複製。', 'fail'); });
      return;
    }
    try {
      textArea = document.createElement('textarea');
      textArea.value = safeUrl;
      textArea.setAttribute('readonly', 'readonly');
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setGalleryStatus('已複製' + label + '連結。', 'done');
    } catch (error) {
      if (textArea && textArea.parentNode) { textArea.parentNode.removeChild(textArea); }
      setGalleryStatus('複製失敗，請手動開啟連結後複製。', 'fail');
    }
  }

  function appendGalleryCopyButton(row, label, href) {
    var safeUrl = safeGalleryUrl(href);
    if (!safeUrl) { return; }
    var button = document.createElement('button');
    button.className = 'btn mini secondary';
    button.type = 'button';
    button.textContent = '複製' + label;
    button.addEventListener('click', function () {
      copyGalleryAdminUrl(safeUrl, label);
    });
    row.appendChild(button);
  }

  function createGalleryAdminCard(item) {
    var card = document.createElement('article');
    var imageUrl = safeGalleryUrl(item && item.imageUrl);
    var title = item && item.title ? item.title : '未命名雲端作品';
    var visibility = item && item.visibility ? item.visibility : 'private';
    var promptPublic = item && item.promptPublic ? 'Prompt 公開' : 'Prompt 隱藏';
    card.className = 'gallery-admin-item';

    if (imageUrl) {
      var image = document.createElement('img');
      image.className = 'gallery-admin-thumb';
      image.src = imageUrl;
      image.alt = title + ' 預覽圖';
      image.loading = 'lazy';
      card.appendChild(image);
    }

    var body = document.createElement('div');
    body.className = 'gallery-admin-body';
    var heading = document.createElement('h4');
    heading.textContent = title;
    body.appendChild(heading);

    var meta = document.createElement('div');
    meta.className = 'gallery-admin-meta';
    appendGalleryMeta(meta, item && item.id ? item.id : '無 id');
    appendGalleryMeta(meta, visibility);
    appendGalleryMeta(meta, promptPublic);
    appendGalleryMeta(meta, item && item.model ? item.model : '未知模型');
    appendGalleryMeta(meta, item && item.size ? item.size : '未知尺寸');
    appendGalleryMeta(meta, formatDateTime(item && item.createdAt));
    body.appendChild(meta);

    var actions = document.createElement('div');
    actions.className = 'gallery-admin-actions';
    appendGalleryLink(actions, '開啟圖片', item && item.imageUrl);
    appendGalleryLink(actions, '開啟分享頁', item && item.shareUrl);
    appendGalleryCopyButton(actions, '圖片', item && item.imageUrl);
    appendGalleryCopyButton(actions, '分享頁', item && item.shareUrl);
    body.appendChild(actions);
    card.appendChild(body);
    return card;
  }

  function galleryFilterText(value) {
    return String(value || '').toLowerCase();
  }

  function galleryItemMatchesFilters(item) {
    var query = galleryFilterText(els.gallerySearch && els.gallerySearch.value);
    var visibility = els.galleryVisibility && els.galleryVisibility.value ? els.galleryVisibility.value : '';
    var promptPublic = els.galleryPromptPublic && els.galleryPromptPublic.value ? els.galleryPromptPublic.value : '';
    var model = galleryFilterText(els.galleryModel && els.galleryModel.value);
    var haystack = galleryFilterText([
      item && item.id,
      item && item.title,
      item && item.model,
      item && item.size,
      item && item.mode,
      item && item.styleLabel,
      item && item.useCaseLabel,
      item && item.createdAt
    ].join(' '));
    if (query && haystack.indexOf(query) < 0) { return false; }
    if (visibility && (!item || item.visibility !== visibility)) { return false; }
    if (promptPublic && String(Boolean(item && item.promptPublic)) !== promptPublic) { return false; }
    if (model && galleryFilterText(item && item.model).indexOf(model) < 0) { return false; }
    return true;
  }

  function applyGalleryAdminFilters() {
    var visible = [];
    clearNode(els.galleryList);
    galleryItems.forEach(function (item) {
      if (galleryItemMatchesFilters(item)) { visible.push(item); }
    });
    if (!galleryItems.length) {
      renderEmpty(els.galleryList, '雲端圖庫尚無作品，或目前 R2 metadata 尚未建立。');
    } else if (!visible.length) {
      renderEmpty(els.galleryList, '目前篩選沒有符合的雲端作品。');
    } else {
      visible.forEach(function (item) {
        els.galleryList.appendChild(createGalleryAdminCard(item));
      });
    }
    if (els.galleryCount) {
      els.galleryCount.textContent = visible.length + ' / ' + galleryItems.length + ' 筆符合篩選' +
        (galleryCursor ? '，可載入下一頁' : '');
    }
  }

  function renderGalleryAdmin(data, append) {
    var items = data && data.items ? data.items : [];
    if (!append) {
      galleryItems = [];
      clearNode(els.galleryList);
    }
    Array.prototype.push.apply(galleryItems, items);
    galleryCursor = data && data.cursor ? data.cursor : '';
    applyGalleryAdminFilters();
    if (els.galleryNext) { els.galleryNext.disabled = !galleryCursor || galleryLoading; }
    setGalleryStatus('已讀取雲端圖庫；回應只含公開管理摘要，不含刪除 token hash 或未公開 prompt。', 'done');
  }

  function sortedKeys(objectValue) {
    var keys = [];
    var key;
    for (key in (objectValue || {})) {
      if (Object.prototype.hasOwnProperty.call(objectValue, key)) { keys.push(key); }
    }
    keys.sort(function (a, b) {
      var left = objectValue[a] && objectValue[a].images ? objectValue[a].images : objectValue[a];
      var right = objectValue[b] && objectValue[b].images ? objectValue[b].images : objectValue[b];
      return Number(right || 0) - Number(left || 0);
    });
    return keys;
  }

  function renderUsageBucket(node, bucket) {
    var keys = sortedKeys(bucket);
    clearNode(node);
    if (!keys.length) { renderEmpty(node, '尚無用量'); return; }

    var head = document.createElement('div');
    head.className = 'usage-row usage-row-head';
    appendCell(head, '項目');
    appendCell(head, '請求');
    appendCell(head, '成功');
    appendCell(head, '失敗');
    appendCell(head, '圖數');
    appendCell(head, '嘗試');
    appendCell(head, '成本');
    node.appendChild(head);

    keys.forEach(function (key) {
      var item = bucket[key] || {};
      var row = document.createElement('div');
      row.className = 'usage-row';
      appendCell(row, key, 'usage-key');
      appendCell(row, numberText(item.requests));
      appendCell(row, numberText(item.successes));
      appendCell(row, numberText(item.failures));
      appendCell(row, numberText(item.images));
      appendCell(row, numberText(item.attempts));
      appendCell(row, costText(item.estimatedCostUsd));
      node.appendChild(row);
    });
  }

  function renderErrorBucket(node, bucket) {
    var keys = sortedKeys(bucket);
    clearNode(node);
    if (!keys.length) { renderEmpty(node, '目前沒有錯誤'); return; }
    keys.forEach(function (key) {
      var row = document.createElement('div');
      row.className = 'usage-error-row';
      appendCell(row, key, 'usage-key');
      appendCell(row, numberText(bucket[key]), 'usage-count');
      node.appendChild(row);
    });
  }

  function renderAlerts(alerts) {
    clearNode(els.alerts);
    (alerts || []).forEach(function (alert) {
      var item = document.createElement('p');
      item.className = 'usage-alert';
      item.textContent = (alert && alert.message ? alert.message : '用量提醒') +
        (alert && alert.threshold ? '（' + alert.actual + '/' + alert.threshold + '）' : '');
      els.alerts.appendChild(item);
    });
  }

  function renderUsage(data) {
    setText(els.generatedImages, numberText(data.generatedImages));
    setText(els.failedRequests, numberText(data.failedRequests));
    setText(els.successRequests, numberText(data.successRequests));
    setText(els.estimatedCost, costText(data.estimatedCostUsd));
    setText(els.averageMs, msText(data.averageGenerationMs));
    setText(els.errorRate, percentText(data.errorRate));
    setText(els.totalRequests, numberText(data.totalRequests));
    setText(els.totalAttempts, numberText(data.totalAttempts));
    renderAlerts(data.alerts);
    renderUsageBucket(els.byModel, data.byModel || {});
    renderUsageBucket(els.byProvider, data.byProvider || {});
    renderUsageBucket(els.byRoute, data.byRoute || {});
    renderErrorBucket(els.byError, data.byErrorCode || {});
    setStatus('已載入 ' + (data.date || '') + ' 用量，最後更新：' + (data.updatedAt || '未知'), 'done');
  }

  function fetchUsage() {
    var date = els.date && els.date.value ? els.date.value : todayKey();
    var token = els.galleryToken && els.galleryToken.value ? els.galleryToken.value : '';
    if (!token) {
      setStatus('請先輸入站長 Token；此欄位只保留在目前頁面，不寫入 localStorage。', 'fail');
      return Promise.resolve();
    }
    loadedOnce = true;
    if (els.refresh) { els.refresh.disabled = true; }
    setStatus('正在載入用量資料…', 'busy');
    return fetch('/api/usage?date=' + encodeURIComponent(date), {
      method: 'GET',
      headers: { 'X-Gallery-Admin-Token': token }
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) {
            throw new Error(data && data.error ? data.error : '用量資料讀取失敗');
          }
          return data;
        });
      })
      .then(renderUsage)
      .catch(function (error) {
        setStatus('用量資料讀取失敗：' + (error && error.message ? error.message : error), 'fail');
      })
      .then(function () {
        if (els.refresh) { els.refresh.disabled = false; }
      });
  }

  function galleryErrorMessage(response, data) {
    var code = data && data.code ? data.code : '';
    if (response && response.status === 401) { return '站長 Token 不正確，請確認 GALLERY_ADMIN_TOKEN。'; }
    if (code === 'admin_gallery_disabled') { return '後端尚未設定 GALLERY_ADMIN_TOKEN，雲端圖庫管理未啟用。'; }
    if (code === 'gallery_disabled') { return '雲端圖庫尚未啟用，請確認 R2 IMAGE_BUCKET 綁定。'; }
    return data && data.error ? data.error : '雲端圖庫讀取失敗';
  }

  function fetchGalleryAdmin(reset) {
    var token = els.galleryToken && els.galleryToken.value ? els.galleryToken.value : '';
    var url = '/api/gallery?limit=50';
    if (galleryLoading) { return Promise.resolve(); }
    if (!token) {
      setGalleryStatus('請先輸入站長 Token；此欄位只保留在目前頁面，不寫入 localStorage。', 'fail');
      return Promise.resolve();
    }
    if (!reset && galleryCursor) { url += '&cursor=' + encodeURIComponent(galleryCursor); }
    if (reset) { galleryCursor = ''; }
    galleryLoading = true;
    if (els.galleryRefresh) { els.galleryRefresh.disabled = true; }
    if (els.galleryNext) { els.galleryNext.disabled = true; }
    setGalleryStatus('正在讀取雲端圖庫 metadata…', 'busy');
    return fetch(url, {
      method: 'GET',
      headers: { 'X-Gallery-Admin-Token': token }
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) { throw new Error(galleryErrorMessage(response, data)); }
          return data;
        });
      })
      .then(function (data) { renderGalleryAdmin(data, !reset); })
      .catch(function (error) {
        setGalleryStatus('雲端圖庫讀取失敗：' + (error && error.message ? error.message : error), 'fail');
      })
      .then(function () {
        galleryLoading = false;
        if (els.galleryRefresh) { els.galleryRefresh.disabled = false; }
        if (els.galleryNext) { els.galleryNext.disabled = !galleryCursor; }
      });
  }

  if (els.date && !els.date.value) { els.date.value = todayKey(); }
  if (els.refresh) { els.refresh.addEventListener('click', fetchUsage); }
  if (els.date) { els.date.addEventListener('change', fetchUsage); }
  if (els.galleryRefresh) { els.galleryRefresh.addEventListener('click', function () { fetchGalleryAdmin(true); }); }
  if (els.galleryNext) { els.galleryNext.addEventListener('click', function () { fetchGalleryAdmin(false); }); }
  [els.gallerySearch, els.galleryVisibility, els.galleryPromptPublic, els.galleryModel].forEach(function (control) {
    if (control) { control.addEventListener('input', applyGalleryAdminFilters); }
    if (control) { control.addEventListener('change', applyGalleryAdminFilters); }
  });
  var usageTab = document.getElementById('tab-usage');
  if (usageTab) {
    usageTab.addEventListener('click', function () {
      if (!loadedOnce) { fetchUsage(); }
    });
  }
  window.addEventListener('hashchange', function () {
    if (!loadedOnce && location.hash === '#usage') { fetchUsage(); }
  });
  if (document.body && document.body.getAttribute('data-tab') === 'usage') { fetchUsage(); }
  panel.addEventListener('usage:refresh', fetchUsage);

  root.UsageDashboard = {
    fetchUsage: fetchUsage,
    fetchGalleryAdmin: fetchGalleryAdmin,
    renderUsage: renderUsage,
    renderUsageBucket: renderUsageBucket,
    renderGalleryAdmin: renderGalleryAdmin,
    applyGalleryAdminFilters: applyGalleryAdminFilters
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
