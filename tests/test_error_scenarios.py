import subprocess
import sys

from scripts.validate_error_scenarios import (
    REQUIRED_SCENARIOS,
    assert_evidence_patterns,
    load_scenario_set,
    validate_scenario_set,
)


def test_error_scenario_matrix_covers_task_050_required_cases():
    data = load_scenario_set()
    scenarios = validate_scenario_set(data)

    assert REQUIRED_SCENARIOS <= {scenario["id"] for scenario in scenarios}
    assert all(scenario["expected"] for scenario in scenarios)
    assert all(scenario["evidence"] for scenario in scenarios)


def test_error_scenario_evidence_patterns_exist():
    scenarios = validate_scenario_set(load_scenario_set())

    assert_evidence_patterns(scenarios)


def test_error_scenario_cli_validator_is_runnable():
    result = subprocess.run(
        [sys.executable, "scripts/validate_error_scenarios.py"],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "[error-scenarios] OK" in result.stdout
