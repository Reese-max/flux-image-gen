from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(relative):
    return (ROOT / relative).read_text(encoding="utf-8")


def write(relative, content):
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")


def replace_once(relative, old, new):
    content = read(relative)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{relative}: expected exactly one match, found {count}")
    write(relative, content.replace(old, new, 1))


# Issue #1: use Blob object URLs for all browser image downloads.
write(
    "app/static/download-utils.js",
    r"""(function (root) {
  'use strict';

  var activeObjectUrls = [];

  function text(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function removeTrackedUrl(url) {
    var index = activeObjectUrls.indexOf(url);
    if (index !== -1) {
      activeObjectUrls.splice(index, 1);
    }
  }

  function revokeObjectUrl(url) {
    if (!url || !root.URL || typeof root.URL.revokeObjectURL !== 'function') { return; }
    removeTrackedUrl(url);
    root.URL.revokeObjectURL(url);
  }

  function dataUrlToBlob(dataUrl) {
    var source = text(dataUrl);
    var comma = source.indexOf(',');
    var metadata;
    var mime;
    var base64;
    var payload;
    var binary;
    var bytes;
    var i;

    if (source.indexOf('data:image/') !== 0 || comma < 0) {
      throw new Error('圖片資料格式不正確');
    }
    metadata = source.slice(5, comma).split(';');
    mime = metadata.shift() || 'image/png';
    base64 = metadata.indexOf('base64') !== -1;
    payload = source.slice(comma + 1);
    try {
      binary = base64 ? root.atob(payload.replace(/\s/g, '')) : root.decodeURIComponent(payload);
    } catch (error) {
      throw new Error('圖片資料無法解碼');
    }
    bytes = new root.Uint8Array(binary.length);
    for (i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i) & 255;
    }
    return new root.Blob([bytes], { type: mime });
  }

  function clearLink(link) {
    if (!link) { return; }
    if (link._imageDownloadObjectUrl) {
      revokeObjectUrl(link._imageDownloadObjectUrl);
      link._imageDownloadObjectUrl = '';
    }
    link.removeAttribute('href');
  }

  function isAllowedImageUrl(source) {
    return source.indexOf('https://') === 0 ||
      source.indexOf('http://') === 0 ||
      source.indexOf('blob:') === 0 ||
      source.charAt(0) === '/';
  }

  function prepareLink(link, image, filename) {
    var source = text(image);
    var href = source;
    var blob;

    if (!link) {
      throw new Error('找不到下載按鈕');
    }
    clearLink(link);
    if (source.indexOf('data:image/') === 0) {
      if (!root.URL || typeof root.URL.createObjectURL !== 'function' ||
          typeof root.Blob !== 'function' ||
          typeof root.Uint8Array !== 'function' ||
          typeof root.atob !== 'function') {
        throw new Error('瀏覽器不支援安全圖片下載');
      }
      blob = dataUrlToBlob(source);
      href = root.URL.createObjectURL(blob);
      activeObjectUrls.push(href);
      link._imageDownloadObjectUrl = href;
    } else if (!isAllowedImageUrl(source)) {
      throw new Error('圖片網址格式不正確');
    }
    link.href = href;
    if (filename) {
      link.download = filename;
    }
    return href;
  }

  function trigger(image, filename) {
    var link;
    if (!root.document || !root.document.body) {
      throw new Error('下載功能尚未就緒');
    }
    link = root.document.createElement('a');
    link.style.display = 'none';
    prepareLink(link, image, filename);
    root.document.body.appendChild(link);
    try {
      link.click();
    } finally {
      root.setTimeout(function () {
        clearLink(link);
        if (link.parentNode) {
          link.parentNode.removeChild(link);
        }
      }, 1000);
    }
  }

  function revokeAll() {
    var urls = activeObjectUrls.slice();
    var i;
    for (i = 0; i < urls.length; i += 1) {
      revokeObjectUrl(urls[i]);
    }
  }

  if (root.addEventListener) {
    root.addEventListener('pagehide', revokeAll);
  }

  root.ImageDownload = {
    dataUrlToBlob: dataUrlToBlob,
    prepareLink: prepareLink,
    clearLink: clearLink,
    trigger: trigger,
    revokeAll: revokeAll
  };
})(typeof window !== 'undefined' ? window : this);
""",
)

