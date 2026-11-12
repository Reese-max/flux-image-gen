"""Shared pytest configuration.

Some workflow regression tests resolve POSIX tools (``mktemp``, ``rm``) with
``shutil.which`` before handing absolute paths to Git Bash. On Windows those
tools live next to Git Bash but are not always on the parent process PATH, so
make them discoverable without changing the tests themselves.
"""

import os
from pathlib import Path


def _prepend_git_tools_to_path():
    if os.name != "nt":
        return
    git_bash = Path("C:/Program Files/Git/bin/bash.exe")
    if not git_bash.is_file():
        return
    candidates = [
        git_bash.parent,  # bash.exe, sh.exe
        git_bash.parent.parent / "usr" / "bin",  # mktemp.exe, rm.exe
    ]
    current = [part for part in os.environ.get("PATH", "").split(os.pathsep) if part]
    merged = []
    for entry in [str(path) for path in candidates] + current:
        if entry not in merged:
            merged.append(entry)
    os.environ["PATH"] = os.pathsep.join(merged)


_prepend_git_tools_to_path()


# Shared pytest setup for the offline suite.
#
# ``app.settings.Settings`` binds its field defaults from ``os.environ`` at class
# definition time (i.e. on first import). Tests must never reach the real MiniMax,
# NVIDIA, or Cloudflare endpoints just because a developer has provider keys in
# their shell, so clear every env var that selects/configures a real image
# provider *before* any test module imports ``app.settings`` — pytest loads this
# conftest first. Tests that exercise a provider stub the HTTP layer and pass
# explicit kwargs such as ``Settings(minimax_api_key=FAKE_KEY)``.
for _var in (
    "NVIDIA_API_KEY",
    "MINIMAX_API_KEY",
    "CF_ACCOUNT_ID",
    "CF_API_TOKEN",
    "IMAGE_PROVIDER",
    "POLLINATIONS_FALLBACK_ENABLED",
):
    os.environ.pop(_var, None)
