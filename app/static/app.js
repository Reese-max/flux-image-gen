(function(){
  var ok = ('fetch' in window) && ('Promise' in window) && (typeof window.fetch === 'function');
  if(!ok){
    var banner = document.getElementById('oldbrowser');
    var button = document.getElementById('go');
    if(banner){ banner.style.display = 'block'; }
    if(button){ button.disabled = true; button.textContent = '不支援'; }
  }
})();

var R_SUBJECTS = [
  'a majestic snow leopard', 'a tiny astronaut', 'a steaming bowl of ramen',
  'an ancient bonsai tree', 'a vintage brass robot', 'a koi fish', 'a lone lighthouse',
  'a hot air balloon', 'a sleepy corgi', 'a wandering samurai', 'a red fox',
  'a floating island', 'a baby dragon', 'a classic sports car', 'a cup of coffee',
  'a giant whale', 'a cyber owl', 'a magical bookstore'
];
var R_SETTINGS = [
  'floating in deep space', 'in a neon cyberpunk alley', 'on a misty mountaintop',
  'in an enchanted glowing forest', 'beside a quiet Japanese garden',
  'under the northern lights', 'in a cozy rainy cafe', 'on a tropical beach at sunset',
  'inside a crystal cave', 'in a bustling night market', 'above the clouds at dawn'
];
var R_STYLES = [
  'Studio Ghibli anime style', 'traditional Chinese ink painting',
  'cinematic photograph, 85mm', 'soft watercolor illustration', 'low-poly 3D render',
  'rich oil painting', 'retro pixel art', 'minimalist flat design',
  'hyperrealistic digital art', 'dreamy vaporwave aesthetic'
];
var R_EXTRAS = [
  'soft golden lighting', 'vibrant colors', 'dramatic shadows', 'highly detailed',
  'dreamy atmosphere', 'shallow depth of field', 'epic composition', '8k, sharp focus'
];

var MAX_SEED = 2147483647;
var WORKSPACE_STORAGE_KEY = 'fluxiGenerationWorkspace.v1';
var WORKSPACE_LEGACY_DEFAULT_WIDTH = 390;
var WORKSPACE_DEFAULT_WIDTH = 460;
var WORKSPACE_MIN_WIDTH = 320;
var WORKSPACE_MAX_WIDTH = 560;
var generationInFlight = false;
var lastGeneration = null;
var seedMode = 'random';
var pendingSourceRecordId = '';
var pendingPwaRegistration = null;
var pwaRefreshing = false;
var pwaUpdateRequested = false;
var hadServiceWorkerController = false;
var providerStatus = 'checking';
var lastProviderHealth = null;
var generationState = 'idle';
var turnstileState = { required: false, siteKey: '', widgetId: null, scriptLoading: false };
var retryBlockedUntil = 0;
var retryCountdownTimer = null;

var PROVIDER_STATUS_COPY = {
  checking: '正在檢查服務狀態',
  demo: 'Demo 模式，不會真實出圖',
  ready: '真實出圖可用',
  degraded: '部分服務可用',
  offline: '出圖服務暫時不可用',
  error: '服務狀態錯誤'
};

var GENERATION_STATE_COPY = {
  idle: '🎨 生成圖片',
  compiling_prompt: '正在整理提示詞…',
  generating: '正在生成圖片…',
  saving: '正在保存作品…',
  success: '🎨 生成圖片',
  error: '重試',
  cancelled: '已取消'
};

function pick(list){ return list[Math.floor(Math.random() * list.length)]; }
function el(id){ return document.getElementById(id); }
function isTurnstileRequired(){ return !!turnstileState.required; }
function setTurnstileStatus(message, kind){
  var status = el('turnstileStatus');
  if(!status){ return; }
  status.textContent = message || '';
  status.className = 'turnstile-status ' + (kind || '');
}
function readTurnstileToken(){
  var field = document.querySelector('input[name="cf-turnstile-response"]');
  return field && field.value ? field.value : '';
}
function resetTurnstileWidget(){
  if(!isTurnstileRequired()){ return; }
  if(window.turnstile && turnstileState.widgetId !== null && typeof window.turnstile.reset === 'function'){
    try{ window.turnstile.reset(turnstileState.widgetId); }catch(error){}
  }
}
function renderTurnstileWidget(){
  var target = el('turnstileWidget');
  if(!target || !turnstileState.siteKey || !window.turnstile || typeof window.turnstile.render !== 'function'){ return; }
  if(turnstileState.widgetId !== null){ return; }
  try{
    turnstileState.widgetId = window.turnstile.render(target, {
      sitekey: turnstileState.siteKey,
      action: 'turnstile-spin-v1',
      callback: function(){ setTurnstileStatus('真人驗證完成，可以生成圖片。', 'done'); },
      'expired-callback': function(){ setTurnstileStatus('真人驗證已過期，請重新驗證。', 'warn'); },
      'error-callback': function(){ setTurnstileStatus('真人驗證載入失敗，請重新整理後再試。', 'fail'); }
    });
  }catch(error){
    setTurnstileStatus('真人驗證載入失敗，請重新整理後再試。', 'fail');
  }
}
function ensureTurnstileScript(){
  var script;
  if(window.turnstile){ renderTurnstileWidget(); return; }
  if(turnstileState.scriptLoading){ return; }
  turnstileState.scriptLoading = true;
  script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.defer = true;
  script.onload = renderTurnstileWidget;
  script.onerror = function(){ setTurnstileStatus('真人驗證載入失敗，請檢查網路後重試。', 'fail'); };
  document.head.appendChild(script);
}
function configureTurnstile(config){
  var gate = el('turnstileGate');
  var required = !!(config && config.required);
  var siteKey = config && config.siteKey ? String(config.siteKey) : '';
  turnstileState.required = required;
  turnstileState.siteKey = siteKey;
  if(!gate){ return; }
  if(!required){
    gate.hidden = true;
    return;
  }
  gate.hidden = false;
  if(!siteKey){
    setTurnstileStatus('真人驗證尚未完成設定，暫時無法生成圖片。', 'fail');
    return;
  }
  setTurnstileStatus('公開站生成前需完成人機驗證。', 'warn');
  ensureTurnstileScript();
}
function requireTurnstileReady(){
  if(!isTurnstileRequired()){ return true; }
  if(readTurnstileToken()){ return true; }
  setTurnstileStatus('請先完成真人驗證，再按生成圖片。', 'fail');
  setStatus('請先完成真人驗證', 'fail');
  return false;
}
function pad2(n){
  var value = String(n);
  return value.length < 2 ? '0' + value : value;
}
function clearNode(node){
  while(node.firstChild){
    node.removeChild(node.firstChild);
  }
}
function shallowClone(source){
  var copy = {};
  var key;
  for(key in source){
    if(Object.prototype.hasOwnProperty.call(source, key)){
      copy[key] = source[key];
    }
  }
  return copy;
}
function isFocusableVisible(node){
  if(!node || node.disabled || node.getAttribute('aria-hidden') === 'true'){ return false; }
  return !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
}
function getModalFocusable(modal){
  var nodes;
  if(!modal){ return []; }
  nodes = modal.querySelectorAll('a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])');
  return Array.prototype.filter.call(nodes, isFocusableVisible);
}
function findActiveModal(){
  var modals = document.querySelectorAll('.modal-backdrop:not([hidden])');
  return modals.length ? modals[modals.length - 1] : null;
}
function focusModalElement(modal, preferred){
  var target = preferred;
  var focusable;
  if(!target || typeof target.focus !== 'function'){
    focusable = getModalFocusable(modal);
    target = focusable.length ? focusable[0] : modal;
  }
  if(target && typeof target.focus === 'function'){
    target.focus();
  }
}
function openAccessibleModal(modal, preferred){
  if(!modal){ return; }
  modal._modalReturnFocus = document.activeElement;
  modal.hidden = false;
  focusModalElement(modal, preferred);
}
function closeAccessibleModal(modal){
  var returnFocus;
  if(!modal){ return; }
  returnFocus = modal._modalReturnFocus;
  modal.hidden = true;
  modal._modalReturnFocus = null;
  if(returnFocus && typeof returnFocus.focus === 'function'){
    returnFocus.focus();
  }
}
function trapModalTab(modal, event){
  var focusable = getModalFocusable(modal);
  var first;
  var last;
  if(!focusable.length){
    event.preventDefault();
    modal.focus();
    return;
  }
  first = focusable[0];
  last = focusable[focusable.length - 1];
  if(event.shiftKey && document.activeElement === first){
    event.preventDefault();
    last.focus();
  }else if(!event.shiftKey && document.activeElement === last){
    event.preventDefault();
    first.focus();
  }
}
function closeTopAccessibleModal(modal){
  var closeButton;
  if(!modal){ return; }
  closeButton = modal.querySelector('.modal-head .icon-btn, [data-close-idea-editor]');
  if(closeButton && typeof closeButton.click === 'function'){
    closeButton.click();
  }else{
    closeAccessibleModal(modal);
  }
}
function limitText(value, max){
  var text = value === null || value === undefined ? '' : String(value);
  var limit = max || 500;
  text = text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/^\s+|\s+$/g, '');
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}
function errorMessage(error){
  if(!error){ return ''; }
  if(error.message){ return error.message; }
  return String(error);
}
function parseRetryAfter(value){
  var seconds = Number(value);
  var deadline;
  if(isFinite(seconds) && seconds > 0){ return Math.ceil(seconds); }
  deadline = Date.parse(String(value || ''));
  return isNaN(deadline) ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}
