(function(){
  var completionInFlight = false;
  var transformInFlight = false;

  function byId(id){
    return document.getElementById(id);
  }

  function setTransformStatus(message, cls){
    var status = byId('transformStatus');
    if(!status){ return; }
    status.textContent = message;
    status.className = 'transform-status' + (cls ? ' ' + cls : '');
  }

  function setCompletionBusy(button, busy){
    if(!button){ return; }
    button.disabled = busy;
    if(busy){
      button.setAttribute('aria-busy', 'true');
      button.textContent = '正在補完整…';
      return;
    }
    button.removeAttribute('aria-busy');
    button.textContent = '✨ 幫我補完整';
  }

  function setTransformBusy(button, busy){
    if(!button){ return; }
    button.disabled = busy;
    if(busy){
      button.setAttribute('aria-busy', 'true');
      return;
    }
    button.removeAttribute('aria-busy');
    button.textContent = '轉成英文提示詞';
  }

  function transformPrompt(){
    var plainPrompt = byId('plainPrompt');
    var promptStyle = byId('promptStyle');
    var finalPrompt = byId('prompt');
    var source = plainPrompt ? plainPrompt.value.trim() : '';
    var style = promptStyle ? promptStyle.value : 'auto';

    if(transformInFlight){ return; }
    if(!source){
      setTransformStatus('請先輸入白話中文描述', 'fail');
      if(plainPrompt){ plainPrompt.focus(); }
      return;
    }

    transformInFlight = true;
    var transformButton = byId('transformPrompt');
    setTransformBusy(transformButton, true);
    var elapsedTimer = window.ElapsedTimer.start({
      onTick: function(seconds){
        setTransformStatus('AI 轉換中… 已用 ' + seconds + ' 秒', 'busy');
        if(transformButton){ transformButton.textContent = '轉換中… ' + seconds + ' 秒'; }
      }
    });

    fetch('/prompt/transform', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source: source, style: style})
      })
      .then(function(response){
        return response.json().then(function(data){
          if(!response.ok){
            throw new Error(data.error || ('HTTP ' + response.status));
          }
          if(!data.prompt){
            throw new Error('轉換結果缺少提示詞');
          }

          if(finalPrompt){
            finalPrompt.value = data.prompt;
            finalPrompt.setAttribute('data-auto-source', source);
          }
          var providerLabels = { gemini: 'AI 智慧轉換 (Gemini)', codex: 'AI 備援轉換 (Codex)' };
          var label = providerLabels[data.provider] || '離線規則轉換';
          var seconds = elapsedTimer.stop();
          var message = '已轉成英文提示詞 · ' + label + ' · 耗時 ' + seconds + ' 秒';
          if(data.warnings && data.warnings.length){
            message += ' · ' + data.warnings.join('、');
          }
          setTransformStatus(message, 'done');
        });
      })
      .catch(function(error){
        setTransformStatus('轉換失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + error.message, 'fail');
      })
      .then(function(){
        transformInFlight = false;
        setTransformBusy(transformButton, false);
      }, function(){
        transformInFlight = false;
        setTransformBusy(transformButton, false);
      });
  }

  function completePrompt(){
    var plainPrompt = byId('plainPrompt');
    var promptStyle = byId('promptStyle');
    var completePromptButton = byId('completePrompt');
    var source = plainPrompt ? plainPrompt.value.trim() : '';
    var style = promptStyle ? promptStyle.value : 'auto';

    if(completionInFlight){ return; }
    if(!source){
      setTransformStatus('請先輸入白話中文描述', 'fail');
      if(plainPrompt){ plainPrompt.focus(); }
      return;
    }

    completionInFlight = true;
    setCompletionBusy(completePromptButton, true);
    var elapsedTimer = window.ElapsedTimer.start({
      onTick: function(seconds){
        setTransformStatus('AI 正在補完整中文描述… 已用 ' + seconds + ' 秒', 'busy');
        if(completePromptButton){ completePromptButton.textContent = '正在補完整… ' + seconds + ' 秒'; }
      }
    });

    fetch('/prompt/complete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source: source, style: style})
      })
      .then(function(response){
        return response.json().then(function(data){
          if(!response.ok){
            throw new Error(data.error || ('HTTP ' + response.status));
          }
          if(!data.prompt){
            throw new Error('補全結果缺少提示詞');
          }

          if(plainPrompt){
            plainPrompt.value = data.prompt;
            plainPrompt.focus();
            if(typeof plainPrompt.setSelectionRange === 'function'){
              plainPrompt.setSelectionRange(plainPrompt.value.length, plainPrompt.value.length);
            }
          }
          var finalPrompt = byId('prompt');
          if(finalPrompt && finalPrompt.getAttribute('data-auto-source')){
            finalPrompt.value = '';
            finalPrompt.removeAttribute('data-auto-source');
          }
          var providerLabel = data.provider === 'gemini' ? 'Gemma' : '離線補全';
          var seconds = elapsedTimer.stop();
          var message = '已補完整中文描述 · ' + providerLabel + ' · 耗時 ' + seconds + ' 秒';
          if(data.warnings && data.warnings.length){ message += ' · ' + data.warnings.join('、'); }
          setTransformStatus(message, 'done');
        });
      })
      .catch(function(error){
        setTransformStatus('補全失敗（耗時 ' + elapsedTimer.stop() + ' 秒）：' + error.message, 'fail');
      })
      .then(function(){
        completionInFlight = false;
        setCompletionBusy(completePromptButton, false);
      }, function(){
        completionInFlight = false;
        setCompletionBusy(completePromptButton, false);
      });
  }

  document.addEventListener('DOMContentLoaded', function(){
    var plainPrompt = byId('plainPrompt');
    var transformPromptButton = byId('transformPrompt');
    var completePromptButton = byId('completePrompt');

    if(transformPromptButton){
      transformPromptButton.addEventListener('click', transformPrompt);
    }
    if(completePromptButton){
      completePromptButton.addEventListener('click', completePrompt);
    }

    if(plainPrompt){
      plainPrompt.addEventListener('keydown', function(event){
        if((event.metaKey || event.ctrlKey) && event.key === 'Enter'){
          event.preventDefault();
          transformPrompt();
        }
      });
    }
  });
})();
