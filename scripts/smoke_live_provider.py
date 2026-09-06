#!/usr/bin/env python3
"""Deployment smoke test for Fluxi health/generation consistency.

Default mode only checks /api/health and does not call paid model providers.
Use --check-generate together with --confirm-cost when you intentionally want
one live generation request against a deployed site.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

VALID_PROVIDER_STATUS = {"checking", "demo", "ready", "degraded", "offline", "error"}
VALID_MODES = {"demo", "live"}
SAFE_PROMPT = "一隻柴犬在月球吃拉麵，PPT 插圖，明亮背景"
PROVIDER_PROMPT = "A shiba inu eating ramen on the moon, bright presentation illustration, clean composition"
USER_AGENT = "Fluxi-Deployment-Smoke/1.0"


class SmokeFailure(RuntimeError):
    pass


@dataclass
class HttpResult:
    status: int
    body: dict[str, Any]
    raw: str


def normalize_base_url(value: str) -> str:
    base = (value or "").strip().rstrip("/")
    if not base:
        raise SmokeFailure("請提供 --base-url，例如 https://example.workers.dev")
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SmokeFailure("--base-url 必須是 http(s) URL")
    return base


def read_json(url: str, *, method: str = "GET", payload: dict[str, Any] | None = None, timeout: float = 20.0) -> HttpResult:
    body_bytes = None
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if payload is not None:
        body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body_bytes, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            status = int(response.status)
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        status = int(error.code)
    except urllib.error.URLError as error:
        raise SmokeFailure(f"連線失敗：{error.reason}") from error
    except TimeoutError as error:
        raise SmokeFailure("連線逾時") from error

    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError as error:
        raise SmokeFailure(f"回應不是 JSON：HTTP {status} {raw[:160]}") from error
    if not isinstance(data, dict):
        raise SmokeFailure(f"回應 JSON 不是 object：HTTP {status}")
    return HttpResult(status=status, body=data, raw=raw)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def validate_health(data: dict[str, Any], expect_mode: str) -> list[str]:
    checks: list[str] = []
    provider_status = data.get("providerStatus")
    mode = data.get("mode")
    providers = data.get("providers")

    require(provider_status in VALID_PROVIDER_STATUS, f"providerStatus 不合法：{provider_status!r}")
    require(mode in VALID_MODES, f"mode 不合法：{mode!r}")
    require(isinstance(providers, dict), "providers 必須是 object")
    require(isinstance(data.get("hasApiKey"), bool), "hasApiKey 必須是 boolean")
    require(isinstance(data.get("storageAvailable"), bool), "storageAvailable 必須是 boolean")
    require(isinstance(data.get("message"), str) and data.get("message"), "message 必須是非空字串")
    require(isinstance(data.get("checkedAt"), str) and data.get("checkedAt"), "checkedAt 必須是非空字串")

    if expect_mode != "any":
        require(mode == expect_mode, f"mode 預期 {expect_mode}，實際 {mode}")
    if mode == "demo":
        require(provider_status == "demo", f"Demo mode 不應回 {provider_status}")
        require(data.get("hasApiKey") is False, "Demo mode 不應宣告 hasApiKey=true")
        require("Demo" in data.get("message", "") or "demo" in data.get("message", "").lower(), "Demo mode message 應明確告知 Demo")
    if mode == "live":
        require(provider_status in {"ready", "degraded"}, f"Live mode providerStatus 應是 ready/degraded，實際 {provider_status}")
        require(data.get("hasApiKey") is True, "Live mode 應宣告 hasApiKey=true")
        require("Demo" not in data.get("message", ""), "Live mode message 不可同時顯示 Demo")

    checks.append(f"health schema OK（mode={mode}, providerStatus={provider_status}）")
    checks.append(f"health message：{data.get('message')}")
    return checks


def turnstile_required(health: dict[str, Any]) -> bool:
    turnstile = health.get("turnstile")
    return isinstance(turnstile, dict) and bool(turnstile.get("required"))


def build_generate_payload(token: str) -> dict[str, Any]:
    payload = {
        "prompt": PROVIDER_PROMPT,
        "userPrompt": SAFE_PROMPT,
        "model": "schnell",
        "size": "ppt_16_9",
        "seed": 0,
        "visionQa": False,
    }
    if token:
        payload["turnstileToken"] = token
    return payload


def validate_generate_result(result: HttpResult, health: dict[str, Any], *, expect_mode: str) -> list[str]:
    checks: list[str] = []
    mode = str(health.get("mode"))
    if result.status >= 400:
        raise SmokeFailure(f"/generate 失敗：HTTP {result.status} {result.body.get('code') or result.body.get('error')}")
    image = result.body.get("image")
    provider = result.body.get("provider")
    require(isinstance(image, str) and (image.startswith("data:image/") or image.startswith("https://") or image.startswith("http://")), "generate 回應缺少有效 image")
    require(isinstance(provider, str) and provider, "generate 回應缺少 provider")
    require("api_key" not in result.raw.lower(), "generate 回應疑似洩漏 api_key 字樣")

    if expect_mode == "live" or mode == "live":
        require(provider != "demo", "health 宣告 live，但 /generate 回 demo provider")
    if expect_mode == "demo" or mode == "demo":
        require(provider == "demo", f"health 宣告 demo，但 /generate 回 {provider}")

    checks.append(f"generate consistency OK（provider={provider}, model={result.body.get('model', 'unknown')}）")
    return checks


def verify_turnstile_gate(base_url: str, timeout: float) -> list[str]:
    result = read_json(base_url + "/generate", method="POST", payload=build_generate_payload(""), timeout=timeout)
    code = result.body.get("code")
    require(result.status == 403 and code == "turnstile_required", f"Turnstile gate 預期 403 turnstile_required，實際 HTTP {result.status} {code}")
    return ["turnstile gate OK（未提供 token 時不呼叫模型）"]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fluxi deployment smoke test for /api/health and optional /generate consistency.")
    parser.add_argument("--base-url", required=True, help="部署網址，例如 https://fluxi.example.com")
    parser.add_argument("--expect-mode", choices=["any", "demo", "live"], default="any", help="預期 health mode；預設只驗 schema 與一致性")
    parser.add_argument("--check-generate", action="store_true", help="額外呼叫 /generate；live mode 需要 --confirm-cost")
    parser.add_argument("--confirm-cost", action="store_true", help="確認這次 smoke 允許花一次 live provider 成本")
    parser.add_argument("--turnstile-token", default="", help="Turnstile token；不會被輸出到 log")
    parser.add_argument("--timeout", type=float, default=30.0, help="單次 HTTP timeout 秒數")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    started = time.time()
    base_url = normalize_base_url(args.base_url)
    checks: list[str] = []

    health_result = read_json(base_url + "/api/health", timeout=args.timeout)
    require(health_result.status == 200, f"/api/health 預期 HTTP 200，實際 {health_result.status}")
    checks.extend(validate_health(health_result.body, args.expect_mode))

    if args.check_generate:
        if turnstile_required(health_result.body) and not args.turnstile_token:
            checks.extend(verify_turnstile_gate(base_url, args.timeout))
        else:
            if health_result.body.get("mode") == "live" and not args.confirm_cost:
                raise SmokeFailure("health 顯示 live；若要實際呼叫 /generate，請明確加 --confirm-cost 以避免意外花費")
            generate_result = read_json(base_url + "/generate", method="POST", payload=build_generate_payload(args.turnstile_token), timeout=args.timeout)
            checks.extend(validate_generate_result(generate_result, health_result.body, expect_mode=args.expect_mode))

    print(json.dumps({
        "status": "PASS",
        "baseUrl": base_url,
        "checks": checks,
        "elapsedMs": round((time.time() - started) * 1000),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SmokeFailure as error:
        print(json.dumps({"status": "FAIL", "error": str(error)}, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(1)
