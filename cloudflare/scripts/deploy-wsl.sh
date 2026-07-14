#!/bin/bash
# WSL fallback for the Windows Node 25 native Wrangler crash.
#
# This path deliberately uses the same wrangler.toml and source entrypoint as
# the normal deploy. It never deploys a pre-built, git-ignored dist bundle.
#
# Usage (from Windows):
#   wsl.exe -d Ubuntu -u root -- bash -lc 'bash "/mnt/d/Users/Administrator/Desktop/圖片生成/cloudflare/scripts/deploy-wsl.sh"'

set -euo pipefail

WRANGLER_VERSION="4.104.0"
PROJ="/mnt/d/Users/Administrator/Desktop/圖片生成/cloudflare"
REPO="$(dirname "$PROJ")"
WIN_REPO="$(wslpath -w "$REPO")"
WIN_CREDS="/mnt/c/Users/Administrator/.wrangler/config/default.toml"
WSL_CREDS="$HOME/.wrangler/config/default.toml"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
case "$NODE_MAJOR" in
  20|22) ;;
  *)
    echo "[deploy-wsl] Node 20 or 22 LTS is required; found Node $NODE_MAJOR." >&2
    exit 1
    ;;
esac

# Run the exact same full gate as the Windows wrapper, then enforce the public
# Turnstile preflight. This intentionally blocks deployment until the real
# widget/site key and TURNSTILE_SECRET_KEY exist.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \
  "\$ErrorActionPreference='Stop'; Set-Location -LiteralPath '$WIN_REPO'; node scripts\\verify.mjs; if (\$LASTEXITCODE -ne 0) { exit \$LASTEXITCODE }; python scripts\\check_deployment_preflight.py --public; exit \$LASTEXITCODE"

if [[ ! -f "$WIN_CREDS" ]]; then
  echo "[deploy-wsl] Windows Wrangler OAuth credentials were not found: $WIN_CREDS" >&2
  exit 1
fi

unset CLOUDFLARE_API_TOKEN 2>/dev/null || true
install -d -m 700 "$(dirname "$WSL_CREDS")"
ORIGINAL_WSL_CREDS=""
WSL_CREDS_EXISTED=no
BORROWED_WSL_CREDS_READY=no
if [[ -f "$WSL_CREDS" ]]; then
  WSL_CREDS_EXISTED=yes
  ORIGINAL_WSL_CREDS="$(mktemp)"
  cp -p "$WSL_CREDS" "$ORIGINAL_WSL_CREDS"
fi

# Sync a refreshed borrowed token on every exit, including readiness failures.
# The shared Windows file is backed up once per day before any overwrite.
sync_windows_credentials() {
  if [[ "$BORROWED_WSL_CREDS_READY" != yes || ! -f "$WSL_CREDS" ]] || cmp -s "$WSL_CREDS" "$WIN_CREDS"; then
    return 0
  fi

  local backup="${WIN_CREDS}.bak-$(date +%Y%m%d)"
  if [[ ! -e "$backup" ]]; then
    cp "$WIN_CREDS" "$backup" || return 1
    echo "TOKEN_BACKUP_CREATED=$backup"
  fi
  cp "$WSL_CREDS" "$WIN_CREDS" || return 1
  echo "TOKEN_SYNCED_BACK=yes"
}

restore_wsl_credentials() {
  if [[ "$WSL_CREDS_EXISTED" == yes && -f "$ORIGINAL_WSL_CREDS" ]]; then
    cp -p "$ORIGINAL_WSL_CREDS" "$WSL_CREDS" || return 1
    rm -f "$ORIGINAL_WSL_CREDS" || return 1
  else
    rm -f "$WSL_CREDS" || return 1
  fi
}

# The Windows OAuth file is borrowed only for this deploy. On every exit, sync
# any refresh first, then restore the user's original WSL login (or remove the
# borrowed file when no WSL credentials existed before this script started).
cleanup_credentials() {
  local command_exit=$?
  local cleanup_exit=0
  local restore_exit=0
  set +e
  sync_windows_credentials || cleanup_exit=$?
  restore_wsl_credentials
  restore_exit=$?
  if [[ "$cleanup_exit" -eq 0 && "$restore_exit" -ne 0 ]]; then
    cleanup_exit=$restore_exit
  fi
  trap - EXIT
  if [[ "$command_exit" -ne 0 ]]; then
    exit "$command_exit"
  fi
  exit "$cleanup_exit"
}
trap cleanup_credentials EXIT
install -m 600 "$WIN_CREDS" "$WSL_CREDS"
BORROWED_WSL_CREDS_READY=yes

# Fail before resolving a version tag or uploading unless the shared repo is
# clean and Wrangler confirms every required production secret name exists.
node "$PROJ/scripts/check-deploy-readiness.mjs" \
  --wrangler-npx-version "$WRANGLER_VERSION"

GIT_COMMIT="$(powershell.exe -NoProfile -NonInteractive -Command "Set-Location -LiteralPath '$WIN_REPO'; git rev-parse HEAD; exit \$LASTEXITCODE" | tr -d '\r\n')"

cd "$PROJ"
set +e
npx --yes "wrangler@$WRANGLER_VERSION" deploy \
  --config "$PROJ/wrangler.toml" \
  --tag "git-${GIT_COMMIT:0:12}" \
  --message "commit $GIT_COMMIT" \
  </dev/null 2>&1
WRANGLER_EXIT=$?
set -e

echo "WRANGLER_EXIT=$WRANGLER_EXIT"
exit "$WRANGLER_EXIT"
