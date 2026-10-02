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


def set_wrangler_var(path: Path, name: str, value: str) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    prefix = f"{name} = "
    assert sum(line.startswith(prefix) for line in lines) == 1
    path.write_text("\n".join(f'{name} = "{value}"' if line.startswith(prefix) else line for line in lines) + "\n", encoding="utf-8")


def test_deployment_preflight_passes_current_repo_default_mode():
    result = run_preflight(ROOT)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "PASS"
    assert "wrangler bindings OK" in payload["checks"]
    assert "release acceptance checklist OK" in payload["checks"]
    assert payload["publicMode"] is False

def test_deployment_preflight_public_mode_passes_checked_in_config():
    result = run_preflight(ROOT, "--public")
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "PASS"
    assert payload["publicMode"] is True


def test_deployment_preflight_public_mode_rejects_turnstile_opt_out(tmp_path):
    """Turnstile opt-out must not survive the public gate: the per-IP limiter
    alone is trivially rotated, so it cannot stand in for the human check."""
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    set_wrangler_var(wrangler, "TURNSTILE_REQUIRED", "false")
    set_wrangler_var(wrangler, "TURNSTILE_SITE_KEY", "")
    result = run_preflight(root, "--public")
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert '--public 模式要求 TURNSTILE_REQUIRED = "true"（單靠 per-IP rate limit 可被輪替 IP 繞過）' in payload["errors"]

    set_wrangler_var(wrangler, "TURNSTILE_REQUIRED", "true")
    result = run_preflight(root, "--public")
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert "--public 模式啟用 Turnstile 時 TURNSTILE_SITE_KEY 不可空白" in payload["errors"]


def test_deployment_preflight_public_mode_passes_when_turnstile_is_configured(tmp_path):
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    set_wrangler_var(wrangler, "ENVIRONMENT", "production")
    set_wrangler_var(wrangler, "TURNSTILE_REQUIRED", "true")
    set_wrangler_var(wrangler, "TURNSTILE_SITE_KEY", "1x00000000000000000000AA")
    result = run_preflight(root, "--public")
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "PASS"
    assert payload["publicMode"] is True


def test_deployment_preflight_public_mode_rejects_development_even_with_turnstile(tmp_path):
    """Turnstile does not cover /prompt/*, so public deploys must be fail-closed."""
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    set_wrangler_var(wrangler, "ENVIRONMENT", "development")
    set_wrangler_var(wrangler, "TURNSTILE_REQUIRED", "true")
    set_wrangler_var(wrangler, "TURNSTILE_SITE_KEY", "1x00000000000000000000AA")
    result = run_preflight(root, "--public")
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert any("ENVIRONMENT" in error and '"production"' in error for error in payload["errors"])


def test_deployment_preflight_public_mode_rejects_when_all_abuse_controls_off(tmp_path):
    """A public deploy with neither Turnstile nor a fail-closed limiter policy must be rejected."""
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    set_wrangler_var(wrangler, "ENVIRONMENT", "development")
    set_wrangler_var(wrangler, "TURNSTILE_REQUIRED", "false")
    result = run_preflight(root, "--public")
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert any("ENVIRONMENT" in e or "TURNSTILE" in e for e in payload["errors"])


def test_deployment_preflight_public_mode_requires_turnstile_not_just_the_limiter(tmp_path):
    """ENVIRONMENT=production plus the limiter binding is not enough: the image
    routes must also verify a human token."""
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    set_wrangler_var(wrangler, "ENVIRONMENT", "production")
    set_wrangler_var(wrangler, "TURNSTILE_REQUIRED", "false")
    result = run_preflight(root, "--public")
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert '--public 模式要求 TURNSTILE_REQUIRED = "true"（單靠 per-IP rate limit 可被輪替 IP 繞過）' in payload["errors"]


def test_deployment_preflight_public_mode_requires_site_key_when_turnstile_is_on(tmp_path):
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    set_wrangler_var(wrangler, "ENVIRONMENT", "production")
    set_wrangler_var(wrangler, "TURNSTILE_REQUIRED", "true")
    set_wrangler_var(wrangler, "TURNSTILE_SITE_KEY", "")
    result = run_preflight(root, "--public")
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert "--public 模式啟用 Turnstile 時 TURNSTILE_SITE_KEY 不可空白" in payload["errors"]


def test_deployment_preflight_public_mode_rejects_missing_environment_and_turnstile_off(tmp_path):
    """Removing ENVIRONMENT entirely must not silently pass: without the flag the
    limiter cannot fail closed, so public mode must still reject the deploy."""
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    text = wrangler.read_text(encoding="utf-8")
    text = "\n".join(line for line in text.splitlines() if not line.startswith("ENVIRONMENT = ")) + "\n"
    wrangler.write_text(text, encoding="utf-8")
    set_wrangler_var(wrangler, "TURNSTILE_REQUIRED", "false")
    result = run_preflight(root, "--public")
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    # The missing-var check alone would pass this test, so assert the public
    # fail-closed policy check fired as well.
    assert (
        '--public 模式要求 ENVIRONMENT = "production"（/prompt/* 路由不驗證 Turnstile，rate limiter 必須 fail-closed）'
        in payload["errors"]
    )


def test_deployment_preflight_public_mode_rejects_unknown_environment_mode(tmp_path):
    """A present but unrecognised ENVIRONMENT must not pass as production: only an
    explicit "production" enables the fail-closed limiter policy."""
    root = copy_repo_subset(tmp_path)
    wrangler = root / "cloudflare" / "wrangler.toml"
    set_wrangler_var(wrangler, "ENVIRONMENT", "staging")
    set_wrangler_var(wrangler, "TURNSTILE_REQUIRED", "false")
    result = run_preflight(root, "--public")
    assert result.returncode == 1
    payload = json.loads(result.stderr)
    assert (
        '--public 模式要求 ENVIRONMENT = "production"（/prompt/* 路由不驗證 Turnstile，rate limiter 必須 fail-closed）'
        in payload["errors"]
    )
    # ENVIRONMENT is present, so only the public-mode policy check can reject it.
    assert not [error for error in payload["errors"] if error.startswith("[vars] 缺少")]


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
