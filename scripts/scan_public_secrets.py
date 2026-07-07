"""Scan public bundles and deployable source for leaked provider secrets.

This is an offline deployment gate. It intentionally scans public assets and
repo files that can be committed or shipped, but it does not read local `.env`
or `.dev.vars` files because those may legitimately contain developer secrets.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]

TEXT_SUFFIXES = {
    ".cjs",
    ".css",
    ".html",
    ".js",
    ".json",
    ".jsonc",
    ".md",
    ".mjs",
    ".py",
    ".toml",
    ".txt",
    ".webmanifest",
    ".yml",
    ".yaml",
}

SCAN_PATHS = [
    "README.md",
    ".env.example",
    "app",
    "cloudflare/public",
    "cloudflare/src",
    "cloudflare/wrangler.toml",
    "scripts",
]

SKIP_DIRS = {
    ".git",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
}

SECRET_SHAPES = [
    ("openai_api_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    ("gemini_or_google_api_key", re.compile(r"\bAIza[A-Za-z0-9_-]{25,}\b")),
    ("nvidia_api_key", re.compile(r"\bnvapi-[A-Za-z0-9_-]{20,}\b", re.IGNORECASE)),
    ("huggingface_token", re.compile(r"\bhf_[A-Za-z0-9]{30,}\b")),
    ("github_token", re.compile(r"\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
]

SENSITIVE_ASSIGNMENT = re.compile(
    r"\b(?:NVIDIA_API_KEY|GEMINI_API_KEY|TURNSTILE_SECRET_KEY|GALLERY_ADMIN_TOKEN)\b"
    r"\s*[:=]\s*['\"](?P<value>[^'\"]{8,})['\"]",
    re.IGNORECASE,
)

SAFE_ASSIGNMENT_VALUE = re.compile(
    r"^(?:"
    r"CHANGE_ME|REPLACE_ME|REPLACE_WITH_|YOUR_|your-|example|dummy|placeholder|"
    r"<[^>]+>|\$\{[^}]+\}|true|false|0|1"
    r")",
    re.IGNORECASE,
)

FORBIDDEN_LOCAL_STORAGE = re.compile(
    r"localStorage\s*\.\s*(?:setItem|getItem)\s*\(\s*['\"](?:GALLERY_ADMIN_TOKEN|NVIDIA_API_KEY|GEMINI_API_KEY|TURNSTILE_SECRET_KEY)['\"]",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    kind: str
    detail: str

    def format(self, root: Path) -> str:
        try:
            display = self.path.relative_to(root)
        except ValueError:
            display = self.path
        return f"{display}:{self.line}: {self.kind}: {self.detail}"


def is_text_file(path: Path) -> bool:
    return path.suffix.lower() in TEXT_SUFFIXES


def iter_scan_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for relative in SCAN_PATHS:
        target = root / relative
        if not target.exists():
            continue
        if target.is_file():
            if is_text_file(target):
                files.append(target)
            continue
        for path in target.rglob("*"):
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            if path.is_file() and is_text_file(path):
                files.append(path)
    return sorted(set(files))


def safe_excerpt(value: str) -> str:
    if len(value) <= 8:
        return "<redacted>"
    return value[:4] + "…" + value[-4:]


def scan_text(path: Path, text: str) -> list[Finding]:
    findings: list[Finding] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for kind, pattern in SECRET_SHAPES:
            match = pattern.search(line)
            if match:
                findings.append(Finding(path, line_number, kind, safe_excerpt(match.group(0))))
        assignment = SENSITIVE_ASSIGNMENT.search(line)
        if assignment and not SAFE_ASSIGNMENT_VALUE.search(assignment.group("value").strip()):
            findings.append(
                Finding(path, line_number, "sensitive_assignment", "secret-like value assigned to a protected key")
            )
        if FORBIDDEN_LOCAL_STORAGE.search(line):
            findings.append(
                Finding(path, line_number, "sensitive_local_storage", "protected token must not be persisted")
            )
    return findings


def scan_root(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for path in iter_scan_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = path.read_text(encoding="utf-8", errors="ignore")
        findings.extend(scan_text(path, text))
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scan deployable files for leaked secrets.")
    parser.add_argument("--root", default=str(ROOT_DIR), help="Repository root to scan")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    findings = scan_root(root)
    if findings:
        print("[secret-scan] Potential secret exposure detected:", file=sys.stderr)
        for finding in findings:
            print("  " + finding.format(root), file=sys.stderr)
        return 1
    print(f"[secret-scan] OK: scanned {len(iter_scan_files(root))} deployable text files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