replace_once(
    "app/static/index.html",
    '  <script src="/static/failure-advice.js"></script>\n  <script src="/static/app.js"></script>',
    '  <script src="/static/failure-advice.js"></script>\n  <script src="/static/download-utils.js"></script>\n  <script src="/static/app.js"></script>',
)

replace_once(
    "app/static/service-worker.js",
    "  var CACHE_NAME = 'ai-image-generator-pwa-v24';",
    "  var CACHE_NAME = 'ai-image-generator-pwa-v25';",
)
replace_once(
    "app/static/service-worker.js",
    "    '/static/failure-advice.js',\n    '/static/app.js',",
    "    '/static/failure-advice.js',\n    '/static/download-utils.js',\n    '/static/app.js',",
)

replace_once(
    "app/static/app.js",
    """(function(){
  var ok = ('fetch' in window) && ('Promise' in window) && (typeof window.fetch === 'function');
  if(!ok){
    var banner = document.getElementById('oldbrowser');
    var button = document.getElementById('go');
    if(banner){ banner.style.display = 'block'; }
    if(button){ button.disabled = true; button.textContent = '不支援'; }
  }
})();""",
    """(function(){
  var banner = document.getElementById('oldbrowser');
  var button = document.getElementById('go');
  var ok = ('fetch' in window) &&
    ('Promise' in window) &&
    ('Blob' in window) &&
    ('Uint8Array' in window) &&
    window.URL &&
    (typeof window.fetch === 'function') &&
    (typeof window.URL.createObjectURL === 'function');
  if(ok){
    if(banner && banner.parentNode){ banner.parentNode.removeChild(banner); }
    return;
  }
  if(banner){ banner.style.display = 'block'; }
  if(button){ button.disabled = true; button.textContent = '不支援'; }
})();""",
)

replace_once(
    "app/static/app.js",
    "var retryCountdownTimer = null;\n",
    "var retryCountdownTimer = null;\nvar toastTimer = null;\nvar PWA_UPDATE_DISMISS_KEY = 'fluxiPwaUpdateDismissed.v1';\n",
)

replace_once(
    "app/static/app.js",
    """function setStatus(text, cls){
  var status = el('status');
  if(!status){ return; }
  status.textContent = text;
  status.className = 'status' + (cls ? ' ' + cls : '');
  status.setAttribute('role', cls === 'fail' ? 'alert' : 'status');
  status.setAttribute('aria-live', cls === 'fail' ? 'assertive' : 'polite');
}
""",
    """function setStatus(text, cls){
  var status = el('status');
  if(!status){ return; }
  status.textContent = text;
  status.className = 'status' + (cls ? ' ' + cls : '');
  status.setAttribute('role', cls === 'fail' ? 'alert' : 'status');
  status.setAttribute('aria-live', cls === 'fail' ? 'assertive' : 'polite');
}
function showToast(message, kind){
  var toast = el('appToast');
  if(toastTimer){ window.clearTimeout(toastTimer); }
  if(!toast){
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.setAttribute('aria-atomic', 'true');
    document.body.appendChild(toast);
  }
  toast.setAttribute('role', kind === 'fail' ? 'alert' : 'status');
  toast.setAttribute('aria-live', kind === 'fail' ? 'assertive' : 'polite');
  toast.className = 'app-toast' + (kind ? ' is-' + kind : '');
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(function(){
    if(toast && toast.parentNode){ toast.parentNode.removeChild(toast); }
    toastTimer = null;
  }, 3600);
}
""",
)

replace_once(
    "app/static/app.js",
    """function enableDownload(on){
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
""",
    """function enableDownload(on){
  var dl = el('dl');
  if(!dl){ return; }
  if(on){
    dl.hidden = false;
    dl.classList.remove('is-disabled');
    dl.setAttribute('aria-disabled', 'false');
  }else{
    dl.hidden = true;
    dl.classList.add('is-disabled');
    dl.setAttribute('aria-disabled', 'true');
    if(window.ImageDownload && typeof window.ImageDownload.clearLink === 'function'){
      window.ImageDownload.clearLink(dl);
    }else{
      dl.removeAttribute('href');
    }
  }
}
function prepareImageDownload(link, image, filename){
  if(!window.ImageDownload || typeof window.ImageDownload.prepareLink !== 'function'){
    throw new Error('下載功能尚未就緒');
  }
  return window.ImageDownload.prepareLink(link, image, filename);
}
""",
)

