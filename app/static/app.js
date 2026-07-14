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
var WORKSPACE_DEFAULT_WIDTH = 390;
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
var generationMode = 'normal';
var agentAnalysis = null;
var turnstileState = { required: false, siteKey: '', widgetId: null, scriptLoading: false };
var retryBlockedUntil = 0;
var retryCountdownTimer = null;

var AGENT_STEP_DEFS = [
  { id: 'parse', label: '解析需求' },
  { id: 'complete', label: '補全畫面' },
  { id: 'prompt', label: '產生 prompt' },
  { id: 'select', label: '選模型與尺寸' },
  { id: 'generate', label: '生成圖片' },
  { id: 'qa', label: '檢查品質' },
  { id: 'recommend', label: '推薦最佳圖' },
  { id: 'suggest', label: '產生修改建議' }
];
var agentSteps = [];

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
function getGenerationMode(){
  var agent = el('modeAgent');
  return agent && agent.checked ? 'agent' : 'normal';
}
function isAgentMode(){
  return getGenerationMode() === 'agent';
}
function agentStatusText(status){
  if(status === 'running'){ return '進行中'; }
  if(status === 'success'){ return '完成'; }
  if(status === 'error'){ return '失敗'; }
  return '等待中';
}
function renderAgentSteps(){
  var list = el('agentSteps');
  var i;
  var item;
  var step;
  var label;
  var status;
  if(!list){ return; }
  clearNode(list);
  for(i = 0; i < agentSteps.length; i += 1){
    item = document.createElement('li');
    step = agentSteps[i];
    label = document.createElement('span');
    status = document.createElement('span');
    item.className = 'agent-step ' + step.status;
    label.className = 'agent-step-label';
    status.className = 'agent-step-status';
    label.textContent = step.label;
    status.textContent = step.message || agentStatusText(step.status);
    item.appendChild(label);
    item.appendChild(status);
    list.appendChild(item);
  }
}
function resetAgentSteps(){
  var i;
  agentSteps = [];
  for(i = 0; i < AGENT_STEP_DEFS.length; i += 1){
    agentSteps.push({
      id: AGENT_STEP_DEFS[i].id,
      label: AGENT_STEP_DEFS[i].label,
      status: 'pending',
      message: ''
    });
  }
  renderAgentSteps();
}
function setAgentStep(id, status, message){
  var i;
  for(i = 0; i < agentSteps.length; i += 1){
    if(agentSteps[i].id === id){
      agentSteps[i].status = status;
      agentSteps[i].message = message || '';
      break;
    }
  }
  renderAgentSteps();
}
function setAgentPanelVisible(on){
  var panel = el('agentPanel');
  if(panel){ panel.hidden = !on; }
}
function setAgentSummary(text){
  var summary = el('agentModeSummary');
  if(summary){ summary.textContent = text; }
}
function setAgentRecommendation(text){
  var box = el('agentRecommendation');
  if(box){
    clearNode(box);
    box.textContent = text || '';
  }
}
function clampQaScore(value){
  var number = Number(value);
  if(!isFinite(number)){ return 0; }
  if(number < 0){ return 0; }
  if(number > 100){ return 100; }
  return Math.round(number);
}
function qaAverage(report){
  var total;
  var count;
  if(!report){ return 0; }
  total = clampQaScore(report.promptMatchScore) + clampQaScore(report.compositionScore) + clampQaScore(report.visualQualityScore);
  count = 3;
  if(typeof report.textAccuracyScore === 'number'){
    total += clampQaScore(report.textAccuracyScore);
    count += 1;
  }
  return Math.round(total / count);
}
function formatVisionQaSummary(report){
  var vision = report && report.visionQa ? report.visionQa : null;
  var parts = [];
  var provider;
  var issues;
  if(!vision){ return ''; }
  if(vision.available === false){
    return '視覺 QA：暫時不可用，已改用本機 QA。';
  }
  provider = vision.provider === 'gemini' ? 'Gemini' : (vision.provider || 'Vision');
  parts.push('視覺 QA：' + provider);
  if(typeof vision.promptMatchScore === 'number'){ parts.push('符合度 ' + clampQaScore(vision.promptMatchScore) + '/100'); }
  if(typeof vision.compositionScore === 'number'){ parts.push('構圖 ' + clampQaScore(vision.compositionScore) + '/100'); }
  if(typeof vision.visualQualityScore === 'number'){ parts.push('畫質 ' + clampQaScore(vision.visualQualityScore) + '/100'); }
  if(typeof vision.textAccuracyScore === 'number'){ parts.push('文字 ' + clampQaScore(vision.textAccuracyScore) + '/100'); }
  if(vision.recommendation){ parts.push('建議 ' + String(vision.recommendation)); }
  if(vision.reason){ parts.push(String(vision.reason)); }
  issues = vision.detectedIssues && vision.detectedIssues.length ? vision.detectedIssues : [];
  if(issues.length){ parts.push('問題 ' + issues.join('；')); }
  return parts.join(' · ');
}
function formatImageQualitySummary(report){
  var quality = report && report.imageQuality ? report.imageQuality : null;
  var parts = [];
  var issues;
  if(!quality){ return ''; }
  if(quality.checked === false){
    return '圖片檢查：未能讀取圖片標頭，已保留結果但建議人工確認。';
  }
  parts.push('圖片檢查');
  if(quality.mime){ parts.push(String(quality.mime)); }
  if(quality.width && quality.height){ parts.push(String(quality.width) + '×' + String(quality.height)); }
  if(typeof quality.byteSize === 'number'){ parts.push(String(Math.round(quality.byteSize / 1024)) + ' KB'); }
  issues = quality.issues && quality.issues.length ? quality.issues : [];
  if(issues.length){ parts.push('問題 ' + issues.join('；')); }
  return parts.join(' · ');
}
function appendQaDetails(box, report){
  var visionText = formatVisionQaSummary(report);
  var imageQualityText = formatImageQualitySummary(report);
  var line;
  if(!box){ return; }
  if(imageQualityText){
    line = document.createElement('div');
    line.className = 'qa-detail-line';
    line.textContent = imageQualityText;
    box.appendChild(line);
  }
  if(visionText){
    line = document.createElement('div');
    line.className = 'qa-detail-line qa-vision-line';
    line.textContent = visionText;
    box.appendChild(line);
  }
}
function hasAgentRisk(analysis, text){
  var risks = analysis && analysis.riskFlags ? analysis.riskFlags : [];
  var i;
  for(i = 0; i < risks.length; i += 1){
    if(String(risks[i]).indexOf(text) !== -1){ return true; }
  }
  return false;
}
function createQaReport(imageId, index, total, base, item, analysis){
  var provider = item && typeof item.provider === 'string' ? item.provider : '';
  var imageQuality = item && item.imageQuality ? item.imageQuality : null;
  var imageQualityIssues = imageQuality && imageQuality.issues && imageQuality.issues.length ? imageQuality.issues : [];
  var visionQa = item && item.visionQa && item.visionQa.available ? item.visionQa : null;
  var visionIssues = visionQa && visionQa.detectedIssues && visionQa.detectedIssues.length ? visionQa.detectedIssues : [];
  var report;
  var issues = [];
  var promptScore = 76;
  var compositionScore = 74;
  var visualScore = 76;
  var textScore;
  var reason;
  var recommendation = 'edit';

  if(base && base.providerPrompt){ promptScore += 8; }
  if(analysis && analysis.subject){ promptScore += 4; }
  if(analysis && analysis.useCase && analysis.useCase !== 'general'){ compositionScore += 6; }
  if(provider === 'demo'){
    visualScore -= 8;
    issues.push('目前是 Demo 圖，無法代表真實 FLUX 畫質');
  }
  if(imageQuality){
    if(typeof imageQuality.visualQualityScore === 'number'){
      visualScore = Math.min(visualScore, clampQaScore(imageQuality.visualQualityScore));
    }
    if(imageQuality.checked === false){
      visualScore -= 6;
    }
    for(var q = 0; q < imageQualityIssues.length; q += 1){
      issues.push(imageQualityIssues[q]);
    }
  }
  if(visionQa){
    if(typeof visionQa.promptMatchScore === 'number'){ promptScore = Math.round((promptScore + clampQaScore(visionQa.promptMatchScore)) / 2); }
    if(typeof visionQa.compositionScore === 'number'){ compositionScore = Math.round((compositionScore + clampQaScore(visionQa.compositionScore)) / 2); }
    if(typeof visionQa.visualQualityScore === 'number'){ visualScore = Math.round((visualScore + clampQaScore(visionQa.visualQualityScore)) / 2); }
    if(typeof visionQa.textAccuracyScore === 'number'){ textScore = clampQaScore(visionQa.textAccuracyScore); }
    for(var v = 0; v < visionIssues.length; v += 1){
      issues.push('視覺 QA：' + visionIssues[v]);
    }
  }else if(item && item.visionQa && item.visionQa.available === false){
    issues.push('視覺 QA 暫時不可用，已使用本機 QA');
  }
  if(hasAgentRisk(analysis, '文字亂碼')){
    textScore = 46;
    issues.push('含文字需求，建議改為後製加字');
  }
  if(hasAgentRisk(analysis, '手部')){
    issues.push('手部細節可能需要多張挑選');
    visualScore -= 3;
  }
  if(analysis && analysis.missingFields && analysis.missingFields.length){
    issues.push('原始需求偏短，已用預設構圖補全');
    promptScore -= 3;
  }
  if(total > 1){
    compositionScore += Math.max(0, 3 - index);
  }

  report = {
    imageId: imageId || ('image-' + index),
    promptMatchScore: clampQaScore(promptScore),
    compositionScore: clampQaScore(compositionScore),
    visualQualityScore: clampQaScore(visualScore),
    detectedIssues: issues,
    recommendation: recommendation,
    reason: '',
    imageQuality: imageQuality || null,
    visionQa: visionQa || (item && item.visionQa ? item.visionQa : null)
  };
  if(typeof textScore === 'number'){ report.textAccuracyScore = clampQaScore(textScore); }

  if(issues.length >= 3 || qaAverage(report) < 62){
    report.recommendation = 'retry';
    reason = 'QA 分數偏低，建議調整提示詞後重試。';
  }else if(visionQa && visionQa.recommendation === 'retry'){
    report.recommendation = 'retry';
    reason = visionQa.reason || '視覺 QA 建議重試。';
  }else if(visionQa && visionQa.recommendation === 'keep'){
    report.recommendation = 'keep';
    reason = visionQa.reason || '視覺 QA 判定可保留。';
  }else if(issues.length){
    report.recommendation = 'edit';
    reason = '整體可用，但建議依問題微調後再生。';
  }else{
    report.recommendation = 'keep';
    reason = '主體、構圖與畫質檢查皆達可用標準。';
  }
  report.reason = reason;
  return report;
}
function pickBestQaIndex(reports){
  var bestIndex = -1;
  var bestScore = -1;
  var score;
  var i;
  for(i = 0; i < reports.length; i += 1){
    score = qaAverage(reports[i]);
    if(reports[i].recommendation === 'retry'){ score -= 20; }
    if(score > bestScore){
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}
function isSevereQaFailure(report){
  var issues = report && report.detectedIssues ? report.detectedIssues : [];
  var text;
  var i;
  if(!report){ return false; }
  if(qaAverage(report) < 62){ return true; }
  if(clampQaScore(report.visualQualityScore) < 55){ return true; }
  for(i = 0; i < issues.length; i += 1){
    text = String(issues[i]);
    if(text.indexOf('圖片資料為空') !== -1){ return true; }
    if(text.indexOf('無法解碼') !== -1){ return true; }
    if(text.indexOf('資料過小') !== -1){ return true; }
    if(text.indexOf('尺寸') !== -1 && text.indexOf('不一致') !== -1){ return true; }
    if(text.indexOf('嚴重模糊') !== -1 || text.indexOf('blur') !== -1){ return true; }
    if(text.indexOf('主體缺失') !== -1 || text.indexOf('missing subject') !== -1){ return true; }
    if(text.indexOf('手指') !== -1 || text.indexOf('手部') !== -1 || text.indexOf('hand') !== -1 || text.indexOf('finger') !== -1){ return true; }
    if(text.indexOf('臉部') !== -1 || text.indexOf('face') !== -1){ return true; }
    if(text.indexOf('浮水印') !== -1 || text.indexOf('watermark') !== -1){ return true; }
  }
  return false;
}
function collectQaIssueText(report){
  var parts = [];
  var issues = report && report.detectedIssues ? report.detectedIssues : [];
  var vision = report && report.visionQa ? report.visionQa : null;
  var visionIssues = vision && vision.detectedIssues ? vision.detectedIssues : [];
  var i;
  for(i = 0; i < issues.length; i += 1){ parts.push(String(issues[i])); }
  for(i = 0; i < visionIssues.length; i += 1){ parts.push(String(visionIssues[i])); }
  if(vision && vision.reason){ parts.push(String(vision.reason)); }
  return parts.join('；');
}
function issueTextHasAny(text, words){
  var lower = String(text || '').toLowerCase();
  var i;
  for(i = 0; i < words.length; i += 1){
    if(lower.indexOf(String(words[i]).toLowerCase()) !== -1){ return true; }
  }
  return false;
}
function classifyQaRetry(report){
  var text = collectQaIssueText(report);
  var plan = { action: '', reason: '', message: '', negativePatch: '' };
  if(!report){ return plan; }
  if((typeof report.textAccuracyScore === 'number' && report.textAccuracyScore < 55) || issueTextHasAny(text, ['文字亂碼', '亂碼', 'gibberish text', 'garbled text'])){
    plan.action = 'manual_edit';
    plan.reason = '文字渲染風險高';
    plan.message = '文字亂碼通常不適合用自動重試硬修，建議改為後製加字，避免浪費額度';
    plan.negativePatch = 'text, logo, watermark, gibberish, broken typography';
    return plan;
  }
  if(issueTextHasAny(text, ['手指', '手部', 'hand', 'finger'])){
    plan.action = 'auto_retry';
    plan.reason = text || '視覺 QA 偵測到手部錯誤';
    plan.message = '視覺 QA 偵測到手部或手指問題，已加強 negative prompt 並自動重試最多 1 次';
    plan.negativePatch = 'malformed hands, extra fingers, fused fingers, broken hands, distorted anatomy';
    return plan;
  }
  if(issueTextHasAny(text, ['臉部', '臉', 'face', 'facial'])){
    plan.action = 'auto_retry';
    plan.reason = text || '視覺 QA 偵測到臉部錯誤';
    plan.message = '視覺 QA 偵測到臉部問題，已加強臉部清晰度與 negative prompt 並自動重試最多 1 次';
    plan.negativePatch = 'deformed face, asymmetrical eyes, distorted facial features, blurry face';
    return plan;
  }
  if(issueTextHasAny(text, ['嚴重模糊', '模糊', 'blur', 'low quality'])){
    plan.action = 'auto_retry';
    plan.reason = text || '視覺 QA 偵測到畫面模糊';
    plan.message = '視覺 QA 偵測到畫面模糊，已加強清晰度並自動重試最多 1 次';
    plan.negativePatch = 'blurry, low resolution, soft focus, compression artifacts';
    return plan;
  }
  if(issueTextHasAny(text, ['主體缺失', '主體不明', 'missing subject', 'subject missing'])){
    plan.action = 'auto_retry';
    plan.reason = text || '視覺 QA 偵測到主體缺失';
    plan.message = '視覺 QA 偵測到主體缺失，已要求主體完整可見並自動重試最多 1 次';
    plan.negativePatch = 'cropped subject, missing main subject, hidden subject, broken composition';
    return plan;
  }
  if(report.visionQa && report.visionQa.recommendation === 'retry'){
    plan.action = 'auto_retry';
    plan.reason = report.visionQa.reason || text || '視覺 QA 建議重試';
    plan.message = '視覺 QA 建議重試，智慧體會自動重試最多 1 次，避免成本失控';
    plan.negativePatch = 'broken layout, low quality, artifacts, watermark';
    return plan;
  }
  return plan;
}
function createAutoRetryPlan(report, analysis){
  var plan = {
    maxRetries: 1,
    attempted: false,
    reason: '',
    action: 'none',
    message: '未觸發自動重試',
    negativePatch: ''
  };
  var classified;
  if(!report){ return plan; }
  classified = classifyQaRetry(report);
  if(classified.action){
    plan.action = classified.action;
    plan.reason = classified.reason;
    plan.message = classified.message;
    plan.negativePatch = classified.negativePatch;
    return plan;
  }
  if(report.recommendation === 'retry' || isSevereQaFailure(report)){
    plan.action = 'auto_retry';
    plan.reason = report.detectedIssues && report.detectedIssues.length ? report.detectedIssues.join('；') : 'QA 分數偏低';
    plan.message = '偵測到嚴重品質問題，智慧體會自動重試最多 1 次，避免成本失控';
    plan.negativePatch = 'low quality, broken layout, malformed hands, malformed faces, missing subject';
    return plan;
  }
  if(hasAgentRisk(analysis, '手部')){
    plan.action = 'prompt_patch';
    plan.reason = '手部細節風險';
    plan.message = '已建議加強 negative prompt，再生時可降低手部錯誤';
    plan.negativePatch = 'malformed hands, extra fingers, fused fingers';
  }
  return plan;
}
function buildAgentSuggestions(analysis, report){
  var suggestions = [];
  var useCase = analysis && analysis.useCase ? analysis.useCase : 'general';
  suggestions.push({ id: 'brighter', label: '讓背景更亮' });
  if(analysis && analysis.style !== 'anime'){ suggestions.push({ id: 'anime', label: '改成動漫風' }); }
  suggestions.push({ id: 'variation', label: '保留構圖再變化' });
  if(useCase !== 'ppt'){ suggestions.push({ id: 'ppt', label: '換成 PPT 橫式' }); }
  if(report && typeof report.textAccuracyScore === 'number'){ suggestions.push({ id: 'remove_text', label: '移除文字' }); }
  if(useCase === 'product'){ suggestions.push({ id: 'product_light', label: '加強產品光影' }); }
  while(suggestions.length < 3){ suggestions.push({ id: 'realistic', label: '變得更寫實' }); }
  return suggestions.slice(0, 5);
}
function applyAgentSuggestion(id){
  var plain = el('plainPrompt');
  var style = el('promptStyle');
  var useCase = el('useCase');
  var size = el('size');
  var avoid = el('avoid');
  var current = plain ? plain.value.trim() : '';
  if(id === 'brighter' && plain){ plain.value = current + '，背景更明亮，柔和自然光，主體清楚'; }
  if(id === 'anime'){ if(style){ style.value = 'anime'; } if(plain){ plain.value = current + '，動漫插畫風格，乾淨線條，鮮明色彩'; } }
  if(id === 'realistic'){ if(style){ style.value = 'realistic'; } if(plain){ plain.value = current + '，寫實攝影風格，自然光影，細節清晰'; } }
  if(id === 'variation'){
    if(lastGeneration && isConcreteSeed(lastGeneration.seed)){ lockCompositionSeed(lastGeneration.seed); }
    if(plain){ plain.value = current + '，保留構圖，產生新的細節變化'; }
  }
  if(id === 'ppt'){ if(useCase){ useCase.value = 'ppt'; } if(size){ size.value = 'ppt_16_9'; } if(plain){ plain.value = current + '，適合簡報封面，留白充足，16:9 橫式構圖'; } }
  if(id === 'remove_text'){ if(plain){ plain.value = current + '，畫面不要出現任何文字、標語或 Logo'; } if(avoid){ avoid.value = (avoid.value ? avoid.value + ', ' : '') + 'text, logo, watermark, gibberish'; } }
  if(id === 'product_light'){ if(style){ style.value = 'product'; } if(useCase){ useCase.value = 'product'; } if(plain){ plain.value = current + '，產品攝影棚光，乾淨背景，細緻反光，高級商業攝影'; } }
  if(el('prompt')){
    el('prompt').value = '';
    el('prompt').removeAttribute('data-auto-source');
  }
  updateMobileGenerateSummary();
  setGenerationState('idle');
  setStatus('已套用智慧體建議，可再次按生成圖片', 'done');
}
function renderAgentOutcome(outcome){
  var box = el('agentRecommendation');
  var text;
  var retryText;
  var suggestions;
  var p;
  var retry;
  var actions;
  var i;
  if(!box){ return; }
  clearNode(box);
  if(!outcome){ return; }
  text = outcome.text || '';
  p = document.createElement('p');
  p.textContent = text;
  box.appendChild(p);
  if(outcome.retryPlan && outcome.retryPlan.action !== 'none'){
    retry = document.createElement('p');
    retry.className = 'agent-retry-note';
    retryText = outcome.retryPlan.message || '';
    retry.textContent = retryText;
    box.appendChild(retry);
  }
  suggestions = outcome.suggestions || [];
  if(suggestions.length){
    actions = document.createElement('div');
    actions.className = 'agent-next-actions';
    for(i = 0; i < suggestions.length; i += 1){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn mini secondary';
      btn.setAttribute('data-agent-suggestion', suggestions[i].id);
      btn.textContent = suggestions[i].label;
      actions.appendChild(btn);
    }
    box.appendChild(actions);
  }
}
function includesAny(text, words){
  var i;
  for(i = 0; i < words.length; i += 1){
    if(text.indexOf(words[i]) !== -1){ return true; }
  }
  return false;
}
function detectUseCaseFromPrompt(text, selected){
  if(selected && selected !== 'auto'){ return selected; }
  if(includesAny(text, ['ppt', '簡報', '投影片'])){ return 'ppt'; }
  if(includesAny(text, ['ig', '貼文', '社群'])){ return 'social'; }
  if(includesAny(text, ['限動', 'reels', 'shorts', '短影音'])){ return 'story'; }
  if(includesAny(text, ['海報', 'poster'])){ return 'poster'; }
  if(includesAny(text, ['桌布', '手機'])){ return 'wallpaper'; }
  if(includesAny(text, ['封面', '縮圖', 'youtube'])){ return 'thumbnail'; }
  if(includesAny(text, ['產品', '商品', '白底'])){ return 'product'; }
  if(includesAny(text, ['角色', '人物設定', '立繪'])){ return 'character'; }
  return 'general';
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
function detectStyleFromPrompt(text, selected){
  if(selected && selected !== 'auto'){ return selected; }
  if(includesAny(text, ['動漫', '動畫', '二次元', '漫畫'])){ return 'anime'; }
  if(includesAny(text, ['產品', '商品', '白底', '攝影棚'])){ return 'product'; }
  if(includesAny(text, ['寫實', '真實', '照片', '攝影'])){ return 'realistic'; }
  if(includesAny(text, ['電影', '電影感', '鏡頭', 'cinematic'])){ return 'cinematic'; }
  if(includesAny(text, ['可愛', '療癒', '吉祥物'])){ return 'cute'; }
  return 'auto';
}
function modelForIntent(useCase, style){
  if(useCase === 'product' || useCase === 'character' || style === 'realistic'){ return 'dev'; }
  return 'schnell';
}
function extractSubject(text){
  var cleaned = text.replace(/[，。,.！!？?：:；;]/g, ' ').replace(/\s+/g, ' ').trim();
  if(!cleaned){ return ''; }
  return cleaned.slice(0, 36);
}
function analyzeIntentForAgent(){
  var plain = el('plainPrompt') ? el('plainPrompt').value.trim() : '';
  var lowered = plain.toLowerCase();
  var selectedStyle = el('promptStyle') ? el('promptStyle').value : 'auto';
  var selectedUseCase = el('useCase') ? el('useCase').value : 'auto';
  var useCase = detectUseCaseFromPrompt(lowered, selectedUseCase);
  var style = detectStyleFromPrompt(lowered, selectedStyle);
  var missing = [];
  var risks = [];
  if(plain.length < 8){ missing.push('場景或風格'); }
  if(!includesAny(lowered, ['在', '背景', '場景', '室內', '戶外', '月球', '城市', '森林', '海邊'])){ missing.push('場景'); }
  if(includesAny(lowered, ['文字', '標語', 'logo', '字', '海報字'])){ risks.push('模型可能產生文字亂碼，建議後製加字'); }
  if(includesAny(lowered, ['手', '手指', '彈吉他', '拿著'])){ risks.push('手部細節可能需要多張挑選'); }
  return {
    subject: extractSubject(plain),
    style: style,
    useCase: useCase,
    size: sizeForUseCase(useCase),
    model: modelForIntent(useCase, style),
    missingFields: missing,
    riskFlags: risks
  };
}
function applyAgentSelection(analysis){
  var style = el('promptStyle');
  var useCase = el('useCase');
  var size = el('size');
  var model = el('model');
  if(style && style.value === 'auto' && analysis.style !== 'auto'){ style.value = analysis.style; }
  if(useCase && useCase.value === 'auto' && analysis.useCase !== 'general'){ useCase.value = analysis.useCase; }
  if(size){ size.value = analysis.size; }
  if(model){ model.value = analysis.model; }
  updateMobileGenerateSummary();
}
function describeAgentRecommendation(analysis){
  var sizeLabel = selectedOptionText('size', analysis.size);
  var modelLabel = selectedOptionText('model', analysis.model);
  var batchCount = readBatchCount();
  var warnings = analysis.riskFlags.length ? ' 注意：' + analysis.riskFlags.join('；') : '';
  var missing = analysis.missingFields.length ? ' 建議補充：' + analysis.missingFields.join('、') + '。' : '';
  return '已解析主體：「' + (analysis.subject || '未明確指定') + '」。推薦 ' + modelLabel + '、' + sizeLabel + '，依你選擇生成 ' + batchCount + ' 張。' + missing + warnings;
}
function prepareAgentFlow(){
  var source = el('plainPrompt') ? el('plainPrompt').value.trim() : '';
  var hasProviderPrompt = !!(el('prompt') && el('prompt').value.trim());
  setAgentPanelVisible(true);
  resetAgentSteps();
  setAgentSummary('解析中文需求中');
  setAgentStep('parse', 'running', '讀取中文描述');
  agentAnalysis = analyzeIntentForAgent();
  setAgentStep('parse', 'success', agentAnalysis.subject ? '主體：' + agentAnalysis.subject : '尚未明確指定主體');
  if(hasProviderPrompt){
    setAgentStep('complete', 'success', '使用已編輯的英文提示詞');
  }else if(agentAnalysis.missingFields.length){
    setAgentStep('complete', 'running', '生成前將補足視覺細節');
  }else{
    setAgentStep('complete', 'success', '需求已足夠');
  }
  setAgentStep('select', 'running', '推薦模型與尺寸');
  applyAgentSelection(agentAnalysis);
  setAgentStep('select', 'success', '模型與尺寸已套用');
  setAgentRecommendation(describeAgentRecommendation(agentAnalysis));
  setAgentSummary(source ? '已完成需求解析' : '請先輸入中文需求');
}
function syncGenerationModeUi(){
  generationMode = getGenerationMode();
  if(generationMode === 'agent'){
    setAgentPanelVisible(true);
    if(!agentSteps.length){ resetAgentSteps(); }
    setAgentSummary('智慧體模式待命');
    if(el('batchCount') && el('batchCount').value === '1'){ el('batchCount').value = '4'; }
  }else{
    setAgentPanelVisible(false);
    if(el('batchCount') && el('batchCount').value === '4'){ el('batchCount').value = '1'; }
  }
  updateMobileGenerateSummary();
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
  try{
    parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) || '{}');
  }catch(error){
    parsed = {};
  }
  return {
    width: clampWorkspaceWidth(parsed.width),
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
  if(!window.confirm || window.confirm('確定要清除這台瀏覽器中的歷史、風格卡、專案與教學偏好嗎？雲端作品不會被刪除。')){
    if(window.ImageHistoryStore && window.ImageHistoryStore.STORAGE_KEY){ keys.push(window.ImageHistoryStore.STORAGE_KEY); }
    if(window.IdeaStore && window.IdeaStore.STORAGE_KEY){ keys.push(window.IdeaStore.STORAGE_KEY); }
    if(window.IdeaStore && window.IdeaStore.LEGACY_STORAGE_KEY){ keys.push(window.IdeaStore.LEGACY_STORAGE_KEY); }
    keys.push(window.ImageProjectStore && window.ImageProjectStore.STORAGE_KEY ? window.ImageProjectStore.STORAGE_KEY : 'aiImageProjects.v1');
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
  var mainBadge;
  var mainQa;
  var mainActions;
  var mainSeed;
  var mainLock;
  var mainDownload;
  var thumbButtons = [];
  var qaReports = [];
  var bestIndex = -1;
  var bestReport = null;
  var retryPlan = null;
  var suggestions = [];
  var outcome = null;
  var isAgent = isAgentMode();
  var i;
  function selectImage(index){
    var item = images[index];
    var image = validateImageUrl(item.image);
    var qaReport = isAgent ? qaReports[index] : null;
    var qaScore;
    var fallback = getSizeDimensions(base.size);
    var j;
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
    mainBadge.hidden = !(isAgent && index === bestIndex);
    clearNode(mainQa);
    if(qaReport){
      qaScore = qaAverage(qaReport);
      mainQa.hidden = false;
      mainQa.textContent = 'QA ' + qaScore + '/100 · ' + qaReport.reason;
      if(qaReport.detectedIssues && qaReport.detectedIssues.length){
        mainQa.textContent += ' 問題：' + qaReport.detectedIssues.join('；');
      }
      appendQaDetails(mainQa, qaReport);
    }else{
      mainQa.hidden = true;
    }
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
  if(isAgent){
    for(i = 0; i < images.length; i += 1){
      qaReports.push(createQaReport('variation-' + String(i + 1), i, images.length, base, images[i], agentAnalysis));
    }
    bestIndex = pickBestQaIndex(qaReports);
    if(bestIndex < 0){ bestIndex = 0; }
    for(i = 0; i < qaReports.length; i += 1){
      if(i === bestIndex){
        if(qaReports[i].recommendation !== 'retry' && !isSevereQaFailure(qaReports[i])){
          qaReports[i].recommendation = 'keep';
          qaReports[i].reason = '主體完整、構圖清楚，綜合分數最高，最適合作為本輪首選。';
        }else{
          qaReports[i].reason = '本輪最佳圖仍有嚴重品質問題，智慧體會自動重試一次。';
        }
      }else if(qaReports[i].recommendation === 'keep'){
        qaReports[i].recommendation = 'edit';
        qaReports[i].reason = '可作為變體候選，但綜合分數略低於推薦圖。';
      }
    }
    bestReport = qaReports[bestIndex];
    retryPlan = createAutoRetryPlan(bestReport, agentAnalysis);
    suggestions = buildAgentSuggestions(agentAnalysis, bestReport);
    outcome = {
      bestIndex: bestIndex,
      bestReport: bestReport,
      retryPlan: retryPlan,
      suggestions: suggestions,
      text: '推薦最佳圖：第 ' + String(bestIndex + 1) + ' 張。原因：' + bestReport.reason + ' QA 綜合分數 ' + qaAverage(bestReport) + '/100。'
    };
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
  mainBadge = document.createElement('span');
  mainBadge.className = 'batch-best-badge';
  mainBadge.textContent = '推薦最佳圖';
  mainBadge.hidden = true;
  mainQa = document.createElement('div');
  mainQa.className = 'batch-qa';
  mainQa.hidden = true;
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
  mainMeta.appendChild(mainBadge);
  mainMeta.appendChild(mainQa);
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
    var qaReport = isAgent ? qaReports[index] : null;

    card.className = 'batch-card' + (isAgent && index === bestIndex ? ' is-recommended' : '');
    card.setAttribute('role', 'listitem');
    thumb.type = 'button';
    thumb.className = 'batch-thumb';
    thumb.setAttribute('aria-label', '檢視第 ' + String(index + 1) + ' 張生成圖片');
    thumb.setAttribute('aria-pressed', 'false');
    img.src = image;
    img.alt = '生成圖片變體第 ' + String(index + 1) + ' 張';
    img.loading = 'lazy';
    label.className = 'batch-thumb-label';
    label.textContent = '第 ' + String(index + 1) + ' 張' + (isAgent && index === bestIndex ? ' · 推薦' : '');
    thumb.appendChild(img);
    thumb.appendChild(label);
    thumb.addEventListener('click', function(){
      selectImage(index);
    });
    thumbButtons.push(thumb);
    card.appendChild(thumb);
    grid.appendChild(card);

    document.dispatchEvent(new CustomEvent('imagegen:generated', { detail: {
      image: image,
      thumbnail: image,
      prompt: base.prompt,
      providerPrompt: base.providerPrompt,
      avoid: base.avoid,
      model: typeof item.model === 'string' ? item.model : 'schnell',
      size: base.size,
      seed: typeof item.seed === 'number' ? item.seed : 0,
      width: typeof item.width === 'number' ? item.width : fallback.width,
      height: typeof item.height === 'number' ? item.height : fallback.height,
      provider: typeof item.provider === 'string' ? item.provider : '',
      sourceRecordId: '',
      mode: isAgent ? 'agent' : 'normal',
      qaReport: isAgent ? qaReport : null,
      recommended: isAgent && index === bestIndex,
      agentRecommendation: isAgent ? outcome.text : '',
      autoRetry: isAgent ? retryPlan : null,
      nextSuggestions: isAgent ? suggestions : []
    }}));
  });
  viewer.appendChild(mainFrame);
  viewer.appendChild(grid);
  stage.appendChild(createMobileSaveHint());
  stage.appendChild(viewer);
  selectImage(isAgent && bestIndex >= 0 ? bestIndex : 0);
  if(isAgent){ renderAgentOutcome(outcome); }
  return outcome;
}

function buildAgentAutoRetryPrompt(providerPrompt, retryPlan){
  var reason = retryPlan && retryPlan.reason ? retryPlan.reason : 'QA 分數偏低';
  var negativePatch = retryPlan && retryPlan.negativePatch ? retryPlan.negativePatch : 'blur, watermark, malformed hands, malformed faces, gibberish text, broken layout';
  return providerPrompt + '\n\nQuality correction retry: fix these issues: ' + reason + '. Generate a complete, sharp, valid image that matches the requested composition, keeps the main subject visible. Negative focus: ' + negativePatch + '. Avoid blur, watermark, malformed hands, malformed faces, gibberish text, and broken layout.';
}

function runAgentAutoRetry(settings, providerPrompt, prompt, model, size, retryPlan){
  if(!retryPlan || retryPlan.action !== 'auto_retry' || retryPlan.attempted){ return Promise.resolve(null); }
  retryPlan.attempted = true;
  retryPlan.message = '已觸發自動重試一次：' + (retryPlan.reason || 'QA 分數偏低');
  return fetch('/generate', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      prompt: buildAgentAutoRetryPrompt(providerPrompt, retryPlan),
      userPrompt: prompt,
      model: model,
      size: size,
      width: settings.width,
      height: settings.height,
      seed: 0,
      visionQa: true,
      turnstileToken: readTurnstileToken()
    })
  }).then(function(response){
    return response.json().then(function(data){
      if(!response.ok){
        throw new Error(data && data.error ? data.error : ('HTTP ' + response.status));
      }
      return data;
    });
  });
}

