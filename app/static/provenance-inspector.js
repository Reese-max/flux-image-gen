// Lazy, entirely local C2PA validation. No asset, remote manifest or OCSP upload.
(function (root) {
  'use strict';
  var runtime;
  var sdk;
  function loadSdk() {
    if (!runtime) {
      runtime = import('/static/vendor/c2pa-web.js').then(function (module) {
        sdk = module;
        // The SDK's external-worker option requires HTTPS. Local FastAPI uses its inline worker.
        var localHttp = root.location.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(root.location.hostname);
        return sdk.createC2pa({ wasmSrc: '/static/vendor/c2pa.wasm',
          workerSrc: localHttp ? undefined : new URL('/static/vendor/c2pa-worker.js', root.location.href) });
      });
    }
    return runtime;
  }
  function inspect(blob, options) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(blob.type) || blob.size > 24 * 1024 * 1024) {
      return Promise.resolve({ status: 'unsupported', codes: [] });
    }
    var settings = { verify: { verifyAfterReading: true, verifyTrust: true, verifyTimestampTrust: true,
      ocspFetch: false, remoteManifestFetch: false } };
    // Explicit local anchors are useful for controlled validation. No fixture/test root is trusted by default.
    if (options && options.trustAnchors) { settings.trust = { trustAnchors: options.trustAnchors }; }
    var reader;
    return loadSdk().then(function (instance) {
      return sdk.Reader.fromBlob(instance, blob.type, blob, new sdk.Context(settings)).then(function (result) {
        reader = result;
        return reader ? reader.manifestStore().then(classify) : { status: 'absent', codes: [] };
      }).catch(function () {
        // SDK parse errors are not absence and raw errors may contain private metadata.
        return { status: 'invalid', codes: [] };
      });
    }).then(function (result) {
      return reader ? reader.free().then(function () { return result; }) : result;
    }).catch(function () { return { status: 'unsupported', codes: [] }; });
    function classify(store) {
      var codes = [];
      // Keep only codes, never assertions, URLs, filenames, identities or embedded EXIF.
      function collect(value) {
        if (!value || typeof value !== 'object') { return; }
        if (typeof value.code === 'string') { codes.push(value.code); }
        Object.keys(value).forEach(function (key) { if (key !== 'code') { collect(value[key]); } });
      }
      collect(store.validation_results);
      collect(store.validation_status);
      var state = store.validation_state;
      return { status: state === 'Trusted' ? 'verified' : state === 'Valid' ? 'present_untrusted' : 'invalid', codes: codes };
    }
  }
  root.C2paInspector = { inspect: inspect };
})(typeof globalThis !== 'undefined' ? globalThis : this);