replace_once(
    "app/static/app.js",
    """function registerServiceWorker(){
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
""",
    """function pwaUpdateDismissed(){
  try{
    return window.sessionStorage.getItem(PWA_UPDATE_DISMISS_KEY) === '1';
  }catch(error){
    return false;
  }
}
function createPwaUpdateNotice(){
  var notice = document.createElement('div');
  var message = document.createElement('span');
  var reload = document.createElement('button');
  var dismiss = document.createElement('button');
  notice.id = 'pwaUpdateNotice';
  notice.className = 'pwa-update-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.setAttribute('aria-atomic', 'true');
  message.textContent = '新版本已準備好。';
  reload.id = 'reloadPwa';
  reload.className = 'btn mini secondary';
  reload.type = 'button';
  reload.textContent = '重新整理';
  dismiss.id = 'dismissPwa';
  dismiss.className = 'btn mini secondary';
  dismiss.type = 'button';
  dismiss.textContent = '稍後';
  reload.addEventListener('click', reloadPwaVersion);
  dismiss.addEventListener('click', dismissPwaUpdate);
  notice.appendChild(message);
  notice.appendChild(reload);
  notice.appendChild(dismiss);
  document.body.appendChild(notice);
  return notice;
}
function hidePwaUpdateNotice(remember){
  var notice = el('pwaUpdateNotice');
  if(remember){
    try{ window.sessionStorage.setItem(PWA_UPDATE_DISMISS_KEY, '1'); }catch(error){}
  }
  if(notice && notice.parentNode){ notice.parentNode.removeChild(notice); }
  pendingPwaRegistration = null;
}
function dismissPwaUpdate(){
  hidePwaUpdateNotice(true);
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
    hidePwaUpdateNotice(false);
    window.location.reload();
  });
}
function showPwaUpdateNotice(registration){
  var notice;
  if(pwaUpdateDismissed()){ return; }
  pendingPwaRegistration = registration || null;
  notice = el('pwaUpdateNotice') || createPwaUpdateNotice();
  notice.hidden = false;
}
function reloadPwaVersion(){
  var registration = pendingPwaRegistration;
  hidePwaUpdateNotice(false);
  try{ window.sessionStorage.removeItem(PWA_UPDATE_DISMISS_KEY); }catch(error){}
  if(registration && registration.waiting){
    pwaUpdateRequested = true;
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  window.location.reload();
}
""",
)

replace_once(
    "app/static/app.js",
    """    mainDownload.href = image;
    mainDownload.download = slugify(base.prompt) + '_' + (item.seed || 0) + extensionFromImageData(image);
""",
    """    try{
      prepareImageDownload(
        mainDownload,
        image,
        slugify(base.prompt) + '_' + (item.seed || 0) + extensionFromImageData(image)
      );
      mainDownload.hidden = false;
    }catch(downloadError){
      mainDownload.hidden = true;
      reportClientError(downloadError, { type: 'prepare_batch_download' });
    }
""",
)

replace_once(
    "app/static/app.js",
    """      dl.href = image;
      dl.download = slugify(prompt) + '_' + timestamp() + extensionFromImageData(image);
      enableDownload(true);
""",
    """      try{
        prepareImageDownload(
          dl,
          image,
          slugify(prompt) + '_' + timestamp() + extensionFromImageData(image)
        );
        enableDownload(true);
      }catch(downloadError){
        enableDownload(false);
        reportClientError(downloadError, { type: 'prepare_download' });
      }
""",
)

replace_once(
    "app/static/app.js",
    """function onSeedLockClick(){
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
""",
    """function onSeedLockClick(){
  var seedField = el('seed');
  var message;
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
  message = '先生成一張圖，才能鎖定它的構圖';
  setStatus(message, 'warn');
  showToast(message, 'warn');
}
""",
)

replace_once(
    "app/static/app.js",
    """function applyQualityPreset(name){
  var preset = QUALITY_PRESETS[name];
  if(!preset){ return; }
  if(el('devSteps')){ el('devSteps').value = preset.steps; }
  if(el('devCfgScale')){ el('devCfgScale').value = preset.cfg; }
  updateQualityPresetUi();
}
""",
    """function applyQualityPreset(name){
  var preset = QUALITY_PRESETS[name];
  if(!preset){ return; }
  if(el('devSteps')){ el('devSteps').value = preset.steps; }
  if(el('devCfgScale')){ el('devCfgScale').value = preset.cfg; }
  updateQualityPresetUi();
  document.dispatchEvent(new CustomEvent('imagegen:quality-changed', {
    detail: { preset: name, steps: preset.steps, cfgScale: preset.cfg }
  }));
}
""",
)

