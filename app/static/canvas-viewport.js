(function (root) {
  'use strict';

  function clampScale(value) {
    var number = Number(value);
    if (!isFinite(number)) { return 1; }
    return Math.max(0.25, Math.min(4, number));
  }

  function nextWheelScale(current, deltaY) {
    var factor = deltaY < 0 ? 1.12 : (1 / 1.12);
    return clampScale(current * factor);
  }

  function nextStepScale(current, direction) {
    var value = clampScale(current);
    var step = direction < 0 ? (value > 1 ? 0.25 : 0.1) : (value >= 1 ? 0.25 : 0.1);
    return clampScale(value + (direction < 0 ? -step : step));
  }

  root.CanvasViewportMath = {
    clampScale: clampScale,
    nextWheelScale: nextWheelScale,
    nextStepScale: nextStepScale
  };

  if (typeof document === 'undefined') { return; }

  var stage = document.getElementById('stage');
  var zoomOut = document.getElementById('canvasZoomOut');
  var zoomValue = document.getElementById('canvasZoomValue');
  var zoomIn = document.getElementById('canvasZoomIn');
  var previewFit = document.getElementById('previewFit');
  var previewActual = document.getElementById('previewActual');
  var desktopQuery = root.matchMedia ? root.matchMedia('(min-width: 981px)') : null;
  var scale = 1;
  var offsetX = 0;
  var offsetY = 0;
  var drag = null;

  if (!stage || !zoomOut || !zoomValue || !zoomIn) { return; }

  function isDesktop() {
    return !desktopQuery || desktopQuery.matches;
  }

  function getTarget() {
    var batchImage = stage.querySelector('.batch-main-image');
    var images;
    var i;
    if (batchImage) { return batchImage; }
    images = stage.getElementsByTagName('img');
    for (i = 0; i < images.length; i += 1) {
      if (!images[i].classList.contains('batch-thumb')) { return images[i]; }
    }
    return null;
  }

  function updateLabel() {
    var percent = Math.round(scale * 100);
    zoomValue.textContent = String(percent) + '%';
    zoomValue.setAttribute('aria-label', '重設畫布縮放，目前 ' + String(percent) + '%');
    zoomOut.disabled = scale <= 0.25;
    zoomIn.disabled = scale >= 4;
  }

  function applyTransform() {
    var target = getTarget();
    if (!target || !isDesktop()) {
      stage.classList.remove('is-canvas-interactive', 'is-panning');
      updateLabel();
      return;
    }
    target.style.transformOrigin = 'center center';
    target.style.transform = 'translate(' + String(offsetX) + 'px, ' + String(offsetY) + 'px) scale(' + String(scale) + ')';
    target.style.willChange = scale === 1 && offsetX === 0 && offsetY === 0 ? '' : 'transform';
    stage.classList.add('is-canvas-interactive');
    updateLabel();
  }

  function resetViewport() {
    var target = getTarget();
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    drag = null;
    stage.classList.remove('is-panning');
    if (target) {
      target.style.transform = '';
      target.style.transformOrigin = '';
      target.style.willChange = '';
    }
    applyTransform();
  }

  function setScale(nextScale, clientX, clientY) {
    var rect;
    var centerX;
    var centerY;
    var ratio;
    var previous = scale;
    if (!getTarget() || !isDesktop()) { return; }
    scale = clampScale(nextScale);
    if (clientX !== undefined && clientY !== undefined && previous !== scale) {
      rect = stage.getBoundingClientRect();
      centerX = rect.left + rect.width / 2;
      centerY = rect.top + rect.height / 2;
      ratio = scale / previous;
      offsetX = offsetX + (1 - ratio) * (clientX - centerX - offsetX);
      offsetY = offsetY + (1 - ratio) * (clientY - centerY - offsetY);
    }
    applyTransform();
  }

  zoomOut.addEventListener('click', function () {
    setScale(nextStepScale(scale, -1));
  });
  zoomIn.addEventListener('click', function () {
    setScale(nextStepScale(scale, 1));
  });
  zoomValue.addEventListener('click', resetViewport);

  stage.addEventListener('wheel', function (event) {
    if (!getTarget() || !isDesktop()) { return; }
    event.preventDefault();
    setScale(nextWheelScale(scale, event.deltaY), event.clientX, event.clientY);
  }, { passive: false });

  stage.addEventListener('pointerdown', function (event) {
    if (!getTarget() || !isDesktop() || event.button !== 0) { return; }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: offsetX,
      offsetY: offsetY
    };
    stage.classList.add('is-panning');
    if (stage.setPointerCapture) { stage.setPointerCapture(event.pointerId); }
    event.preventDefault();
  });

  stage.addEventListener('pointermove', function (event) {
    if (!drag || drag.pointerId !== event.pointerId) { return; }
    offsetX = drag.offsetX + event.clientX - drag.startX;
    offsetY = drag.offsetY + event.clientY - drag.startY;
    applyTransform();
  });

  function endDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) { return; }
    if (stage.releasePointerCapture && stage.hasPointerCapture && stage.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
    drag = null;
    stage.classList.remove('is-panning');
  }

  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', resetViewport);
  stage.addEventListener('keydown', function (event) {
    if (!getTarget() || !isDesktop()) { return; }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setScale(nextStepScale(scale, 1));
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      setScale(nextStepScale(scale, -1));
    } else if (event.key === '0') {
      event.preventDefault();
      resetViewport();
    }
  });

  if (previewFit) { previewFit.addEventListener('click', resetViewport); }
  if (previewActual) { previewActual.addEventListener('click', resetViewport); }

  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function (mutations) {
      var i;
      for (i = 0; i < mutations.length; i += 1) {
        if (mutations[i].type === 'childList') {
          resetViewport();
          return;
        }
      }
    }).observe(stage, { childList: true, subtree: true });
  }

  if (desktopQuery) {
    if (desktopQuery.addEventListener) {
      desktopQuery.addEventListener('change', resetViewport);
    } else if (desktopQuery.addListener) {
      desktopQuery.addListener(resetViewport);
    }
  }

  updateLabel();
})(typeof globalThis !== 'undefined' ? globalThis : this);
