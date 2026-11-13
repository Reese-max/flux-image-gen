// 中文補完整（/prompt/complete）與轉英文（/prompt/transform）的共用管線。
// 生成分頁與 AI 改圖分頁各註冊一組 ctx：差別只在讀寫哪個欄位、狀態列與按鈕。
// 改圖分頁的 sourceId === targetId，轉英文就是就地取代同一個指令框。
(function(){
  var inFlight = {};

  var GENERATE_CTX = {
    key: 'generate',
    sourceId: 'plainPrompt',
    targetId: 'prompt',
    styleId: 'promptStyle',
    statusId: 'transformStatus',
    completeButtonId: 'completePrompt',
    transformButtonId: 'transformPrompt',
    emptySourceMessage: '請先輸入白話中文描述'
  };

  var EDIT_CTX = {
    key: 'edit',
    sourceId: 'editPrompt',
    targetId: 'editPrompt',
    styleId: 'editPromptStyle',
    statusId: 'editTransformStatus',
    completeButtonId: 'editCompletePrompt',
    transformButtonId: 'editTransformPrompt',
    emptySourceMessage: '請先輸入中文改圖指令'
  };

  function byId(id){
    return document.getElementById(id);
  }

  function setTransformStatus(ctx, message, cls){
    var status = byId(ctx.statusId);
    if(!status){ return; }
    status.textContent = message;
    status.className = 'transform-status' + (cls ? ' ' + cls : '');
  }

  // 忙碌時換掉按鈕文字，恢復時用第一次記下的原文字，免得每個分頁各寫一份標籤。
  function setBusy(button, busy, busyText){
    if(!button){ return; }
    if(busy){
      if(!button.getAttribute('data-idle-label')){
        button.setAttribute('data-idle-label', button.textContent);
      }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = busyText;
      return;
    }
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = button.getAttribute('data-idle-label') || button.textContent;
  }

  function readSource(ctx){
    var source = byId(ctx.sourceId);
    return source ? source.value.trim() : '';
  }

  function readStyle(ctx){
    var style = byId(ctx.styleId);
    return style ? style.value : 'auto';
  }

  function busyKey(ctx, action){
    return ctx.key + ':' + action;
  }

  function postPrompt(path, payload){
    return fetch(path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    }).then(function(response){
      return response.json().then(function(data){
        if(!response.ok){
          throw new Error(data.error || ('HTTP ' + response.status));
        }
        if(!data.prompt){
          throw new Error('結果缺少提示詞');
        }
        return data;
      });
    });
  }

  function transformPrompt(ctx){
    var source = readSource(ctx);
    var targetField = byId(ctx.targetId);
    var button = byId(ctx.transformButtonId);
    var key = busyKey(ctx, 'transform');
    var elapsedTimer;

    if(inFlight[key]){ return; }
    if(!source){
      setTransformStatus(ctx, ctx.emptySourceMessage, 'fail');
      if(byId(ctx.sourceId)){ byId(ctx.sourceId).focus(); }
      return;
    }

    inFlight[key] = true;
    setBusy(button, true, '轉換中…');
    elapsedTimer = window.ElapsedTimer.start({
      onTick: function(seconds){
        setTransformStatus(ctx, 'AI 轉換中… 已用 ' + seconds + ' 秒', 'busy');
        if(button){ button.textContent = '轉換中… ' + seconds + ' 秒'; }
      }
    });

    postPrompt('/prompt/transform', {source: source, style: readStyle(ctx)})
      .then(function(data){
        if(targetField){
          targetField.value = data.prompt;
          targetField.setAttribute('data-auto-source', source);
        }
        var providerLabels = { gemini: 'AI 智慧轉換 (Gemini)', codex: 'AI 備援轉換 (Codex)' };
        var label = providerLabels[data.provider] || '離線規則轉換';
        var message = '已轉成英文提示詞 · ' + label + ' · 耗時 ' + elapsedTimer.stop() + ' 秒';
        if(data.warnings && data.warnings.length){
          message += ' · ' + data.warnings.join('、');
        }
        setTransformStatus(ctx, message, 'done');
      })
      .catch(function(error){
        setTransformStatus(ctx, '轉換失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + error.message, 'fail');
      })
      .then(function(){
        inFlight[key] = false;
        setBusy(button, false);
      });
  }

  function completePrompt(ctx){
    var source = readSource(ctx);
    var sourceField = byId(ctx.sourceId);
    var button = byId(ctx.completeButtonId);
    var key = busyKey(ctx, 'complete');
    var elapsedTimer;

    if(inFlight[key]){ return; }
    if(!source){
      setTransformStatus(ctx, ctx.emptySourceMessage, 'fail');
      if(sourceField){ sourceField.focus(); }
      return;
    }

    inFlight[key] = true;
    setBusy(button, true, '正在補完整…');
    elapsedTimer = window.ElapsedTimer.start({
      onTick: function(seconds){
        setTransformStatus(ctx, 'AI 正在補完整中文描述… 已用 ' + seconds + ' 秒', 'busy');
        if(button){ button.textContent = '正在補完整… ' + seconds + ' 秒'; }
      }
    });

    postPrompt('/prompt/complete', {source: source, style: readStyle(ctx)})
      .then(function(data){
        var targetField;
        if(sourceField){
          sourceField.value = data.prompt;
          sourceField.focus();
          if(typeof sourceField.setSelectionRange === 'function'){
            sourceField.setSelectionRange(sourceField.value.length, sourceField.value.length);
          }
        }
        // 中文換了，之前自動轉出的英文就過期了；只有獨立英文欄位才清（改圖分頁共用同一個框）。
        targetField = ctx.targetId === ctx.sourceId ? null : byId(ctx.targetId);
        if(targetField && targetField.getAttribute('data-auto-source')){
          targetField.value = '';
          targetField.removeAttribute('data-auto-source');
        }
        var providerLabel = data.provider === 'gemini' ? 'Gemma' : '離線補全';
        var message = '已補完整中文描述 · ' + providerLabel + ' · 耗時 ' + elapsedTimer.stop() + ' 秒';
        if(data.warnings && data.warnings.length){ message += ' · ' + data.warnings.join('、'); }
        setTransformStatus(ctx, message, 'done');
      })
      .catch(function(error){
        setTransformStatus(ctx, '補全失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + error.message, 'fail');
      })
      .then(function(){
        inFlight[key] = false;
        setBusy(button, false);
      });
  }

  function wire(ctx){
    var sourceField = byId(ctx.sourceId);
    var transformButton = byId(ctx.transformButtonId);
    var completeButton = byId(ctx.completeButtonId);

    if(transformButton){
      transformButton.addEventListener('click', function(){ transformPrompt(ctx); });
    }
    if(completeButton){
      completeButton.addEventListener('click', function(){ completePrompt(ctx); });
    }
    if(sourceField){
      sourceField.addEventListener('keydown', function(event){
        if((event.metaKey || event.ctrlKey) && event.key === 'Enter'){
          event.preventDefault();
          transformPrompt(ctx);
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', function(){
    wire(GENERATE_CTX);
    wire(EDIT_CTX);
  });
})();
