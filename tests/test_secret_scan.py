import importlib.util
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT_DIR / "scripts" / "scan_public_secrets.py"


spec = importlib.util.spec_from_file_location("scan_public_secrets", SCRIPT_PATH)
secret_scan = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules["scan_public_secrets"] = secret_scan
spec.loader.exec_module(secret_scan)


def test_secret_scan_detects_provider_key_shapes():
    text = "\n".join(
        [
            "const gemini = 'AIza" + "A" * 35 + "';",
            "const nvidia = 'nvapi-" + "B" * 32 + "';",
            "const openai = 'sk-proj-" + "C" * 32 + "';",
        ]
    )

    findings = secret_scan.scan_text(Path("bundle.js"), text)
    kinds = {finding.kind for finding in findings}

    assert "gemini_or_google_api_key" in kinds
    assert "nvidia_api_key" in kinds
    assert "openai_api_key" in kinds


def test_secret_scan_allows_documented_env_var_names_and_placeholders():
    text = "\n".join(
        [
            "請設定 NVIDIA_API_KEY 與 GEMINI_API_KEY。",
            'GEMINI_API_KEY="REPLACE_WITH_REAL_SECRET"',
            'TURNSTILE_SECRET_KEY="<turnstile-secret>"',
            'USAGE_ADMIN_TOKEN="placeholder-admin-token"',
        ]
    )

    findings = secret_scan.scan_text(Path("docs.md"), text)

    assert findings == []


def test_secret_scan_rejects_sensitive_assignment_and_local_storage():
    text = "\n".join(
        [
            'GEMINI_API_KEY="live-secret-value"',
            "window.localStorage.setItem('USAGE_ADMIN_TOKEN', token);",
        ]
    )

    findings = secret_scan.scan_text(Path("app.js"), text)
    kinds = {finding.kind for finding in findings}

    assert "sensitive_assignment" in kinds
    assert "sensitive_local_storage" in kinds
