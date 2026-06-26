(function (root) {
  'use strict';

  var STORAGE_KEY = 'aiImageCustomIdeaCards.v1';
  var DEFAULT_EMOJI = '✨';
  var DEFAULT_MODEL = 'schnell';
  var DEFAULT_SIZE = 'square';

  function toText(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).trim();
  }

  function truncateText(value, maxLength) {
    var text = toText(value);
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength);
  }

  function defaultMakeId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    return 'card-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function normalizeCard(raw, makeId) {
    var source = raw || {};
    var title = truncateText(source.title, 24);
    var promptZh = truncateText(source.promptZh, 500);
    var promptEn = truncateText(source.promptEn, 1000);
    var id = toText(source.id);
    var idFactory = typeof makeId === 'function' ? makeId : defaultMakeId;

    if (!title) {
      throw new Error('請輸入卡片名稱');
    }
    if (!promptZh && !promptEn) {
      throw new Error('請輸入中文描述或英文提示詞');
    }
    if (!id) {
      id = toText(idFactory());
    }

    return {
      id: id,
      emoji: toText(source.emoji) || DEFAULT_EMOJI,
      title: title,
      promptZh: promptZh,
      promptEn: promptEn,
      model: toText(source.model) || DEFAULT_MODEL,
      size: toText(source.size) || DEFAULT_SIZE
    };
  }

  function parseImportedCards(text) {
    var parsed;

    try {
      parsed = JSON.parse(toText(text));
    } catch (error) {
      throw new Error('匯入資料不是有效 JSON');
    }

    if (!Array.isArray(parsed)) {
      throw new Error('匯入資料必須是卡片陣列');
    }

    return parsed.map(function (card) {
      return normalizeCard(card);
    });
  }

  function getStorage(storage) {
    if (storage) {
      return storage;
    }
    if (root.localStorage) {
      return root.localStorage;
    }
    return null;
  }

  function loadCards(storage) {
    var store = getStorage(storage);
    var raw;

    if (!store || typeof store.getItem !== 'function') {
      return [];
    }

    try {
      raw = store.getItem(STORAGE_KEY);
    } catch (error) {
      return [];
    }

    if (!raw) {
      return [];
    }

    try {
      return parseImportedCards(raw);
    } catch (error) {
      return [];
    }
  }

  function saveCards(cards, storage) {
    var store = getStorage(storage);
    var normalizedCards = Array.isArray(cards) ? cards.map(function (card) {
      return normalizeCard(card);
    }) : [];

    if (!store || typeof store.setItem !== 'function') {
      return normalizedCards;
    }

    try {
      store.setItem(STORAGE_KEY, JSON.stringify(normalizedCards));
    } catch (error) {
      return normalizedCards;
    }

    return normalizedCards;
  }

  function upsertCard(cards, card) {
    var list = Array.isArray(cards) ? cards.slice() : [];
    var normalized = normalizeCard(card);
    var replaced = false;
    var nextCards = list.map(function (existing) {
      if (toText(existing && existing.id) === normalized.id) {
        replaced = true;
        return normalized;
      }
      return normalizeCard(existing);
    });

    if (!replaced) {
      nextCards.push(normalized);
    }

    return nextCards;
  }

  function deleteCard(cards, id) {
    var targetId = toText(id);
    if (!Array.isArray(cards) || !targetId) {
      return Array.isArray(cards) ? cards.slice() : [];
    }
    return cards.filter(function (card) {
      return toText(card && card.id) !== targetId;
    }).map(function (card) {
      return normalizeCard(card);
    });
  }

  root.IdeaStore = {
    STORAGE_KEY: STORAGE_KEY,
    normalizeCard: normalizeCard,
    parseImportedCards: parseImportedCards,
    loadCards: loadCards,
    saveCards: saveCards,
    upsertCard: upsertCard,
    deleteCard: deleteCard
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
