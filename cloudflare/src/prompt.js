// Prompt transform: Gemini (Gemma) LLM tier + offline rule-based fallback.
// Mirrors app/prompt_llm.py and app/prompt_transform.py.
import {
  CJK_PATTERN,
  CHINESE_FILLER_TERMS,
  GEMINI_COMPLETE_DEFAULT_MODEL,
  GEMINI_COMPLETION_RESPONSE_SCHEMA,
  GEMINI_COMPLETION_STYLE_HINTS,
  GEMINI_COMPLETION_SYSTEM_INSTRUCTION,
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_MODEL,
  GEMINI_MAX_ATTEMPTS,
  GEMINI_RESPONSE_SCHEMA,
  GEMINI_RETRYABLE_STATUS,
  GEMINI_STYLE_HINTS,
  GEMINI_SYSTEM_INSTRUCTION,
  MAX_PROMPT_LENGTH,
  PHRASE_RULES,
  STYLE_MODIFIERS,
  SUPPORTED_STYLES,
  TRANSLATED_CHINESE_TERMS,
} from "./constants.js";
import { HttpError } from "./http.js";

function buildGeminiUserText(source, style) {
  const hint = GEMINI_STYLE_HINTS[style] || GEMINI_STYLE_HINTS.auto;
  return `${hint}\n\nDescription:\n${String(source).trim()}`;
}

function buildGeminiCompletionUserText(source, style) {
  const hint = GEMINI_COMPLETION_STYLE_HINTS[style] || GEMINI_COMPLETION_STYLE_HINTS.auto;
  return `${hint}\n\n原始描述：\n${String(source).trim()}`;
}

function stripWrapping(text) {
  let cleaned = String(text || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .split("\n")
      .filter((line) => !line.trim().startsWith("```"))
      .join("\n")
      .trim();
  }
  if (
    cleaned.length >= 2 &&
    cleaned[0] === cleaned[cleaned.length - 1] &&
    (cleaned[0] === '"' || cleaned[0] === "'")
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

function tryParsePromptJson(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && typeof parsed.prompt === "string" && parsed.prompt.trim()) {
      const cleanedPrompt = parsed.prompt.trim();
      return tryParsePromptJson(cleanedPrompt) || cleanedPrompt;
    }
  } catch {
    // not valid JSON
  }
  return null;
}

function extractPromptText(rawText) {
  const cleaned = stripWrapping(rawText);

  const found = tryParsePromptJson(cleaned);
  if (found) return found;

  // The model sometimes wraps the JSON in a code fence or adds stray text;
  // try the {...} substring before giving up.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const fromSub = tryParsePromptJson(cleaned.slice(start, end + 1));
    if (fromSub) return fromSub;
  }

  return cleaned;
}

function parseGeminiResponse(data) {
  const feedback = (data && data.promptFeedback) || {};
  if (feedback.blockReason) throw new Error(`gemini blocked: ${feedback.blockReason}`);
  const candidates = (data && data.candidates) || [];
  if (!candidates.length) throw new Error("gemini returned no candidates");
  const parts = ((candidates[0] && candidates[0].content) || {}).parts || [];
  const raw = parts.map((p) => (p && p.text) || "").join("").trim();
  let text = extractPromptText(raw);
  if (!text) throw new Error("gemini returned empty text");
  if (text.length > MAX_PROMPT_LENGTH) {
    text = text.slice(0, MAX_PROMPT_LENGTH).replace(/[ ,]+$/g, "");
  }
  return text;
}

export async function geminiTransformPrompt(source, style, env) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) throw new Error("missing GEMINI_API_KEY");

  const model = env.GEMINI_PROMPT_MODEL || GEMINI_DEFAULT_MODEL;
  const base = (env.GEMINI_BASE_URL || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/models/${model}:generateContent`;
  const payload = {
    system_instruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: buildGeminiUserText(source, style) }] }],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
      responseSchema: GEMINI_RESPONSE_SCHEMA,
    },
  };

  let lastError;
  for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      lastError = new Error(`gemini network error: ${e}`);
      continue;
    }
    if (GEMINI_RETRYABLE_STATUS.has(resp.status)) {
      lastError = new Error(`gemini returned HTTP ${resp.status}`);
      continue;
    }
    if (resp.status !== 200) throw new Error(`gemini returned HTTP ${resp.status}`);

    let data;
    try {
      data = await resp.json();
    } catch {
      throw new Error("gemini returned non-JSON response");
    }
    return parseGeminiResponse(data);
  }
  throw lastError || new Error("gemini request failed");
}

export async function geminiCompletePrompt(source, style, env) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) throw new HttpError("Gemma 中文補全尚未啟用（缺少 GEMINI_API_KEY）", 503, "missing_api_key");

  const model = env.GEMINI_COMPLETE_MODEL || GEMINI_COMPLETE_DEFAULT_MODEL;
  const base = (env.GEMINI_BASE_URL || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/models/${model}:generateContent`;
  const payload = {
    system_instruction: { parts: [{ text: GEMINI_COMPLETION_SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: buildGeminiCompletionUserText(source, style) }] }],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 450,
      responseMimeType: "application/json",
      responseSchema: GEMINI_COMPLETION_RESPONSE_SCHEMA,
    },
  };

  let lastError;
  for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      lastError = new Error(`gemini completion network error: ${e}`);
      continue;
    }
    if (GEMINI_RETRYABLE_STATUS.has(resp.status)) {
      lastError = new Error(`gemini completion returned HTTP ${resp.status}`);
      continue;
    }
    if (resp.status !== 200) throw new Error(`gemini completion returned HTTP ${resp.status}`);

    let data;
    try {
      data = await resp.json();
    } catch {
      throw new Error("gemini completion returned non-JSON response");
    }
    return parseGeminiResponse(data);
  }
  throw lastError || new Error("gemini completion request failed");
}

