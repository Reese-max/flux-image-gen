from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class ModerationDecision:
    allowed: bool
    category: str = "ok"
    code: str = "ok"
    message: str = ""
    status_code: int = 200


FRIENDLY_BLOCK_MESSAGE = "這段描述屬於高風險內容，無法生成圖片。請改成安全、非侵害性且不涉及詐欺或偽造的描述。"


def moderate_prompt(prompt: str) -> ModerationDecision:
    """Small deterministic abuse gate before any image provider call.

    This intentionally returns only a category and user-safe reason. Do not log
    or echo matched text here; prompts may contain sensitive personal data.
    """

    text = _normalize(prompt)
    if not text:
        return ModerationDecision(True)

    category = _detect_high_risk_category(text)
    if not category:
        return ModerationDecision(True)

    return ModerationDecision(
        allowed=False,
        category=category,
        code="prompt_blocked",
        message=FRIENDLY_BLOCK_MESSAGE,
        status_code=422,
    )


def _normalize(value: str) -> str:
    # NFKC folds full-width/compat lookalikes (ｐａｓｓｐｏｒｔ → passport) and
    # dropping Cf format chars (ZWSP, word joiner, BOM...) blocks invisible
    # separators used to evade the term list.
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    return re.sub(r"\s+", " ", text).strip().lower()


def _has_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


# 政府核發的身分／官方證件預設拒絕：不需要「假／偽造」字眼，因為寫實證件圖本身就是偽造風險。
_ID_DOCUMENT_TERMS = (
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
)

# Latin terms match on token boundaries so "valid card"/"paid card" do not
# collide with "id card" and "advisable" does not collide with "visa".
# Separators may be a space, hyphen, or nothing ("id-card"/"idcard"); plurals
# and straight/curly apostrophes are covered.
_ID_DOCUMENT_LATIN_RE = re.compile(
    r"(?<![a-z0-9])(?:"
    r"identification[ -]?(?:cards?|documents?)|"
    r"identity[ -]?(?:cards?|documents?)|"
    r"national[ -]?(?:ids?|identity[ -]?(?:cards?|documents?))|"
    r"student[ -]?ids?|school[ -]?ids?|state[ -]?ids?|government[ -]?ids?|"
    r"id[ -]?cards?|passports?|visas?|"
    r"driver['’]?s?[ -]?licen[cs]es?|driving[ -]?licen[cs]es?|"
    r"social[ -]?security[ -]?cards?|ssn[ -]?cards?|"
    r"birth[ -]?certificates?|green[ -]?cards?|"
    r"residence[ -]?permits?|permanent[ -]?resident[ -]?cards?"
    r")(?![a-z0-9])"
)


def _detect_high_risk_category(text: str) -> str:
    sexual = (
        "色情",
        "性愛",
        "性行為",
        "裸照",
        "裸體",
        "成人影片",
        "porn",
        "nsfw",
        "nude",
        "sex scene",
    )
    minors = ("未成年", "兒童", "小孩", "國中生", "高中生", "幼女", "幼童", "child", "minor", "teen")
    gore = (
        "血腥",
        "肢解",
        "斬首",
        "酷刑",
        "處決",
        "虐殺",
        "gore",
        "decapitation",
        "dismember",
        "torture",
    )
    fake_docs = (
        "假身分證",
        "偽造身分證",
        "偽造護照",
        "假護照",
        "偽造駕照",
        "假駕照",
        "fake id",
        "fake passport",
        "counterfeit passport",
    )
    fraud = (
        "詐騙廣告",
        "釣魚網站",
        "偽造發票",
        "假付款",
        "投資詐騙",
        "盜刷",
        "phishing",
        "scam ad",
        "fake invoice",
    )
    privacy = (
        "公開個資",
        "人肉搜索",
        "洩漏地址",
        "洩露地址",
        "偷窺",
        "偷拍",
        "doxx",
        "doxxing",
        "leak address",
    )
    political = ("政治人物", "總統", "候選人", "立委", "市長", "president", "candidate", "politician")
    deceptive = ("假新聞", "抹黑", "造謠", "冒充", "deepfake", "fake endorsement", "宣傳海報")
    trademark = ("仿冒", "山寨", "盜版", "假logo", "假 logo", "counterfeit", "knockoff")

    if _has_any(text, minors) and _has_any(text, sexual):
        return "minor_sensitive"
    if _has_any(text, sexual):
        return "sexual"
    if _has_any(text, gore):
        return "graphic_violence"
    if _has_any(text, fake_docs) or _has_any(text, _ID_DOCUMENT_TERMS) or _ID_DOCUMENT_LATIN_RE.search(text):
        return "fake_documents"
    if _has_any(text, fraud):
        return "fraud"
    if _has_any(text, privacy):
        return "privacy"
    if _has_any(text, political) and _has_any(text, deceptive):
        return "political_deception"
    if _has_any(text, trademark):
        return "trademark_abuse"
    return ""
