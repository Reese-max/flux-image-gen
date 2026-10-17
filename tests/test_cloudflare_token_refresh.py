"""Execute the workflow's refresh scripts with synthetic responses only."""

import json
import os
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy.yml"
SCRIPTS = [
    textwrap.dedent(block)
    for block in re.findall(
        r"      - name: Refresh Cloudflare Token\n"
        r"        id: cf_token\n"
        r"        run: \|\n((?:          [^\n]*\n)+)",
        WORKFLOW.read_text(encoding="utf-8"),
    )
]
assert len(SCRIPTS) == 2, "Expected the preview and production refresh scripts"

# Bash resolves this function before any curl executable. It never sends a
# request or reads credentials; only the supplied synthetic fixture is returned.
# jq delegates to the existing installed binary by absolute path. The shell's
# PATH contains only the empty temporary directory, preventing network fallback.
CURL_STUB = r"""
jq() {
  "$SYNTHETIC_JQ_EXEC" "$@"
}
curl() {
  printf 'synthetic call\n' >> "$SYNTHETIC_CALLS"
  local fail_http=0
  for arg in "$@"; do
    case "$arg" in --fail|-f) fail_http=1 ;; esac
  done
  if (( SYNTHETIC_CURL_EXIT != 0 )); then
    return "$SYNTHETIC_CURL_EXIT"
  fi
  if (( SYNTHETIC_HTTP_STATUS >= 400 && fail_http == 1 )); then
    return 22
  fi
  printf '%s' "$SYNTHETIC_BODY"
}
"""


@pytest.fixture(params=SCRIPTS, ids=["preview", "production"])
def refresh_script(request):
    script = request.param
    reference = "${{ secrets.CF_REFRESH_TOKEN }}"
    assert script.count(reference) == 1
    script = script.replace(reference, "synthetic-refresh-placeholder")
    assert "${{" not in script
    return script


def bash_path():
    # Avoid selecting the WSL launcher on Windows runners; this workflow itself
    # runs on Ubuntu, while the repository's pytest job also runs on Windows.
    git_bash = Path("C:/Program Files/Git/bin/bash.exe")
    if os.name == "nt" and git_bash.is_file():
        return str(git_bash)
    executable = shutil.which("bash")
    assert executable, "Workflow regression tests require Bash"
    return executable


def shell_environment():
    env = {"PATH": "", "LANG": "C.UTF-8"}
    if os.name == "nt":
        env["SystemRoot"] = os.environ.get("SystemRoot", "C:/Windows")
    return env


def run_refresh(tmp_path, script, body, http_status=200, curl_exit=0):
    jq_binary = shutil.which("jq")
    assert jq_binary, "Workflow regression tests require jq"
    output = tmp_path / "github-output.txt"
    calls = tmp_path / "synthetic-calls.txt"
    output.write_text("", encoding="utf-8")
    # Do not inherit environment credentials or shell startup hooks.
    env = shell_environment()
    env.update({
        "PATH": tmp_path.as_posix(),
        "GITHUB_OUTPUT": output.as_posix(),
        "SYNTHETIC_CALLS": calls.as_posix(),
        "SYNTHETIC_BODY": body,
        "SYNTHETIC_HTTP_STATUS": str(http_status),
        "SYNTHETIC_CURL_EXIT": str(curl_exit),
        "SYNTHETIC_JQ_EXEC": Path(jq_binary).as_posix(),
    })
    result = subprocess.run(
        [bash_path(), "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", CURL_STUB + script],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert calls.read_text(encoding="utf-8").splitlines() == ["synthetic call"]
    return result, output.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    "token",
    ["synthetic-opaque-token", "synthetic.jwt.payload", "synthetic_._~+/=="],
)
def test_valid_response_is_forwarded(tmp_path, refresh_script, token):
    result, output = run_refresh(tmp_path, refresh_script, json.dumps({"access_token": token}))
    assert result.returncode == 0, result.stderr
    assert output == f"token={token}\n"
    assert result.stdout == f"::add-mask::{token}\n"
    assert result.stderr == ""


@pytest.mark.parametrize(
    "body",
    [
        '{"error":"invalid_grant","error_description":"synthetic-response-marker"}',
        "{}",
        '{"access_token":null}',
        '{"access_token":""}',
        '{"access_token":123}',
        '{"access_token":true}',
        '{"access_token":{}}',
        '{"access_token":[]}',
        "[]",
        "synthetic-response-marker-not-json",
        '{"access_token":"synthetic-response-marker with spaces"}',
        '{"access_token":"synthetic-response-marker\\nwrong_key=value"}',
        '{"access_token":"synthetic-response-marker\\r"}',
        '{"access_token":"synthetic-response-marker\\n"}',
        '{"error":"invalid_grant","access_token":"synthetic-response-marker"}',
        '{"access_token":"synthetic-first"}\n{"access_token":"synthetic-response-marker"}',
    ],
    ids=[
        "oauth-error", "missing", "null", "empty", "number", "boolean", "object", "array",
        "non-object-response", "invalid-json", "space", "output-injection", "carriage-return",
        "trailing-newline", "error-with-token", "multiple-json-values",
    ],
)
def test_invalid_response_cannot_produce_token_output(tmp_path, refresh_script, body):
    result, output = run_refresh(tmp_path, refresh_script, body)
    assert result.returncode != 0, "Invalid OAuth response passed the refresh step"
    assert output == ""
    assert "::add-mask::" not in result.stdout
    assert "synthetic-response-marker" not in result.stdout + result.stderr


@pytest.mark.parametrize("http_status", [400, 401, 500])
def test_http_failure_cannot_forward_even_a_token_field(tmp_path, refresh_script, http_status):
    body = '{"access_token":"synthetic-response-marker"}'
    result, output = run_refresh(tmp_path, refresh_script, body, http_status=http_status)
    assert result.returncode != 0, "Non-success HTTP response passed the refresh step"
    assert output == ""
    assert "::add-mask::" not in result.stdout
    assert "synthetic-response-marker" not in result.stdout + result.stderr


def test_transport_failure_produces_no_token_output(tmp_path, refresh_script):
    result, output = run_refresh(tmp_path, refresh_script, "synthetic-response-marker", curl_exit=7)
    assert result.returncode != 0
    assert output == ""
    assert "::add-mask::" not in result.stdout
    assert "synthetic-response-marker" not in result.stdout + result.stderr


def test_refresh_shell_syntax(refresh_script):
    result = subprocess.run(
        [bash_path(), "--noprofile", "--norc", "-n"],
        input=refresh_script,
        capture_output=True,
        text=True,
        env=shell_environment(),
        check=False,
    )
    assert result.returncode == 0, result.stderr
