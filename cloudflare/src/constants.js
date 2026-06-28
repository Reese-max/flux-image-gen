// Shared constants for the Worker. Prompt-transform constants come from the single
// source of truth shared with the Python backend: shared/prompt-constants.json.
// esbuild inlines the JSON at bundle time.
import sharedConstants from "../../shared/prompt-constants.json" with { type: "json" };

export const SIZE_MAP = {
  square: [1024, 1024],
  landscape: [1344, 768],
  portrait: [768, 1344],
};

export const MODEL_ENDPOINTS = {
  schnell: "black-forest-labs/flux.1-schnell",
  dev: "black-forest-labs/flux.1-dev",
};

export const MAX_JSON_BYTES = 64 * 1024;
export const MAX_PROMPT_LENGTH = 900;
export const MAX_TRANSFORM_SOURCE_LENGTH = 2000;
export const MAX_GALLERY_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SEED = 2147483647;
export const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿]/;
export const SUPPORTED_STYLES = new Set(["auto", "cute", "cinematic", "realistic", "anime", "product"]);

export const PHRASE_RULES = Object.freeze([
  { keywords: ["台北", "臺北", "夜市"], phrase: "Taipei night market" },
  { keywords: ["下雨", "雨天", "雨", "街景"], phrase: "rainy street scene" },
  { keywords: ["柴犬"], phrase: "Shiba Inu" },
  { keywords: ["貓", "猫"], phrase: "cat" },
  { keywords: ["狗", "犬"], phrase: "dog" },
  { keywords: ["月球", "月亮", "月面"], phrase: "on the moon" },
  { keywords: ["拉麵", "拉面"], phrase: "eating ramen" },
  { keywords: ["可愛", "萌", "療癒"], phrase: "adorable" },
  { keywords: ["紅色", "紅"], phrase: "red" },
  { keywords: ["白色", "白"], phrase: "white" },
  { keywords: ["黑色", "黑"], phrase: "black" },
  { keywords: ["藍色", "藍"], phrase: "blue" },
  { keywords: ["綠色", "綠"], phrase: "green" },
  { keywords: ["黃色", "黃"], phrase: "yellow" },
  { keywords: ["杯子", "杯"], phrase: "cup" },
  { keywords: ["木桌", "木桌上"], phrase: "wooden table" },
  { keywords: ["桌上", "桌子", "桌面"], phrase: "tabletop" },
  { keywords: ["陽光", "日光", "自然光"], phrase: "sunlight" },
]);

export const TRANSLATED_CHINESE_TERMS = Object.freeze(
  PHRASE_RULES.flatMap((rule) => rule.keywords).sort((a, b) => b.length - a.length)
);

export const CHINESE_FILLER_TERMS = Object.freeze([
  "旁邊",
  "附近",
  "放在",
  "放置",
  "正在",
  "風格",
  "一點",
  "一個",
  "一隻",
  "一張",
  "一片",
  "一位",
  "一名",
  "幫我",
  "請",
  "生成",
  "圖片",
  "照片",
  "場景",
  "上",
  "下",
  "裡",
  "中",
  "旁",
  "的",
  "在",
  "有",
  "和",
  "與",
  "並",
  "要",
  "吃",
  "個",
  "隻",
  "張",
  "片",
  "位",
  "名",
]);

export const STYLE_MODIFIERS = Object.freeze({
  cute: ["adorable", "soft rounded shapes", "warm pastel colors"],
  cinematic: ["cinematic lighting", "film still", "dramatic atmosphere", "shallow depth of field"],
  realistic: ["photorealistic", "natural lighting", "realistic textures"],
  anime: ["anime style", "expressive character design", "vibrant colors"],
  product: ["studio product photography", "clean background", "commercial lighting"],
  auto: ["clean composition"],
});

// --- Gemini (Gemma) LLM prompt transform: mirrors app/prompt_llm.py ---
export const GEMINI_DEFAULT_MODEL = sharedConstants.geminiDefaultModel;
export const GEMINI_DEFAULT_BASE_URL = sharedConstants.geminiDefaultBaseUrl;
export const GEMINI_MAX_ATTEMPTS = sharedConstants.geminiMaxAttempts;
export const GEMINI_RETRYABLE_STATUS = new Set(sharedConstants.geminiRetryableStatus);
export const GEMINI_SYSTEM_INSTRUCTION = sharedConstants.systemInstruction;
export const GEMINI_RESPONSE_SCHEMA = sharedConstants.responseSchema;
export const GEMINI_STYLE_HINTS = sharedConstants.styleHints;

// Image generation retry policy — mirrors app/image_service.py. Retry transient
// failures (network / 5xx); 429 is surfaced immediately so the client honours retry_after.
export const IMAGE_MAX_ATTEMPTS = 2;
export const RETRYABLE_IMAGE_STATUS = new Set([500, 502, 503, 504]);
export const IMAGE_RETRY_BACKOFF_MS = 500;
export const MAX_BATCH_COUNT = 4;

// --- Cloud gallery (R2) ---
export const GALLERY_PREFIX = "gallery/";
export const GALLERY_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const GALLERY_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