export function normalizeStyle(style) {
  const key = String(style || "auto").trim().toLowerCase();
  return SUPPORTED_STYLES.has(key) ? key : "auto";
}

export function resolveStyle(sourceText, style) {
  if (style !== "auto") return style;
  if (["可愛", "萌", "療癒"].some((keyword) => sourceText.includes(keyword))) return "cute";
  if (["電影", "鏡頭", "夜景", "街景"].some((keyword) => sourceText.includes(keyword))) return "cinematic";
  if (["動畫", "動漫", "二次元"].some((keyword) => sourceText.includes(keyword))) return "anime";
  if (["商品", "產品", "包裝"].some((keyword) => sourceText.includes(keyword))) return "product";
  if (["寫實", "真實", "照片"].some((keyword) => sourceText.includes(keyword))) return "realistic";
  return "auto";
}

function containsCjk(text) {
  return CJK_PATTERN.test(text);
}

function hasUntranslatedCjk(sourceText) {
  if (!containsCjk(sourceText)) return false;

  let remaining = sourceText;
  for (const term of TRANSLATED_CHINESE_TERMS.concat(CHINESE_FILLER_TERMS)) {
    remaining = remaining.split(term).join("");
  }
  return containsCjk(remaining);
}

function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function fallbackCorePhrase(sourceText) {
  if (containsCjk(sourceText) || Array.from(sourceText).some((char) => char.charCodeAt(0) > 127)) {
    return "imaginative visual scene";
  }
  return sourceText;
}

function extractCorePhrases(sourceText) {
  const phrases = [];
  for (const rule of PHRASE_RULES) {
    if (rule.keywords.some((keyword) => sourceText.includes(keyword))) {
      phrases.push(rule.phrase);
    }
  }
  if (!phrases.length) {
    phrases.push(fallbackCorePhrase(sourceText));
  }
  return dedupe(phrases);
}

function buildWarnings(sourceText) {
  const warnings = [];
  if (sourceText.length <= 2) {
    warnings.push("描述較短");
  }
  if (hasUntranslatedCjk(sourceText)) {
    warnings.push("部分詞彙未能精準翻譯，已使用通用英文描述補足");
  }
  return warnings;
}

export function transformPlainPrompt(source, style = "auto") {
  const sourceText = String(source || "").trim();
  if (!sourceText) {
    throw new HttpError("請先輸入白話描述", 400, "bad_request");
  }

  const normalizedStyle = normalizeStyle(style);
  const resolvedStyle = resolveStyle(sourceText, normalizedStyle);
  const corePhrases = extractCorePhrases(sourceText);
  const warnings = buildWarnings(sourceText);
  const modifiers = STYLE_MODIFIERS[resolvedStyle] || STYLE_MODIFIERS.auto;
  const promptParts = dedupe(corePhrases.concat(modifiers, ["highly detailed"]));
  let prompt = promptParts.join(", ");

  if (prompt.length > MAX_PROMPT_LENGTH) {
    prompt = prompt.slice(0, MAX_PROMPT_LENGTH).replace(/[ ,]+$/g, "");
  }

  return {
    source: sourceText,
    prompt,
    provider: "rule_based",
    warnings,
    style: resolvedStyle,
  };
}

export async function completePlainPrompt(source, style = "auto", env = {}) {
  const sourceText = String(source || "").trim();
  if (!sourceText) {
    throw new HttpError("請先輸入白話描述", 400, "bad_request");
  }

  const normalizedStyle = normalizeStyle(style);
  const resolvedStyle = resolveStyle(sourceText, normalizedStyle);
  const prompt = await geminiCompletePrompt(sourceText, resolvedStyle, env);
  return {
    source: sourceText,
    prompt,
    provider: "gemini",
    warnings: [],
    style: resolvedStyle,
  };
}
