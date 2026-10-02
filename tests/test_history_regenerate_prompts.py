from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
REGRESSION_TEST = ROOT / "tests" / "frontend" / "regenerate-settings.test.cjs"


def test_history_regeneration_regression_harness_passes():
    result = subprocess.run(
        ["node", "--test", str(REGRESSION_TEST)],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
