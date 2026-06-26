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
var generationInFlight = false;
var lastGeneration = null;
var seedMode = 'random';
var pendingSourceRecordId = '';
var pendingPwaRegistration = null;
var pwaRefreshing = false;
var hadServiceWorkerController = false;

function pick(list){ return list[Math.floor(Math.random() * list.length)]; }
function el(id){ return document.getElementById(id); }
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
  status.textContent = text;
  status.className = 'status' + (cls ? ' ' + cls : '');
}
function enableDownload(on){
  var dl = el('dl');
  if(on){
    dl.classList.remove('is-disabled');
    dl.setAttribute('aria-disabled', 'false');
  }else{
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
  clearNode(stage);
  stage.appendChild(node);
}
function renderFailureAdvice(code){
  var advice;
  var stage = el('stage');
  var box;
  var title;
  var list;
  if(!window.FailureAdvice || !stage){ return; }
  advice = window.FailureAdvice.getAdvice(code);
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
function getSizeDimensions(size){
  if(size === 'landscape'){ return {width: 1344, height: 768}; }
  if(size === 'portrait'){ return {width: 768, height: 1344}; }
  return {width: 1024, height: 1024};
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
      hint.textContent = '每次生成都會給你不一樣的畫面。';
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
  var promptField = el('prompt');
  if(!promptField){ return; }
  if(typeof promptField.scrollIntoView === 'function'){
    promptField.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  promptField.focus();
}
function readGenerationSettings(){
  return GenerationSettings.serializeSettings({
    prompt: el('prompt').value,
    avoid: el('avoid') ? el('avoid').value : '',
    model: el('model').value,
    size: el('size').value,
    seed: computeSeedForGeneration()
  });
}
function setGenerationSettings(settings){
  var source = settings || {};
  if(Object.prototype.hasOwnProperty.call(source, 'prompt')){ el('prompt').value = source.prompt || ''; }
  if(Object.prototype.hasOwnProperty.call(source, 'avoid') && el('avoid')){ el('avoid').value = source.avoid || ''; }
  if(Object.prototype.hasOwnProperty.call(source, 'model')){ el('model').value = source.model || 'schnell'; }
  if(Object.prototype.hasOwnProperty.call(source, 'size')){ el('size').value = source.size || 'square'; }
  if(Object.prototype.hasOwnProperty.call(source, 'seed') && el('seed')){ el('seed').value = String(source.seed || 0); }
}
function setNextGenerationSourceRecord(id){
  pendingSourceRecordId = id || '';
}
function applyPromptEnhancement(mode){
  var promptField = el('prompt');
  var result;
  if(!window.PromptEnhancer || !promptField){ return; }
  try{
    result = window.PromptEnhancer.enhancePrompt(promptField.value, mode);
    promptField.value = result.prompt;
    setStatus('已套用：' + result.label, 'done');
  }catch(error){
    setStatus(error.message, 'fail');
  }
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

function generate(){
  if(generationInFlight){
    pendingSourceRecordId = '';
    return Promise.resolve();
  }
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
  enableDownload(false);
  setResultActionsVisible(false);

  try{
    settings = readGenerationSettings();
  }catch(error){
    pendingSourceRecordId = '';
    renderStageText(stage, error.message, 'err');
    setStatus('❌ ' + error.message, 'fail');
    return Promise.resolve();
  }

  prompt = settings.prompt;
  providerPrompt = settings.providerPrompt;
  model = settings.model;
  size = settings.size;

  if(!prompt){
    pendingSourceRecordId = '';
    setStatus('請先輸入描述文字', 'fail');
    renderStageText(stage, '請先輸入描述文字', 'err');
    return Promise.resolve();
  }

  generationInFlight = true;
  btn.disabled = true;
  btn.textContent = '生成中…';
  stage.classList.remove('has-failure-advice');
  spinner = document.createElement('div');
  spinner.className = 'skeleton';
  clearNode(stage);
  stage.appendChild(spinner);
  t0 = performance.now();
  timer = setInterval(function(){
    var s = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(progressCopy(model, s), 'busy');
  }, 100);

  function cleanupGenerate(){
    generationInFlight = false;
    btn.disabled = false;
    btn.textContent = '🎨 生成圖片';
  }

  function handleGenerateError(err){
    var errMsg;
    reportClientError(err, { type: 'generate_network' });
    clearInterval(timer);
    setResultActionsVisible(false);
    errMsg = document.createElement('span');
    errMsg.className = 'err';
    errMsg.textContent = '出錯了：' + err.message;
    stage.classList.remove('has-failure-advice');
    clearNode(stage);
    stage.appendChild(errMsg);
    renderFailureAdvice('network');
    pendingSourceRecordId = '';
    setStatus('❌ 失敗：' + err.message, 'fail');
  }

  return fetch('/generate', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      prompt: providerPrompt,
      model: model,
      size: size,
      seed: settings.seed
    })
  }).then(function(response){
    return response.json().then(function(data){
      var backendMessage;
      var backendErrMsg;
      var secs;
      var image;
      var img;
      var fallbackDimensions;
      var generatedRecord;
      var providerNote;

      if(!response.ok){
        var requestId = responseRequestId(response) || (data && data.requestId ? data.requestId : '');
        backendMessage = data && data.error ? data.error : ('HTTP ' + response.status);
        reportClientError(new Error(backendMessage), {
          type: 'generate_backend',
          requestId: requestId,
          source: data && data.code ? data.code : 'unknown'
        });
        clearInterval(timer);
        setResultActionsVisible(false);
        backendErrMsg = document.createElement('span');
        backendErrMsg.className = 'err';
        backendErrMsg.textContent = '出錯了：' + backendMessage + requestIdSuffix(requestId);
        stage.classList.remove('has-failure-advice');
        clearNode(stage);
        stage.appendChild(backendErrMsg);
        renderFailureAdvice(data && data.code ? data.code : 'unknown');
        pendingSourceRecordId = '';
        setStatus('❌ 失敗：' + backendMessage + requestIdSuffix(requestId), 'fail');
        return;
      }

      clearInterval(timer);
      secs = ((performance.now() - t0) / 1000).toFixed(1);
      image = validateImageUrl(data.image);
      img = document.createElement('img');
      img.src = image;
      img.alt = 'generated image';
      stage.classList.remove('has-failure-advice');
      clearNode(stage);
      stage.appendChild(img);
      dl.href = image;
      dl.download = slugify(prompt) + '_' + timestamp() + extensionFromImageData(image);
      enableDownload(true);
      fallbackDimensions = getSizeDimensions(size);
      generatedRecord = {
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
        sourceRecordId: pendingSourceRecordId
      };
      lastGeneration = shallowClone(generatedRecord);
      if(el('seed') && isConcreteSeed(generatedRecord.seed)){
        el('seed').value = String(generatedRecord.seed);
        updateSeedModeUi();
      }
      setResultActionsVisible(true);
      document.dispatchEvent(new CustomEvent('imagegen:generated', { detail: shallowClone(generatedRecord) }));
      pendingSourceRecordId = '';
      providerNote = generatedRecord.provider === 'demo' ? '（Demo 圖，設定 NVIDIA_API_KEY 後可真實產圖）' : '（NVIDIA FLUX）';
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

function setPromptAndGenerate(prompt){
  el('prompt').value = prompt;
  generate();
}

window.ImageGenApp = {
  generate: generate,
  setPromptAndGenerate: setPromptAndGenerate,
  setGenerationSettings: setGenerationSettings,
  setNextGenerationSourceRecord: setNextGenerationSourceRecord,
  lockCompositionFromRecord: lockCompositionFromRecord,
  copyText: copyText,
  setStatus: setStatus,
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
function refreshProvider(){
  var pill = el('provider-pill');
  var text = el('provider-text');
  if(!pill || !text){ return Promise.resolve(); }
  return fetch('/health').then(function(res){
    return res.json();
  }).then(function(data){
    if(data.provider === 'nvidia'){
      pill.className = 'pill online';
      text.textContent = '真實出圖 · NVIDIA FLUX';
      showDemoNotice(false);
    }else{
      pill.className = 'pill demo';
      text.textContent = 'Demo 模式 · 示意圖';
      showDemoNotice(true);
    }
  }).catch(function(){
    pill.className = 'pill offline';
    text.textContent = '離線';
    showDemoNotice(false);
  });
}

document.addEventListener('DOMContentLoaded', function(){
  registerServiceWorker();
  refreshProvider();
  el('go').addEventListener('click', generate);
  if(el('mobileGenerate')){ el('mobileGenerate').addEventListener('click', generate); }
  if(el('mobileGenerateBar')){ el('mobileGenerateBar').hidden = false; }
  if(el('reloadPwa')){ el('reloadPwa').addEventListener('click', reloadPwaVersion); }
  if(el('regenerate')){ el('regenerate').addEventListener('click', regenerate); }
  if(el('copySettings')){ el('copySettings').addEventListener('click', copySettings); }
  if(el('copyPrompt')){ el('copyPrompt').addEventListener('click', copyPrompt); }
  if(el('seedRandom')){ el('seedRandom').addEventListener('click', function(){ setSeedMode('random'); }); }
  if(el('seedLock')){ el('seedLock').addEventListener('click', onSeedLockClick); }
  if(el('seed')){ el('seed').addEventListener('input', onSeedManualInput); }
  if(el('useComposition')){ el('useComposition').addEventListener('click', useComposition); }
  updateSeedModeUi();
  Array.prototype.forEach.call(document.querySelectorAll('[data-enhance-mode]'), function(button){
    button.addEventListener('click', function(){
      applyPromptEnhancement(button.getAttribute('data-enhance-mode'));
    });
  });
  el('random').addEventListener('click', function(){
    el('prompt').value = randomPrompt();
    generate();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.idea[data-prompt]'), function(button){
    button.addEventListener('click', function(){
      el('prompt').value = button.getAttribute('data-prompt');
      generate();
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
