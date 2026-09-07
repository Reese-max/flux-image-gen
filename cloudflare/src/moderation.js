import { HttpError } from "./http.js";

export const PROMPT_BLOCK_MESSAGE =
  "這段描述屬於高風險內容，無法生成圖片。請改成安全、非侵害性且不涉及詐欺或偽造的描述。";

function normalize(value) {
  return String(value || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

export function detectHighRiskPromptCategory(prompt) {
  const text = normalize(prompt);
  if (!text) return "";

  const sexual = ["色情", "性愛", "性行為", "裸照", "裸體", "成人影片", "porn", "nsfw", "nude", "sex scene"];
  const minors = ["未成年", "兒童", "小孩", "國中生", "高中生", "幼女", "幼童", "child", "minor", "teen"];
  const gore = ["血腥", "肢解", "斬首", "酷刑", "處決", "虐殺", "gore", "decapitation", "dismember", "torture"];
  const fakeDocs = ["假身分證", "假身份證", "偽造身分證", "偽造身份證", "偽造護照", "假護照", "偽造駕照", "假駕照", "fake id", "fake passport", "counterfeit passport"];
  const identityDocuments = ["身分證", "身份證", "國民身分證", "國民身份證", "護照", "駕照", "駕駛執照", "居留證", "居留卡", "健保卡", "identity card", "identification card", "id card", "national id", "official id", "passport", "driver's license", "drivers license", "driving licence", "residence permit"];
  const fraud = ["詐騙廣告", "釣魚網站", "偽造發票", "假付款", "投資詐騙", "盜刷", "phishing", "scam ad", "fake invoice"];
  const privacy = ["公開個資", "人肉搜索", "洩漏地址", "洩露地址", "偷窺", "偷拍", "doxx", "doxxing", "leak address"];
  const political = ["政治人物", "總統", "候選人", "立委", "市長", "president", "candidate", "politician"];
  const deceptive = ["假新聞", "抹黑", "造謠", "冒充", "deepfake", "fake endorsement", "宣傳海報"];
  const trademark = ["仿冒", "山寨", "盜版", "假logo", "假 logo", "counterfeit", "knockoff"];

  if (hasAny(text, minors) && hasAny(text, sexual)) return "minor_sensitive";
  if (hasAny(text, sexual)) return "sexual";
  if (hasAny(text, gore)) return "graphic_violence";
  if (hasAny(text, fakeDocs) || hasAny(text, identityDocuments)) return "fake_documents";
  if (hasAny(text, fraud)) return "fraud";
  if (hasAny(text, privacy)) return "privacy";
  if (hasAny(text, political) && hasAny(text, deceptive)) return "political_deception";
  if (hasAny(text, trademark)) return "trademark_abuse";
  return "";
}

export function assertPromptAllowedForGeneration(...parts) {
  const category = detectHighRiskPromptCategory(parts.filter(Boolean).join("\n"));
  if (!category) return;
  const err = new HttpError(PROMPT_BLOCK_MESSAGE, 422, "prompt_blocked");
  err.category = category;
  throw err;
}
