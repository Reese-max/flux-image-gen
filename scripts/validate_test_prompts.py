"""Validate the product acceptance prompt set.

The JSON file is the source of truth for TASK-049. This script keeps it useful
as both a manual checklist and an offline automated smoke test:

    python scripts/validate_test_prompts.py
    python scripts/validate_test_prompts.py --json eval/product-test-prompts.json

Network calls are intentionally disabled. Automated transform assertions force
the rule-based prompt compiler so CI remains deterministic.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROMPT_SET = PROJECT_ROOT / "eval" / "product-test-prompts.json"
sys.path.insert(0, str(PROJECT_ROOT))

REQUIRED_CATEGORIES = {
    "短中文 prompt",
    "長中文 prompt",
    "PPT 用途",
    "IG 用途",
    "人像",
    "產品照",
    "動漫",
    "文字渲染",
    "Negative prompt",
    "Seed 重現",
    "多張生成",
    "Demo 模式",
    "API 失敗",
    "金鑰未設定",
}

ALLOWED_GENERATION_STATES = {
    "idle",
    "compiling_prompt",
    "generating",
    "saving",
    "success",
    "error",
    "cancelled",
}
ALLOWED_PROVIDER_STATUSES = {"checking", "demo", "ready", "degraded", "offline", "error"}
ALLOWED_MODES = {"normal", "agent"}
ALLOWED_MODE_LABELS = {"demo", "live"}
ALLOWED_MODELS = {"schnell", "dev"}
ALLOWED_SIZES = {"square", "landscape", "portrait"}
ALLOWED_STYLES = {"auto", "cute", "cinematic", "realistic", "anime", "product"}
ALLOWED_USE_CASES = {
    "auto",
    "general",
    "ppt",
    "social",
    "story",
    "poster",
    "wallpaper",
    "thumbnail",
    "product",
    "character",
}


def load_prompt_set(path: Path = DEFAULT_PROMPT_SET) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_prompt_set(data: dict[str, Any]) -> list[dict[str, Any]]:
    errors: list[str] = []
    if data.get("schema") != "flux-product-test-prompts.v1":
        errors.append("schema must be flux-product-test-prompts.v1")
    if data.get("version") != 1:
        errors.append("version must be 1")

    cases = data.get("cases")
    if not isinstance(cases, list) or not cases:
        errors.append("cases must be a non-empty list")
        raise AssertionError("\n".join(errors))

    ids: set[str] = set()
    categories: set[str] = set()
    for index, case in enumerate(cases):
        prefix = f"cases[{index}]"
        case_id = _require_text(case, "id", errors, prefix)
        if case_id:
            if case_id in ids:
                errors.append(f"{prefix}.id duplicates {case_id}")
            ids.add(case_id)

        category = _require_text(case, "category", errors, prefix)
        if category:
            categories.add(category)
        _require_text(case, "description", errors, prefix)

        input_data = case.get("input")
        expected = case.get("expected")
        if not isinstance(input_data, dict):
            errors.append(f"{prefix}.input must be an object")
            continue
        if not isinstance(expected, dict):
            errors.append(f"{prefix}.expected must be an object")
            continue

        _validate_input(input_data, errors, f"{prefix}.input")
        _validate_expected(expected, errors, f"{prefix}.expected")

    missing_categories = REQUIRED_CATEGORIES - categories
    if missing_categories:
        errors.append("missing categories: " + ", ".join(sorted(missing_categories)))

    if errors:
        raise AssertionError("\n".join(errors))
    return cases


def run_automated_transform_checks(cases: list[dict[str, Any]]) -> None:
    # Force deterministic offline rules even if local .env contains live keys.
    from app import prompt_transform

    prompt_transform.get_settings = lambda: SimpleNamespace(gemini_api_key="", codex_api_key="")

    failures: list[str] = []
    for case in cases:
        expected = case["expected"]
        if not expected.get("automatedTransform"):
            continue

        input_data = case["input"]
        result = prompt_transform.transform_plain_prompt(
            input_data["userPrompt"],
            input_data.get("style", "auto"),
        )
        prompt = result.prompt

        if expected.get("style") and result.style != expected["style"]:
            failures.append(f"{case['id']}: expected style {expected['style']}, got {result.style}")

        for needle in expected.get("providerPromptContains", []):
            if needle.lower() not in prompt.lower():
                failures.append(f"{case['id']}: prompt missing {needle!r}; got {prompt!r}")

        combined_prompt = prompt
        negative = input_data.get("negativePrompt", "").strip()
        if negative:
            combined_prompt = f"{combined_prompt}, avoid {negative}"
        for needle in expected.get("providerPromptSuffixContains", []):
            if needle.lower() not in combined_prompt.lower():
                failures.append(f"{case['id']}: provider prompt missing suffix {needle!r}")

        warnings = " ".join(result.warnings)
        for needle in expected.get("warningsContain", []):
            if needle not in warnings:
                failures.append(f"{case['id']}: warnings missing {needle!r}; got {result.warnings!r}")

    if failures:
        raise AssertionError("\n".join(failures))


def _validate_input(input_data: dict[str, Any], errors: list[str], prefix: str) -> None:
    _require_text(input_data, "userPrompt", errors, prefix)
    _validate_choice(input_data.get("style"), ALLOWED_STYLES, errors, f"{prefix}.style")
    _validate_choice(input_data.get("useCase"), ALLOWED_USE_CASES, errors, f"{prefix}.useCase")
    _validate_choice(input_data.get("mode"), ALLOWED_MODES, errors, f"{prefix}.mode")
    if not isinstance(input_data.get("negativePrompt", ""), str):
        errors.append(f"{prefix}.negativePrompt must be a string")
    seed = input_data.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 or seed > 2147483647:
        errors.append(f"{prefix}.seed must be an integer between 0 and 2147483647")
    batch_count = input_data.get("batchCount")
    if not isinstance(batch_count, int) or isinstance(batch_count, bool) or not (1 <= batch_count <= 4):
        errors.append(f"{prefix}.batchCount must be an integer between 1 and 4")


def _validate_expected(expected: dict[str, Any], errors: list[str], prefix: str) -> None:
    if "automatedTransform" not in expected:
        errors.append(f"{prefix}.automatedTransform is required")
    elif not isinstance(expected["automatedTransform"], bool):
        errors.append(f"{prefix}.automatedTransform must be a boolean")

    _validate_optional_choice(expected, "style", ALLOWED_STYLES, errors, prefix)
    _validate_optional_choice(expected, "useCase", ALLOWED_USE_CASES, errors, prefix)
    _validate_optional_choice(expected, "modelPreset", ALLOWED_MODELS, errors, prefix)
    _validate_optional_choice(expected, "sizePreset", ALLOWED_SIZES, errors, prefix)
    _validate_optional_choice(expected, "providerStatus", ALLOWED_PROVIDER_STATUSES, errors, prefix)
    _validate_optional_choice(expected, "generationState", ALLOWED_GENERATION_STATES, errors, prefix)
    _validate_optional_choice(expected, "modeLabel", ALLOWED_MODE_LABELS, errors, prefix)

    if "batchCount" in expected:
        value = expected["batchCount"]
        if not isinstance(value, int) or isinstance(value, bool) or not (1 <= value <= 4):
            errors.append(f"{prefix}.batchCount must be an integer between 1 and 4")
    if "seed" in expected:
        value = expected["seed"]
        if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 2147483647:
            errors.append(f"{prefix}.seed must be an integer between 0 and 2147483647")

    for key in (
        "providerPromptContains",
        "providerPromptSuffixContains",
        "warningsContain",
        "riskFlagsContain",
        "forbiddenErrorText",
        "uiNotes",
        "agentSteps",
        "providerPromptMustPreserve",
    ):
        _validate_text_list(expected, key, errors, prefix)

    if "generationStateSequence" in expected:
        seq = expected["generationStateSequence"]
        if not isinstance(seq, list) or not seq:
            errors.append(f"{prefix}.generationStateSequence must be a non-empty list")
        else:
            for state in seq:
                if state not in ALLOWED_GENERATION_STATES:
                    errors.append(f"{prefix}.generationStateSequence has invalid state {state!r}")

    if "forbiddenStatusCombinations" in expected:
        combos = expected["forbiddenStatusCombinations"]
        if not isinstance(combos, list):
            errors.append(f"{prefix}.forbiddenStatusCombinations must be a list")
        else:
            for combo in combos:
                if not isinstance(combo, list) or len(combo) != 2 or not all(isinstance(item, str) for item in combo):
                    errors.append(f"{prefix}.forbiddenStatusCombinations entries must be two strings")


def _require_text(obj: dict[str, Any], key: str, errors: list[str], prefix: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{prefix}.{key} must be a non-empty string")
        return ""
    return value


def _validate_choice(value: Any, choices: set[str], errors: list[str], key: str) -> None:
    if value not in choices:
        errors.append(f"{key} must be one of {sorted(choices)}")


def _validate_optional_choice(
    obj: dict[str, Any],
    key: str,
    choices: set[str],
    errors: list[str],
    prefix: str,
) -> None:
    if key in obj:
        _validate_choice(obj.get(key), choices, errors, f"{prefix}.{key}")


def _validate_text_list(obj: dict[str, Any], key: str, errors: list[str], prefix: str) -> None:
    if key not in obj:
        return
    value = obj[key]
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        errors.append(f"{prefix}.{key} must be a list of non-empty strings")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", type=Path, default=DEFAULT_PROMPT_SET)
    args = parser.parse_args()

    data = load_prompt_set(args.json)
    cases = validate_prompt_set(data)
    run_automated_transform_checks(cases)
    automated_count = sum(1 for case in cases if case["expected"].get("automatedTransform"))
    print(
        f"[test-prompts] OK: {len(cases)} cases, "
        f"{len(REQUIRED_CATEGORIES)} required categories, {automated_count} automated transform checks."
    )


if __name__ == "__main__":
    main()