replace_once(
    "app/static/app.js",
    """function showDemoNotice(on){
  var notice = el('demo-notice');
  if(notice){ notice.hidden = !on; }
}
""",
    """function showDemoNotice(on){
  var notice = el('demo-notice');
  var shell;
  var topbar;
  var icon;
  var message;
  if(!on){
    if(notice && notice.parentNode){ notice.parentNode.removeChild(notice); }
    return;
  }
  if(!notice){
    notice = document.createElement('div');
    notice.id = 'demo-notice';
    notice.className = 'demo-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.setAttribute('aria-atomic', 'true');
    icon = document.createElement('span');
    icon.className = 'demo-ico';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⚠️';
    message = document.createElement('span');
    message.textContent = '目前是展示模式，畫面上的產出為示意圖，尚未接上真實生成服務。';
    notice.appendChild(icon);
    notice.appendChild(message);
    shell = document.querySelector('main.shell');
    topbar = shell ? shell.querySelector('.topbar') : null;
    if(shell && topbar && topbar.nextSibling){
      shell.insertBefore(notice, topbar.nextSibling);
    }else if(shell){
      shell.insertBefore(notice, shell.firstChild);
    }else{
      document.body.appendChild(notice);
    }
  }
  notice.hidden = false;
}
""",
)

replace_once(
    "app/static/app.js",
    """function providerNoteFor(provider){
  if(provider === 'demo'){ return '（示範圖片，圖片服務連接後可產生正式圖片）'; }
  if(provider === 'workers-ai'){ return '（Workers AI FLUX）'; }
  if(provider === 'nvidia-fallback'){ return '（Workers AI 忙碌，已自動改用 NVIDIA FLUX 備援）'; }
  return '（NVIDIA FLUX）';
}
""",
    """function providerNoteFor(provider){
  if(provider === 'demo'){ return '（示範圖片，圖片服務連接後可產生正式圖片）'; }
  if(provider === 'workers-ai'){ return '（Workers AI FLUX）'; }
  if(provider === 'pollinations'){ return '（Pollinations 備援）'; }
  if(provider === 'nvidia-fallback'){ return '（Workers AI 忙碌，已自動改用 NVIDIA FLUX 備援）'; }
  if(provider === 'nvidia'){ return '（NVIDIA FLUX）'; }
  if(provider){ return '（' + providerDisplayName(provider) + '）'; }
  return '（圖片服務）';
}
""",
)

replace_once(
    "app/static/app.js",
    "  if(el('reloadPwa')){ el('reloadPwa').addEventListener('click', reloadPwaVersion); }\n",
    "",
)

replace_once(
    "app/static/history-wall.js",
    """  function downloadHistoryImage(record) {
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
""",
    """  function downloadHistoryImage(record) {
    var sourceRecord = record || getSelectedRecord();
    var id = toText(sourceRecord && sourceRecord.id) || Date.now().toString(36);
    var image;
    var filename;
    try {
      image = validateHistoryImageUrl(sourceRecord && sourceRecord.image);
      filename = 'history_' + id + extensionFromImageData(image);
      if (!root.ImageDownload || typeof root.ImageDownload.trigger !== 'function') {
        throw new Error('下載功能尚未就緒');
      }
      root.ImageDownload.trigger(image, filename);
      setAppStatus('已開始下載圖片', 'done');
    } catch (error) {
      setAppStatus('下載失敗：' + error.message, 'fail');
    }
  }
""",
)

# Issue #2: make the canvas status bar reflect the quality preset, not just the model select.
replace_once(
    "app/static/tabs.js",
    """    var model = document.getElementById('model');
    var seed = document.getElementById('seed');
""",
    """    var model = document.getElementById('model');
    var devSteps = document.getElementById('devSteps');
    var devCfgScale = document.getElementById('devCfgScale');
    var seed = document.getElementById('seed');
""",
)

