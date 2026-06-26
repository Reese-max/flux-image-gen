(function (root) {
  'use strict';

  var MODES = [
    { id: 'realistic', label: '更寫實', modifiers: ['photorealistic', 'natural lighting', 'realistic textures'] },
    { id: 'cinematic', label: '更電影感', modifiers: ['cinematic lighting', 'film still', 'dramatic atmosphere'] },
    { id: 'product', label: '商業產品照', modifiers: ['studio product photography', 'clean background', 'commercial lighting'] },
    { id: 'cute', label: '更可愛', modifiers: ['adorable', 'soft rounded shapes', 'warm pastel colors'] },
    { id: 'clean', label: '更乾淨構圖', modifiers: ['clean composition', 'minimal background', 'clear subject focus'] },
    { id: 'fix_artifacts', label: '修正常見瑕疵', modifiers: ['sharp details', 'avoid blurry details', 'avoid extra fingers', 'avoid distorted hands'] }
  ];

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function findMode(modeId) {
    var id = toText(modeId) || 'clean';
    var i;
    for (i = 0; i < MODES.length; i += 1) {
      if (MODES[i].id === id) { return MODES[i]; }
    }
    return MODES[4];
  }

  function appendUnique(base, modifiers) {
    var parts = base.split(',').map(toText).filter(Boolean);
    var seen = {};
    var out = [];
    var i;
    parts.concat(modifiers).forEach(function (part) {
      var key = part.toLowerCase();
      if (seen[key]) { return; }
      seen[key] = true;
      out.push(part);
    });
    return out.join(', ');
  }

  function enhancePrompt(prompt, modeId) {
    var base = toText(prompt);
    var mode = findMode(modeId);
    if (!base) { throw new Error('請先輸入提示詞'); }
    return { prompt: appendUnique(base, mode.modifiers), mode: mode.id, label: mode.label };
  }

  function listModes() {
    return MODES.map(function (mode) {
      return { id: mode.id, label: mode.label };
    });
  }

  root.PromptEnhancer = {
    enhancePrompt: enhancePrompt,
    listModes: listModes
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
