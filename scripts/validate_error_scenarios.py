"""Validate TASK-050 error scenario coverage.

This is a lightweight coverage gate for the product error matrix. It checks that
every required scenario has explicit evidence and that the referenced files still
contain the expected test/code patterns.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SCENARIO_SET = PROJECT_ROOT / "eval" / "error-scenarios.json"

REQUIRED_SCENARIOS = {
    "missing-api-key",
    "provider-timeout",
    "provider-500",
    "rate-limit-exceeded",
    "turnstile-failed",
    "prompt-moderation-blocked",
    "local-storage-full",
    "json-import-invalid",
    "network-interrupted",
    "double-submit",
    "mobile-generation",
    "clear-history-misclick",
    "reference-image-validation",
    "usage-dashboard-read-failed",
    "deep-link-onboarding-blocked",
    "share-page-prompt-privacy",
    "cloud-delete-token-invalid",
}


def load_scenario_set(path: Path = DEFAULT_SCENARIO_SET) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_scenario_set(data: dict[str, Any]) -> list[dict[str, Any]]:
    errors: list[str] = []
    if data.get("schema") != "flux-error-scenarios.v1":
        errors.append("schema must be flux-error-scenarios.v1")
    if data.get("version") != 1:
        errors.append("version must be 1")

    scenarios = data.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        errors.append("scenarios must be a non-empty list")
        raise AssertionError("\n".join(errors))

    ids: set[str] = set()
    for index, scenario in enumerate(scenarios):
        prefix = f"scenarios[{index}]"
        scenario_id = _require_text(scenario, "id", errors, prefix)
        if scenario_id:
            if scenario_id in ids:
                errors.append(f"{prefix}.id duplicates {scenario_id}")
            ids.add(scenario_id)
        _require_text(scenario, "title", errors, prefix)
        _validate_text_list(scenario, "expected", errors, prefix)
        evidence = scenario.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            errors.append(f"{prefix}.evidence must be a non-empty list")
            continue
        for evidence_index, item in enumerate(evidence):
            _validate_evidence_item(item, errors, f"{prefix}.evidence[{evidence_index}]")

    missing = REQUIRED_SCENARIOS - ids
    if missing:
        errors.append("missing scenarios: " + ", ".join(sorted(missing)))

    if errors:
        raise AssertionError("\n".join(errors))
    return scenarios


def assert_evidence_patterns(scenarios: list[dict[str, Any]]) -> None:
    failures: list[str] = []
    cache: dict[Path, str] = {}

    for scenario in scenarios:
        for item in scenario["evidence"]:
            relative = Path(item["path"])
            path = PROJECT_ROOT / relative
            if not path.exists():
                failures.append(f"{scenario['id']}: evidence file missing: {relative}")
                continue
            if path not in cache:
                cache[path] = path.read_text(encoding="utf-8")
            text = cache[path]
            for pattern in item["patterns"]:
                if pattern not in text:
                    failures.append(f"{scenario['id']}: pattern {pattern!r} not found in {relative}")

    if failures:
        raise AssertionError("\n".join(failures))


def _validate_evidence_item(item: Any, errors: list[str], prefix: str) -> None:
    if not isinstance(item, dict):
        errors.append(f"{prefix} must be an object")
        return
    _require_text(item, "path", errors, prefix)
    _validate_text_list(item, "patterns", errors, prefix)


def _require_text(obj: dict[str, Any], key: str, errors: list[str], prefix: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{prefix}.{key} must be a non-empty string")
        return ""
    return value


def _validate_text_list(obj: dict[str, Any], key: str, errors: list[str], prefix: str) -> None:
    value = obj.get(key)
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item.strip() for item in value):
        errors.append(f"{prefix}.{key} must be a non-empty list of non-empty strings")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", type=Path, default=DEFAULT_SCENARIO_SET)
    args = parser.parse_args()

    data = load_scenario_set(args.json)
    scenarios = validate_scenario_set(data)
    assert_evidence_patterns(scenarios)
    print(f"[error-scenarios] OK: {len(scenarios)} scenarios, {len(REQUIRED_SCENARIOS)} required covered.")


if __name__ == "__main__":
    main()