function retrySecondsRemaining(){
  return retryBlockedUntil > Date.now() ? Math.ceil((retryBlockedUntil - Date.now()) / 1000) : 0;
}
function clearRetryCountdown(){
  if(retryCountdownTimer){ clearInterval(retryCountdownTimer); }
  retryCountdownTimer = null;
  retryBlockedUntil = 0;
}
function startRetryCountdown(seconds){
  clearRetryCountdown();
  seconds = parseRetryAfter(seconds);
  if(!seconds){ return; }
  retryBlockedUntil = Date.now() + seconds * 1000;
  updateGenerateButtons();
  retryCountdownTimer = setInterval(function(){
    if(retrySecondsRemaining()){
      updateGenerateButtons();
      return;
    }
    clearRetryCountdown();
    updateGenerateButtons();
  }, 250);
}
function generationErrorFromResponse(response, data){
  var status = response && response.status ? response.status : 0;
  var code = data && data.code ? String(data.code) : '';
  var adviceCode;
  var retryAfter = data && data.retry_after !== undefined ? data.retry_after : (response && response.headers ? response.headers.get('retry-after') : '');
  if(!code && status === 429){ code = 'rate_limited'; }
  if(!code && status === 503){ code = 'service_unavailable'; }
  if(!code && status === 504){ code = 'timeout'; }
  adviceCode = status === 429 ? 'rate_limited' : code;
  if(status === 503 && code !== 'missing_api_key'){ adviceCode = 'service_unavailable'; }
  return {
    code: code || 'unknown',
    adviceCode: adviceCode || 'unknown',
    message: data && (data.error || data.message) ? String(data.error || data.message) : ('HTTP ' + status),
    requestId: responseRequestId(response) || (data && data.requestId ? data.requestId : ''),
    retryAfter: parseRetryAfter(retryAfter)
  };
}
function reportClientError(error, context){
  var details = context || {};
  var payload = {
    type: limitText(details.type || 'client_error', 80),
    message: limitText(errorMessage(error), 500),
    stack: limitText(error && error.stack ? error.stack : '', 900),
    source: limitText(details.source || '', 300),
    url: limitText(window.location.href, 300),
    line: typeof details.line === 'number' ? details.line : null,
    column: typeof details.column === 'number' ? details.column : null,
    requestId: limitText(details.requestId || '', 120),
    userAgent: limitText(navigator.userAgent || '', 300)
  };
  var body = JSON.stringify(payload);
  if(navigator.sendBeacon){
    try{
      if(navigator.sendBeacon('/client-error', new Blob([body], { type: 'application/json' }))){
        return Promise.resolve();
      }
    }catch(beaconError){}
  }
  if(window.fetch){
    return fetch('/client-error', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: body,
      keepalive: true
    }).catch(function(){});
  }
  return Promise.resolve();
}
function responseRequestId(response){
  if(!response || !response.headers || typeof response.headers.get !== 'function'){ return ''; }
  return response.headers.get('x-request-id') || '';
}
function requestIdSuffix(requestId){
  return requestId ? '（追蹤 ID：' + requestId + '）' : '';
}
function timestamp(){
  var d = new Date();
  return d.getFullYear() + pad2(d.getMonth()+1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
function createHistoryRecordId(){
  if(window.crypto && typeof window.crypto.randomUUID === 'function'){
    return window.crypto.randomUUID();
  }
  return 'history-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function slugify(s){
  var out = s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return out || 'image';
}
function extensionFromImageData(image){
  if(image.indexOf('data:image/jpeg') === 0 || image.indexOf('data:image/jpg') === 0){ return '.jpg'; }
  if(image.indexOf('data:image/webp') === 0){ return '.webp'; }
  if(image.indexOf('data:image/gif') === 0){ return '.gif'; }
  return '.png';
}
function validateImageUrl(image){
  if(typeof image !== 'string'){
    throw new Error('後端回傳的圖片網址格式不正確');
  }
  if(image.indexOf('data:image/') === 0 || image.indexOf('http://') === 0 || image.indexOf('https://') === 0){
    return image;
  }
  throw new Error('後端回傳的圖片網址格式不正確');
}
function setStatus(text, cls){
  var status = el('status');
  if(!status){ return; }
  status.textContent = text;
  status.className = 'status' + (cls ? ' ' + cls : '');
  status.setAttribute('role', cls === 'fail' ? 'alert' : 'status');
  status.setAttribute('aria-live', cls === 'fail' ? 'assertive' : 'polite');
}
function setFieldInvalid(field, message){
  if(!field){ return; }
  if(message){
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-errormessage', 'status');
  }else{
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-errormessage');
  }
}
function setStageBusy(on){
  var stage = el('stage');
  if(stage){ stage.setAttribute('aria-busy', on ? 'true' : 'false'); }
}
function setButtonText(button, text){
  if(button){ button.textContent = text; }
}
function updateGenerateButtons(){
  var go = el('go');
  var mobile = el('mobileGenerate');
  var baseText = GENERATION_STATE_COPY[generationState] || GENERATION_STATE_COPY.idle;
  var text = baseText;
  var disabled = generationInFlight;
  var retrySeconds = retrySecondsRemaining();
  if(!generationInFlight && generationState === 'idle' && providerStatus === 'demo'){
    text = '🎨 Demo 生成圖片';
  }
  if(!generationInFlight && retrySeconds){
    text = retrySeconds + ' 秒後可重試';
    disabled = true;
  }
  if(!generationInFlight && (providerStatus === 'offline' || providerStatus === 'error')){
    disabled = true;
  }
  if(go){
    go.disabled = disabled;
    go.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    go.setAttribute('aria-busy', generationInFlight ? 'true' : 'false');
    setButtonText(go, text);
  }
  if(mobile){
    mobile.disabled = disabled;
    mobile.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    mobile.setAttribute('aria-busy', generationInFlight ? 'true' : 'false');
    setButtonText(mobile, text);
  }
}
function setGenerationState(state){
  generationState = GENERATION_STATE_COPY[state] ? state : 'idle';
  setStageBusy(generationState === 'compiling_prompt' || generationState === 'generating' || generationState === 'saving');
  updateGenerateButtons();
}
function setProviderStatus(status, message){
  providerStatus = PROVIDER_STATUS_COPY[status] ? status : 'error';
  if(message && providerStatus === 'error'){
    PROVIDER_STATUS_COPY.error = message;
  }
  updateGenerateButtons();
}
function selectedOptionText(selectId, fallback){
  var select = el(selectId);
  if(!select || select.selectedIndex < 0){ return fallback; }
  return select.options[select.selectedIndex].text;
}
function updateMobileGenerateSummary(){
  var summary = el('mobileGenerateSummary');
  if(!summary){ return; }
  summary.textContent = selectedOptionText('useCase', '自動用途') + '｜' + selectedOptionText('promptStyle', '自動風格');
}
function sizeForUseCase(useCase){
  if(useCase === 'ppt'){ return 'ppt_16_9'; }
  if(useCase === 'thumbnail'){ return 'youtube_thumb'; }
  if(useCase === 'story'){ return 'ig_story'; }
  if(useCase === 'wallpaper'){ return 'mobile_wallpaper'; }
  if(useCase === 'poster'){ return 'poster_3_4'; }
  if(useCase === 'hero'){ return 'hero_21_9'; }
  return 'ig_post';
}
function applyUseCaseSize(){
  var useCase = el('useCase');
  var size = el('size');
  if(!useCase || !size || useCase.value === 'auto'){ return; }
  size.value = sizeForUseCase(useCase.value);
  size.dispatchEvent(new Event('change', { bubbles: true }));
}
function enableDownload(on){
  var dl = el('dl');
  if(on){
    dl.hidden = false;
    dl.classList.remove('is-disabled');
    dl.setAttribute('aria-disabled', 'false');
  }else{
    dl.hidden = true;
    dl.classList.add('is-disabled');
    dl.setAttribute('aria-disabled', 'true');
    dl.removeAttribute('href');
  }
}
function randomPrompt(){
  return pick(R_SUBJECTS) + ' ' + pick(R_SETTINGS) + ', ' + pick(R_STYLES) + ', ' + pick(R_EXTRAS);
}
function registerServiceWorker(){
  if(!('serviceWorker' in navigator)){ return; }
  hadServiceWorkerController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/service-worker.js').then(function(registration){
    if(registration.waiting && navigator.serviceWorker.controller){
      showPwaUpdateNotice(registration);
    }
    registration.addEventListener('updatefound', function(){
      var worker = registration.installing;
      if(!worker){ return; }
      worker.addEventListener('statechange', function(){
        if(worker.state === 'installed' && navigator.serviceWorker.controller){
          showPwaUpdateNotice(registration);
        }
      });
    });
  }).catch(function(){});
  navigator.serviceWorker.addEventListener('controllerchange', function(){
    if(!hadServiceWorkerController){
      hadServiceWorkerController = true;
      return;
    }
    if(!pwaUpdateRequested){ return; }
    if(pwaRefreshing){ return; }
    pwaRefreshing = true;
    window.location.reload();
  });
}
function showPwaUpdateNotice(registration){
  var notice = el('pwaUpdateNotice');
  pendingPwaRegistration = registration || null;
  if(notice){ notice.hidden = false; }
}
function reloadPwaVersion(){
  if(pendingPwaRegistration && pendingPwaRegistration.waiting){
    pwaUpdateRequested = true;
    pendingPwaRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  window.location.reload();
}

function renderStageText(stage, text, cls){
  var node = document.createElement('span');
  if(cls){ node.className = cls; }
  node.textContent = text;
  stage.classList.remove('has-failure-advice');
  stage.classList.remove('has-batch-results');
  stage.classList.remove('has-mobile-save');
  stage.setAttribute('aria-busy', 'false');
  stage.setAttribute('aria-live', cls === 'err' ? 'off' : 'polite');
  clearNode(stage);
  stage.appendChild(node);
}
function renderFailureAdvice(code, context){
  var advice;
  var stage = el('stage');
  var box;
  var title;
  var list;
  if(!window.FailureAdvice || !stage){ return; }
  advice = window.FailureAdvice.getAdvice(code, context);
  box = document.createElement('div');
  title = document.createElement('strong');
  list = document.createElement('ul');
  box.className = 'failure-advice';
  title.textContent = advice.title;
  advice.steps.forEach(function(step){
    var item = document.createElement('li');
    item.textContent = step;
    list.appendChild(item);
  });
  box.appendChild(title);
  box.appendChild(list);
  stage.classList.add('has-failure-advice');
  stage.appendChild(box);
}
function createMobileSaveHint(){
  var hint = document.createElement('p');
  hint.className = 'mobile-save-hint';
  hint.textContent = '手機上可按「下載」，或長按圖片保存。多張結果可左右滑動挑選。';
  return hint;
}
function normalizeSizePreset(size){
  if(size === 'square'){ return 'ig_post'; }
  if(size === 'landscape'){ return 'ppt_16_9'; }
  if(size === 'portrait'){ return 'ig_story'; }
  return size || 'ig_post';
}
function getSizeDimensions(size){
  var preset = normalizeSizePreset(size);
  var customWidth;
  var customHeight;
  if(preset === 'custom'){
    customWidth = el('customWidth') ? Number(el('customWidth').value) : 1024;
    customHeight = el('customHeight') ? Number(el('customHeight').value) : 1024;
    return {width: customWidth || 1024, height: customHeight || 1024};
  }
  if(preset === 'ppt_16_9' || preset === 'youtube_thumb'){ return {width: 1344, height: 768}; }
  if(preset === 'ig_story'){ return {width: 768, height: 1344}; }
  if(preset === 'mobile_wallpaper'){ return {width: 768, height: 1664}; }
  if(preset === 'poster_3_4'){ return {width: 960, height: 1280}; }
  if(preset === 'a4_illustration'){ return {width: 896, height: 1280}; }
  if(preset === 'hero_21_9'){ return {width: 1792, height: 768}; }
  return {width: 1024, height: 1024};
}
function updateCustomSizeVisibility(){
  var box = el('customSizeFields');
  var size = el('size');
  if(box && size){ box.hidden = size.value !== 'custom'; }
}
function updateDevTuningVisibility(){
  // 畫質檔已合併為單一模型，調參欄位永遠顯示。
  var box = el('devTuning');
  if(box){ box.hidden = false; }
}
function readDevTuning(){
  var steps = el('devSteps');
  var cfg = el('devCfgScale');
  var tuning = { steps: null, cfgScale: null };
  if(steps && steps.value !== ''){ tuning.steps = parseInt(steps.value, 10); }
  if(cfg && cfg.value !== ''){ tuning.cfgScale = parseFloat(cfg.value); }
  return tuning;
}
// 畫質檔：只是往 devSteps/devCfgScale 寫值的便利層。「平衡」＝清空＝站方預設（steps 30 / cfg 5），
// 送出行為完全走 readDevTuning，故後端／驗證不受影響。
var QUALITY_PRESETS = {
  draft: { steps: '10', cfg: '3', hint: '快、省額度，先抓構圖草稿用。' },
  balanced: { steps: '', cfg: '', hint: '站方推薦：速度與品質平衡，多數情況直接用這個。' },
  fine: { steps: '45', cfg: '4', hint: '步數拉高，細節更足，但較慢、較耗額度。' }
};
function currentQualityPreset(){
  var stepsEl = el('devSteps');
  var cfgEl = el('devCfgScale');
  var s = stepsEl ? stepsEl.value.trim() : '';
  var c = cfgEl ? cfgEl.value.trim() : '';
  var names = Object.keys(QUALITY_PRESETS);
  for(var i = 0; i < names.length; i++){
    if(s === QUALITY_PRESETS[names[i]].steps && c === QUALITY_PRESETS[names[i]].cfg){ return names[i]; }
  }
  return null;
}
function updateQualityPresetUi(){
  var active = currentQualityPreset();
  Array.prototype.forEach.call(document.querySelectorAll('.quality-preset-btn'), function(btn){
    var on = btn.getAttribute('data-preset') === active;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  var hint = el('qualityPresetHint');
  if(hint){
    hint.textContent = active ? QUALITY_PRESETS[active].hint
      : '自訂數值：steps 越高越細緻但越慢；cfg_scale 越高越貼合描述，太高會顯得僵硬。';
  }
}
function applyQualityPreset(name){
  var preset = QUALITY_PRESETS[name];
  if(!preset){ return; }
  if(el('devSteps')){ el('devSteps').value = preset.steps; }
  if(el('devCfgScale')){ el('devCfgScale').value = preset.cfg; }
  updateQualityPresetUi();
}
function clampWorkspaceWidth(value){
  var width = Number(value);
  if(!isFinite(width)){ width = WORKSPACE_DEFAULT_WIDTH; }
  return Math.max(WORKSPACE_MIN_WIDTH, Math.min(WORKSPACE_MAX_WIDTH, Math.round(width)));
}
function persistWorkspaceState(width, collapsed){
  try{
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      width: clampWorkspaceWidth(width),
      collapsed: !!collapsed
    }));
  }catch(error){}
}
function applyWorkspaceState(width, collapsed, shouldPersist){
  var workspace = el('generationWorkspace');
  var divider = el('workspaceDivider');
  var toggle = el('toggleGenerationControls');
  var nextWidth = clampWorkspaceWidth(width);
  var isCollapsed = !!collapsed;
  if(!workspace){ return; }
  workspace.style.setProperty('--control-panel-width', nextWidth + 'px');
  workspace.classList.toggle('is-controls-collapsed', isCollapsed);
  workspace.setAttribute('data-control-width', String(nextWidth));
  if(divider){ divider.setAttribute('aria-valuenow', String(nextWidth)); }
  if(toggle){
    toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', isCollapsed ? '展開生成設定面板' : '收合生成設定面板');
    toggle.title = isCollapsed ? '展開生成設定' : '收合生成設定';
  }
  if(shouldPersist){ persistWorkspaceState(nextWidth, isCollapsed); }
}
function readWorkspaceState(){
  var parsed;
  var storedWidth;
  try{
    parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) || '{}');
  }catch(error){
    parsed = {};
  }
  storedWidth = Number(parsed.width);
  if(storedWidth === WORKSPACE_LEGACY_DEFAULT_WIDTH){ storedWidth = WORKSPACE_DEFAULT_WIDTH; }
  return {
    width: clampWorkspaceWidth(storedWidth),
    collapsed: !!parsed.collapsed
  };
}
function setPreviewScaleMode(mode){
  var stage = el('stage');
  var fit = el('previewFit');
  var actual = el('previewActual');
  var showActual = mode === 'actual';
  if(stage){ stage.classList.toggle('is-actual-size', showActual); }
  if(fit){
    fit.classList.toggle('is-active', !showActual);
    fit.setAttribute('aria-pressed', showActual ? 'false' : 'true');
  }
  if(actual){
    actual.classList.toggle('is-active', showActual);
    actual.setAttribute('aria-pressed', showActual ? 'true' : 'false');
  }
}
function initGenerationWorkspace(){
  var workspace = el('generationWorkspace');
  var divider = el('workspaceDivider');
  var toggle = el('toggleGenerationControls');
  var state;
  var resizing = false;
  var startX = 0;
  var startWidth = WORKSPACE_DEFAULT_WIDTH;
  function finishResize(){
    if(!resizing){ return; }
    resizing = false;
    workspace.classList.remove('is-resizing');
    document.body.classList.remove('is-workspace-resizing');
    persistWorkspaceState(Number(workspace.getAttribute('data-control-width')), false);
  }
  if(!workspace){ return; }
  state = readWorkspaceState();
  applyWorkspaceState(state.width, state.collapsed, false);
  if(toggle){
    toggle.addEventListener('click', function(){
      var collapsed = workspace.classList.contains('is-controls-collapsed');
      var width = Number(workspace.getAttribute('data-control-width')) || WORKSPACE_DEFAULT_WIDTH;
      applyWorkspaceState(width, !collapsed, true);
      if(collapsed && el('plainPrompt')){ el('plainPrompt').focus(); }
    });
  }
  if(divider){
    divider.addEventListener('pointerdown', function(event){
      if(event.button !== 0 || (window.matchMedia && !window.matchMedia('(min-width: 981px)').matches)){ return; }
      event.preventDefault();
      resizing = true;
      startX = event.clientX;
      startWidth = Number(workspace.getAttribute('data-control-width')) || WORKSPACE_DEFAULT_WIDTH;
      workspace.classList.remove('is-controls-collapsed');
      workspace.classList.add('is-resizing');
      document.body.classList.add('is-workspace-resizing');
      if(divider.setPointerCapture){ divider.setPointerCapture(event.pointerId); }
    });
    divider.addEventListener('pointermove', function(event){
      if(!resizing){ return; }
      applyWorkspaceState(startWidth + event.clientX - startX, false, false);
    });
    divider.addEventListener('pointerup', finishResize);
    divider.addEventListener('pointercancel', finishResize);
    divider.addEventListener('dblclick', function(){
      applyWorkspaceState(WORKSPACE_DEFAULT_WIDTH, false, true);
    });
    divider.addEventListener('keydown', function(event){
      var width = Number(workspace.getAttribute('data-control-width')) || WORKSPACE_DEFAULT_WIDTH;
      var nextWidth = width;
      if(event.key === 'ArrowLeft'){ nextWidth = width - 16; }
      else if(event.key === 'ArrowRight'){ nextWidth = width + 16; }
      else if(event.key === 'Home'){ nextWidth = WORKSPACE_MIN_WIDTH; }
      else if(event.key === 'End'){ nextWidth = WORKSPACE_MAX_WIDTH; }
      else { return; }
      event.preventDefault();
      applyWorkspaceState(nextWidth, false, true);
    });
  }
  if(el('previewFit')){ el('previewFit').addEventListener('click', function(){ setPreviewScaleMode('fit'); }); }
  if(el('previewActual')){ el('previewActual').addEventListener('click', function(){ setPreviewScaleMode('actual'); }); }
}
function setResultActionsVisible(on){
  var resultActions = el('resultActions');
  if(resultActions){ resultActions.hidden = !on; }
}
function randomSeed(){
  return Math.floor(Math.random() * MAX_SEED) + 1;
}
function isConcreteSeed(value){
  var text = value === null || value === undefined ? '' : String(value).trim();
  return /^\d+$/.test(text) && Number(text) > 0 && Number(text) <= MAX_SEED;
}
function updateSeedModeUi(){
  var randomBtn = el('seedRandom');
  var lockBtn = el('seedLock');
  var hint = el('seedModeHint');
  var seedField = el('seed');
  var locked = seedMode === 'lock';
  if(randomBtn){
    randomBtn.classList.toggle('is-active', !locked);
    randomBtn.setAttribute('aria-pressed', locked ? 'false' : 'true');
  }
  if(lockBtn){
    lockBtn.classList.toggle('is-active', locked);
    lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
  }
  if(hint){
    if(locked){
      hint.textContent = '已鎖定構圖（種子碼 ' + (seedField && seedField.value ? seedField.value : '—') + '），改描述後再生成就能微調。';
    }else{
      hint.textContent = '每次生成都換新構圖；想留住喜歡的這張就切「鎖定」。';
    }
  }
}
function setSeedMode(mode){
  seedMode = mode === 'lock' ? 'lock' : 'random';
  updateSeedModeUi();
}
function lockCompositionSeed(seedValue){
  var seedField = el('seed');
  if(!isConcreteSeed(seedValue)){
    setStatus('這張圖沒有可鎖定的種子碼（隨機產生的舊圖無法重現），請先生成一張新圖再鎖定', 'warn');
    return false;
  }
  if(seedField){ seedField.value = String(seedValue); }
  setSeedMode('lock');
  return true;
}
function computeSeedForGeneration(){
  var seedField = el('seed');
  var raw = seedField ? String(seedField.value).trim() : '';
  if(seedMode === 'lock' && isConcreteSeed(raw)){
    return raw;
  }
  return String(randomSeed());
}
function scrollToComposerAndFocus(){
  var promptField = el('plainPrompt') || el('prompt');
  if(!promptField){ return; }
  if(typeof promptField.scrollIntoView === 'function'){
    promptField.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  promptField.focus();
}
function revealResultStage(shouldFocus){
  var stage = el('stage');
  var scrollTarget = el('generationPreview') || el('resultHeading') || stage;
  var reduceMotion;
  if(!stage){ return; }
  reduceMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.requestAnimationFrame(function(){
    if(typeof scrollTarget.scrollIntoView === 'function'){
      scrollTarget.scrollIntoView({ behavior: shouldFocus || reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
    if(shouldFocus){
      try{
        stage.focus({ preventScroll: true });
      }catch(error){
        stage.focus();
      }
    }
  });
}
function readGenerationSettings(){
  var userPrompt = el('plainPrompt') ? el('plainPrompt').value : '';
  var providerPrompt = el('prompt') ? el('prompt').value : '';
  var promptForRecord = userPrompt || providerPrompt;
  return GenerationSettings.serializeSettings({
    prompt: promptForRecord,
    providerPrompt: providerPrompt,
    avoid: el('avoid') ? el('avoid').value : '',
    model: el('model').value,
    size: el('size').value,
    width: el('customWidth') ? el('customWidth').value : '',
    height: el('customHeight') ? el('customHeight').value : '',
    seed: computeSeedForGeneration()
  });
}
function clearAutoProviderPrompt(){
  var promptField = el('prompt');
  if(!promptField || !promptField.getAttribute('data-auto-source')){ return false; }
  promptField.value = '';
  promptField.removeAttribute('data-auto-source');
  return true;
}
function setGenerationSettings(settings){
  var source = settings || {};
  if(Object.prototype.hasOwnProperty.call(source, 'prompt')){
    if(el('plainPrompt')){ el('plainPrompt').value = source.prompt || ''; }
    if(el('prompt')){
      el('prompt').value = source.providerPrompt || source.prompt || '';
      el('prompt').removeAttribute('data-auto-source');
    }
  }
  if(Object.prototype.hasOwnProperty.call(source, 'providerPrompt') && el('prompt')){
    el('prompt').value = source.providerPrompt || '';
    el('prompt').removeAttribute('data-auto-source');
  }
  if(Object.prototype.hasOwnProperty.call(source, 'avoid') && el('avoid')){ el('avoid').value = source.avoid || ''; }
  if(Object.prototype.hasOwnProperty.call(source, 'model')){ el('model').value = source.model || 'schnell'; }
  if(Object.prototype.hasOwnProperty.call(source, 'size')){ el('size').value = normalizeSizePreset(source.size); }
  if(Object.prototype.hasOwnProperty.call(source, 'width') && el('customWidth')){ el('customWidth').value = source.width || 1024; }
  if(Object.prototype.hasOwnProperty.call(source, 'height') && el('customHeight')){ el('customHeight').value = source.height || 1024; }
  if(Object.prototype.hasOwnProperty.call(source, 'seed') && el('seed')){ el('seed').value = String(source.seed || 0); }
  updateCustomSizeVisibility();
  updateDevTuningVisibility();
}
function setNextGenerationSourceRecord(id){
  pendingSourceRecordId = id || '';
}
function applyPromptEnhancement(){
  var promptField = el('prompt');
  var effectField = el('effectPrompt');
  var effectButton = el('applyEffect');
  var elapsedTimer;
  var autoSource;
  if(!window.PromptEnhancer || !promptField || !effectField){ return; }
  var base = promptField.value.trim();
  var effect = effectField.value.trim();
  autoSource = promptField.getAttribute('data-auto-source');
  if(!base){
    setStatus('請先輸入或轉出英文提示詞', 'fail');
    return;
  }
  if(!effect){
    setStatus('請先說明想要的效果', 'fail');
    if(effectField.focus){ effectField.focus(); }
    return;
  }
  if(effectButton){
    effectButton.disabled = true;
    effectButton.setAttribute('aria-busy', 'true');
  }
  elapsedTimer = window.ElapsedTimer.start({
    onTick: function(seconds){
      setStatus('AI 套用效果中… 已用 ' + seconds + ' 秒', 'busy');
      if(effectButton){ effectButton.textContent = '套用中… ' + seconds + ' 秒'; }
    }
  });
  window.PromptEnhancer.applyEffect(base, effect).then(function(result){
    promptField.value = result.prompt;
    if(autoSource){
      promptField.setAttribute('data-auto-source', autoSource);
    }else{
      promptField.removeAttribute('data-auto-source');
    }
    var providerLabel = result.provider === 'gemini' ? 'Gemini' : '離線強化';
    var message = '已套用效果 · ' + providerLabel + ' · 耗時 ' + elapsedTimer.stop() + ' 秒';
    if(result.warnings && result.warnings.length){ message += ' · ' + result.warnings.join('、'); }
    setStatus(message, 'done');
  }, function(error){
    setStatus('套用效果失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + error.message, 'fail');
  }).then(function(){
    if(effectButton){
      effectButton.disabled = false;
      effectButton.removeAttribute('aria-busy');
      effectButton.textContent = '用 AI 套用效果';
    }
  });
}
function progressCopy(model, seconds){
  if(model === 'dev'){
    return '🎨 高品質模型產圖中… 已用 ' + seconds + ' 秒，通常會久一點';
  }
  return '⚡ 快速模型產圖中… 已用 ' + seconds + ' 秒';
}
function fallbackCopyText(value){
  return new Promise(function(resolve, reject){
    var textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try{
      if(document.execCommand('copy')){
        resolve();
      }else{
        reject(new Error('瀏覽器不支援複製'));
      }
    }catch(error){
      reject(error);
    }finally{
      document.body.removeChild(textarea);
    }
  });
}
function copyText(text){
  var value = text === null || text === undefined ? '' : String(text);
  if(navigator.clipboard && typeof navigator.clipboard.writeText === 'function'){
    return navigator.clipboard.writeText(value).catch(function(){
      return fallbackCopyText(value);
    });
  }
  return fallbackCopyText(value);
}
function copyPrompt(){
  if(!lastGeneration){
    setStatus('尚無可複製的提示詞', 'warn');
    return;
  }
  copyText(lastGeneration.providerPrompt).then(function(){
    setStatus('已複製提示詞', 'done');
  }).catch(function(error){
    setStatus('複製失敗：' + error.message, 'fail');
  });
}
function copySettings(){
  if(!lastGeneration){
    setStatus('尚無可複製的設定', 'warn');
    return;
  }
  copyText(JSON.stringify({
    prompt: lastGeneration.prompt,
    avoid: lastGeneration.avoid,
    model: lastGeneration.model,
    size: lastGeneration.size,
    seed: lastGeneration.seed
  }, null, 2)).then(function(){
    setStatus('已複製這組設定', 'done');
  }).catch(function(error){
    setStatus('複製失敗：' + error.message, 'fail');
  });
}
function regenerate(){
  if(!lastGeneration){
    setStatus('尚無可再生的圖片', 'warn');
    return;
  }
  setSeedMode('random');
  setGenerationSettings({
    prompt: lastGeneration.prompt,
    avoid: lastGeneration.avoid,
    model: lastGeneration.model,
    size: lastGeneration.size,
    seed: ''
  });
  generate();
}
function lockCompositionFromRecord(record){
  if(!record){
    setStatus('找不到可鎖定構圖的圖片', 'warn');
    return false;
  }
  setGenerationSettings({
    prompt: record.prompt,
    avoid: record.avoid,
    model: record.model,
    size: record.size,
    seed: record.seed
  });
  if(lockCompositionSeed(record.seed)){
    setStatus('已鎖定這張的構圖，改描述後按生成就能微調', 'done');
    scrollToComposerAndFocus();
    return true;
  }
  return false;
}
function useComposition(){
  if(!lastGeneration){
    setStatus('尚無可鎖定構圖的圖片', 'warn');
    return;
  }
  lockCompositionFromRecord(lastGeneration);
}
function onSeedLockClick(){
  var seedField = el('seed');
  if(lastGeneration && isConcreteSeed(lastGeneration.seed)){
    if(lockCompositionSeed(lastGeneration.seed)){
      setStatus('已鎖定剛才那張的構圖，改描述後按生成就能微調', 'done');
    }
    return;
  }
  if(seedField && isConcreteSeed(seedField.value)){
    lockCompositionSeed(seedField.value);
    return;
  }
  setStatus('先生成一張圖，才能鎖定它的構圖', 'warn');
}
function onSeedManualInput(){
  var seedField = el('seed');
  if(seedField && isConcreteSeed(seedField.value)){
    setSeedMode('lock');
  }else{
    setSeedMode('random');
  }
}

function openPolicyModal(id, focusId){
  var modal = el(id);
  var focusTarget = focusId ? el(focusId) : null;
  if(!modal){ return; }
  if(window.ModalA11y && typeof window.ModalA11y.open === 'function'){
    window.ModalA11y.open(modal, focusTarget || modal);
  } else {
    modal.hidden = false;
    if(focusTarget && typeof focusTarget.focus === 'function'){ focusTarget.focus(); }
  }
}
function closePolicyModal(id){
  var modal = el(id);
  if(!modal){ return; }
  if(window.ModalA11y && typeof window.ModalA11y.close === 'function'){
    window.ModalA11y.close(modal);
  } else {
    modal.hidden = true;
  }
}
function clearLocalData(){
  var keys = [];
  var i;
  if(!window.confirm || window.confirm('確定要清除這台瀏覽器中的歷史與教學偏好嗎？雲端作品不會被刪除。')){
    if(window.ImageHistoryStore && window.ImageHistoryStore.STORAGE_KEY){ keys.push(window.ImageHistoryStore.STORAGE_KEY); }
    keys.push('aiImageTutorialSeen.v1');
    keys.push(WORKSPACE_STORAGE_KEY);
    try {
      for(i = 0; i < keys.length; i += 1){
        window.localStorage.removeItem(keys[i]);
      }
      setStatus('已清除本機資料；雲端作品不會因此刪除。頁面即將重新整理。', 'done');
      setTimeout(function(){ window.location.reload(); }, 350);
    } catch(error) {
      setStatus('清除本機資料失敗：' + error.message, 'fail');
    }
  }
}

function readVisionQa(){
  var field = el('visionQa');
  return !!(field && field.checked);
}

function visionQaSummary(report){
  var issues;
  if(!report){ return ''; }
  if(report.available === false){ return ' · AI 檢查暫時不可用'; }
  issues = Array.isArray(report.detectedIssues) ? report.detectedIssues : [];
  return ' · AI 檢查：符合度 ' + String(report.promptMatchScore || 0) +
    '／構圖 ' + String(report.compositionScore || 0) +
    '／畫質 ' + String(report.visualQualityScore || 0) +
    (issues.length ? '，問題：' + issues.join('、') : '');
}

function readBatchCount(){
  var field = el('batchCount');
  var value = field ? parseInt(field.value, 10) : 1;
  if(!(value >= 1 && value <= 4)){ return 1; }
  return value;
}

function renderBatchResults(stage, images, base){
  var grid;
  var viewer;
  var mainFrame;
  var mainImageWrap;
  var mainImage;
  var mainMeta;
  var mainActions;
  var mainSeed;
  var mainLock;
  var mainDownload;
  var thumbButtons = [];
  var records = [];
  function selectImage(index){
    var item = images[index];
    var image = validateImageUrl(item.image);
    var fallback = getSizeDimensions(base.size);
    var j;
    lastGeneration = shallowClone(records[index]);
    mainImage.src = image;
    mainImage.alt = '生成圖片變體第 ' + String(index + 1) + ' 張';
    mainImage.width = typeof item.width === 'number' ? item.width : fallback.width;
    mainImage.height = typeof item.height === 'number' ? item.height : fallback.height;
    mainSeed.textContent = '種子碼 ' + (typeof item.seed === 'number' ? item.seed : '—');
    mainDownload.href = image;
    mainDownload.download = slugify(base.prompt) + '_' + (item.seed || 0) + extensionFromImageData(image);
    mainLock.onclick = function(){
      if(lockCompositionSeed(item.seed)){
        setStatus('已鎖定構圖（種子碼 ' + item.seed + '），改描述後生成就能微調', 'done');
      }
    };
    for(j = 0; j < thumbButtons.length; j += 1){
      thumbButtons[j].setAttribute('aria-pressed', j === index ? 'true' : 'false');
    }
  }
  stage.classList.remove('has-failure-advice');
  stage.classList.add('has-batch-results');
  stage.classList.add('has-mobile-save');
  clearNode(stage);
  if(!images.length){
    renderStageText(stage, '沒有產生任何圖片', 'err');
    return null;
  }
  viewer = document.createElement('div');
  viewer.className = 'batch-viewer';
  mainFrame = document.createElement('div');
  mainFrame.className = 'batch-main-frame';
  mainImageWrap = document.createElement('div');
  mainImageWrap.className = 'batch-main-image-wrap';
  mainImage = document.createElement('img');
  mainImage.className = 'batch-main-image';
  mainImageWrap.appendChild(mainImage);
  mainMeta = document.createElement('div');
  mainMeta.className = 'batch-main-meta';
  mainActions = document.createElement('div');
  mainActions.className = 'batch-card-actions';
  mainSeed = document.createElement('span');
  mainSeed.className = 'batch-seed';
  mainLock = document.createElement('button');
  mainLock.type = 'button';
  mainLock.className = 'btn mini secondary';
  mainLock.textContent = '🔒 鎖定';
  mainDownload = document.createElement('a');
  mainDownload.className = 'btn mini secondary';
  mainDownload.textContent = '⬇ 下載';
  mainActions.appendChild(mainSeed);
  mainActions.appendChild(mainLock);
  mainActions.appendChild(mainDownload);
  mainMeta.appendChild(mainActions);
  mainFrame.appendChild(mainImageWrap);
  mainFrame.appendChild(mainMeta);

  grid = document.createElement('div');
  grid.className = 'batch-grid';
  grid.setAttribute('role', 'list');
  grid.setAttribute('aria-label', '多張生成結果，可左右滑動挑選');
  images.forEach(function(item, index){
    var image = validateImageUrl(item.image);
    var card = document.createElement('div');
    var thumb = document.createElement('button');
    var img = document.createElement('img');
    var label = document.createElement('span');
    var fallback = getSizeDimensions(base.size);
    var record;

    card.className = 'batch-card';
    card.setAttribute('role', 'listitem');
    thumb.type = 'button';
    thumb.className = 'batch-thumb';
    thumb.setAttribute('aria-label', '檢視第 ' + String(index + 1) + ' 張生成圖片');
    thumb.setAttribute('aria-pressed', 'false');
    img.src = image;
    img.alt = '生成圖片變體第 ' + String(index + 1) + ' 張';
    img.loading = 'lazy';
    label.className = 'batch-thumb-label';
    label.textContent = '第 ' + String(index + 1) + ' 張';
    thumb.appendChild(img);
    thumb.appendChild(label);
    thumb.addEventListener('click', function(){
      selectImage(index);
    });
    thumbButtons.push(thumb);
    card.appendChild(thumb);
    grid.appendChild(card);

    record = {
      image: image,
      thumbnail: image,
      prompt: base.prompt,
      providerPrompt: base.providerPrompt,
      avoid: base.avoid,
      model: typeof item.model === 'string' ? item.model : 'schnell',
      size: base.size,
      steps: base.steps,
      cfgScale: base.cfgScale,
      seed: typeof item.seed === 'number' ? item.seed : 0,
      width: typeof item.width === 'number' ? item.width : fallback.width,
      height: typeof item.height === 'number' ? item.height : fallback.height,
      provider: typeof item.provider === 'string' ? item.provider : '',
      sourceRecordId: '',
      mode: 'normal'
    };
    records.push(record);
    document.dispatchEvent(new CustomEvent('imagegen:generated', { detail: shallowClone(record) }));
  });
  viewer.appendChild(mainFrame);
  viewer.appendChild(grid);
  stage.appendChild(createMobileSaveHint());
  stage.appendChild(viewer);
  selectImage(0);
  return records;
}

function compileProviderPromptIfNeeded(settings){
  var finalPromptField = el('prompt');
  var plainPromptField = el('plainPrompt');
  var promptStyle = el('promptStyle');
  var existingProviderPrompt = finalPromptField ? finalPromptField.value.trim() : '';
  var source = plainPromptField ? plainPromptField.value.trim() : '';
  var style = promptStyle ? promptStyle.value : 'auto';
  var requestBody;

  if(existingProviderPrompt || !source){
    return Promise.resolve(settings);
  }

  setGenerationState('compiling_prompt');
  setStatus('正在整理提示詞', 'busy');
  requestBody = JSON.stringify({ source: source, style: style });

  return fetch('/prompt/transform', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: requestBody
  }).then(function(response){
    return response.json().then(function(data){
      if(!response.ok){
        throw new Error(data && data.error ? data.error : ('HTTP ' + response.status));
      }
      if(!data.prompt){
        throw new Error('轉換結果缺少提示詞');
      }
      if(finalPromptField){
        finalPromptField.value = data.prompt;
        finalPromptField.setAttribute('data-auto-source', source);
      }
      settings.providerPrompt = GenerationSettings.buildProviderPrompt(data.prompt, settings.avoid);
      settings.prompt = source;
      return settings;
    });
  });
}

function generate(options){
  var opts = options || {};
  var activeTrigger = opts.triggerButton || document.activeElement;
  var triggerButton = activeTrigger && (activeTrigger.id === 'go' || activeTrigger.id === 'mobileGenerate') ? activeTrigger : null;
  if(generationInFlight || retrySecondsRemaining()){
    pendingSourceRecordId = '';
    return Promise.resolve();
  }
  if(retryCountdownTimer){ clearRetryCountdown(); }
  var stage = el('stage');
  var btn = el('go');
  var dl = el('dl');
  var settings;
  var prompt;
  var providerPrompt;
  var model;
  var size;
  var spinner;
  var t0;
  var timer;
  var flowStartedAt = typeof opts.startedAt === 'number' ? opts.startedAt : performance.now();
  enableDownload(false);
  setResultActionsVisible(false);

  try{
    settings = readGenerationSettings();
  }catch(error){
    pendingSourceRecordId = '';
    setFieldInvalid(el('plainPrompt'), error.message);
    setStatus('❌ ' + error.message, 'fail');
    setGenerationState('idle');
    return Promise.resolve();
  }

  prompt = settings.prompt;
  providerPrompt = settings.providerPrompt;
  model = settings.model;
  size = settings.size;

  if(!prompt){
    pendingSourceRecordId = '';
    setFieldInvalid(el('plainPrompt'), '請先輸入描述文字');
    setStatus('請先輸入描述文字', 'fail');
    setGenerationState('idle');
    scrollToComposerAndFocus();
    return Promise.resolve();
  }

  if(el('plainPrompt') && el('plainPrompt').value.trim() && el('prompt') && !el('prompt').value.trim()){
    generationInFlight = true;
    setFieldInvalid(el('plainPrompt'), '');
    setGenerationState('compiling_prompt');
    var compileTimer = window.ElapsedTimer.start({
      startedAt: flowStartedAt,
      onTick: function(seconds){
        setStatus('AI 正在整理提示詞… 已用 ' + seconds + ' 秒', 'busy');
      }
    });
    return compileProviderPromptIfNeeded(settings).then(function(){
      compileTimer.stop();
      generationInFlight = false;
      return generate({ startedAt: flowStartedAt, triggerButton: triggerButton });
    }, function(error){
      var compileSeconds = compileTimer.stop();
      generationInFlight = false;
      pendingSourceRecordId = '';
      reportClientError(error, { type: 'prompt_compile' });
      renderStageText(stage, '提示詞整理失敗：' + error.message, 'err');
      setStatus('❌ 提示詞整理失敗（耗時 ' + compileSeconds + ' 秒）：' + error.message, 'fail');
      setGenerationState('error');
    });
  }

  if(!requireTurnstileReady()){
    pendingSourceRecordId = '';
    setGenerationState('error');
    return Promise.resolve();
  }

  generationInFlight = true;
  setFieldInvalid(el('plainPrompt'), '');
  setGenerationState('generating');
  stage.classList.remove('has-failure-advice');
  stage.classList.remove('has-batch-results');
  stage.classList.remove('has-mobile-save');
  stage.setAttribute('aria-live', 'polite');
  spinner = document.createElement('div');
  spinner.className = 'skeleton';
  spinner.setAttribute('role', 'status');
  spinner.setAttribute('aria-label', '正在生成圖片');
  clearNode(stage);
  stage.appendChild(spinner);
  revealResultStage(false);
  t0 = flowStartedAt;
  timer = setInterval(function(){
    var s = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(progressCopy(model, s), 'busy');
  }, 100);

  function cleanupGenerate(){
    generationInFlight = false;
    resetTurnstileWidget();
    updateGenerateButtons();
  }

  function showGenerateFailure(failure, reportType, originalError){
    var message = failure.message || '產圖失敗';
    reportClientError(originalError || new Error(message), {
      type: reportType,
      requestId: failure.requestId || '',
      source: failure.code || 'unknown'
    });
    clearInterval(timer);
    setResultActionsVisible(false);
    renderStageText(stage, '出錯了：' + message + requestIdSuffix(failure.requestId), 'err');
    renderFailureAdvice(failure.adviceCode || failure.code || 'unknown', { retryAfter: failure.retryAfter });
    revealResultStage(false);
    pendingSourceRecordId = '';
    generationInFlight = false;
    setStatus('❌ 失敗：' + message + requestIdSuffix(failure.requestId), 'fail');
    setGenerationState('error');
    if(failure.retryAfter){ startRetryCountdown(failure.retryAfter); }
    if(triggerButton && typeof triggerButton.focus === 'function'){
      try{ triggerButton.focus({ preventScroll: true }); }catch(focusError){ triggerButton.focus(); }
    }
  }

  function handleGenerateError(err){
    var raw = errorMessage(err);
    var message = /failed to fetch|networkerror|err_failed|load failed/i.test(raw) ? '網路連線中斷' : (raw || '網路連線中斷');
    showGenerateFailure({ code: 'network', adviceCode: 'network', message: message, requestId: '', retryAfter: 0 }, 'generate_network', err);
  }

  var batchCount = readBatchCount();
  var devTuning = readDevTuning();
  if(batchCount > 1){
    return fetch('/generate/batch', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        prompt: providerPrompt,
        userPrompt: prompt,
        model: model,
        size: size,
        width: settings.width,
        height: settings.height,
        seed: settings.seed,
        steps: devTuning.steps,
        cfgScale: devTuning.cfgScale,
        count: batchCount,
        turnstileToken: readTurnstileToken()
      })
    }).then(function(response){
      return response.json().then(function(data){
        var secs;
        var images;
        var batchErrors;
        var batchSummary;
        var note;
        if(!response.ok){
          showGenerateFailure(generationErrorFromResponse(response, data), 'generate_batch_backend');
          return;
        }
        clearInterval(timer);
        secs = ((performance.now() - t0) / 1000).toFixed(1);
        images = (data && Array.isArray(data.images)) ? data.images : [];
        batchErrors = (data && Array.isArray(data.errors)) ? data.errors : [];
        if(!images.length){
          showGenerateFailure({ code: 'generation_failed', adviceCode: 'generation_failed', message: '批次沒有成功產生圖片', requestId: '', retryAfter: 0 }, 'generate_batch_empty');
          return;
        }
        batchSummary = '已生成 ' + images.length + ' 張' + (batchErrors.length ? '，' + batchErrors.length + ' 張失敗' : '');
        renderBatchResults(stage, images, { prompt: prompt, providerPrompt: providerPrompt, avoid: settings.avoid, size: size, steps: devTuning.steps, cfgScale: devTuning.cfgScale });
        revealResultStage(true);
        setResultActionsVisible(false);
        pendingSourceRecordId = '';
        note = providerNoteFor(images[0] && images[0].provider);
        setGenerationState('success');
        setStatus('✅ ' + batchSummary + '，耗時 ' + secs + ' 秒 ' + note, 'done');
      });
    }).then(function(result){
      cleanupGenerate();
      return result;
    }, function(err){
      try{ handleGenerateError(err); }finally{ cleanupGenerate(); }
    });
  }

  return fetch('/generate', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      prompt: providerPrompt,
      userPrompt: prompt,
      model: model,
      size: size,
      width: settings.width,
      height: settings.height,
      seed: settings.seed,
      steps: devTuning.steps,
      cfgScale: devTuning.cfgScale,
      visionQa: readVisionQa(),
      turnstileToken: readTurnstileToken()
    })
  }).then(function(response){
    return response.json().then(function(data){
      var secs;
      var image;
      var img;
      var fallbackDimensions;
      var generatedRecord;
      var providerNote;

      if(!response.ok){
        showGenerateFailure(generationErrorFromResponse(response, data), 'generate_backend');
        return;
      }

      clearInterval(timer);
      setGenerationState('saving');
      secs = ((performance.now() - t0) / 1000).toFixed(1);
      image = validateImageUrl(data.image);
      img = document.createElement('img');
      img.src = image;
      img.alt = '生成完成的圖片';
      stage.classList.remove('has-failure-advice');
      stage.classList.remove('has-batch-results');
      stage.classList.add('has-mobile-save');
      clearNode(stage);
      stage.appendChild(img);
      stage.appendChild(createMobileSaveHint());
      revealResultStage(true);
      dl.href = image;
      dl.download = slugify(prompt) + '_' + timestamp() + extensionFromImageData(image);
      enableDownload(true);
      fallbackDimensions = getSizeDimensions(size);
      generatedRecord = {
        id: createHistoryRecordId(),
        image: image,
        thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : image,
        prompt: prompt,
        providerPrompt: providerPrompt,
        avoid: settings.avoid,
        model: typeof data.model === 'string' ? data.model : model,
        size: size,
        steps: devTuning.steps,
        cfgScale: devTuning.cfgScale,
        seed: typeof data.seed === 'number' ? data.seed : 0,
        width: typeof data.width === 'number' ? data.width : fallbackDimensions.width,
        height: typeof data.height === 'number' ? data.height : fallbackDimensions.height,
        provider: typeof data.provider === 'string' ? data.provider : '',
        sourceRecordId: pendingSourceRecordId,
        mode: 'normal'
      };
      lastGeneration = shallowClone(generatedRecord);
      if(el('seed') && isConcreteSeed(generatedRecord.seed)){
        el('seed').value = String(generatedRecord.seed);
        updateSeedModeUi();
      }
      setResultActionsVisible(true);
      document.dispatchEvent(new CustomEvent('imagegen:generated', { detail: shallowClone(generatedRecord) }));
      pendingSourceRecordId = '';
      providerNote = providerNoteFor(generatedRecord.provider);
      setGenerationState('success');
      setStatus('✅ 完成，耗時 ' + secs + ' 秒 ' + providerNote + visionQaSummary(data.visionQa), 'done');
    });
  }).then(function(result){
    cleanupGenerate();
    return result;
  }, function(err){
    try{
      handleGenerateError(err);
    }finally{
      cleanupGenerate();
    }
  });
}

