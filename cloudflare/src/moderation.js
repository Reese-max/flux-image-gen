import { HttpError } from "./http.js";

export const PROMPT_BLOCK_MESSAGE =
  "這段描述屬於高風險內容，無法生成圖片。請改成安全、非侵害性且不涉及詐欺或偽造的描述。";

function normalize(value) {
  // NFKC folds full-width/compat lookalikes and dropping Cf format chars
  // (ZWSP, word joiner, BOM...) blocks invisible separators used to evade
  // the term list.
  let text = String(value || "");
  try {
    text = text.normalize("NFKC");
  } catch (_) {
    // normalize() may throw on some runtimes; fall back to raw text
  }
  text = text.replace(/\p{Cf}/gu, "");
  return text.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

// 政府核發的身分／官方證件預設拒絕：不需要「假／偽造」字眼，因為寫實證件圖本身就是偽造風險。
const ID_DOCUMENT_TERMS = [
  "身分證",
  "身份證",
  "身分証",
  "身份証",
  "身分证",
  "身份证",
  "護照",
  "护照",
  "駕照",
  "驾照",
  "駕駛執照",
  "驾驶执照",
  "居留證",
  "居留证",
  "健保卡",
  "戶口名簿",
  "户口簿",
  "戶籍謄本",
  "户籍誊本",
  "台胞證",
  "台胞证",
  "簽證",
  "签证",
  "學生證",
  "学生证",
];

// Latin terms match on token boundaries so "valid card"/"paid card" do not
// collide with "id card" and "advisable" does not collide with "visa".
// Separators may be a space, hyphen, or nothing ("id-card"/"idcard"); plurals
// and straight/curly apostrophes are covered.
const ID_DOCUMENT_LATIN_RE = new RegExp(
  "(?<![a-z0-9])(?:" +
    "identification[ -]?(?:cards?|documents?)" +
    "|identity[ -]?(?:cards?|documents?)" +
    "|national[ -]?(?:ids?|identity[ -]?(?:cards?|documents?))" +
    "|student[ -]?ids?|school[ -]?ids?|state[ -]?ids?|government[ -]?ids?" +
    "|id[ -]?cards?|passports?|visas?" +
    "|driver['\\u2019]?s?[ -]?licen[cs]es?|driving[ -]?licen[cs]es?" +
    "|social[ -]?security[ -]?cards?|ssn[ -]?cards?" +
    "|birth[ -]?certificates?|green[ -]?cards?" +
    "|residence[ -]?permits?|permanent[ -]?resident[ -]?cards?" +
    ")(?![a-z0-9])"
);

export function detectHighRiskPromptCategory(prompt) {
  const text = normalize(prompt);
  if (!text) return "";

  const sexual = ["色情", "性愛", "性行為", "裸照", "裸體", "成人影片", "porn", "nsfw", "nude", "sex scene"];
  const minors = ["未成年", "兒童", "小孩", "國中生", "高中生", "幼女", "幼童", "child", "minor", "teen"];
  const gore = ["血腥", "肢解", "斬首", "酷刑", "處決", "虐殺", "gore", "decapitation", "dismember", "torture"];
  const fakeDocs = ["假身分證", "偽造身分證", "偽造護照", "假護照", "偽造駕照", "假駕照", "fake id", "fake passport", "counterfeit passport"];
  const fraud = ["詐騙廣告", "釣魚網站", "偽造發票", "假付款", "投資詐騙", "盜刷", "phishing", "scam ad", "fake invoice"];
  const privacy = ["公開個資", "人肉搜索", "洩漏地址", "洩露地址", "偷窺", "偷拍", "doxx", "doxxing", "leak address"];
  const political = ["政治人物", "總統", "候選人", "立委", "市長", "president", "candidate", "politician"];
  const deceptive = ["假新聞", "抹黑", "造謠", "冒充", "deepfake", "fake endorsement", "宣傳海報"];
  const trademark = ["仿冒", "山寨", "盜版", "假logo", "假 logo", "counterfeit", "knockoff"];

  if (hasAny(text, minors) && hasAny(text, sexual)) return "minor_sensitive";
  if (hasAny(text, sexual)) return "sexual";
  if (hasAny(text, gore)) return "graphic_violence";
  const compactText = text.replace(/\s+/g, "");
  if (hasAny(text, fakeDocs) || hasAny(text, ID_DOCUMENT_TERMS) || hasAny(compactText, ID_DOCUMENT_TERMS) || ID_DOCUMENT_LATIN_RE.test(text)) return "fake_documents";
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
