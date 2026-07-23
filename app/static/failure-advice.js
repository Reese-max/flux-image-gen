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
    service_unavailable: {
      title: '服務暫時不可用',
      steps: ['圖片服務目前無法使用，請稍後再試。', '目前輸入內容仍保留，不需要修改描述。']
    },
    timeout: {
      title: '產圖逾時',
      steps: ['服務目前較忙，請直接重試一次。', '若仍逾時，可換一個畫面編號（seed）、縮短描述，或稍後再試。']
    },
    bad_provider_response: {
      title: '影像服務回應異常',
      steps: ['重試一次。', '如果持續失敗，改用較短 prompt 或稍後再試。']
    },
    missing_api_key: {
      title: '圖片服務尚未連接',
      steps: ['目前無法產生正式圖片。', '請稍後再試或聯絡站方。']
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

  function getAdvice(code, context) {
    var key = toText(code) || 'unknown';
    var details = context || {};
    var advice = MAP[key] || {
      title: '產圖失敗',
      steps: ['請稍後重試。', '若持續失敗，請保留追蹤 ID 供站方查詢。']
    };
    var steps = advice.steps.slice();
    var retryAfter = Math.max(0, parseInt(details.retryAfter, 10) || 0);
    if (key === 'rate_limited' && retryAfter) {
      steps[0] = '請在 ' + retryAfter + ' 秒後重試。';
    }
    return { code: key, title: advice.title, steps: steps };
  }

  root.FailureAdvice = { getAdvice: getAdvice };
})(typeof globalThis !== 'undefined' ? globalThis : this);
