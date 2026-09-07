from __future__ import annotations

import re
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
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def _has_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


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
        "假身份證",
        "偽造身分證",
        "偽造身份證",
        "偽造護照",
        "假護照",
        "偽造駕照",
        "假駕照",
        "fake id",
        "fake passport",
        "counterfeit passport",
    )
    # Identity documents are high-risk even when the request avoids the words
    # "fake" or "counterfeit". Official-looking fields (name/number/front/back)
    # make the intent unambiguous, while the document terms alone remain a
    # fail-closed safety boundary for this public image generator.
    identity_documents = (
        "身分證",
        "身份證",
        "國民身分證",
        "國民身份證",
        "護照",
        "駕照",
        "駕駛執照",
        "居留證",
        "居留卡",
        "健保卡",
        "identity card",
        "identification card",
        "id card",
        "national id",
        "official id",
        "passport",
        "driver's license",
        "drivers license",
        "driving licence",
        "residence permit",
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
    if _has_any(text, fake_docs) or _has_any(text, identity_documents):
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
