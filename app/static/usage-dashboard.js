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
    usageToken: document.getElementById('usageAdminToken')
  };
  var loadedOnce = false;

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function setStatus(message, kind) {
    if (!els.status) { return; }
    els.status.textContent = message || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
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
    var token = els.usageToken && els.usageToken.value ? els.usageToken.value : '';
    if (!token) {
      setStatus('請先輸入站長 Token；此欄位只保留在目前頁面，不寫入 localStorage。', 'fail');
      return Promise.resolve();
    }
    loadedOnce = true;
    if (els.refresh) { els.refresh.disabled = true; }
    setStatus('正在載入用量資料…', 'busy');
    return fetch('/api/usage?date=' + encodeURIComponent(date), {
      method: 'GET',
      headers: { 'X-Usage-Admin-Token': token }
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

  if (els.date && !els.date.value) { els.date.value = todayKey(); }
  if (els.refresh) { els.refresh.addEventListener('click', fetchUsage); }
  if (els.date) { els.date.addEventListener('change', fetchUsage); }
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
    renderUsage: renderUsage,
    renderUsageBucket: renderUsageBucket
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
