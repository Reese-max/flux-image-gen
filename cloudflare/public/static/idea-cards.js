(function (root) {
  'use strict';

  var cards = [];
  var lastFocusedElement = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function toText(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).trim();
  }

  function setEditorStatus(message, cls) {
    var status = byId('ideaEditorStatus');
    if (!status) {
      return;
    }
    status.textContent = message || '';
    status.className = 'form-status' + (cls ? ' ' + cls : '');
  }

  function setGenerationStatus(message, cls) {
    if (root.ImageGenApp && typeof root.ImageGenApp.setStatus === 'function') {
      root.ImageGenApp.setStatus(message, cls);
    }
  }

  function getCardById(id) {
    var targetId = toText(id);
    var i;

    for (i = 0; i < cards.length; i += 1) {
      if (toText(cards[i] && cards[i].id) === targetId) {
        return cards[i];
      }
    }
    return null;
  }

  function setSelectValue(id, value) {
    var field = byId(id);
    var nextValue = toText(value);

    if (field && nextValue) {
      field.value = nextValue;
    }
  }

  function readFormCard() {
    return {
      id: byId('ideaId').value,
      emoji: byId('ideaEmoji').value,
      title: byId('ideaTitle').value,
      promptZh: byId('ideaPromptZh').value,
      promptEn: byId('ideaPromptEn').value,
      model: byId('ideaModel').value,
      size: byId('ideaSize').value
    };
  }

  function writeFormCard(card) {
    var source = card || {};

    byId('ideaId').value = source.id || '';
    byId('ideaEmoji').value = source.emoji || '';
    byId('ideaTitle').value = source.title || '';
    byId('ideaPromptZh').value = source.promptZh || '';
    byId('ideaPromptEn').value = source.promptEn || '';
    byId('ideaModel').value = source.model || 'schnell';
    byId('ideaSize').value = source.size || 'square';
  }

  function openEditor(card) {
    var backdrop = byId('ideaEditor');
    var title = byId('ideaEditorTitle');
    var deleteButton = byId('deleteIdea');

    if (!backdrop) {
      return;
    }

    lastFocusedElement = document.activeElement;
    writeFormCard(card);
    setEditorStatus('', '');

    if (title) {
      title.textContent = card ? '編輯客製梗卡' : '新增客製梗卡';
    }
    if (deleteButton) {
      deleteButton.hidden = !card;
    }

    if (root.ModalA11y && typeof root.ModalA11y.open === 'function') {
      root.ModalA11y.open(backdrop, byId('ideaTitle'));
    } else {
      backdrop.hidden = false;
      byId('ideaTitle').focus();
    }
  }

  function closeEditor() {
    var backdrop = byId('ideaEditor');
    var form = byId('ideaForm');

    if (backdrop && root.ModalA11y && typeof root.ModalA11y.close === 'function') {
      root.ModalA11y.close(backdrop);
    } else if (backdrop) {
      backdrop.hidden = true;
    }
    if (form) {
      form.reset();
    }
    setEditorStatus('', '');

    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus();
    }
    lastFocusedElement = null;
  }

  function renderEmpty(grid) {
    var empty = document.createElement('div');

    empty.className = 'custom-empty';
    empty.textContent = '還沒有客製梗卡，先新增一張常用提示詞吧。';
    grid.appendChild(empty);
  }

  function renderCard(grid, card) {
    var wrap = document.createElement('div');
    var button = document.createElement('button');
    var emoji = document.createElement('span');
    var label = document.createElement('span');
    var meta = document.createElement('span');
    var edit = document.createElement('button');

    wrap.className = 'custom-card';

    button.type = 'button';
    button.className = 'idea custom-idea';
    button.setAttribute('data-idea-id', card.id);
    button.addEventListener('click', function () {
      generateFromCard(card);
    });

    emoji.className = 'emo';
    emoji.textContent = card.emoji || '✨';
    label.className = 'lbl';
    label.textContent = card.title;
    meta.className = 'idea-meta';
    meta.textContent = card.promptEn ? '英文提示詞' : '中文轉英文';

    edit.type = 'button';
    edit.className = 'card-edit';
    edit.textContent = '編輯';
    edit.addEventListener('click', function () {
      openEditor(getCardById(card.id) || card);
    });

    button.appendChild(emoji);
    button.appendChild(label);
    button.appendChild(meta);
    wrap.appendChild(button);
    wrap.appendChild(edit);
    grid.appendChild(wrap);
  }

  function renderCards() {
    var grid = byId('customIdeaGrid');

    if (!grid) {
      return;
    }

    grid.textContent = '';
    if (!cards.length) {
      renderEmpty(grid);
      return;
    }

    cards.forEach(function (card) {
      renderCard(grid, card);
    });
  }

  function saveAndRender(nextCards) {
    cards = root.IdeaStore.saveCards(nextCards);
    renderCards();
  }

  function submitForm(event) {
    var normalized;
    var nextCards;

    event.preventDefault();

    try {
      normalized = root.IdeaStore.normalizeCard(readFormCard());
      nextCards = root.IdeaStore.upsertCard(cards, normalized);
      saveAndRender(nextCards);
      closeEditor();
      setGenerationStatus('✅ 已儲存客製梗卡', 'done');
    } catch (error) {
      setEditorStatus(error.message, 'fail');
    }
  }

  function deleteCurrentCard() {
    var id = byId('ideaId').value;

    if (!toText(id)) {
      closeEditor();
      return;
    }

    saveAndRender(root.IdeaStore.deleteCard(cards, id));
    closeEditor();
    setGenerationStatus('已刪除客製梗卡', 'done');
  }

  function exportIdeas() {
    var blob = new Blob([JSON.stringify(cards, null, 2)], { type: 'application/json' });
    var link = document.createElement('a');
    var url = root.URL.createObjectURL(blob);

    link.href = url;
    link.download = 'custom-idea-cards.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(function () {
      root.URL.revokeObjectURL(url);
    }, 0);
  }

  function importIdeas(event) {
    var input = event.target;
    var file = input.files && input.files[0];
    var reader;

    if (!file) {
      return;
    }

    reader = new FileReader();
    reader.onload = function () {
      var importedCards;
      var nextCards = cards.slice();

      try {
        importedCards = root.IdeaStore.parseImportedCards(reader.result);
        importedCards.forEach(function (card) {
          nextCards = root.IdeaStore.upsertCard(nextCards, card);
        });
        saveAndRender(nextCards);
        setGenerationStatus('✅ 已匯入 ' + importedCards.length + ' 張客製梗卡', 'done');
      } catch (error) {
        setGenerationStatus('❌ 匯入失敗：' + error.message, 'fail');
      } finally {
        input.value = '';
      }
    };
    reader.onerror = function () {
      setGenerationStatus('❌ 匯入失敗：無法讀取檔案', 'fail');
      input.value = '';
    };
    reader.readAsText(file);
  }

  function transformAndGenerate(card) {
    setGenerationStatus('正在轉換客製梗卡提示詞…', 'busy');

    fetch('/prompt/transform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: card.promptZh, style: 'auto' })
      })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) {
            throw new Error(data.error || ('HTTP ' + response.status));
          }
          if (!data.prompt) {
            throw new Error('轉換結果缺少提示詞');
          }

          root.ImageGenApp.setPromptAndGenerate(data.prompt);
        });
      })
      .catch(function (error) {
        setGenerationStatus('❌ 客製梗卡轉換失敗：' + error.message, 'fail');
      });
  }

  function generateFromCard(card) {
    if (!root.ImageGenApp || typeof root.ImageGenApp.setPromptAndGenerate !== 'function') {
      return;
    }

    setSelectValue('model', card.model);
    setSelectValue('size', card.size);

    if (card.promptEn) {
      root.ImageGenApp.setPromptAndGenerate(card.promptEn);
      return;
    }

    if (card.promptZh) {
      transformAndGenerate(card);
      return;
    }

    setGenerationStatus('這張客製梗卡沒有可用提示詞', 'fail');
  }

  function bindEditorEvents() {
    var backdrop = byId('ideaEditor');
    var addButton = byId('addIdea');
    var closeButton = byId('closeIdeaEditor');
    var form = byId('ideaForm');
    var deleteButton = byId('deleteIdea');
    var exportButton = byId('exportIdeas');
    var importInput = byId('importIdeas');

    if (addButton) {
      addButton.addEventListener('click', function () {
        openEditor(null);
      });
    }
    if (closeButton) {
      closeButton.addEventListener('click', closeEditor);
    }
    if (backdrop) {
      backdrop.addEventListener('click', function (event) {
        if (event.target === backdrop || event.target.hasAttribute('data-close-idea-editor')) {
          closeEditor();
        }
      });
    }
    if (form) {
      form.addEventListener('submit', submitForm);
    }
    if (deleteButton) {
      deleteButton.addEventListener('click', deleteCurrentCard);
    }
    if (exportButton) {
      exportButton.addEventListener('click', exportIdeas);
    }
    if (importInput) {
      importInput.addEventListener('change', importIdeas);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!root.IdeaStore) {
      setGenerationStatus('❌ 客製梗卡儲存模組未載入', 'fail');
      return;
    }

    cards = root.IdeaStore.loadCards();
    renderCards();
    bindEditorEvents();
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