function setPromptForReview(prompt, label){
  var field = el('prompt');
  var advanced = el('advancedSettings');
  var promptSettings = el('advancedPromptSettings');
  if(field){ field.value = prompt || ''; }
  if(advanced){ advanced.open = true; }
  if(promptSettings){ promptSettings.open = true; }
  setGenerationState('idle');
  setStatus('已套用' + (label || '提示詞') + '；確認後再按「生成圖片」，不會自動消耗額度。', 'done');
  scrollToComposerAndFocus();
}

function setPromptAndGenerate(prompt){
  setPromptForReview(prompt, '提示詞');
}

// 靈感卡專用：中文進主框、英文當內部 provider prompt（標記 auto-source，編輯中文時會被清掉重編譯）。
// 刻意不彈開進階設定，維持「免學提示詞」定位。絕不觸發生成。
function applyInspiration(zh, en, label){
  if(el('plainPrompt')){ el('plainPrompt').value = zh || ''; }
  var p = el('prompt');
  if(p){
    if(en){
      p.value = en;
      p.setAttribute('data-auto-source', 'inspiration');
    }else{
      clearAutoProviderPrompt();
    }
  }
  setGenerationState('idle');
  setStatus('已套用' + (label || '靈感') + '；確認後再按「生成圖片」，不會自動消耗額度。', 'done');
  scrollToComposerAndFocus();
}

