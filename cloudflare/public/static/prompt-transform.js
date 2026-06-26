(function(){
  function byId(id){
    return document.getElementById(id);
  }

  function setTransformStatus(message, cls){
    var status = byId('transformStatus');
    if(!status){ return; }
    status.textContent = message;
    status.className = 'transform-status' + (cls ? ' ' + cls : '');
  }

  function transformPrompt(){
    var plainPrompt = byId('plainPrompt');
    var promptStyle = byId('promptStyle');
    var finalPrompt = byId('prompt');
    var source = plainPrompt ? plainPrompt.value.trim() : '';
    var style = promptStyle ? promptStyle.value : 'auto';

    if(!source){
      setTransformStatus('請先輸入白話中文描述', 'fail');
      if(plainPrompt){ plainPrompt.focus(); }
      return;
    }

    setTransformStatus('轉換中…', 'busy');

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

          if(finalPrompt){ finalPrompt.value = data.prompt; }
          var providerLabels = { gemini: 'AI 智慧轉換 (Gemini)', codex: 'AI 備援轉換 (Codex)' };
          var label = providerLabels[data.provider] || '離線規則轉換';
          var message = '已轉成英文提示詞 · ' + label;
          if(data.warnings && data.warnings.length){
            message += ' · ' + data.warnings.join('、');
          }
          setTransformStatus(message, 'done');
        });
      })
      .catch(function(error){
        setTransformStatus('轉換失敗：' + error.message, 'fail');
      });
  }

  document.addEventListener('DOMContentLoaded', function(){
    var plainPrompt = byId('plainPrompt');
    var transformPromptButton = byId('transformPrompt');

    if(transformPromptButton){
      transformPromptButton.addEventListener('click', transformPrompt);
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
