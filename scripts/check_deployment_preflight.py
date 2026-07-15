#!/usr/bin/env python3
"""Static deployment preflight for the Cloudflare Fluxi Worker.

Default mode verifies the repository is wired safely for deployment without
requiring production-only values. Use --public before a real public deploy to
require Turnstile production vars.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11 fallback is not expected here.
    tomllib = None  # type: ignore[assignment]

REQUIRED_SECRET_NAMES = {
    "GALLERY_TOKEN_SECRET",
    "NVIDIA_API_KEY",
    "GEMINI_API_KEY",
    "TURNSTILE_SECRET_KEY",
    "GALLERY_ADMIN_TOKEN",
}

REQUIRED_VARS = {
    "NVIDIA_BASE_URL",
    "GEMINI_PROMPT_MODEL",
    "GEMINI_COMPLETE_MODEL",
    "GEMINI_VISION_MODEL",
    "VISION_QA_ENABLED",
    "TURNSTILE_REQUIRED",
    "TURNSTILE_SITE_KEY",
    "USAGE_ESTIMATED_COST_USD_PER_IMAGE",
    "USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST",
    "USAGE_ALERT_DAILY_GENERATIONS",
}

REQUIRED_PACKAGE_SCRIPTS = {
    "sync:check",
    "check",
    "check:wrangler",
    "test",
    "deploy",
    "deploy:dry-run",
    "qa:network",
    "qa:mobile",
    "qa:a11y",
}

REQUIRED_GITIGNORE_PATTERNS = {".env", ".dev.vars", ".dev.vars.*", ".wrangler/", "node_modules/"}

REQUIRED_RELEASE_ACCEPTANCE_ITEMS = {
    "Release blocker",
    "正式網域與 health / provider 一致性",
    "python scripts\\check_deployment_preflight.py --public",
    "python scripts\\smoke_live_provider.py --base-url https://<正式網域> --expect-mode live",
    "--check-generate --confirm-cost",
    "iPhone Safari",
    "Android Chrome",
    "Vision QA 部署抽驗",
    "R2 gallery save",
    "分享頁隱藏 prompt",
    "Turnstile 真實驗證",
    "Rate limit",
    "成本估算校準",
    "隱私政策法務確認",
    "授權與商用說明法務確認",
    "Sign-off",
    "CF_VERSION_METADATA",
    "GitHub Actions CI",
    "wrangler rollback",
    "不可公開",
}


class PreflightFailure(RuntimeError):
    pass


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_toml(path: Path) -> dict[str, Any]:
    if tomllib is None:
        raise PreflightFailure("Python 3.11+ tomllib is required")
    try:
        return tomllib.loads(read_text(path))
    except Exception as exc:  # noqa: BLE001 - report config parse errors plainly.
        raise PreflightFailure(f"wrangler.toml 解析失敗：{exc}") from exc


def list_contains_object(items: Any, key: str, value: str) -> dict[str, Any] | None:
    if not isinstance(items, list):
        return None
    for item in items:
        if isinstance(item, dict) and item.get(key) == value:
            return item
    return None


def validate_wrangler(root: Path, public: bool, errors: list[str], checks: list[str]) -> None:
    wrangler_path = root / "cloudflare" / "wrangler.toml"
    legacy_deploy_path = root / "cloudflare" / "wrangler.deploy.toml"
    require(wrangler_path.exists(), "缺少 cloudflare/wrangler.toml", errors)
    require(
        not legacy_deploy_path.exists(),
        "不得保留第二份 cloudflare/wrangler.deploy.toml；部署設定必須只有 wrangler.toml",
        errors,
    )
    if not wrangler_path.exists():
        return
    data = read_toml(wrangler_path)

    require(data.get("main") == "src/index.js", "wrangler main 必須是 src/index.js", errors)
    require(data.get("compatibility_date"), "wrangler 必須設定 compatibility_date", errors)
    require("nodejs_compat" in (data.get("compatibility_flags") or []), "wrangler 必須啟用 nodejs_compat", errors)

    version_metadata = data.get("version_metadata")
    require(
        isinstance(version_metadata, dict) and version_metadata.get("binding") == "CF_VERSION_METADATA",
        "必須設定 [version_metadata] binding = CF_VERSION_METADATA",
        errors,
    )

    observability = data.get("observability")
    require(
        isinstance(observability, dict) and observability.get("enabled") is True,
        "必須啟用 [observability]",
        errors,
    )
    if isinstance(observability, dict):
        sample_rate = observability.get("head_sampling_rate")
        require(
            isinstance(sample_rate, (int, float)) and 0 < sample_rate <= 1,
            "observability head_sampling_rate 必須介於 0（不含）與 1 之間",
            errors,
        )
        logs = observability.get("logs")
        require(
            isinstance(logs, dict) and logs.get("enabled") is True,
            "必須啟用 [observability.logs]",
            errors,
        )
        if isinstance(logs, dict):
            log_sample_rate = logs.get("head_sampling_rate")
            require(
                isinstance(log_sample_rate, (int, float)) and 0 < log_sample_rate <= 1,
                "observability.logs head_sampling_rate 必須介於 0（不含）與 1 之間",
                errors,
            )
    assets = data.get("assets")
    require(isinstance(assets, dict), "wrangler 必須設定 [assets]", errors)
    if isinstance(assets, dict):
        require(assets.get("directory") == "./public", "[assets].directory 必須是 ./public", errors)
        require(assets.get("binding") == "ASSETS", "[assets].binding 必須是 ASSETS", errors)

    ai = data.get("ai")
    require(isinstance(ai, dict) and ai.get("binding") == "AI", "必須設定 [ai] binding = AI", errors)

    r2 = list_contains_object(data.get("r2_buckets"), "binding", "IMAGE_BUCKET")
    require(r2 is not None, "必須設定 [[r2_buckets]] binding = IMAGE_BUCKET", errors)
    if r2 is not None:
        require(bool(str(r2.get("bucket_name", "")).strip()), "IMAGE_BUCKET 必須設定 bucket_name", errors)

    limiter = list_contains_object(data.get("ratelimits"), "name", "GENERATE_RATE_LIMITER")
    require(limiter is not None, "必須設定 [[ratelimits]] name = GENERATE_RATE_LIMITER", errors)
    if limiter is not None:
        simple = limiter.get("simple")
        require(isinstance(simple, dict), "GENERATE_RATE_LIMITER 必須設定 simple limit/period", errors)
        if isinstance(simple, dict):
            require(int(simple.get("limit", 0)) > 0, "rate limit simple.limit 必須大於 0", errors)
            require(int(simple.get("period", 0)) > 0, "rate limit simple.period 必須大於 0", errors)

    vars_section = data.get("vars")
    require(isinstance(vars_section, dict), "wrangler 必須設定 [vars]", errors)
    vars_section = vars_section if isinstance(vars_section, dict) else {}
    missing_vars = sorted(REQUIRED_VARS - set(vars_section.keys()))
    require(not missing_vars, "[vars] 缺少：" + ", ".join(missing_vars), errors)
    leaked_secret_vars = sorted(REQUIRED_SECRET_NAMES & set(vars_section.keys()))
    require(not leaked_secret_vars, "Secret 不可放在 [vars]：" + ", ".join(leaked_secret_vars), errors)

    if "NVIDIA_BASE_URL" in vars_section:
        require(str(vars_section.get("NVIDIA_BASE_URL", "")).startswith("https://"), "NVIDIA_BASE_URL 必須是 https URL", errors)
    if "VISION_QA_ENABLED" in vars_section:
        require(str(vars_section.get("VISION_QA_ENABLED")).lower() in {"true", "false"}, "VISION_QA_ENABLED 必須是 true/false 字串", errors)
    if "TURNSTILE_REQUIRED" in vars_section:
        require(str(vars_section.get("TURNSTILE_REQUIRED")).lower() in {"true", "false"}, "TURNSTILE_REQUIRED 必須是 true/false 字串", errors)
    if "USAGE_ESTIMATED_COST_USD_PER_IMAGE" in vars_section:
        try:
            require(float(vars_section.get("USAGE_ESTIMATED_COST_USD_PER_IMAGE")) >= 0, "USAGE_ESTIMATED_COST_USD_PER_IMAGE 不可為負", errors)
        except (TypeError, ValueError):
            errors.append("USAGE_ESTIMATED_COST_USD_PER_IMAGE 必須是數字字串")
    if "USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST" in vars_section:
        try:
            require(float(vars_section.get("USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST")) >= 0, "USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST 不可為負", errors)
        except (TypeError, ValueError):
            errors.append("USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST 必須是數字字串")
    if "USAGE_ALERT_DAILY_GENERATIONS" in vars_section:
        try:
            require(int(vars_section.get("USAGE_ALERT_DAILY_GENERATIONS")) > 0, "USAGE_ALERT_DAILY_GENERATIONS 必須大於 0", errors)
        except (TypeError, ValueError):
            errors.append("USAGE_ALERT_DAILY_GENERATIONS 必須是整數字串")

    if public and str(vars_section.get("TURNSTILE_REQUIRED", "")).lower() == "true":
        require(bool(str(vars_section.get("TURNSTILE_SITE_KEY", "")).strip()), "--public 模式啟用 Turnstile 時 TURNSTILE_SITE_KEY 不可空白", errors)

    checks.append("wrangler bindings OK")


def validate_package(root: Path, errors: list[str], checks: list[str]) -> None:
    package_path = root / "cloudflare" / "package.json"
    require(package_path.exists(), "缺少 cloudflare/package.json", errors)
    if not package_path.exists():
        return
    try:
        package = json.loads(read_text(package_path))
    except json.JSONDecodeError as exc:
        raise PreflightFailure(f"cloudflare/package.json 解析失敗：{exc}") from exc
    scripts = package.get("scripts") if isinstance(package, dict) else None
    require(isinstance(scripts, dict), "cloudflare/package.json 必須有 scripts", errors)
    scripts = scripts if isinstance(scripts, dict) else {}
    missing_scripts = sorted(REQUIRED_PACKAGE_SCRIPTS - set(scripts.keys()))
    require(not missing_scripts, "cloudflare package scripts 缺少：" + ", ".join(missing_scripts), errors)
    checks.append("cloudflare package scripts OK")


def validate_repo_hygiene(root: Path, errors: list[str], checks: list[str]) -> None:
    gitignore_path = root / ".gitignore"
    require(gitignore_path.exists(), "缺少 .gitignore", errors)
    gitignore = read_text(gitignore_path) if gitignore_path.exists() else ""
    for pattern in sorted(REQUIRED_GITIGNORE_PATTERNS):
        require(pattern in gitignore, f".gitignore 缺少 {pattern}", errors)
    require((root / "cloudflare" / "public" / "index.html").exists(), "缺少 cloudflare/public/index.html", errors)
    require((root / "cloudflare" / "src" / "index.js").exists(), "缺少 cloudflare/src/index.js", errors)
    checks.append("repo hygiene OK")


def validate_checklist(root: Path, public: bool, errors: list[str], checks: list[str]) -> None:
    checklist_path = root / "docs" / "deployment-checklist.md"
    require(checklist_path.exists(), "缺少 docs/deployment-checklist.md", errors)
    checklist = read_text(checklist_path) if checklist_path.exists() else ""
    for secret in sorted(REQUIRED_SECRET_NAMES):
        require(f"wrangler secret put {secret}" in checklist, f"deployment checklist 缺少 {secret} secret 指令", errors)
    for command in [
        "python scripts\\scan_public_secrets.py",
        "python scripts\\check_deployment_preflight.py",
        "python scripts\\check_deployment_preflight.py --public",
        "python scripts\\smoke_live_provider.py",
        "npm --prefix cloudflare run sync:check",
        "npm --prefix cloudflare run check:wrangler",
        "npm --prefix cloudflare run qa:network",
        "npm --prefix cloudflare run qa:mobile",
        "npm --prefix cloudflare run qa:a11y",
        "npm --prefix cloudflare run deploy:dry-run",
        "node scripts\\verify.mjs",
        "wrangler versions list",
        "wrangler versions view",
        "wrangler rollback",
    ]:
        require(command in checklist, "deployment checklist 缺少命令：" + command, errors)
    require("docs/release-acceptance-checklist.md" in checklist, "deployment checklist 必須連到 release acceptance checklist", errors)
    if public:
        require("TURNSTILE_REQUIRED = \"true\"" in checklist, "deployment checklist 必須要求公開站 TURNSTILE_REQUIRED=true", errors)
    checks.append("deployment checklist OK")


def validate_release_acceptance(root: Path, errors: list[str], checks: list[str]) -> None:
    checklist_path = root / "docs" / "release-acceptance-checklist.md"
    require(checklist_path.exists(), "缺少 docs/release-acceptance-checklist.md", errors)
    checklist = read_text(checklist_path) if checklist_path.exists() else ""
    for item in sorted(REQUIRED_RELEASE_ACCEPTANCE_ITEMS):
        require(item in checklist, "release acceptance checklist 缺少：" + item, errors)
    checks.append("release acceptance checklist OK")


def run(root: Path, public: bool) -> dict[str, Any]:
    errors: list[str] = []
    checks: list[str] = []
    validate_wrangler(root, public, errors, checks)
    validate_package(root, errors, checks)
    validate_repo_hygiene(root, errors, checks)
    validate_checklist(root, public, errors, checks)
    validate_release_acceptance(root, errors, checks)
    if errors:
        return {"status": "FAIL", "errors": errors, "checks": checks}
    return {"status": "PASS", "checks": checks, "publicMode": public}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check Cloudflare deployment wiring before publishing Fluxi.")
    parser.add_argument("--root", default=".", help="Repo root. Defaults to current directory.")
    parser.add_argument("--public", action="store_true", help="Require production-only public deployment vars such as Turnstile.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    root = Path(args.root).resolve()
    result = run(root, args.public)
    stream = sys.stdout if result["status"] == "PASS" else sys.stderr
    print(json.dumps(result, ensure_ascii=False, indent=2), file=stream)
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except PreflightFailure as exc:
        print(json.dumps({"status": "FAIL", "errors": [str(exc)]}, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(1)
