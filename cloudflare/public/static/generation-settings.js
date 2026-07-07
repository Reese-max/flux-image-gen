(function (root) {
  'use strict';

  var MAX_SEED = 2147483647;
  var MIN_CUSTOM_DIMENSION = 256;
  var MAX_CUSTOM_DIMENSION = 1920;
  var CUSTOM_DIMENSION_STEP = 64;

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

  function normalizeCustomDimension(value, label) {
    var text = toText(value);
    var number;
    if (!text || !/^\d+$/.test(text)) {
      throw new Error(label + '必須是 256 到 1920 之間，且為 64 的倍數');
    }
    number = Number(text);
    if (!isFinite(number) || number < MIN_CUSTOM_DIMENSION || number > MAX_CUSTOM_DIMENSION || Math.floor(number) !== number || number % CUSTOM_DIMENSION_STEP !== 0) {
      throw new Error(label + '必須是 256 到 1920 之間，且為 64 的倍數');
    }
    return number;
  }

  function serializeSettings(settings) {
    var source = settings || {};
    var prompt = toText(source.prompt);
    var providerPrompt = toText(source.providerPrompt) || prompt;
    var result = {
      prompt: prompt,
      avoid: toText(source.avoid),
      providerPrompt: buildProviderPrompt(providerPrompt, source.avoid),
      model: toText(source.model) || 'schnell',
      size: toText(source.size) || 'square',
      seed: normalizeSeed(source.seed)
    };
    if (result.size === 'custom') {
      result.width = normalizeCustomDimension(source.width, '自訂寬度');
      result.height = normalizeCustomDimension(source.height, '自訂高度');
    }
    return result;
  }

  root.GenerationSettings = {
    MAX_SEED: MAX_SEED,
    MIN_CUSTOM_DIMENSION: MIN_CUSTOM_DIMENSION,
    MAX_CUSTOM_DIMENSION: MAX_CUSTOM_DIMENSION,
    CUSTOM_DIMENSION_STEP: CUSTOM_DIMENSION_STEP,
    normalizeSeed: normalizeSeed,
    normalizeCustomDimension: normalizeCustomDimension,
    buildProviderPrompt: buildProviderPrompt,
    serializeSettings: serializeSettings
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
