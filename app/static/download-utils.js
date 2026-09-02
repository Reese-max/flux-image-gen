(function (root) {
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
