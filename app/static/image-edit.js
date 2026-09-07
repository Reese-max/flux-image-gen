// AI 改圖前端：選圖 → canvas 縮到 <512 → 帶 prompt POST /edit（multipart，欄位
// 名 images 可重複）→ 顯示結果。純函式掛在 root.ImageEdit 供 node 測試；DOM 綁定
// 只在瀏覽器（存在 #editPanel）時執行。後端契約見 app/main.py 與 cloudflare/src/index.js。
(function (root) {
  'use strict';

  var MAX_EDIT_IMAGES = 4;
  // 嚴格小於 512：FLUX.2 klein 每張輸入圖須 < 512x512。
  var MAX_EDIT_DIM = 511;
  var REFERENCE_ROLES = {
    character: '角色',
    product: '產品',
    style: '風格',
    composition: '構圖'
  };

  // 等比縮到框內，只縮不放大；回傳整數寬高。
  function computeResizeDims(width, height, maxDim) {
    var w = Math.max(1, Math.floor(width));
    var h = Math.max(1, Math.floor(height));
    var cap = maxDim || MAX_EDIT_DIM;
    if (w <= cap && h <= cap) { return { width: w, height: h }; }
    var scale = cap / Math.max(w, h);
    return {
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale))
    };
  }

  // 驗證選圖數量，回傳 { ok, error }。
  function validateEditSelection(count) {
    if (!count || count < 1) { return { ok: false, error: '請至少選 1 張圖片' }; }
    if (count > MAX_EDIT_IMAGES) { return { ok: false, error: '最多只能上傳 ' + MAX_EDIT_IMAGES + ' 張圖片' }; }
    return { ok: true, error: '' };
  }

  function normalizeReferenceRole(role) {
    return REFERENCE_ROLES[role] ? role : 'style';
  }

  function composeEditPrompt(prompt, references, options) {
    var cleanPrompt = String(prompt == null ? '' : prompt).replace(/\s+/g, ' ').trim();
    var mode = options && options.mode ? String(options.mode) : 'general';
    var parts = [];
    var roles = [];
    (references || []).forEach(function (ref, index) {
      var role = normalizeReferenceRole(ref && ref.role);
      roles.push('image ' + index + ' = ' + REFERENCE_ROLES[role] + '參考');
    });
    if (roles.length) {
      parts.push('參考圖用途：' + roles.join('；') + '。');
    }
    if (mode === 'character') {
      parts.push('角色一致模式：保持角色的臉部輪廓、髮型、服裝與主要特徵，但允許姿勢與場景自然變化；不得改變核心角色身份。');
    } else if (mode === 'product') {
      parts.push('產品照模式：保持產品外觀、比例、Logo 位置與材質一致，避免改變商品設計。');
      if (options && options.background) { parts.push('背景：' + options.background + '。'); }
      if (options && options.lighting) { parts.push('光線：' + options.lighting + '。'); }
    }
    if (cleanPrompt) { parts.push(cleanPrompt); }
    return parts.join(' ');
  }

  // 組出送到 /edit 的 FormData：prompt + 多個同名 images 欄位。
  function buildEditFormData(prompt, blobs, turnstileToken) {
    var fd = new FormData();
    fd.append('prompt', String(prompt == null ? '' : prompt));
    if (turnstileToken) {
      fd.append('turnstileToken', String(turnstileToken));
    }
    (blobs || []).forEach(function (blob, i) {
      fd.append('images', blob, 'input_image_' + i + '.png');
    });
    return fd;
  }

  // 把 /edit 回應映射成 { image, error }：成功回圖，否則回後端 error 或通用 HTTP 訊息。
  function mapEditResponse(ok, status, data) {
    if (ok && data && data.image) { return { image: data.image, error: null, data: data }; }
    var msg = (data && data.error) ? data.error : ('改圖失敗（HTTP ' + status + '）');
    return { image: null, error: msg, data: data || {} };
  }

  var EDIT_PROVIDER_UNAVAILABLE_MESSAGE = '此環境尚未啟用 Workers AI 改圖；仍可先整理參考圖與指令，啟用後再送出。';

  // 只有健康檢查明確回報 workersAI=false 時才停用，避免網路錯誤或舊版後端造成誤判。
  function editAvailabilityFromHealth(data) {
    var providers = data && data.providers;
    if (providers && typeof providers === 'object' && typeof providers.workersAI === 'boolean') {
      return {
        available: providers.workersAI,
        message: providers.workersAI ? '' : EDIT_PROVIDER_UNAVAILABLE_MESSAGE
      };
    }
    if (data && Array.isArray(data.providerList)) {
      return {
        available: data.providerList.indexOf('workers-ai') !== -1,
        message: data.providerList.indexOf('workers-ai') !== -1 ? '' : EDIT_PROVIDER_UNAVAILABLE_MESSAGE
      };
    }
    return { available: null, message: '' };
  }

  root.ImageEdit = {
    MAX_EDIT_IMAGES: MAX_EDIT_IMAGES,
    MAX_EDIT_DIM: MAX_EDIT_DIM,
    computeResizeDims: computeResizeDims,
    validateEditSelection: validateEditSelection,
    normalizeReferenceRole: normalizeReferenceRole,
    composeEditPrompt: composeEditPrompt,
    buildEditFormData: buildEditFormData,
    mapEditResponse: mapEditResponse,
    editAvailabilityFromHealth: editAvailabilityFromHealth
  };

  // ---- 以下為瀏覽器 DOM 綁定，node 測試環境不執行 ----
  if (typeof document === 'undefined') { return; }
  var panel = document.getElementById('editPanel');
  if (!panel) { return; }

  var filesInput = document.getElementById('editFiles');
  var dropEl = document.getElementById('editDrop');
  var thumbs = document.getElementById('editThumbs');
  var promptEl = document.getElementById('editPrompt');
  var goBtn = document.getElementById('editGo');
  var dlLink = document.getElementById('editDl');
  var statusEl = document.getElementById('editStatus');
  var stage = document.getElementById('editStage');
  var previewBadge = document.getElementById('editPreviewBadge');
  var referenceCount = document.getElementById('editReferenceCount');
  var productControls = document.getElementById('editProductControls');
  var promptLabel = document.getElementById('editPromptLabel');
  var productBackground = document.getElementById('editProductBackground');
  var productLighting = document.getElementById('editProductLighting');
  var STAGE_PLACEHOLDER = '<div class="edit-empty-state"><span aria-hidden="true">◫</span><strong>結果會顯示在這裡</strong><p>左側加入參考圖片並輸入指令後，按下「開始改圖」。</p></div>';
  var EDIT_MODE_COPY = {
    general: {
      label: '改圖指令',
      placeholder: '例如：把背景換成雨夜街道，保留主體構圖與色彩層次。'
    },
    character: {
      label: '角色變化指令',
      placeholder: '例如：保持角色臉部、髮型與服裝特徵，改成在咖啡廳看書。'
    },
    product: {
      label: '產品攝影指令',
      placeholder: '例如：保持產品外觀一致，製作適合電商首頁的高級棚拍主圖。'
    }
  };

  var selected = []; // { blob, url, name, role }
  var editMode = 'general';
  var editInFlight = false;
  var providerAvailable = null;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setPreviewState(state, label) {
    if (!previewBadge) { return; }
    previewBadge.setAttribute('data-state', state || 'idle');
    previewBadge.innerHTML = '<i aria-hidden="true"></i>' + (label || '等待執行');
  }

  function updateGoButton() {
    var disabled = editInFlight || providerAvailable === false;
    goBtn.disabled = disabled;
    goBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function applyHealth(data) {
    var availability = editAvailabilityFromHealth(data);
    providerAvailable = availability.available;
    updateGoButton();
    if (providerAvailable === false) {
      setStatus(availability.message, 'fail');
      setPreviewState('error', '服務不可用');
    } else if (statusEl.textContent === EDIT_PROVIDER_UNAVAILABLE_MESSAGE) {
      setStatus('', '');
      setPreviewState('idle', '等待執行');
    }
  }

  root.ImageEdit.applyHealth = applyHealth;

  // 清掉上一張結果並停用下載連結，避免失敗時仍殘留舊圖/可下載舊圖。
  function resetResult() {
    stage.innerHTML = STAGE_PLACEHOLDER;
    setPreviewState('idle', '等待執行');
    if (dlLink && dlLink._blobUrl) {
      try { URL.revokeObjectURL(dlLink._blobUrl); } catch (_) {}
      dlLink._blobUrl = null;
    }
    dlLink.classList.add('is-disabled');
    dlLink.setAttribute('aria-disabled', 'true');
    dlLink.removeAttribute('href');
  }

  // 讀檔 → 縮圖 → 回傳 PNG Blob。
  function resizeFileToBlob(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var dims = computeResizeDims(img.naturalWidth || img.width, img.naturalHeight || img.height, MAX_EDIT_DIM);
          var canvas = document.createElement('canvas');
          canvas.width = dims.width;
          canvas.height = dims.height;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, dims.width, dims.height);
          URL.revokeObjectURL(url);
          canvas.toBlob(function (blob) {
            if (blob) { resolve(blob); } else { reject(new Error('canvas toBlob 失敗')); }
          }, 'image/png');
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('無法讀取圖片')); };
      img.src = url;
    });
  }

  function renderThumbs() {
    thumbs.innerHTML = '';
    selected.forEach(function (item, index) {
      var wrap = document.createElement('div');
      wrap.className = 'edit-thumb';
      var im = document.createElement('img');
      im.src = item.url;
      im.alt = '第 ' + (index + 1) + ' 張';
      var tag = document.createElement('span');
      tag.className = 'edit-thumb-tag';
      tag.textContent = '第 ' + (index + 1) + ' 張';
      var role = document.createElement('select');
      role.className = 'edit-thumb-role';
      role.setAttribute('aria-label', '設定第 ' + (index + 1) + ' 張的參考用途');
      Object.keys(REFERENCE_ROLES).forEach(function (key) {
        var option = document.createElement('option');
        option.value = key;
        option.textContent = REFERENCE_ROLES[key];
        role.appendChild(option);
      });
      role.value = normalizeReferenceRole(item.role);
      role.addEventListener('change', function () {
        item.role = normalizeReferenceRole(role.value);
      });
      var moveUp = document.createElement('button');
      moveUp.type = 'button';
      moveUp.className = 'edit-thumb-move edit-thumb-up';
      moveUp.setAttribute('aria-label', '將 image ' + index + ' 往前排序');
      moveUp.textContent = '↑';
      moveUp.disabled = index === 0;
      moveUp.addEventListener('click', function () {
        var tmp;
        if (index <= 0) { return; }
        tmp = selected[index - 1];
        selected[index - 1] = selected[index];
        selected[index] = tmp;
        renderThumbs();
      });
      var moveDown = document.createElement('button');
      moveDown.type = 'button';
      moveDown.className = 'edit-thumb-move edit-thumb-down';
      moveDown.setAttribute('aria-label', '將 image ' + index + ' 往後排序');
      moveDown.textContent = '↓';
      moveDown.disabled = index === selected.length - 1;
      moveDown.addEventListener('click', function () {
        var tmp;
        if (index >= selected.length - 1) { return; }
        tmp = selected[index + 1];
        selected[index + 1] = selected[index];
        selected[index] = tmp;
        renderThumbs();
      });
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'edit-thumb-remove';
      rm.setAttribute('aria-label', '移除 image ' + index);
      rm.textContent = '×';
      rm.addEventListener('click', function () {
        URL.revokeObjectURL(item.url);
        selected.splice(index, 1);
        renderThumbs();
      });
      wrap.appendChild(im);
      wrap.appendChild(tag);
      wrap.appendChild(role);
      wrap.appendChild(moveUp);
      wrap.appendChild(moveDown);
      wrap.appendChild(rm);
      thumbs.appendChild(wrap);
    });
    if (referenceCount) {
      referenceCount.textContent = String(selected.length) + ' / ' + String(MAX_EDIT_IMAGES);
      referenceCount.setAttribute('aria-label', '已加入 ' + String(selected.length) + ' 張參考圖，最多 ' + String(MAX_EDIT_IMAGES) + ' 張');
      referenceCount.classList.toggle('has-files', selected.length > 0);
    }
    if (dropEl) {
      dropEl.classList.toggle('has-files', selected.length > 0);
    }
  }

  // 處理一批選到的檔案：逐張縮圖（allSettled，單張失敗不拖累其他），縮好後才建
  // objectURL 並在仍有空位時加入 selected，避免部分失敗或超量時洩漏 objectURL。
  function handlePickedFiles(fileList) {
    var picked = Array.prototype.slice.call(fileList || []);
    if (!picked.length) { return; }
    if (selected.length >= MAX_EDIT_IMAGES) {
      setStatus('最多只能 ' + MAX_EDIT_IMAGES + ' 張，請先移除再加', 'fail');
      return;
    }
    Promise.all(picked.map(function (file) {
      return resizeFileToBlob(file).then(
        function (blob) { return { ok: true, blob: blob }; },
        function () { return { ok: false }; }
      );
    })).then(function (results) {
      var failed = 0, dropped = 0;
      results.forEach(function (r) {
        if (!r.ok) { failed++; return; }
        if (selected.length < MAX_EDIT_IMAGES) {
          selected.push({ blob: r.blob, url: URL.createObjectURL(r.blob), name: 'image.png', role: editMode === 'product' ? 'product' : (editMode === 'character' ? 'character' : 'style') });
        } else {
          dropped++; // 超過上限：未建 URL，直接丟棄，無洩漏
        }
      });
      renderThumbs();
      if (failed && !selected.length) {
        setStatus('圖片都無法處理，請換有效的影像檔', 'fail');
      } else if (failed) {
        setStatus('有 ' + failed + ' 張無法處理，已略過', '');
      } else if (dropped) {
        setStatus('超過 ' + MAX_EDIT_IMAGES + ' 張，多的已略過', '');
      } else {
        setStatus('已加入 ' + selected.length + ' / ' + MAX_EDIT_IMAGES + ' 張參考圖，接著輸入改圖指令', 'done');
      }
    });
  }

  filesInput.addEventListener('change', function () {
    handlePickedFiles(filesInput.files);
    filesInput.value = ''; // 允許重選同一檔
  });

  // 拖放支援：drop-zone 樣式暗示可拖放，補上 handler 並阻止瀏覽器預設導航離開。
  if (dropEl) {
    dropEl.addEventListener('dragover', function (e) { e.preventDefault(); });
    dropEl.addEventListener('drop', function (e) {
      e.preventDefault();
      handlePickedFiles(e.dataTransfer && e.dataTransfer.files);
    });
  }
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  function setEditMode(mode) {
    var copy;
    editMode = mode === 'character' || mode === 'product' ? mode : 'general';
    copy = EDIT_MODE_COPY[editMode];
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit-mode]'), function (button) {
      var active = button.getAttribute('data-edit-mode') === editMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (productControls) {
      productControls.hidden = editMode !== 'product';
    }
    if (promptLabel) {
      promptLabel.textContent = copy.label;
    }
    if (promptEl) {
      promptEl.placeholder = copy.placeholder;
      promptEl.setAttribute('aria-label', copy.label);
    }
    selected.forEach(function (item) {
      if (editMode === 'character') { item.role = 'character'; }
      if (editMode === 'product') { item.role = 'product'; }
    });
    renderThumbs();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-edit-mode]'), function (button) {
    button.addEventListener('click', function () {
      setEditMode(button.getAttribute('data-edit-mode'));
    });
  });
  setEditMode('general');

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

  function showResult(dataUrl) {
    var blob;
    stage.innerHTML = '';
    var im = document.createElement('img');
    im.src = dataUrl;
    im.alt = 'AI 改圖結果';
    im.className = 'stage-img';
    stage.appendChild(im);
    if (dlLink._blobUrl) {
      try { URL.revokeObjectURL(dlLink._blobUrl); } catch (_) {}
      dlLink._blobUrl = null;
    }
    blob = dataUrlToBlob(dataUrl);
    if (blob && typeof URL.createObjectURL === 'function') {
      dlLink._blobUrl = URL.createObjectURL(blob);
      dlLink.href = dlLink._blobUrl;
    } else {
      dlLink.href = dataUrl;
    }
    dlLink.download = 'edit_' + Date.now().toString(36) + (dataUrl.indexOf('data:image/jpeg') === 0 ? '.jpg' : '.png');
    dlLink.classList.remove('is-disabled');
    dlLink.removeAttribute('aria-disabled');
    setPreviewState('done', '完成');
  }

  function makeHistoryRecordId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    return 'edit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function dispatchEditHistoryRecord(data, image, prompt, finalPrompt, inputHashes) {
    var source = data || {};
    var detail;
    if (typeof document.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') { return; }
    detail = {
      id: makeHistoryRecordId(),
      image: image,
      thumbnail: image,
      prompt: prompt,
      providerPrompt: finalPrompt,
      avoid: '',
      model: typeof source.model === 'string' ? source.model : 'edit',
      size: 'edit',
      steps: null,
      cfgScale: null,
      seed: 0,
      width: typeof source.width === 'number' ? source.width : 0,
      height: typeof source.height === 'number' ? source.height : 0,
      provider: typeof source.provider === 'string' ? source.provider : '',
      mode: editMode,
      operation: 'edit',
      inputImageSha256: Array.isArray(inputHashes) ? inputHashes : [],
      providerModelRevision: typeof source.providerModelRevision === 'string' ? source.providerModelRevision : '',
      credentialStatus: typeof source.credentialStatus === 'string' ? source.credentialStatus : '',
      appBuildVersion: typeof source.appBuildVersion === 'string' ? source.appBuildVersion : '',
      sourceRecordId: ''
    };
    document.dispatchEvent(new CustomEvent('imagegen:generated', { detail: detail }));
  }

  goBtn.addEventListener('click', function () {
    var elapsedTimer;
    var inputBlobs;
    if (providerAvailable === false) {
      setStatus(EDIT_PROVIDER_UNAVAILABLE_MESSAGE, 'fail');
      setPreviewState('error', '服務不可用');
      return;
    }
    var check = validateEditSelection(selected.length);
    if (!check.ok) {
      setStatus(check.error, 'fail');
      setPreviewState('error', '需要參考圖');
      return;
    }
    if (editMode === 'character' && !selected.some(function (item) { return normalizeReferenceRole(item.role) === 'character'; })) {
      setStatus('角色一致模式需要至少一張標成「角色」的參考圖', 'fail');
      setPreviewState('error', '檢查參考圖');
      return;
    }
    if (editMode === 'product' && !selected.some(function (item) { return normalizeReferenceRole(item.role) === 'product'; })) {
      setStatus('產品照模式需要至少一張標成「產品」的參考圖', 'fail');
      setPreviewState('error', '檢查參考圖');
      return;
    }
    var prompt = (promptEl.value || '').trim();
    if (!prompt) {
      setStatus('請輸入改圖指令', 'fail');
      setPreviewState('error', '需要改圖指令');
      return;
    }

    editInFlight = true;
    updateGoButton();
    resetResult(); // 送出前先清舊結果，避免失敗時殘留可下載的舊圖
    setPreviewState('busy', '改圖中');
    elapsedTimer = root.ElapsedTimer.start({
      onTick: function (seconds) {
        setStatus('AI 改圖中… 已用 ' + seconds + ' 秒', '');
        goBtn.textContent = '改圖中… ' + seconds + ' 秒';
      }
    });
    var token = typeof readTurnstileToken === 'function' ? readTurnstileToken() : '';
    var finalPrompt = composeEditPrompt(prompt, selected, {
      mode: editMode,
      background: productBackground ? productBackground.value : '',
      lighting: productLighting ? productLighting.value : ''
    });
    inputBlobs = selected.map(function (s) { return s.blob; });
    var fd = buildEditFormData(finalPrompt, inputBlobs, token);

    fetch('/edit', { method: 'POST', body: fd })
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          return { ok: resp.ok, status: resp.status, data: data };
        });
      })
      .then(function (r) {
        var mapped = mapEditResponse(r.ok, r.status, r.data);
        if (mapped.image) {
          showResult(mapped.image);
          setStatus('完成 ✓ · 耗時 ' + elapsedTimer.stop() + ' 秒', 'done');
          if (root.ProvenanceReceipt && typeof root.ProvenanceReceipt.hashBlobs === 'function') {
            root.ProvenanceReceipt.hashBlobs(inputBlobs).then(function (inputHashes) {
              dispatchEditHistoryRecord(mapped.data, mapped.image, prompt, finalPrompt, inputHashes);
            }, function () {
              dispatchEditHistoryRecord(mapped.data, mapped.image, prompt, finalPrompt, []);
            });
          } else {
            dispatchEditHistoryRecord(mapped.data, mapped.image, prompt, finalPrompt, []);
          }
        } else {
          setStatus('改圖失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + mapped.error, 'fail');
          setPreviewState('error', '改圖失敗');
        }
      })
      .catch(function (e) {
        setStatus('連線失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + (e && e.message ? e.message : e), 'fail');
        setPreviewState('error', '連線失敗');
      })
      .then(function () {
        elapsedTimer.stop();
        if (typeof resetTurnstileWidget === 'function') { resetTurnstileWidget(); }
        editInFlight = false;
        updateGoButton();
        goBtn.textContent = '✦ 開始改圖';
      });
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
