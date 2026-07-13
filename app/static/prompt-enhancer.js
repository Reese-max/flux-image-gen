(function (root) {
  'use strict';

  // Effect optimisation prefers Gemini and falls back to server-side local rules.
  // Returns { prompt, provider, warnings }; callers own DOM + status.
  function applyEffect(prompt, effect) {
    return fetch('/prompt/enhance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, effect: effect })
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          throw new Error(data.error || ('HTTP ' + response.status));
        }
        if (!data.prompt) {
          throw new Error('優化結果缺少提示詞');
        }
        return {
          prompt: data.prompt,
          provider: data.provider,
          warnings: data.warnings || []
        };
      });
    });
  }

  root.PromptEnhancer = {
    applyEffect: applyEffect
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