function appendAgentAutoRetryResult(stage, item, base, retryPlan){
  var grid = stage ? stage.querySelector('.batch-grid') : null;
  var image;
  var card;
  var img;
  var badge;
  var qaBox;
  var qaReport;
  var qaScore;
  var actions;
  var seedTag;
  var dlLink;
  var fallback;
  var suggestions;
  var outcome;
  if(!grid || !item){ return null; }
  image = validateImageUrl(item.image);
  fallback = getSizeDimensions(base.size);
  qaReport = createQaReport('auto-retry-1', grid.children.length, grid.children.length + 1, base, item, agentAnalysis);
  if(!isSevereQaFailure(qaReport) && qaReport.recommendation !== 'retry'){
    qaReport.recommendation = 'keep';
    qaReport.reason = '已自動修正一次，圖片格式與尺寸檢查達可用標準。';
  }
  card = document.createElement('div');
  card.className = 'batch-card is-auto-retry';
  card.setAttribute('role', 'listitem');
  badge = document.createElement('div');
  badge.className = 'batch-best-badge';
  badge.textContent = '已自動修正一次';
  card.appendChild(badge);
  img = document.createElement('img');
  img.src = image;
  img.alt = '智慧體自動重試後的圖片';
  img.loading = 'lazy';
  card.appendChild(img);
  qaScore = qaAverage(qaReport);
  qaBox = document.createElement('div');
  qaBox.className = 'batch-qa';
  qaBox.textContent = 'QA ' + qaScore + '/100 · ' + qaReport.reason;
  if(qaReport.detectedIssues && qaReport.detectedIssues.length){
    qaBox.textContent += ' 問題：' + qaReport.detectedIssues.join('；');
  }
  appendQaDetails(qaBox, qaReport);
  card.appendChild(qaBox);
  seedTag = document.createElement('span');
  seedTag.className = 'batch-seed';
  seedTag.textContent = '種子碼 ' + (typeof item.seed === 'number' ? item.seed : '—');
  dlLink = document.createElement('a');
  dlLink.className = 'btn mini secondary';
  dlLink.textContent = '⬇ 下載';
  dlLink.href = image;
  dlLink.download = slugify(base.prompt) + '_' + (item.seed || 0) + extensionFromImageData(image);
  actions = document.createElement('div');
  actions.className = 'batch-card-actions';
  actions.appendChild(seedTag);
  actions.appendChild(dlLink);
  card.appendChild(actions);
  grid.appendChild(card);
  suggestions = buildAgentSuggestions(agentAnalysis, qaReport);
  retryPlan.message = '已自動修正一次：' + qaReport.reason;
  outcome = {
    bestIndex: grid.children.length - 1,
    bestReport: qaReport,
    retryPlan: retryPlan,
    suggestions: suggestions,
    text: '已自動修正一次。最新候選圖 QA 綜合分數 ' + qaScore + '/100。原因：' + qaReport.reason
  };
  renderAgentOutcome(outcome);
  document.dispatchEvent(new CustomEvent('imagegen:generated', { detail: {
    image: image,
    thumbnail: image,
    prompt: base.prompt,
    providerPrompt: base.providerPrompt,
    avoid: base.avoid,
    model: typeof item.model === 'string' ? item.model : 'schnell',
    size: base.size,
    seed: typeof item.seed === 'number' ? item.seed : 0,
    width: typeof item.width === 'number' ? item.width : fallback.width,
    height: typeof item.height === 'number' ? item.height : fallback.height,
    provider: typeof item.provider === 'string' ? item.provider : '',
    sourceRecordId: '',
    mode: 'agent',
    qaReport: qaReport,
    recommended: qaReport.recommendation === 'keep',
    agentRecommendation: outcome.text,
    autoRetry: retryPlan,
    nextSuggestions: suggestions
  }}));
  return qaReport;
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
    if(isAgentMode()){ setAgentStep('prompt', 'success', existingProviderPrompt ? '使用進階區 prompt' : '沿用原始描述'); }
    return Promise.resolve(settings);
  }

  setGenerationState('compiling_prompt');
  setStatus('正在整理提示詞', 'busy');
  if(isAgentMode()){ setAgentStep('prompt', 'running', '中文轉 FLUX provider prompt'); }
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
      if(isAgentMode()){
        setAgentStep('complete', 'success', '已依風格補足視覺細節');
        setAgentStep('prompt', 'success', '已產生 provider prompt');
      }
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
  generationMode = getGenerationMode();
  if(generationMode === 'agent' && !opts.skipAgentPrepare){
    prepareAgentFlow();
  }

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
      return generate({ skipAgentPrepare: true, startedAt: flowStartedAt, triggerButton: triggerButton });
    }, function(error){
      var compileSeconds = compileTimer.stop();
      generationInFlight = false;
      pendingSourceRecordId = '';
      reportClientError(error, { type: 'prompt_compile' });
      renderStageText(stage, '提示詞整理失敗：' + error.message, 'err');
      setStatus('❌ 提示詞整理失敗（耗時 ' + compileSeconds + ' 秒）：' + error.message, 'fail');
      setGenerationState('error');
      if(isAgentMode()){
        setAgentStep('complete', 'error', error.message);
        setAgentStep('prompt', 'error', error.message);
      }
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
  if(generationMode === 'agent'){ setAgentStep('generate', 'running', '呼叫出圖服務'); }
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
    if(isAgentMode()){ setAgentStep('generate', 'error', message); }
  }

  function handleGenerateError(err){
    var raw = errorMessage(err);
    var message = /failed to fetch|networkerror|err_failed|load failed/i.test(raw) ? '網路連線中斷' : (raw || '網路連線中斷');
    showGenerateFailure({ code: 'network', adviceCode: 'network', message: message, requestId: '', retryAfter: 0 }, 'generate_network', err);
  }

  var batchCount = readBatchCount();
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
        count: batchCount,
        visionQa: generationMode === 'agent',
        turnstileToken: readTurnstileToken()
      })
    }).then(function(response){
      return response.json().then(function(data){
        var secs;
        var images;
        var batchErrors;
        var batchSummary;
        var note;
        var batchOutcome;
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
        batchOutcome = renderBatchResults(stage, images, { prompt: prompt, providerPrompt: providerPrompt, avoid: settings.avoid, size: size });
        revealResultStage(true);
        setResultActionsVisible(false);
        pendingSourceRecordId = '';
        note = providerNoteFor(images[0] && images[0].provider);
        setGenerationState('success');
        if(isAgentMode()){
          setAgentStep('generate', 'success', batchSummary);
          setAgentStep('qa', 'success', '已建立每張圖的 QAReport');
          setAgentStep('recommend', 'success', batchOutcome && typeof batchOutcome.bestIndex === 'number' ? '推薦最佳圖：第 ' + String(batchOutcome.bestIndex + 1) + ' 張' : '推薦保留此圖');
          setAgentStep('suggest', 'success', '已產生下一步修改建議');
          setAgentSummary('智慧體流程完成');
        }
        setStatus('✅ ' + batchSummary + '，耗時 ' + secs + ' 秒 ' + note, 'done');
        if(isAgentMode() && batchOutcome && batchOutcome.retryPlan && batchOutcome.retryPlan.action === 'auto_retry'){
          setAgentStep('qa', 'running', '偵測到嚴重品質問題，正在自動重試一次');
          setStatus('偵測到嚴重品質問題，智慧體自動重試一次', 'busy');
          return runAgentAutoRetry(settings, providerPrompt, prompt, model, size, batchOutcome.retryPlan).then(function(retryData){
            var retryReport = appendAgentAutoRetryResult(stage, retryData, { prompt: prompt, providerPrompt: providerPrompt, avoid: settings.avoid, size: size }, batchOutcome.retryPlan);
            setAgentStep('qa', 'success', '已自動修正一次並保存 QAReport');
            setAgentStep('recommend', 'success', retryReport && retryReport.recommendation === 'keep' ? '自動重試結果可保留' : '自動重試後仍建議人工挑選');
            setAgentSummary('智慧體流程完成，已自動修正一次');
            setStatus('✅ ' + batchSummary + '，並已自動修正一次 ' + note, 'done');
          }, function(retryError){
            reportClientError(retryError, { type: 'agent_auto_retry' });
            batchOutcome.retryPlan.message = '自動重試失敗：' + retryError.message;
            renderAgentOutcome(batchOutcome);
            setAgentStep('qa', 'success', '已建立 QAReport；自動重試失敗');
            setStatus('✅ ' + batchSummary + '；自動重試失敗：' + retryError.message, 'done');
          });
        }
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
      visionQa: generationMode === 'agent',
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
      var qaReport;
      var retryPlan;
      var suggestions;
      var singleOutcome;
      var qaBox;

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
      qaReport = generationMode === 'agent' ? createQaReport('single-result', 0, 1, { prompt: prompt, providerPrompt: providerPrompt, avoid: settings.avoid, size: size }, data, agentAnalysis) : null;
      if(qaReport){
        qaReport.recommendation = qaReport.recommendation === 'retry' ? 'retry' : 'keep';
        if(qaReport.recommendation === 'keep'){ qaReport.reason = '單張生成完成，主體與畫面設定達可用標準。'; }
        qaBox = document.createElement('div');
        qaBox.className = 'single-qa';
        qaBox.textContent = 'QA ' + qaAverage(qaReport) + '/100 · ' + qaReport.reason;
        if(qaReport.detectedIssues && qaReport.detectedIssues.length){
          qaBox.textContent += ' 問題：' + qaReport.detectedIssues.join('；');
        }
        appendQaDetails(qaBox, qaReport);
        stage.appendChild(qaBox);
      }
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
        seed: typeof data.seed === 'number' ? data.seed : 0,
        width: typeof data.width === 'number' ? data.width : fallbackDimensions.width,
        height: typeof data.height === 'number' ? data.height : fallbackDimensions.height,
        provider: typeof data.provider === 'string' ? data.provider : '',
        sourceRecordId: pendingSourceRecordId,
        mode: generationMode === 'agent' ? 'agent' : 'normal',
        qaReport: generationMode === 'agent' ? qaReport : null,
        recommended: generationMode === 'agent',
        agentRecommendation: generationMode === 'agent' && qaReport ? '推薦保留此圖。原因：' + qaReport.reason + ' QA 綜合分數 ' + qaAverage(qaReport) + '/100。' : '',
        autoRetry: generationMode === 'agent' && qaReport ? createAutoRetryPlan(qaReport, agentAnalysis) : null,
        nextSuggestions: generationMode === 'agent' && qaReport ? buildAgentSuggestions(agentAnalysis, qaReport) : []
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
      if(isAgentMode()){
        retryPlan = generatedRecord.autoRetry;
        suggestions = generatedRecord.nextSuggestions;
        singleOutcome = {
          bestIndex: 0,
          bestReport: qaReport,
          retryPlan: retryPlan,
          suggestions: suggestions,
          text: generatedRecord.agentRecommendation
        };
        renderAgentOutcome(singleOutcome);
        setAgentStep('generate', 'success', '已生成 1 張');
        setAgentStep('qa', 'success', '圖片格式有效，已保存 QAReport');
        setAgentStep('recommend', 'success', qaReport && qaReport.recommendation === 'retry' ? '建議重試或修改' : '推薦保留此圖');
        setAgentStep('suggest', 'success', '已產生下一步修改建議');
        setAgentSummary('智慧體流程完成');
      }
      setStatus('✅ 完成，耗時 ' + secs + ' 秒 ' + providerNote, 'done');
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
  if(field){ field.value = prompt || ''; }
  if(advanced){ advanced.open = true; }
  setGenerationState('idle');
  setStatus('已套用' + (label || '提示詞') + '；確認後再按「生成圖片」，不會自動消耗額度。', 'done');
  scrollToComposerAndFocus();
}

function setPromptAndGenerate(prompt){
  setPromptForReview(prompt, '提示詞');
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
  if(model){ model.value = 'schnell'; }
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
  setGenerationSettings: setGenerationSettings,
  applyExampleGalleryPrompt: applyExampleGalleryPrompt,
  getLastGeneration: getLastGeneration,
  setNextGenerationSourceRecord: setNextGenerationSourceRecord,
  lockCompositionFromRecord: lockCompositionFromRecord,
  copyText: copyText,
  setStatus: setStatus,
  prepareAgentFlow: prepareAgentFlow,
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
    if(data.providers.modal){ list.push('modal'); }
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
  setSelectIfOptionExists('promptStyle', params.get('style'));
  setSelectIfOptionExists('useCase', params.get('useCase'));
  if(el('advancedSettings')){ el('advancedSettings').open = true; }
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
  return fetch('/api/health').then(function(res){
    return res.json();
  }).then(function(data){
    lastProviderHealth = data || {};
    var status = data && data.providerStatus ? data.providerStatus : 'demo';
    var providers = providerListFromHealth(data);
    message = data && data.message ? data.message : (PROVIDER_STATUS_COPY[status] || PROVIDER_STATUS_COPY.error);
    setProviderStatus(status, message);
    configureTurnstile(data && data.turnstile ? data.turnstile : null);
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
  syncGenerationModeUi();
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
  if(el('modeNormal')){ el('modeNormal').addEventListener('change', syncGenerationModeUi); }
  if(el('modeAgent')){ el('modeAgent').addEventListener('change', syncGenerationModeUi); }
  if(el('agentRecommendation')){
    el('agentRecommendation').addEventListener('click', function(event){
      var target = event.target;
      var suggestion = '';
      while(target && target !== el('agentRecommendation')){
        if(target.getAttribute){
          suggestion = target.getAttribute('data-agent-suggestion') || '';
          if(suggestion){ break; }
        }
        target = target.parentNode;
      }
      if(suggestion){
        event.preventDefault();
        applyAgentSuggestion(suggestion);
      }
    });
  }
  updateMobileGenerateSummary();
  if(el('useCase')){ el('useCase').addEventListener('change', updateMobileGenerateSummary); }
  if(el('promptStyle')){
    el('promptStyle').addEventListener('change', function(){
      clearAutoProviderPrompt();
      updateMobileGenerateSummary();
    });
  }
  if(el('size')){ el('size').addEventListener('change', function(){ updateCustomSizeVisibility(); if(!generationInFlight){ setGenerationState('idle'); } }); }
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
    setPromptForReview(randomPrompt(), '隨機靈感');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.idea[data-prompt]'), function(button){
    button.addEventListener('click', function(){
      setPromptForReview(button.getAttribute('data-prompt'), '靈感 prompt');
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
