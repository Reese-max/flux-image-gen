(function (root) {
  'use strict';

  var STORAGE_KEY = 'aiImagePromptCards.v1';
  var LEGACY_STORAGE_KEY = 'aiImageCustomIdeaCards.v1';
  var SCHEMA_VERSION = 1;
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

  function normalizeSeed(value) {
    var text = toText(value);
    var seed;
    if (!text) { return 0; }
    seed = Number(text);
    if (!isFinite(seed) || Math.floor(seed) !== seed || seed < 0) { return 0; }
    return seed;
  }

  function normalizeVersion(value) {
    var version = Number(value);
    if (!isFinite(version) || Math.floor(version) !== version || version < 1) { return SCHEMA_VERSION; }
    return version;
  }

  function normalizeTags(value) {
    var raw = value;
    var tags = [];
    var i;
    var tag;
    var seen = {};
    if (typeof raw === 'string') { raw = raw.split(','); }
    if (!Array.isArray(raw)) { return tags; }
    for (i = 0; i < raw.length; i += 1) {
      tag = truncateText(raw[i], 32);
      if (tag && !seen[tag]) {
        seen[tag] = true;
        tags.push(tag);
      }
    }
    return tags;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeCard(raw, makeId) {
    var source = raw || {};
    var id = toText(source.id);
    var idFactory = typeof makeId === 'function' ? makeId : defaultMakeId;
    var name = truncateText(source.name || source.title, 48);
    var userPrompt = truncateText(source.userPrompt || source.promptZh, 1200);
    var providerPrompt = truncateText(source.providerPrompt || source.promptEn, 2400);
    var negativePrompt = truncateText(source.negativePrompt || source.avoid, 1200);
    var createdAt = toText(source.createdAt) || nowIso();
    var updatedAt = toText(source.updatedAt) || createdAt;

    if (!name) {
      throw new Error('請輸入卡片名稱');
    }
    if (!userPrompt && !providerPrompt) {
      throw new Error('請輸入中文描述或 provider prompt');
    }
    if (!id) {
      id = toText(idFactory());
    }

    return {
      id: id,
      name: name,
      emoji: toText(source.emoji) || DEFAULT_EMOJI,
      userPrompt: userPrompt,
      providerPrompt: providerPrompt,
      negativePrompt: negativePrompt,
      modelPreset: toText(source.modelPreset || source.model) || DEFAULT_MODEL,
      sizePreset: toText(source.sizePreset || source.size) || DEFAULT_SIZE,
      seed: normalizeSeed(source.seed),
      tags: normalizeTags(source.tags),
      previewImageUrl: toText(source.previewImageUrl || source.previewImage || source.image),
      createdAt: createdAt,
      updatedAt: updatedAt,
      version: normalizeVersion(source.version)
    };
  }

  function normalizeCardList(list) {
    var cards = [];
    if (!Array.isArray(list)) { return cards; }
    list.forEach(function (card) {
      cards.push(normalizeCard(card));
    });
    return cards;
  }

  function parseImportedCards(text) {
    var parsed;
    var version;

    try {
      parsed = JSON.parse(toText(text));
    } catch (error) {
      throw new Error('匯入資料不是有效 JSON');
    }

    if (Array.isArray(parsed)) {
      return normalizeCardList(parsed);
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cards)) {
      throw new Error('匯入資料必須是 PromptCard 陣列或含 cards 的物件');
    }

    version = Number(parsed.version || parsed.schemaVersion);
    if (!isFinite(version) || Math.floor(version) !== version || version < 1) {
      throw new Error('匯入資料缺少 schema version');
    }
    if (version > SCHEMA_VERSION) {
      throw new Error('不支援的 PromptCard schema version');
    }

    return normalizeCardList(parsed.cards);
  }

  function exportCards(cards) {
    return {
      schema: 'PromptCardCollection',
      version: SCHEMA_VERSION,
      exportedAt: nowIso(),
      cards: normalizeCardList(cards)
    };
  }

  function dateScore(value) {
    var score = Date.parse(toText(value));
    return isFinite(score) ? score : 0;
  }

  function dropOldestCard(cards) {
    var list = cards.slice();
    var oldestIndex = 0;
    var oldestScore;
    var score;
    var i;
    if (!list.length) { return list; }
    oldestScore = dateScore(list[0].updatedAt || list[0].createdAt);
    for (i = 1; i < list.length; i += 1) {
      score = dateScore(list[i].updatedAt || list[i].createdAt);
      if (score < oldestScore) {
        oldestScore = score;
        oldestIndex = i;
      }
    }
    list.splice(oldestIndex, 1);
    return list;
  }

  function getStorage(storage) {
    if (storage) {
      return storage;
    }
    try {
      if (root.localStorage) {
        return root.localStorage;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function loadCards(storage) {
    var store = getStorage(storage);
    var raw;
    var legacyRaw;

    if (!store || typeof store.getItem !== 'function') {
      return [];
    }

    try {
      raw = store.getItem(STORAGE_KEY);
      legacyRaw = raw ? '' : store.getItem(LEGACY_STORAGE_KEY);
    } catch (error) {
      return [];
    }

    if (!raw && !legacyRaw) {
      return [];
    }

    try {
      return parseImportedCards(raw || legacyRaw);
    } catch (error) {
      return [];
    }
  }

  function saveCards(cards, storage) {
    var store = getStorage(storage);
    var normalizedCards = normalizeCardList(cards);
    var nextCards = normalizedCards.slice();

    if (!store || typeof store.setItem !== 'function') {
      return normalizedCards;
    }

    while (true) {
      try {
        store.setItem(STORAGE_KEY, JSON.stringify(exportCards(nextCards)));
        return nextCards;
      } catch (error) {
        if (!nextCards.length) {
          return [];
        }
        nextCards = dropOldestCard(nextCards);
      }
    }
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
      return Array.isArray(cards) ? normalizeCardList(cards) : [];
    }
    return cards.filter(function (card) {
      return toText(card && card.id) !== targetId;
    }).map(function (card) {
      return normalizeCard(card);
    });
  }

  function createCardFromGeneration(record, makeId) {
    var source = record || {};
    var prompt = toText(source.prompt || source.userPrompt);
    var providerPrompt = toText(source.providerPrompt);
    var shortName = truncateText(prompt || providerPrompt || '生成作品', 18);
    return normalizeCard({
      id: '',
      name: shortName ? shortName + ' 風格' : '生成作品風格',
      emoji: '🎨',
      userPrompt: prompt,
      providerPrompt: providerPrompt,
      negativePrompt: source.avoid || source.negativePrompt,
      modelPreset: source.model || source.modelPreset,
      sizePreset: source.size || source.sizePreset,
      seed: source.seed,
      tags: ['生成作品'],
      previewImageUrl: source.thumbnail || source.image || source.previewImageUrl,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      version: SCHEMA_VERSION
    }, makeId);
  }

  root.IdeaStore = {
    STORAGE_KEY: STORAGE_KEY,
    LEGACY_STORAGE_KEY: LEGACY_STORAGE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    normalizeCard: normalizeCard,
    parseImportedCards: parseImportedCards,
    exportCards: exportCards,
    loadCards: loadCards,
    saveCards: saveCards,
    upsertCard: upsertCard,
    deleteCard: deleteCard,
    createCardFromGeneration: createCardFromGeneration
  };
  root.PromptCardStore = root.IdeaStore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
