// AI 改圖前端：選圖 → canvas 縮到 <512 → 帶 prompt POST /edit（multipart，欄位
// 名 images 可重複）→ 顯示結果。純函式掛在 root.ImageEdit 供 node 測試；DOM 綁定
// 只在瀏覽器（存在 #editPanel）時執行。後端契約見 app/main.py 與 cloudflare/src/index.js。
//
// 功能對齊生成分頁：快速指令庫、修改幅度與保留項目、前後對比、用結果再改一次、
// 複製指令、失敗建議（重用 FailureAdvice）、歷史記錄（重用 imagegen:generated 事件）。
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

  // 修改幅度：後端 /edit 只吃 prompt + images，強度只能靠指令措辭表達。
  var EDIT_STRENGTHS = {
    subtle: {
      label: '微調',
      hint: '只改指令指定的地方，其餘畫面盡量不動。',
      clause: '修改幅度：微調。只改動指令指定的部分，其餘構圖、色調與細節維持原樣。'
    },
    balanced: {
      label: '適中',
      hint: '依指令調整，同時維持原圖的整體構圖與氛圍。',
      clause: '修改幅度：適中。依指令調整，同時維持原圖的整體構圖與氛圍。'
    },
    bold: {
      label: '大改',
      hint: '可大幅重繪場景與風格，只保留主體與核心特徵。',
      clause: '修改幅度：大改。可大幅重繪場景與風格，只保留主體與核心特徵。'
    }
  };
  var DEFAULT_STRENGTH = 'balanced';
  // 由弱到強，順序即滑桿由左到右。
  var STRENGTH_ORDER = ['subtle', 'balanced', 'bold'];

  // 風格：值對齊生成分頁的 #promptStyle，同一份選項也餵給 /prompt/complete 與
  // /prompt/transform。auto＝維持原圖風格，不加任何句子。
  var STYLE_CLAUSES = {
    cute: '整體風格：可愛療癒的插畫感，線條柔和、色彩明亮。',
    cinematic: '整體風格：電影感光線與色調，戲劇性的明暗對比。',
    realistic: '整體風格：寫實攝影質感，自然光線與真實材質細節。',
    anime: '整體風格：日系動畫插畫風格，乾淨線條與鮮明色彩。',
    product: '整體風格：商業產品攝影質感，乾淨背景與精準打光。'
  };

  var KEEP_OPTIONS = {
    face: { label: '臉部', clause: '人物臉部特徵與表情' },
    text: { label: '文字 / Logo', clause: '畫面中的文字與 Logo 內容' },
    layout: { label: '構圖', clause: '原本的構圖與主體位置' },
    palette: { label: '配色', clause: '原本的主要配色' }
  };

  // 快速指令庫：對應生成分頁的「幫我想梗」，點一下帶入可再編輯，不消耗額度。
  var EDIT_PRESETS = {
    general: [
      { label: '換背景', text: '把背景換成乾淨的純色棚拍背景，主體邊緣保持銳利。' },
      { label: '去背白底', text: '把主體去背，背景改成純白，邊緣乾淨不留雜點。' },
      { label: '換光線', text: '把光線換成黃昏側逆光，加上溫暖的邊緣光。' },
      { label: '轉動漫風', text: '把畫面轉成日系動畫插畫風格，線條乾淨、色彩明亮。' },
      { label: '轉水彩', text: '轉成手繪水彩插畫風格，筆觸柔和、留白自然。' },
      { label: '加景深', text: '背景加上淺景深模糊，讓主體更突出。' },
      { label: '清雜物', text: '移除畫面中多餘的雜物與雜訊，保持自然不做作。' },
      { label: '換季節', text: '把場景換成下雪的冬天，光線轉冷但保留主體。' },
      { label: '換色系', text: '把整體色調換成低飽和的莫蘭迪色系。' },
      { label: '擴充畫面', text: '往左右延伸畫面內容，補出合理的背景，主體位置不變。' }
    ],
    character: [
      { label: '換場景', text: '讓角色改到咖啡廳窗邊看書，角色外觀保持一致。' },
      { label: '換服裝', text: '幫角色換上正式西裝，臉部與髮型維持一致。' },
      { label: '換表情', text: '把角色表情改成開心大笑，其他辨識特徵維持不變。' },
      { label: '換角度', text: '改成四分之三側面角度的半身構圖。' },
      { label: '三視圖', text: '做成角色設定用的正面、側面、背面三視圖。' },
      { label: '換畫風', text: '轉成水彩插畫風格，角色辨識特徵保持一致。' },
      { label: '加配件', text: '幫角色加上耳機與側背包，整體風格維持一致。' },
      { label: '大頭貼', text: '做成社群大頭貼用的正面半身特寫，背景乾淨。' }
    ],
    product: [
      { label: '白底電商', text: '做成白底電商主圖，商品置中、陰影自然。' },
      { label: '情境照', text: '把商品放進溫暖的居家情境，商品外觀維持不變。' },
      { label: '高級感', text: '重打光成高級精品廣告質感，背景簡潔。' },
      { label: '加倒影', text: '底部加上乾淨的鏡面倒影，商品比例不變。' },
      { label: '換角度', text: '改成 45 度俯角展示商品正面與側面細節。' },
      { label: '節慶版', text: '加入節慶佈景元素，商品本體與 Logo 不變。' },
      { label: '情境使用', text: '加入手持使用商品的情境，商品細節保持清楚。' },
      { label: '橫幅版', text: '重新排版成橫式廣告橫幅，左側留白可放標題。' }
    ]
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

  function normalizeStrength(value) {
    return EDIT_STRENGTHS[value] ? String(value) : DEFAULT_STRENGTH;
  }

  function normalizeStyle(value) {
    return STYLE_CLAUSES[value] ? String(value) : 'auto';
  }

  // 修改幅度是有序的三段，滑桿存 0/1/2；這裡是索引與 key 的單一換算來源。
  function strengthFromIndex(index) {
    return STRENGTH_ORDER[Number(index)] || DEFAULT_STRENGTH;
  }

  function strengthToIndex(value) {
    return STRENGTH_ORDER.indexOf(normalizeStrength(value));
  }

  // 去掉未知 key 與重複值，並固定成 KEEP_OPTIONS 的宣告順序，讓 prompt 可重現。
  function normalizeKeepList(value) {
    var picked = {};
    var result = [];
    (value && value.length ? Array.prototype.slice.call(value) : []).forEach(function (key) {
      if (KEEP_OPTIONS[key]) { picked[key] = true; }
    });
    Object.keys(KEEP_OPTIONS).forEach(function (key) {
      if (picked[key]) { result.push(key); }
    });
    return result;
  }

  function presetsForMode(mode) {
    return EDIT_PRESETS[mode] ? EDIT_PRESETS[mode] : EDIT_PRESETS.general;
  }

  function composeEditPrompt(prompt, references, options) {
    var cleanPrompt = String(prompt == null ? '' : prompt).replace(/\s+/g, ' ').trim();
    var opts = options || {};
    var mode = opts.mode ? String(opts.mode) : 'general';
    var parts = [];
    var roles = [];
    var keepClauses = [];
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
      if (opts.background) { parts.push('背景：' + opts.background + '。'); }
      if (opts.lighting) { parts.push('光線：' + opts.lighting + '。'); }
    }
    var styleClause = STYLE_CLAUSES[normalizeStyle(opts.style)];
    if (styleClause) { parts.push(styleClause); }
    parts.push(EDIT_STRENGTHS[normalizeStrength(opts.strength)].clause);
    normalizeKeepList(opts.keep).forEach(function (key) {
      keepClauses.push(KEEP_OPTIONS[key].clause);
    });
    if (keepClauses.length) {
      parts.push('務必保留：' + keepClauses.join('、') + '。');
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

  // 把 /edit 回應映射成 { image, error, code, provider, model }：成功回圖，否則回後端
  // error 或通用 HTTP 訊息；code 供 FailureAdvice 給可執行建議。
  function mapEditResponse(ok, status, data) {
    var body = data || {};
    if (ok && body.image) {
      return {
        image: body.image,
        error: null,
        code: '',
        provider: typeof body.provider === 'string' ? body.provider : '',
        model: typeof body.model === 'string' ? body.model : ''
      };
    }
    return {
      image: null,
      error: body.error ? body.error : ('改圖失敗（HTTP ' + status + '）'),
      code: typeof body.code === 'string' && body.code ? body.code : 'unknown',
      provider: '',
      model: ''
    };
  }

  // 改圖結果 → 歷史記錄牆的 record（欄位對齊 history-store normalizeRecord）。
  // 打上「AI 改圖」標籤，歷史牆才分得出來源；steps/cfgScale 留空（/edit 沒有這些參數）。
  function buildEditRecord(image, userPrompt, providerPrompt, meta) {
    var info = meta || {};
    return {
      image: image,
      thumbnail: image,
      prompt: String(userPrompt == null ? '' : userPrompt),
      providerPrompt: String(providerPrompt == null ? '' : providerPrompt),
      model: 'edit',
      size: 'square',
      seed: 0,
      provider: typeof info.provider === 'string' ? info.provider : '',
      tags: ['AI 改圖'].concat(info.modeLabel ? [info.modeLabel] : []),
      sourceRecordId: '',
      mode: 'normal'
    };
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
    EDIT_STRENGTHS: EDIT_STRENGTHS,
    STYLE_CLAUSES: STYLE_CLAUSES,
    KEEP_OPTIONS: KEEP_OPTIONS,
    EDIT_PRESETS: EDIT_PRESETS,
    computeResizeDims: computeResizeDims,
    validateEditSelection: validateEditSelection,
    normalizeReferenceRole: normalizeReferenceRole,
    normalizeStrength: normalizeStrength,
    normalizeStyle: normalizeStyle,
    STRENGTH_ORDER: STRENGTH_ORDER,
    strengthFromIndex: strengthFromIndex,
    strengthToIndex: strengthToIndex,
    normalizeKeepList: normalizeKeepList,
    presetsForMode: presetsForMode,
    composeEditPrompt: composeEditPrompt,
    buildEditFormData: buildEditFormData,
    buildEditRecord: buildEditRecord,
    mapEditResponse: mapEditResponse,
    editAvailabilityFromHealth: editAvailabilityFromHealth
  };

  // ---- 以下為瀏覽器 DOM 綁定，node 測試環境不執行 ----
  if (typeof document === 'undefined') { return; }
  var panel = document.getElementById('editPanel');
  if (!panel) { return; }

  function byId(id) { return document.getElementById(id); }

  var filesInput = byId('editFiles');
  var dropEl = byId('editDrop');
  var thumbs = byId('editThumbs');
  var promptEl = byId('editPrompt');
  var goBtn = byId('editGo');
  var dlLink = byId('editDl');
  var statusEl = byId('editStatus');
  var stage = byId('editStage');
  var previewBadge = byId('editPreviewBadge');
  var referenceCount = byId('editReferenceCount');
  var productControls = byId('editProductControls');
  var promptLabel = byId('editPromptLabel');
  var productBackground = byId('editProductBackground');
  var productLighting = byId('editProductLighting');
  var presetsEl = byId('editPresets');
  var keepEl = byId('editKeep');
  var strengthHint = byId('editStrengthHint');
  var strengthSlider = byId('editStrength');
  var strengthValue = byId('editStrengthValue');
  var strengthTrack = strengthSlider ? strengthSlider.closest('.segmented-slider') : null;
  var styleSelect = byId('editPromptStyle');
  var completeBtn = byId('editCompletePrompt');
  var transformBtn = byId('editTransformPrompt');
  var effectInput = byId('editEffectPrompt');
  var applyEffectBtn = byId('editApplyEffect');
  var compareBtn = byId('editCompare');
  var reuseBtn = byId('editReuse');
  var copyPromptBtn = byId('editCopyPrompt');
  var stateMeta = byId('editStateMeta');
  var modeMeta = byId('editModeMeta');
  var refMeta = byId('editRefMeta');
  var strengthMeta = byId('editStrengthMeta');
  var providerMeta = byId('editProviderMeta');

  var STAGE_PLACEHOLDER = '<div class="edit-empty-state"><span aria-hidden="true">◫</span><strong>結果會顯示在這裡</strong><p>左側加入參考圖片並輸入指令後，按下「開始改圖」。</p></div>';
  var PROVIDER_HINT = '輸入圖片會在瀏覽器中先縮小後送出';
  var EDIT_MODE_COPY = {
    general: {
      label: '改圖指令',
      title: '一般改圖',
      placeholder: '例如：把背景換成雨夜街道，保留主體構圖與色彩層次。'
    },
    character: {
      label: '角色變化指令',
      title: '角色一致',
      placeholder: '例如：保持角色臉部、髮型與服裝特徵，改成在咖啡廳看書。'
    },
    product: {
      label: '產品攝影指令',
      title: '產品照',
      placeholder: '例如：保持產品外觀一致，製作適合電商首頁的高級棚拍主圖。'
    }
  };

  var selected = []; // { blob, url, name, role }
  var editMode = 'general';
  var editStrength = DEFAULT_STRENGTH;
  var keepFlags = {};
  var editInFlight = false;
  var providerAvailable = null;
  var lastResult = null;   // { image, prompt, providerPrompt, beforeUrl }
  var compareOn = false;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status edit-availability-status' + (kind ? ' ' + kind : '');
  }

  function setPreviewState(state, label) {
    if (previewBadge) {
      previewBadge.setAttribute('data-state', state || 'idle');
      previewBadge.innerHTML = '<i aria-hidden="true"></i>' + (label || '等待執行');
    }
    if (stateMeta) { stateMeta.textContent = label || '待命'; }
  }

  function updateMeta() {
    if (modeMeta) { modeMeta.textContent = EDIT_MODE_COPY[editMode].title; }
    if (refMeta) { refMeta.textContent = String(selected.length) + ' 張參考圖'; }
    if (strengthMeta) { strengthMeta.textContent = EDIT_STRENGTHS[editStrength].label; }
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

  function setResultActionsEnabled(enabled) {
    [compareBtn, reuseBtn].forEach(function (button) {
      if (!button) { return; }
      button.disabled = !enabled;
    });
  }

  // 清掉上一張結果並停用下載連結，避免失敗時仍殘留舊圖/可下載舊圖。
  function resetResult() {
    stage.innerHTML = STAGE_PLACEHOLDER;
    stage.classList.remove('has-failure-advice');
    setPreviewState('idle', '等待執行');
    dlLink.classList.add('is-disabled');
    dlLink.setAttribute('aria-disabled', 'true');
    dlLink.removeAttribute('href');
    if (lastResult && lastResult.beforeUrl) { URL.revokeObjectURL(lastResult.beforeUrl); }
    lastResult = null;
    compareOn = false;
    if (compareBtn) { compareBtn.setAttribute('aria-pressed', 'false'); }
    setResultActionsEnabled(false);
    if (providerMeta) { providerMeta.textContent = PROVIDER_HINT; }
  }

  // 讀檔 → 縮圖 → 回傳 PNG Blob。File 與 Blob 都可以（createObjectURL 兩者都吃），
  // 所以「用結果再改一次」可以直接把結果 Blob 丟進來重用同一條縮圖路徑。
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
    updateMeta();
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

  // 快速指令：點一下附加到指令框（已有內容就換行接續），不直接送出、不消耗額度。
  function renderPresets() {
    if (!presetsEl) { return; }
    presetsEl.innerHTML = '';
    presetsForMode(editMode).forEach(function (preset) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'edit-preset';
      chip.textContent = preset.label;
      chip.title = preset.text;
      chip.setAttribute('aria-label', '帶入快速指令：' + preset.text);
      chip.addEventListener('click', function () {
        var current = (promptEl.value || '').trim();
        promptEl.value = current ? current + '\n' + preset.text : preset.text;
        promptEl.focus();
        setStatus('已帶入「' + preset.label + '」，可再自行修改', 'done');
      });
      presetsEl.appendChild(chip);
    });
  }

  function renderKeepOptions() {
    if (!keepEl) { return; }
    keepEl.innerHTML = '';
    Object.keys(KEEP_OPTIONS).forEach(function (key) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'edit-keep' + (keepFlags[key] ? ' is-active' : '');
      chip.textContent = KEEP_OPTIONS[key].label;
      chip.setAttribute('data-edit-keep', key);
      chip.setAttribute('aria-pressed', keepFlags[key] ? 'true' : 'false');
      chip.addEventListener('click', function () {
        keepFlags[key] = !keepFlags[key];
        renderKeepOptions();
      });
      keepEl.appendChild(chip);
    });
  }

  function currentKeepList() {
    return normalizeKeepList(Object.keys(keepFlags).filter(function (key) { return keepFlags[key]; }));
  }

  function currentEditOptions() {
    return {
      mode: editMode,
      strength: editStrength,
      style: styleSelect ? styleSelect.value : 'auto',
      keep: currentKeepList(),
      background: productBackground ? productBackground.value : '',
      lighting: productLighting ? productLighting.value : ''
    };
  }

  function setEditStrength(value) {
    var index;
    editStrength = normalizeStrength(value);
    index = strengthToIndex(editStrength);
    if (strengthSlider) {
      if (strengthSlider.value !== String(index)) { strengthSlider.value = String(index); }
      strengthSlider.setAttribute('aria-valuetext', EDIT_STRENGTHS[editStrength].label);
    }
    if (strengthTrack) {
      // data-seg 給刻度點著色；--seg-index 給填充長度，實際換算在 CSS（見 .segmented-slider）。
      strengthTrack.setAttribute('data-seg', String(index));
      strengthTrack.style.setProperty('--seg-index', String(index));
      strengthTrack.style.setProperty('--seg-max', String(STRENGTH_ORDER.length - 1));
    }
    if (strengthValue) { strengthValue.textContent = EDIT_STRENGTHS[editStrength].label; }
    if (strengthHint) { strengthHint.textContent = EDIT_STRENGTHS[editStrength].hint; }
    updateMeta();
  }

  if (strengthSlider) {
    strengthSlider.addEventListener('input', function () {
      setEditStrength(strengthFromIndex(strengthSlider.value));
    });
  }

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
    renderPresets();
    renderThumbs();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-edit-mode]'), function (button) {
    button.addEventListener('click', function () {
      setEditMode(button.getAttribute('data-edit-mode'));
    });
  });
  renderKeepOptions();
  setEditStrength(DEFAULT_STRENGTH);
  setEditMode('general');
  setResultActionsEnabled(false);

  function renderSingleResult() {
    var im = document.createElement('img');
    stage.innerHTML = '';
    im.src = lastResult.image;
    im.alt = 'AI 改圖結果';
    im.className = 'stage-img';
    stage.appendChild(im);
  }

  // 前後對比：後圖用 clip-path 依滑桿位置裁切，露出下層原圖；純 CSS，無額外相依。
  function renderCompare() {
    var wrap = document.createElement('div');
    var before = document.createElement('img');
    var after = document.createElement('img');
    var range = document.createElement('input');
    var beforeTag = document.createElement('span');
    var afterTag = document.createElement('span');
    stage.innerHTML = '';
    wrap.className = 'edit-compare';
    wrap.style.setProperty('--split', '50%');
    before.className = 'edit-compare-img edit-compare-before';
    before.src = lastResult.beforeUrl;
    before.alt = '改圖前的原圖';
    after.className = 'edit-compare-img edit-compare-after';
    after.src = lastResult.image;
    after.alt = 'AI 改圖結果';
    beforeTag.className = 'edit-compare-tag is-before';
    beforeTag.textContent = '原圖';
    afterTag.className = 'edit-compare-tag is-after';
    afterTag.textContent = '改後';
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = '50';
    range.className = 'edit-compare-range';
    range.setAttribute('aria-label', '拖曳比較原圖與改圖結果');
    range.addEventListener('input', function () {
      wrap.style.setProperty('--split', range.value + '%');
    });
    wrap.appendChild(before);
    wrap.appendChild(after);
    wrap.appendChild(beforeTag);
    wrap.appendChild(afterTag);
    wrap.appendChild(range);
    stage.appendChild(wrap);
  }

  function renderResult() {
    if (!lastResult) { return; }
    if (compareOn && lastResult.beforeUrl) { renderCompare(); } else { renderSingleResult(); }
  }

  // 失敗時把 FailureAdvice 的可執行步驟渲染在畫布上（與生成分頁同一份文案來源）。
  function renderFailureAdvice(code) {
    var advice;
    var box, title, list;
    if (!root.FailureAdvice) { return; }
    advice = root.FailureAdvice.getAdvice(code, {});
    stage.innerHTML = ''; // 換掉 resetResult 放的 placeholder，避免建議疊在空狀態下方
    box = document.createElement('div');
    title = document.createElement('strong');
    list = document.createElement('ul');
    box.className = 'failure-advice';
    title.textContent = advice.title;
    advice.steps.forEach(function (step) {
      var item = document.createElement('li');
      item.textContent = step;
      list.appendChild(item);
    });
    box.appendChild(title);
    box.appendChild(list);
    stage.classList.add('has-failure-advice');
    stage.appendChild(box);
  }

  function showResult(mapped, finalPrompt, userPrompt) {
    if (lastResult && lastResult.beforeUrl) { URL.revokeObjectURL(lastResult.beforeUrl); }
    lastResult = {
      image: mapped.image,
      prompt: userPrompt,
      providerPrompt: finalPrompt,
      // 另建一份 objectURL：使用者之後移除縮圖也不會讓對比圖失效。
      beforeUrl: selected.length ? URL.createObjectURL(selected[0].blob) : ''
    };
    compareOn = false;
    if (compareBtn) { compareBtn.setAttribute('aria-pressed', 'false'); }
    renderResult();
    dlLink.href = mapped.image;
    dlLink.classList.remove('is-disabled');
    dlLink.removeAttribute('aria-disabled');
    setResultActionsEnabled(true);
    if (compareBtn) { compareBtn.disabled = !lastResult.beforeUrl; }
    setPreviewState('done', '完成');
    if (providerMeta) {
      providerMeta.textContent = mapped.provider ? ('來源：' + mapped.provider) : PROVIDER_HINT;
    }
    // 重用生成分頁的歷史記錄管線：歷史牆自己監聽 imagegen:generated。
    document.dispatchEvent(new CustomEvent('imagegen:generated', {
      detail: buildEditRecord(mapped.image, userPrompt, finalPrompt, {
        provider: mapped.provider,
        modeLabel: EDIT_MODE_COPY[editMode].title
      })
    }));
  }

  if (compareBtn) {
    compareBtn.addEventListener('click', function () {
      if (!lastResult || !lastResult.beforeUrl) { return; }
      compareOn = !compareOn;
      compareBtn.setAttribute('aria-pressed', compareOn ? 'true' : 'false');
      renderResult();
    });
  }

  // 用結果再改一次：結果 dataURL → Blob → 走同一條縮圖路徑，取代目前參考圖，形成迭代閉環。
  if (reuseBtn) {
    reuseBtn.addEventListener('click', function () {
      if (!lastResult) { return; }
      reuseBtn.disabled = true;
      fetch(lastResult.image)
        .then(function (resp) { return resp.blob(); })
        .then(resizeFileToBlob)
        .then(function (blob) {
          selected.forEach(function (item) { URL.revokeObjectURL(item.url); });
          selected = [{ blob: blob, url: URL.createObjectURL(blob), name: 'edited.png', role: editMode === 'product' ? 'product' : (editMode === 'character' ? 'character' : 'style') }];
          renderThumbs();
          resetResult();
          setStatus('已把結果放回參考圖，改一下指令就能再改一次', 'done');
        })
        .catch(function () {
          reuseBtn.disabled = false;
          setStatus('無法把結果轉成參考圖，請先下載再手動上傳', 'fail');
        });
    });
  }

  function setEditTransformStatus(message, kind) {
    var box = byId('editTransformStatus');
    if (!box) { return; }
    box.textContent = message || '';
    box.className = 'transform-status' + (kind ? ' ' + kind : '');
  }

  // 加效果：重用生成分頁的 /prompt/enhance 管線，把中文效果融進改圖指令。
  if (applyEffectBtn) {
    applyEffectBtn.addEventListener('click', function () {
      var base = (promptEl.value || '').trim();
      var effect = effectInput ? (effectInput.value || '').trim() : '';
      var elapsedTimer;
      if (!root.PromptEnhancer) { return; }
      if (!base) {
        setEditTransformStatus('請先輸入中文改圖指令', 'fail');
        promptEl.focus();
        return;
      }
      if (!effect) {
        setEditTransformStatus('請先說明想要的效果', 'fail');
        if (effectInput) { effectInput.focus(); }
        return;
      }
      applyEffectBtn.disabled = true;
      applyEffectBtn.setAttribute('aria-busy', 'true');
      elapsedTimer = root.ElapsedTimer.start({
        onTick: function (seconds) {
          setEditTransformStatus('AI 套用效果中… 已用 ' + seconds + ' 秒', 'busy');
          applyEffectBtn.textContent = '套用中… ' + seconds + ' 秒';
        }
      });
      root.PromptEnhancer.applyEffect(base, effect).then(function (result) {
        var message;
        promptEl.value = result.prompt;
        message = '已套用效果 · ' + (result.provider === 'gemini' ? 'Gemini' : '離線強化') + ' · 耗時 ' + elapsedTimer.stop() + ' 秒';
        if (result.warnings && result.warnings.length) { message += ' · ' + result.warnings.join('、'); }
        setEditTransformStatus(message, 'done');
      }, function (error) {
        setEditTransformStatus('套用效果失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + (error && error.message ? error.message : error), 'fail');
      }).then(function () {
        applyEffectBtn.disabled = false;
        applyEffectBtn.removeAttribute('aria-busy');
        applyEffectBtn.textContent = '用 AI 套用效果';
      });
    });
  }

  if (copyPromptBtn) {
    copyPromptBtn.addEventListener('click', function () {
      var text = lastResult ? lastResult.providerPrompt : composeEditPrompt(promptEl.value || '', selected, currentEditOptions());
      if (!text) {
        setStatus('還沒有可複製的指令', 'fail');
        return;
      }
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        setStatus('這個瀏覽器不支援自動複製，請手動選取指令', 'fail');
        return;
      }
      navigator.clipboard.writeText(text).then(function () {
        setStatus('已複製完整改圖指令', 'done');
      }, function () {
        setStatus('複製失敗，請手動選取指令', 'fail');
      });
    });
  }

  goBtn.addEventListener('click', function () {
    var elapsedTimer;
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
    // 驗證框在分頁外層與生成分頁共用；沒過就別送，否則後端一定回 403。
    if (typeof isTurnstileRequired === 'function' && isTurnstileRequired()
      && !(typeof readTurnstileToken === 'function' && readTurnstileToken())) {
      setStatus('請先完成上方的真人驗證，再按開始改圖', 'fail');
      setPreviewState('error', '需要真人驗證');
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
    var finalPrompt = composeEditPrompt(prompt, selected, currentEditOptions());
    var fd = buildEditFormData(finalPrompt, selected.map(function (s) { return s.blob; }), token);

    fetch('/edit', { method: 'POST', body: fd })
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          return { ok: resp.ok, status: resp.status, data: data };
        });
      })
      .then(function (r) {
        var mapped = mapEditResponse(r.ok, r.status, r.data);
        if (mapped.image) {
          showResult(mapped, finalPrompt, prompt);
          setStatus('完成 ✓ · 耗時 ' + elapsedTimer.stop() + ' 秒 · 已存進歷史作品', 'done');
        } else {
          setStatus('改圖失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + mapped.error, 'fail');
          setPreviewState('error', '改圖失敗');
          renderFailureAdvice(mapped.code);
        }
      })
      .catch(function (e) {
        setStatus('連線失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + (e && e.message ? e.message : e), 'fail');
        setPreviewState('error', '連線失敗');
        renderFailureAdvice('network');
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
