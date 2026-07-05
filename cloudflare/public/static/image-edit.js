// AI 改圖前端：選圖 → canvas 縮到 <512 → 帶 prompt POST /edit（multipart，欄位
// 名 images 可重複）→ 顯示結果。純函式掛在 root.ImageEdit 供 node 測試；DOM 綁定
// 只在瀏覽器（存在 #editPanel）時執行。後端契約見 app/main.py 與 cloudflare/src/index.js。
(function (root) {
  'use strict';

  var MAX_EDIT_IMAGES = 4;
  // 嚴格小於 512：FLUX.2 klein 每張輸入圖須 < 512x512。
  var MAX_EDIT_DIM = 511;

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

  // 組出送到 /edit 的 FormData：prompt + 多個同名 images 欄位。
  function buildEditFormData(prompt, blobs) {
    var fd = new FormData();
    fd.append('prompt', String(prompt == null ? '' : prompt));
    (blobs || []).forEach(function (blob, i) {
      fd.append('images', blob, 'input_image_' + i + '.png');
    });
    return fd;
  }

  // 把 /edit 回應映射成 { image, error }：成功回圖，否則回後端 error 或通用 HTTP 訊息。
  function mapEditResponse(ok, status, data) {
    if (ok && data && data.image) { return { image: data.image, error: null }; }
    var msg = (data && data.error) ? data.error : ('改圖失敗（HTTP ' + status + '）');
    return { image: null, error: msg };
  }

  root.ImageEdit = {
    MAX_EDIT_IMAGES: MAX_EDIT_IMAGES,
    MAX_EDIT_DIM: MAX_EDIT_DIM,
    computeResizeDims: computeResizeDims,
    validateEditSelection: validateEditSelection,
    buildEditFormData: buildEditFormData,
    mapEditResponse: mapEditResponse
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
  var STAGE_PLACEHOLDER = '<span class="muted">改好的圖會出現在這裡</span>';

  var selected = []; // { blob, url, name }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  // 清掉上一張結果並停用下載連結，避免失敗時仍殘留舊圖/可下載舊圖。
  function resetResult() {
    stage.innerHTML = STAGE_PLACEHOLDER;
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
      im.alt = 'image ' + index;
      var tag = document.createElement('span');
      tag.className = 'edit-thumb-tag';
      tag.textContent = 'image ' + index;
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
      wrap.appendChild(rm);
      thumbs.appendChild(wrap);
    });
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
          selected.push({ blob: r.blob, url: URL.createObjectURL(r.blob), name: 'image.png' });
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

  function showResult(dataUrl) {
    stage.innerHTML = '';
    var im = document.createElement('img');
    im.src = dataUrl;
    im.alt = 'AI 改圖結果';
    im.className = 'stage-img';
    stage.appendChild(im);
    dlLink.href = dataUrl;
    dlLink.classList.remove('is-disabled');
    dlLink.removeAttribute('aria-disabled');
  }

  goBtn.addEventListener('click', function () {
    var check = validateEditSelection(selected.length);
    if (!check.ok) { setStatus(check.error, 'fail'); return; }
    var prompt = (promptEl.value || '').trim();
    if (!prompt) { setStatus('請輸入改圖指令', 'fail'); return; }

    goBtn.disabled = true;
    resetResult(); // 送出前先清舊結果，避免失敗時殘留可下載的舊圖
    setStatus('AI 改圖中…（約數秒）', '');
    var fd = buildEditFormData(prompt, selected.map(function (s) { return s.blob; }));

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
          setStatus('完成 ✓', 'done');
        } else {
          setStatus(mapped.error, 'fail');
        }
      })
      .catch(function (e) {
        setStatus('連線失敗：' + (e && e.message ? e.message : e), 'fail');
      })
      .then(function () { goBtn.disabled = false; });
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
