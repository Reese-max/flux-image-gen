import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "smoke_live_provider.py"
TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="


def run_server(health, generate_status=200, generate_body=None):
    state = {"generate_count": 0, "last_generate_payload": None, "last_user_agent": None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def _json(self, status, payload):
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            state["last_user_agent"] = self.headers.get("user-agent")
            if self.path == "/api/health":
                self._json(200, health)
                return
            self._json(404, {"error": "not found"})

        def do_POST(self):
            state["last_user_agent"] = self.headers.get("user-agent")
            if self.path == "/generate":
                state["generate_count"] += 1
                length = int(self.headers.get("content-length") or "0")
                raw = self.rfile.read(length).decode("utf-8") if length else "{}"
                state["last_generate_payload"] = json.loads(raw)
                self._json(generate_status, generate_body or {"image": TINY_PNG, "provider": "demo", "model": "schnell"})
                return
            self._json(404, {"error": "not found"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    return server, base_url, state


def run_smoke(base_url, *args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--base-url", base_url, *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )


def health_payload(mode="demo", provider_status="demo", has_key=False, turnstile_required=False):
    return {
        "providerStatus": provider_status,
        "mode": mode,
        "providers": {"nvidia": has_key, "workersAI": False, "modal": False},
        "hasApiKey": has_key,
        "storageAvailable": True,
        "message": "Demo 模式，不會真實出圖" if mode == "demo" else "部分服務可用",
        "checkedAt": "2026-07-07T00:00:00Z",
        "turnstile": {"required": turnstile_required, "siteKey": "1x00000000000000000000AA" if turnstile_required else ""},
    }


def test_health_smoke_does_not_call_generate_by_default():
    server, base_url, state = run_server(health_payload())
    try:
        result = run_smoke(base_url, "--expect-mode", "demo")
    finally:
        server.shutdown()
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "PASS"
    assert "health schema OK" in payload["checks"][0]
    assert state["generate_count"] == 0
    assert state["last_user_agent"] == "Fluxi-Deployment-Smoke/1.0"


def test_live_generate_requires_explicit_cost_confirmation():
    server, base_url, state = run_server(health_payload(mode="live", provider_status="degraded", has_key=True))
    try:
        result = run_smoke(base_url, "--expect-mode", "live", "--check-generate")
    finally:
        server.shutdown()
    assert result.returncode == 1
    assert "--confirm-cost" in result.stderr
    assert state["generate_count"] == 0


def test_turnstile_required_smoke_checks_gate_without_cost():
    server, base_url, state = run_server(
        health_payload(mode="live", provider_status="degraded", has_key=True, turnstile_required=True),
        generate_status=403,
        generate_body={"error": "請先完成真人驗證", "code": "turnstile_required"},
    )
    try:
        result = run_smoke(base_url, "--expect-mode", "live", "--check-generate")
    finally:
        server.shutdown()
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert "turnstile gate OK（未提供 token 時不呼叫模型）" in payload["checks"]
    assert state["generate_count"] == 1
    assert "turnstileToken" not in state["last_generate_payload"]


def test_live_generate_with_confirmation_rejects_demo_provider():
    server, base_url, state = run_server(
        health_payload(mode="live", provider_status="degraded", has_key=True),
        generate_status=200,
        generate_body={"image": TINY_PNG, "provider": "demo", "model": "schnell"},
    )
    try:
        result = run_smoke(base_url, "--expect-mode", "live", "--check-generate", "--confirm-cost")
    finally:
        server.shutdown()
    assert result.returncode == 1
    assert "health 宣告 live" in result.stderr
    assert state["generate_count"] == 1


def test_live_generate_with_confirmation_accepts_live_provider():
    server, base_url, state = run_server(
        health_payload(mode="live", provider_status="degraded", has_key=True),
        generate_status=200,
        generate_body={"image": TINY_PNG, "provider": "nvidia", "model": "schnell"},
    )
    try:
        result = run_smoke(base_url, "--expect-mode", "live", "--check-generate", "--confirm-cost")
    finally:
        server.shutdown()
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert "generate consistency OK（provider=nvidia, model=schnell）" in payload["checks"]
    assert state["generate_count"] == 1
