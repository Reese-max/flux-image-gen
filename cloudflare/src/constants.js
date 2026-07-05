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
// The gallery POST carries a whole generated image as a base64 data URL
// (~4/3 × binary size), so the generic 64KB JSON cap would reject every real
// image. Sized for MAX_GALLERY_IMAGE_BYTES × 4/3 plus meta headroom.
export const MAX_GALLERY_JSON_BYTES = 8 * 1024 * 1024;
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

// Ordered auto-detect rules for style="auto". The first matching style wins, so
// the order encodes priority (cute > cinematic > anime > product > realistic).
// Keep in sync with STYLE_KEYWORD_RULES in app/prompt_transform.py.
export const STYLE_KEYWORD_RULES = Object.freeze([
  ["cute", ["可愛", "萌", "療癒", "卡哇伊", "Q版", "軟萌", "粉嫩", "童趣",
    "童話", "溫馨", "甜美", "圓滾滾", "吉祥物", "貼圖", "娃娃"]],
  ["cinematic", ["電影", "鏡頭", "夜景", "街景", "電影感", "電影海報", "戲劇",
    "景深", "逆光", "霓虹", "賽博龐克", "賽博", "末日", "史詩",
    "氛圍", "膠捲", "底片", "黑色電影", "光影"]],
  ["anime", ["動畫", "動漫", "二次元", "漫畫", "插畫", "日系", "日漫",
    "少女漫", "少年漫", "賽璐璐", "動漫風", "ACG", "番劇"]],
  ["product", ["商品", "產品", "包裝", "電商", "開箱", "攝影棚", "棚拍",
    "商業攝影", "廣告照", "型錄", "目錄", "白底", "去背", "主圖",
    "精品", "商業"]],
  ["realistic", ["寫實", "真實", "照片", "寫真", "攝影", "實拍", "逼真", "擬真",
    "紀實", "相片", "真人", "超寫實", "4K", "8K", "高清"]],
]);

// --- Gemini (Gemma) LLM prompt transform: mirrors app/prompt_llm.py ---
export const GEMINI_DEFAULT_MODEL = sharedConstants.geminiDefaultModel;
export const GEMINI_COMPLETE_DEFAULT_MODEL = sharedConstants.geminiCompleteDefaultModel;
export const GEMINI_DEFAULT_BASE_URL = sharedConstants.geminiDefaultBaseUrl;
export const GEMINI_MAX_ATTEMPTS = sharedConstants.geminiMaxAttempts;
export const GEMINI_RETRYABLE_STATUS = new Set(sharedConstants.geminiRetryableStatus);
export const GEMINI_SYSTEM_INSTRUCTION = sharedConstants.systemInstruction;
export const GEMINI_RESPONSE_SCHEMA = sharedConstants.responseSchema;
export const GEMINI_STYLE_HINTS = sharedConstants.styleHints;
export const GEMINI_COMPLETION_SYSTEM_INSTRUCTION = sharedConstants.completionSystemInstruction;
export const GEMINI_COMPLETION_RESPONSE_SCHEMA = sharedConstants.completionResponseSchema;
export const GEMINI_COMPLETION_STYLE_HINTS = sharedConstants.completionStyleHints;
export const GEMINI_ENHANCE_SYSTEM_INSTRUCTION = sharedConstants.enhanceSystemInstruction;
export const GEMINI_ENHANCE_RESPONSE_SCHEMA = sharedConstants.enhanceResponseSchema;

// Image generation retry policy — mirrors app/image_service.py. Retry transient
// failures (network / 5xx); 429 is surfaced immediately so the client honours retry_after.
export const IMAGE_MAX_ATTEMPTS = 2;
export const RETRYABLE_IMAGE_STATUS = new Set([500, 502, 503, 504]);
export const IMAGE_RETRY_BACKOFF_MS = 500;
// Abort the NVIDIA fetch when the upstream hangs (observed: flux.1-schnell
// accepting the request then sending 0 bytes forever). Without this the Worker
// waits until the edge kills the whole request as an ugly 1101. Mirrors the
// FastAPI request_timeout_seconds + 504 "timeout" mapping.
export const IMAGE_FETCH_TIMEOUT_MS = 60_000;

// Workers AI model backing the UI's "fast" tier. FLUX.2 klein 4B is a 4-step
// distilled model (schnell-class speed) that, unlike @cf/...flux-1-schnell,
// supports width/height (256-1920) and seed. Takes multipart form input.
export const WORKERS_AI_FAST_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
// AI 改圖（instruction edit）：FLUX.2 klein 吃 1-4 張自訂圖（multipart
// input_image_0..3，每張 < 512x512），回 { image: base64 }。
export const WORKERS_AI_EDIT_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
export const MAX_EDIT_IMAGES = 4;
// 單張上傳上限（前端已縮到 <512，這是防濫用的硬上限）。
export const MAX_EDIT_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_BATCH_COUNT = 4;

// --- Cloud gallery (R2) ---
export const GALLERY_PREFIX = "gallery/";
export const GALLERY_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const GALLERY_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
