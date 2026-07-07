import subprocess
import sys

from scripts.validate_test_prompts import (
    REQUIRED_CATEGORIES,
    load_prompt_set,
    run_automated_transform_checks,
    validate_prompt_set,
)


def test_product_prompt_set_covers_required_task_049_categories():
    data = load_prompt_set()
    cases = validate_prompt_set(data)

    categories = {case["category"] for case in cases}
    assert REQUIRED_CATEGORIES <= categories
    assert len(cases) >= len(REQUIRED_CATEGORIES)
    assert all(case["expected"].get("uiNotes") for case in cases)


def test_product_prompt_set_has_expected_behavior_for_every_case():
    cases = validate_prompt_set(load_prompt_set())

    for case in cases:
        expected = case["expected"]
        assert any(
            key in expected
            for key in (
                "providerPromptContains",
                "providerPromptMustPreserve",
                "providerStatus",
                "generationState",
                "qaReportRequired",
                "safeErrorRequired",
            )
        ), case["id"]


def test_product_prompt_set_automated_transform_checks_pass_offline():
    cases = validate_prompt_set(load_prompt_set())

    run_automated_transform_checks(cases)


def test_product_prompt_set_cli_validator_is_runnable():
    result = subprocess.run(
        [sys.executable, "scripts/validate_test_prompts.py"],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "[test-prompts] OK" in result.stdout
