import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_deployment_preflight.py"


def copy_repo_subset(tmp_path: Path) -> Path:
    dest = tmp_path / "repo"
    for relative in [
        "cloudflare/wrangler.toml",
        "cloudflare/package.json",
        "cloudflare/public/index.html",
        "cloudflare/src/index.js",
        "docs/deployment-checklist.md",
        "docs/release-acceptance-checklist.md",
        ".gitignore",
    ]:
        source = ROOT / relative
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    return dest


def run_preflight(root: Path, *args: str):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )


def replace(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text
    path.write_text(text.replace(old, new), encoding="utf-8")


def test_deployment_preflight_passes_current_repo_default_mode():
    result = run_preflight(ROOT)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "PASS"
    assert "wrangler bindings OK" in payload["checks"]
    assert "release acceptance checklist OK" in payload["checks"]
    assert payload["publicMode"] is False


def test_deployment_preflight_public_mode_requires_turnstile_vars():
    result = run_preflight(ROOT, "--public")
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert "--public 模式要求 TURNSTILE_REQUIRED = true" in payload["errors"]
    assert "--public 模式要求 TURNSTILE_SITE_KEY 不可空白" in payload["errors"]


def test_deployment_preflight_public_mode_passes_when_turnstile_is_configured(tmp_path):
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    replace(wrangler, 'TURNSTILE_REQUIRED = "false"', 'TURNSTILE_REQUIRED = "true"')
    replace(wrangler, 'TURNSTILE_SITE_KEY = ""', 'TURNSTILE_SITE_KEY = "1x00000000000000000000AA"')
    result = run_preflight(root, "--public")
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "PASS"
    assert payload["publicMode"] is True


def test_deployment_preflight_rejects_secret_in_public_vars(tmp_path):
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    text = wrangler.read_text(encoding="utf-8")
    text = text.replace('[vars]\n', '[vars]\nNVIDIA_API_KEY = "do-not-commit"\n')
    wrangler.write_text(text, encoding="utf-8")
    result = run_preflight(root)
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert "Secret 不可放在 [vars]：NVIDIA_API_KEY" in payload["errors"]


def test_deployment_preflight_requires_r2_and_rate_limit_bindings(tmp_path):
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    text = wrangler.read_text(encoding="utf-8")
    text = text.replace('[[ratelimits]]\nname = "GENERATE_RATE_LIMITER"', '[[ratelimits]]\nname = "BROKEN_LIMITER"')
    text = text.replace('binding = "IMAGE_BUCKET"', 'binding = "BROKEN_BUCKET"')
    wrangler.write_text(text, encoding="utf-8")
    result = run_preflight(root)
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert "必須設定 [[r2_buckets]] binding = IMAGE_BUCKET" in payload["errors"]
    assert "必須設定 [[ratelimits]] name = GENERATE_RATE_LIMITER" in payload["errors"]


def test_deployment_preflight_requires_repeatable_qa_scripts(tmp_path):
    root = copy_repo_subset(tmp_path)
    package = root / "cloudflare" / "package.json"
    data = json.loads(package.read_text(encoding="utf-8"))
    data["scripts"].pop("check:wrangler")
    package.write_text(json.dumps(data), encoding="utf-8")
    result = run_preflight(root)
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert "cloudflare package scripts 缺少：check:wrangler" in payload["errors"]


def test_deployment_preflight_requires_release_acceptance_checklist(tmp_path):
    root = copy_repo_subset(tmp_path)
    (root / "docs" / "release-acceptance-checklist.md").unlink()
    result = run_preflight(root)
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert "缺少 docs/release-acceptance-checklist.md" in payload["errors"]


def test_deployment_preflight_requires_release_blocker_items(tmp_path):
    root = copy_repo_subset(tmp_path)
    checklist = root / "docs" / "release-acceptance-checklist.md"
    replace(checklist, "Turnstile 真實驗證", "Turnstile 驗證")
    result = run_preflight(root)
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert "release acceptance checklist 缺少：Turnstile 真實驗證" in payload["errors"]