replace_once(
    "app/static/tabs.js",
    """    function updateSettings() {
      var currentSize = sizeText();
      var currentModel = model && model.value === 'dev' ? '高品質' : '快速草稿';
      var locked = seedLock && seedLock.getAttribute('aria-pressed') === 'true';
""",
    """    function qualityText() {
      var steps = devSteps ? devSteps.value.trim() : '';
      var cfg = devCfgScale ? devCfgScale.value.trim() : '';
      if (!model || model.value !== 'dev') { return '快速草稿'; }
      if (!steps && !cfg) { return '平衡'; }
      if (steps === '10' && cfg === '3') { return '草稿'; }
      if (steps === '45' && cfg === '4') { return '精緻'; }
      return '自訂';
    }
    function updateSettings() {
      var currentSize = sizeText();
      var currentModel = qualityText();
      var locked = seedLock && seedLock.getAttribute('aria-pressed') === 'true';
""",
)

replace_once(
    "app/static/tabs.js",
    """    bindChange(size);
    bindChange(model);
    bindChange(seed);
""",
    """    bindChange(size);
    bindChange(model);
    bindChange(devSteps);
    bindChange(devCfgScale);
    bindChange(seed);
""",
)

replace_once(
    "app/static/tabs.js",
    """    bindChange(document.getElementById('customHeight'));
    updateSettings();
""",
    """    bindChange(document.getElementById('customHeight'));
    document.addEventListener('imagegen:quality-changed', updateSettings);
    updateSettings();
""",
)

# Issue #5: remove static live-region copy; notices are now created only when needed.
replace_once(
    "app/static/index.html",
    """    <div id="demo-notice" class="demo-notice" role="status" aria-live="polite" hidden>
      <span class="demo-ico" aria-hidden="true">⚠️</span>
      <span>目前是<b>展示模式</b>，畫面上的產出為示意圖，尚未接上真實生成服務。</span>
    </div>

""",
    "",
)

replace_once(
    "app/static/index.html",
    """    <div id="pwaUpdateNotice" class="pwa-update-notice" role="status" aria-live="polite" aria-atomic="true" hidden>
      <span>新版本已準備好。</span>
      <button id="reloadPwa" class="btn mini secondary" type="button">重新整理</button>
    </div>

""",
    "",
)

styles = read("app/static/styles.css")
toast_css = r"""
/* ---------- transient app feedback ---------- */
.app-toast {
  position: fixed;
  right: max(16px, env(safe-area-inset-right, 0px));
  bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  z-index: 1400;
  width: max-content;
  max-width: min(420px, calc(100vw - 32px));
  padding: 12px 16px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.5;
}
.app-toast.is-warn {
  border-color: var(--sun-line);
  background: var(--sun-soft);
  color: var(--sun-ink);
}
.app-toast.is-fail {
  border-color: var(--danger-line);
  background: var(--danger-soft);
  color: var(--danger-ink);
}
.app-toast.is-done {
  border-color: var(--sage-line);
  background: var(--sage-soft);
  color: var(--sage-ink);
}
.app-toast[hidden] { display: none; }
"""
if "/* ---------- transient app feedback ---------- */" not in styles:
    write("app/static/styles.css", styles.rstrip() + "\n" + toast_css.lstrip())

# Focused regression tests for the five reported bugs.
write(
    "tests/frontend/download-utils.test.cjs",
    r"""const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '../../app/static/download-utils.js');
const tinyPng = 'data:image/png;base64,iVBORw0KGgo=';

function loadDownloadUtils() {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const created = [];
  const revoked = [];
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options && options.type;
    }
  }
  const context = {
    Blob: FakeBlob,
    Uint8Array,
    atob(value) {
      return Buffer.from(value, 'base64').toString('binary');
    },
    decodeURIComponent,
    URL: {
      createObjectURL(blob) {
        created.push(blob);
        return 'blob:test-' + created.length;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      }
    },
    addEventListener() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    document: {
      body: {
        appendChild(node) {
          node.parentNode = this;
        },
        removeChild(node) {
          node.parentNode = null;
        }
      },
      createElement() {
        return {
          style: {},
          removeAttribute(name) {
            delete this[name];
          },
          click() {
            this.clicked = true;
          }
        };
      }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: scriptPath });
  return { api: context.ImageDownload, created, revoked };
}

test('data image downloads are converted to Blob object URLs', () => {
  const { api, created } = loadDownloadUtils();
  const link = {
    removeAttribute(name) {
      delete this[name];
    }
  };
  const href = api.prepareLink(link, tinyPng, 'picture.png');
  assert.equal(href, 'blob:test-1');
  assert.equal(link.href, 'blob:test-1');
  assert.equal(link.download, 'picture.png');
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'image/png');
  assert.ok(!link.href.startsWith('data:'));
});

test('replacing a prepared download revokes the previous object URL', () => {
  const { api, revoked } = loadDownloadUtils();
  const link = {
    removeAttribute(name) {
      delete this[name];
    }
  };
  api.prepareLink(link, tinyPng, 'first.png');
  api.prepareLink(link, tinyPng, 'second.png');
  assert.deepEqual(revoked, ['blob:test-1']);
  assert.equal(link.href, 'blob:test-2');
});

test('temporary history download clicks a Blob URL and cleans it up', () => {
  const { api, revoked } = loadDownloadUtils();
  api.trigger(tinyPng, 'history.png');
  assert.deepEqual(revoked, ['blob:test-1']);
});
""",
)

