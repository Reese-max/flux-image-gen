(function (root) {
  'use strict';

  var MAX_SEED = 2147483647;

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function normalizeSeed(value) {
    var text = toText(value);
    var seed;
    if (!text) { return 0; }
    if (!/^\d+$/.test(text)) {
      throw new Error('seed 必須是 0 到 2147483647 之間的整數');
    }
    seed = Number(text);
    if (!isFinite(seed) || seed < 0 || seed > MAX_SEED || Math.floor(seed) !== seed) {
      throw new Error('seed 必須是 0 到 2147483647 之間的整數');
    }
    return seed;
  }

  function buildProviderPrompt(prompt, avoidText) {
    var base = toText(prompt);
    var avoid = toText(avoidText);
    return avoid ? base + ', avoid ' + avoid : base;
  }

  function serializeSettings(settings) {
    var source = settings || {};
    return {
      prompt: toText(source.prompt),
      avoid: toText(source.avoid),
      providerPrompt: buildProviderPrompt(source.prompt, source.avoid),
      model: toText(source.model) || 'schnell',
      size: toText(source.size) || 'square',
      seed: normalizeSeed(source.seed)
    };
  }

  root.GenerationSettings = {
    MAX_SEED: MAX_SEED,
    normalizeSeed: normalizeSeed,
    buildProviderPrompt: buildProviderPrompt,
    serializeSettings: serializeSettings
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
