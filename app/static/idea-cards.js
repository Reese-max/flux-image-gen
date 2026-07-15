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

  function tagsToText(tags) {
    if (!Array.isArray(tags)) { return ''; }
    return tags.join(', ');
  }

  function readFormCard() {
    return {
      id: byId('ideaId').value,
      emoji: byId('ideaEmoji').value,
      name: byId('ideaTitle').value,
      userPrompt: byId('ideaPromptZh').value,
      providerPrompt: byId('ideaPromptEn').value,
      negativePrompt: byId('ideaNegativePrompt') ? byId('ideaNegativePrompt').value : '',
      modelPreset: byId('ideaModel').value,
      sizePreset: byId('ideaSize').value,
      seed: byId('ideaSeed') ? byId('ideaSeed').value : '',
      tags: byId('ideaTags') ? byId('ideaTags').value : '',
      previewImageUrl: byId('ideaPreviewImageUrl') ? byId('ideaPreviewImageUrl').value : '',
      createdAt: byId('ideaCreatedAt') ? byId('ideaCreatedAt').value : '',
      updatedAt: new Date().toISOString(),
      version: root.IdeaStore && root.IdeaStore.SCHEMA_VERSION ? root.IdeaStore.SCHEMA_VERSION : 1
    };
  }

  function writeFormCard(card) {
    var source = card || {};

    byId('ideaId').value = source.id || '';
    byId('ideaEmoji').value = source.emoji || '';
    byId('ideaTitle').value = source.name || source.title || '';
    byId('ideaPromptZh').value = source.userPrompt || source.promptZh || '';
    byId('ideaPromptEn').value = source.providerPrompt || source.promptEn || '';
    byId('ideaModel').value = source.modelPreset || source.model || 'schnell';
    byId('ideaSize').value = source.sizePreset || source.size || 'square';
    if (byId('ideaNegativePrompt')) { byId('ideaNegativePrompt').value = source.negativePrompt || source.avoid || ''; }
    if (byId('ideaSeed')) { byId('ideaSeed').value = source.seed ? String(source.seed) : ''; }
    if (byId('ideaTags')) { byId('ideaTags').value = tagsToText(source.tags); }
    if (byId('ideaPreviewImageUrl')) { byId('ideaPreviewImageUrl').value = source.previewImageUrl || ''; }
    if (byId('ideaCreatedAt')) { byId('ideaCreatedAt').value = source.createdAt || ''; }
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
      title.textContent = card ? '編輯風格卡' : '新增風格卡';
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
    empty.textContent = '還沒有風格卡，先新增一張常用提示詞卡吧。';
    grid.appendChild(empty);
  }

  function renderCard(grid, card) {
    var wrap = document.createElement('div');
    var button = document.createElement('button');
    var emoji = document.createElement('span');
    var label = document.createElement('span');
    var meta = document.createElement('span');
    var edit = document.createElement('button');
    var addToProject = document.createElement('button');
    var preview;

    wrap.className = 'custom-card';

    button.type = 'button';
    button.className = 'idea custom-idea';
    button.setAttribute('data-idea-id', card.id);
    button.addEventListener('click', function () {
      generateFromCard(card);
    });

    if (card.previewImageUrl) {
      preview = document.createElement('span');
      preview.className = 'idea-preview';
      preview.style.backgroundImage = 'url("' + card.previewImageUrl.replace(/"/g, '') + '")';
      button.appendChild(preview);
    }

    emoji.className = 'emo';
    emoji.textContent = card.emoji || '✨';
    label.className = 'lbl';
    label.textContent = card.name;
    meta.className = 'idea-meta';
    meta.textContent = (card.providerPrompt ? '英文提示詞' : '中文一鍵生成') + ' · ' + card.modelPreset + ' · ' + card.sizePreset;

    edit.type = 'button';
    edit.className = 'card-edit';
    edit.textContent = '編輯';
    edit.addEventListener('click', function () {
      openEditor(getCardById(card.id) || card);
    });

    addToProject.type = 'button';
    addToProject.className = 'card-edit card-project';
    addToProject.textContent = '加入作品集';
    addToProject.addEventListener('click', function () {
      function addCard() {
        var added;
        if (!root.ProjectBoard || typeof root.ProjectBoard.addPromptCardToProject !== 'function') {
          setGenerationStatus('作品集功能尚未就緒', 'fail');
          return;
        }
        added = root.ProjectBoard.addPromptCardToProject(card.id);
        setGenerationStatus(added ? '已加入作品集' : '請先到作品集分頁建立或選取作品集', added ? 'done' : 'warn');
      }
      if (root.ProjectBoard && typeof root.ProjectBoard.addPromptCardToProject === 'function') {
        addCard();
        return;
      }
      if (!root.ImageFeatureLoader || typeof root.ImageFeatureLoader.load !== 'function') {
        setGenerationStatus('作品集功能尚未就緒', 'fail');
        return;
      }
      setGenerationStatus('正在載入作品集功能…', 'busy');
      root.ImageFeatureLoader.load('projects').then(addCard).catch(function () {
        setGenerationStatus('作品集功能載入失敗，請重新整理後再試', 'fail');
      });
    });

    button.appendChild(emoji);
    button.appendChild(label);
    button.appendChild(meta);
    wrap.appendChild(button);
    wrap.appendChild(edit);
    wrap.appendChild(addToProject);
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
      setGenerationStatus('✅ 已儲存風格卡', 'done');
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
    setGenerationStatus('已刪除風格卡', 'done');
  }

  function exportIdeas() {
    if (root.confirm && !root.confirm('匯出的風格卡備份會包含完整描述、畫質、尺寸與畫面編號。公開分享前請先檢查內容，確定要匯出？')) {
      setGenerationStatus('已取消匯出風格卡備份', 'warn');
      return;
    }
    var payload = root.IdeaStore.exportCards(cards);
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var link = document.createElement('a');
    var url = root.URL.createObjectURL(blob);

    link.href = url;
    link.download = 'prompt-cards-v' + payload.version + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(function () {
      root.URL.revokeObjectURL(url);
    }, 0);
    setGenerationStatus('已匯出風格卡備份；檔案包含描述與生成設定，公開前請先檢查。', 'done');
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
        setGenerationStatus('✅ 已匯入 ' + importedCards.length + ' 張風格卡', 'done');
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
    setGenerationStatus('正在轉換風格卡提示詞…', 'busy');

    fetch('/prompt/transform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: card.userPrompt, style: 'auto' })
      })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) {
            throw new Error(data.error || ('HTTP ' + response.status));
          }
          if (!data.prompt) {
            throw new Error('轉換結果缺少提示詞');
          }

          root.ImageGenApp.setGenerationSettings({
            prompt: card.userPrompt,
            providerPrompt: data.prompt,
            avoid: card.negativePrompt,
            model: card.modelPreset,
            size: card.sizePreset,
            seed: card.seed || ''
          });
          root.ImageGenApp.generate();
        });
      })
      .catch(function (error) {
        setGenerationStatus('❌ 風格卡轉換失敗：' + error.message, 'fail');
      });
  }

  function generateFromCard(card) {
    if (!root.ImageGenApp || typeof root.ImageGenApp.setGenerationSettings !== 'function' || typeof root.ImageGenApp.generate !== 'function') {
      return;
    }

    setSelectValue('model', card.modelPreset);
    setSelectValue('size', card.sizePreset);

    if (card.providerPrompt) {
      root.ImageGenApp.setGenerationSettings({
        prompt: card.userPrompt || card.providerPrompt,
        providerPrompt: card.providerPrompt,
        avoid: card.negativePrompt,
        model: card.modelPreset,
        size: card.sizePreset,
        seed: card.seed || ''
      });
      root.ImageGenApp.generate();
      return;
    }

    if (card.userPrompt) {
      transformAndGenerate(card);
      return;
    }

    setGenerationStatus('這張風格卡沒有可用提示詞', 'fail');
  }

  function openFromRecord(record) {
    var card;
    if (!root.IdeaStore || typeof root.IdeaStore.createCardFromGeneration !== 'function') {
      setGenerationStatus('❌ 風格卡儲存模組未載入', 'fail');
      return false;
    }
    try {
      card = root.IdeaStore.createCardFromGeneration(record || {});
      openEditor(card);
      setEditorStatus('已帶入生成結果，確認後即可保存成風格卡。', 'done');
      return true;
    } catch (error) {
      setGenerationStatus('❌ 無法建立風格卡：' + error.message, 'fail');
      return false;
    }
  }

  function saveLastGenerationAsCard() {
    var record;
    if (!root.ImageGenApp || typeof root.ImageGenApp.getLastGeneration !== 'function') {
      setGenerationStatus('尚無可保存的生成結果', 'warn');
      return;
    }
    record = root.ImageGenApp.getLastGeneration();
    if (!record || !record.image) {
      setGenerationStatus('先生成一張圖，才能存成風格卡', 'warn');
      return;
    }
    openFromRecord(record);
  }

  function bindEditorEvents() {
    var backdrop = byId('ideaEditor');
    var addButton = byId('addIdea');
    var closeButton = byId('closeIdeaEditor');
    var form = byId('ideaForm');
    var deleteButton = byId('deleteIdea');
    var exportButton = byId('exportIdeas');
    var importInput = byId('importIdeas');
    var saveGenerated = byId('saveStyleCard');

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
    if (saveGenerated) {
      saveGenerated.addEventListener('click', saveLastGenerationAsCard);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!root.IdeaStore) {
      setGenerationStatus('❌ 風格卡儲存模組未載入', 'fail');
      return;
    }

    cards = root.IdeaStore.loadCards();
    renderCards();
    bindEditorEvents();
  });

  root.PromptCards = {
    openEditor: openEditor,
    openFromRecord: openFromRecord,
    renderCards: renderCards,
    generateFromCard: generateFromCard,
    saveLastGenerationAsCard: saveLastGenerationAsCard
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