write(
    "tests/test_five_issue_regressions.py",
    r"""from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def test_downloads_never_attach_data_urls_directly_to_download_links():
    app_js = read("app.js")
    history_js = read("history-wall.js")
    download_js = read("download-utils.js")
    html = read("index.html")
    worker = read("service-worker.js")

    assert "ImageDownload.prepareLink" in app_js
    assert "mainDownload.href = image" not in app_js
    assert "dl.href = image" not in app_js
    assert "ImageDownload.trigger" in history_js
    assert "createObjectURL" in download_js
    assert "dataUrlToBlob" in download_js
    assert '/static/download-utils.js' in html
    assert '/static/download-utils.js' in worker


def test_canvas_metadata_tracks_quality_presets():
    tabs_js = read("tabs.js")
    app_js = read("app.js")

    assert "function qualityText()" in tabs_js
    assert "if (!steps && !cfg) { return '平衡'; }" in tabs_js
    assert "if (steps === '10' && cfg === '3') { return '草稿'; }" in tabs_js
    assert "if (steps === '45' && cfg === '4') { return '精緻'; }" in tabs_js
    assert "imagegen:quality-changed" in tabs_js
    assert "imagegen:quality-changed" in app_js


def test_completion_provider_note_matches_actual_provider():
    app_js = read("app.js")

    assert "if(provider === 'pollinations'){ return '（Pollinations 備援）'; }" in app_js
    assert "if(provider === 'nvidia'){ return '（NVIDIA FLUX）'; }" in app_js
    assert "if(provider){ return '（' + providerDisplayName(provider) + '）'; }" in app_js


def test_lock_composition_without_an_image_shows_a_toast():
    app_js = read("app.js")
    styles = read("styles.css")

    assert "showToast(message, 'warn');" in app_js
    assert "message = '先生成一張圖，才能鎖定它的構圖';" in app_js
    assert ".app-toast" in styles


def test_stale_notices_are_created_only_when_relevant():
    html = read("index.html")
    app_js = read("app.js")
    worker = read("service-worker.js")

    assert 'id="demo-notice"' not in html
    assert 'id="pwaUpdateNotice"' not in html
    assert "目前是<b>展示模式</b>" not in html
    assert "if(banner && banner.parentNode){ banner.parentNode.removeChild(banner); }" in app_js
    assert "function createPwaUpdateNotice()" in app_js
    assert "function dismissPwaUpdate()" in app_js
    assert "PWA_UPDATE_DISMISS_KEY" in app_js
    assert "ai-image-generator-pwa-v25" in worker
""",
)


replace_once(
    "tests/test_static_ui.py",
    """    assert 'id="demo-notice" class="demo-notice" role="status" aria-live="polite"' in html
""",
    """    assert 'id="demo-notice"' not in html
    assert "function showDemoNotice(on)" in app_js
""",
)

replace_once(
    "tests/test_static_ui.py",
    """    assert 'id="pwaUpdateNotice"' in html
    assert 'id="reloadPwa"' in html
""",
    """    assert 'id="pwaUpdateNotice"' not in html
    assert "function createPwaUpdateNotice()" in app_js
    assert "reload.id = 'reloadPwa'" in app_js
    assert "dismiss.id = 'dismissPwa'" in app_js
""",
)

replace_once(
    "tests/test_static_ui.py",
    '    assert "ai-image-generator-pwa-v24" in service_worker_js\n',
    '    assert "ai-image-generator-pwa-v25" in service_worker_js\n',
)

print("Applied fixes for issues #1 through #5.")
