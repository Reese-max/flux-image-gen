(function (root) {
  'use strict';

  var MAP = {
    content_filtered: {
      title: '內容安全過濾',
      steps: ['把描述改得更中性。', '移除可能敏感或具體暴力的詞。', '保留構圖、風格、光線等安全描述。']
    },
    rate_limited: {
      title: '叫用太頻繁',
      steps: ['稍候再試。', '先複製目前設定，避免重打。']
    },
    timeout: {
      title: '產圖逾時',
      steps: ['先改用 schnell 模型測試構圖。', '縮短 prompt 或換一個 seed。']
    },
    bad_provider_response: {
      title: '影像服務回應異常',
      steps: ['重試一次。', '如果持續失敗，改用較短 prompt 或稍後再試。']
    },
    missing_api_key: {
      title: '缺少 NVIDIA 金鑰',
      steps: ['本機請設定 NVIDIA_API_KEY。', 'Cloudflare 請使用 wrangler secret put NVIDIA_API_KEY。']
    },
    bad_request: {
      title: '請求格式需要調整',
      steps: ['確認 prompt 不為空。', '確認 seed 是 0 到 2147483647 的整數。']
    },
    network: {
      title: '網路連線中斷',
      steps: ['請確認網路連線後重試。', '目前輸入內容仍保留，不需要重新輸入。', '若服務持續失敗，可先複製 prompt 或稍後再試。']
    }
  };

  function toText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).trim();
  }

  function getAdvice(code) {
    var key = toText(code) || 'unknown';
    var advice = MAP[key] || {
      title: '產圖失敗',
      steps: ['請稍後重試。', '也可以換 seed、縮短 prompt，或改用 schnell 模型。']
    };
    return { code: key, title: advice.title, steps: advice.steps.slice() };
  }

  root.FailureAdvice = { getAdvice: getAdvice };
})(typeof globalThis !== 'undefined' ? globalThis : this);