function findExampleCard(node){
  var current = node;
  while(current && current !== document){
    if(current.className && String(current.className).indexOf('example-card') !== -1){
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

function applyExampleGalleryPrompt(card){
  var promptValue;
  var styleValue;
  var useCaseValue;
  var sizeValue;
  var plain = el('plainPrompt');
  var provider = el('prompt');
  var style = el('promptStyle');
  var useCase = el('useCase');
  var size = el('size');
  var model = el('model');
  if(!card){ return; }
  promptValue = card.getAttribute('data-example-prompt') || '';
  styleValue = card.getAttribute('data-example-style') || 'auto';
  useCaseValue = card.getAttribute('data-example-use-case') || 'auto';
  sizeValue = normalizeSizePreset(card.getAttribute('data-example-size'));
  if(plain){ plain.value = promptValue; }
  if(provider){ provider.value = ''; }
  if(style){ style.value = styleValue; }
  if(useCase){ useCase.value = useCaseValue; }
  if(size){ size.value = sizeValue; }
  if(model){ model.value = 'dev'; }
  updateMobileGenerateSummary();
  setGenerationState('idle');
  setStatus('已套用範例到輸入框；確認後再按「生成圖片」，不會自動消耗額度。', 'done');
  scrollToComposerAndFocus();
}

function getLastGeneration(){
  return lastGeneration ? shallowClone(lastGeneration) : null;
}

function getProviderHealth(){
  return lastProviderHealth;
}

window.ImageGenApp = {
  generate: generate,
  setPromptAndGenerate: setPromptAndGenerate,
  setPromptForReview: setPromptForReview,
  applyInspiration: applyInspiration,
  setGenerationSettings: setGenerationSettings,
  applyExampleGalleryPrompt: applyExampleGalleryPrompt,
  getLastGeneration: getLastGeneration,
  setNextGenerationSourceRecord: setNextGenerationSourceRecord,
  lockCompositionFromRecord: lockCompositionFromRecord,
  copyText: copyText,
  setStatus: setStatus,
  refreshProvider: refreshProvider,
  getProviderHealth: getProviderHealth,
  el: el
};
window.ModalA11y = {
  open: openAccessibleModal,
  close: closeAccessibleModal,
  focusFirst: focusModalElement
};

function showDemoNotice(on){
  var notice = el('demo-notice');
  if(notice){ notice.hidden = !on; }
}
function providerDisplayName(provider){
  if(provider === 'workers-ai'){ return 'Workers AI'; }
  if(provider === 'pollinations'){ return 'Pollinations'; }
  if(provider === 'nvidia-fallback'){ return 'NVIDIA FLUX 備援'; }
  if(provider === 'nvidia'){ return 'NVIDIA FLUX'; }
  return provider;
}
function providerListFromHealth(data){
  var list = [];
  if(data && Array.isArray(data.providerList)){ return data.providerList; }
  if(data && Array.isArray(data.providers)){ return data.providers; }
  if(data && data.providers && typeof data.providers === 'object'){
    if(data.providers.nvidia){ list.push('nvidia'); }
    if(data.providers.workersAI){ list.push('workers-ai'); }
    return list;
  }
  if(data && data.provider && data.provider !== 'demo'){ return [data.provider]; }
  return list;
}
function providerNoteFor(provider){
  if(provider === 'demo'){ return '（示範圖片，圖片服務連接後可產生正式圖片）'; }
  if(provider === 'workers-ai'){ return '（Workers AI FLUX）'; }
  if(provider === 'nvidia-fallback'){ return '（Workers AI 忙碌，已自動改用 NVIDIA FLUX 備援）'; }
  return '（NVIDIA FLUX）';
}
function setSelectIfOptionExists(id, value){
  var field = el(id);
  var i;
  if(!field || value === null || value === undefined || value === ''){ return false; }
  if(id === 'size'){ value = normalizeSizePreset(value); }
  for(i = 0; i < field.options.length; i += 1){
    if(field.options[i].value === value){
      field.value = value;
      return true;
    }
  }
  return false;
}
function applyTemplateFromUrl(){
  var params;
  var promptValue;
  var plainPromptValue;
  var hasTemplateParams;
  if(!window.URLSearchParams){ return; }
  params = new URLSearchParams(window.location.search || '');
  promptValue = params.get('prompt') || '';
  plainPromptValue = params.get('plainPrompt') || '';
  hasTemplateParams = !!(promptValue || plainPromptValue || params.get('model') || params.get('size') || params.get('width') || params.get('height') || params.get('style') || params.get('useCase'));
  if(!hasTemplateParams){ return; }
  if(promptValue && el('prompt')){ el('prompt').value = promptValue; }
  if(el('plainPrompt') && plainPromptValue){ el('plainPrompt').value = plainPromptValue; }
  setSelectIfOptionExists('model', params.get('model'));
  setSelectIfOptionExists('size', params.get('size'));
  if(el('customWidth') && params.get('width')){ el('customWidth').value = params.get('width'); }
  if(el('customHeight') && params.get('height')){ el('customHeight').value = params.get('height'); }
  updateCustomSizeVisibility();
  updateDevTuningVisibility();
  setSelectIfOptionExists('promptStyle', params.get('style'));
  setSelectIfOptionExists('useCase', params.get('useCase'));
  if(el('advancedSettings')){ el('advancedSettings').open = true; }
  if(promptValue && el('advancedPromptSettings')){ el('advancedPromptSettings').open = true; }
  updateMobileGenerateSummary();
  setGenerationState('idle');
  if(promptValue || plainPromptValue){
    setStatus('已從分享頁套用 prompt 模板；確認後再按「生成圖片」，不會自動消耗額度。', 'done');
  }else{
    setStatus('已從分享頁套用公開設定；請補上中文描述後再按「生成圖片」，不會自動消耗額度。', 'done');
  }
  if(window.history && window.history.replaceState){
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }
}
function refreshProvider(){
  var pill = el('provider-pill');
  var text = el('provider-text');
  var message;
  if(!pill || !text){ return Promise.resolve(); }
  setProviderStatus('checking');
  text.textContent = PROVIDER_STATUS_COPY.checking;
  return fetch('/api/health', { cache: 'no-store' }).then(function(res){
    return res.json();
  }).then(function(data){
    lastProviderHealth = data || {};
    var status = data && data.providerStatus ? data.providerStatus : 'demo';
    var providers = providerListFromHealth(data);
    message = data && data.message ? data.message : (PROVIDER_STATUS_COPY[status] || PROVIDER_STATUS_COPY.error);
    setProviderStatus(status, message);
    configureTurnstile(data && data.turnstile ? data.turnstile : null);
    // 後端未啟用 Vision QA 時整列收起，避免使用者勾了沒有任何效果。
    var visionField = el('visionQa');
    if(visionField){
      var visionRow = visionField.closest('label.field');
      if(visionRow){ visionRow.hidden = !(data && data.visionQa === true); }
    }
    if(window.ImageEdit && typeof window.ImageEdit.applyHealth === 'function'){
      window.ImageEdit.applyHealth(data);
    }
    if(status === 'ready'){
      pill.className = 'pill online';
      text.textContent = message + (providers.length ? ' · ' + providers.map(providerDisplayName).join(' + ') : '');
      showDemoNotice(false);
    }else if(status === 'degraded'){
      pill.className = 'pill degraded';
      text.textContent = message + (providers.length ? ' · ' + providers.map(providerDisplayName).join(' + ') : '');
      showDemoNotice(false);
    }else if(status === 'demo'){
      pill.className = 'pill demo';
      text.textContent = message;
      showDemoNotice(true);
    }else if(status === 'offline'){
      pill.className = 'pill offline';
      text.textContent = message;
      showDemoNotice(false);
    }else{
      pill.className = 'pill offline';
      text.textContent = message;
      showDemoNotice(false);
    }
  }).catch(function(){
    lastProviderHealth = { providers: { workersAI: false }, providerList: [] };
    configureTurnstile(null);
    setProviderStatus('offline');
    if(window.ImageEdit && typeof window.ImageEdit.applyHealth === 'function'){
      window.ImageEdit.applyHealth(lastProviderHealth);
    }
    pill.className = 'pill offline';
    text.textContent = PROVIDER_STATUS_COPY.offline;
    showDemoNotice(false);
  });
}

document.addEventListener('DOMContentLoaded', function(){
  registerServiceWorker();
  initGenerationWorkspace();
  setGenerationState('idle');
  refreshProvider();
  el('go').addEventListener('click', generate);
  if(el('mobileGenerate')){ el('mobileGenerate').addEventListener('click', generate); }
  if(el('mobileGenerateBar')){ el('mobileGenerateBar').hidden = false; }
  if(el('reloadPwa')){ el('reloadPwa').addEventListener('click', reloadPwaVersion); }
  if(el('regenerate')){ el('regenerate').addEventListener('click', regenerate); }
  if(el('copySettings')){ el('copySettings').addEventListener('click', copySettings); }
  if(el('copyPrompt')){ el('copyPrompt').addEventListener('click', copyPrompt); }
  if(el('openPrivacyPolicy')){ el('openPrivacyPolicy').addEventListener('click', function(){ openPolicyModal('privacyPolicyModal', 'closePrivacyPolicy'); }); }
  if(el('closePrivacyPolicy')){ el('closePrivacyPolicy').addEventListener('click', function(){ closePolicyModal('privacyPolicyModal'); }); }
  if(el('openLicensePolicy')){ el('openLicensePolicy').addEventListener('click', function(){ openPolicyModal('licensePolicyModal', 'closeLicensePolicy'); }); }
  if(el('closeLicensePolicy')){ el('closeLicensePolicy').addEventListener('click', function(){ closePolicyModal('licensePolicyModal'); }); }
  if(el('clearLocalData')){ el('clearLocalData').addEventListener('click', clearLocalData); }
  if(el('seedRandom')){ el('seedRandom').addEventListener('click', function(){ setSeedMode('random'); }); }
  if(el('seedLock')){ el('seedLock').addEventListener('click', onSeedLockClick); }
  if(el('seed')){ el('seed').addEventListener('input', onSeedManualInput); }
  if(el('useComposition')){ el('useComposition').addEventListener('click', useComposition); }
  updateSeedModeUi();
  if(el('applyEffect')){ el('applyEffect').addEventListener('click', applyPromptEnhancement); }
  if(el('plainPrompt')){
    el('plainPrompt').addEventListener('input', function(){
      var promptField = el('prompt');
      var autoSource = promptField ? promptField.getAttribute('data-auto-source') : '';
      if(promptField && autoSource && autoSource !== el('plainPrompt').value.trim()){
        clearAutoProviderPrompt();
      }
      setFieldInvalid(el('plainPrompt'), '');
      if(!generationInFlight){ setGenerationState('idle'); }
    });
  }
  if(el('prompt')){
    el('prompt').addEventListener('input', function(){
      el('prompt').removeAttribute('data-auto-source');
    });
  }
  if(el('prompt')){ el('prompt').addEventListener('input', function(){ setFieldInvalid(el('prompt'), ''); if(!generationInFlight){ setGenerationState('idle'); } }); }
  updateMobileGenerateSummary();
  if(el('useCase')){
    el('useCase').addEventListener('change', function(){
      applyUseCaseSize();
      updateMobileGenerateSummary();
    });
  }
  if(el('promptStyle')){
    el('promptStyle').addEventListener('change', function(){
      clearAutoProviderPrompt();
      updateMobileGenerateSummary();
    });
  }
  if(el('size')){ el('size').addEventListener('change', function(){ updateCustomSizeVisibility(); if(!generationInFlight){ setGenerationState('idle'); } }); }
  if(el('model')){ el('model').addEventListener('change', function(){ updateDevTuningVisibility(); }); }
  updateDevTuningVisibility();
  Array.prototype.forEach.call(document.querySelectorAll('.quality-preset-btn'), function(btn){
    btn.addEventListener('click', function(){ applyQualityPreset(btn.getAttribute('data-preset')); });
  });
  if(el('devSteps')){ el('devSteps').addEventListener('input', updateQualityPresetUi); }
  if(el('devCfgScale')){ el('devCfgScale').addEventListener('input', updateQualityPresetUi); }
  updateQualityPresetUi();
  if(el('customWidth')){ el('customWidth').addEventListener('input', function(){ if(!generationInFlight){ setGenerationState('idle'); } }); }
  if(el('customHeight')){ el('customHeight').addEventListener('input', function(){ if(!generationInFlight){ setGenerationState('idle'); } }); }
  updateCustomSizeVisibility();
  Array.prototype.forEach.call(document.querySelectorAll('.apply-example'), function(button){
    button.addEventListener('click', function(event){
      event.preventDefault();
      applyExampleGalleryPrompt(findExampleCard(button));
    });
  });
  applyTemplateFromUrl();
  el('random').addEventListener('click', function(){
    var cards = document.querySelectorAll('.idea[data-prompt]');
    if(!cards.length){ return; }
    var card = cards[Math.floor(Math.random() * cards.length)];
    applyInspiration(card.getAttribute('data-plain'), card.getAttribute('data-prompt'), '隨機驚喜');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.idea[data-prompt]'), function(button){
    button.addEventListener('click', function(){
      applyInspiration(button.getAttribute('data-plain'), button.getAttribute('data-prompt'), '靈感');
    });
  });
  el('prompt').addEventListener('keydown', function(event){
    if((event.metaKey || event.ctrlKey) && event.key === 'Enter'){
      generate();
    }
  });
});

document.addEventListener('keydown', function(event){
  var modal = findActiveModal();
  if(!modal){ return; }
  if(event.key === 'Escape'){
    event.preventDefault();
    event.stopImmediatePropagation();
    closeTopAccessibleModal(modal);
    return;
  }
  if(event.key === 'Tab'){
    trapModalTab(modal, event);
  }
});

window.addEventListener('error', function(event){
  reportClientError(event.error || event.message, {
    type: 'window_error',
    source: event.filename || '',
    line: event.lineno,
    column: event.colno
  });
});
window.addEventListener('unhandledrejection', function(event){
  reportClientError(event.reason, { type: 'unhandledrejection' });
});
