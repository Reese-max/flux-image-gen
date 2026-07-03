#!/bin/bash
# WSL wrangler deploy workaround.
#
# Why: on this machine's Node 25, native Windows `wrangler deploy` crashes
# silently after the banner (Git Bash exit 127 / PowerShell 0xC0000409).
# Workaround: esbuild pre-bundles the worker on Windows, then this script runs
# wrangler from WSL's LTS Node against the pre-built bundle.
#
# Usage (from Windows, in cloudflare/):
#   npx esbuild src/index.js --bundle --format=esm --platform=neutral --outfile=dist/_worker.bundle.js
#   wsl.exe -d Ubuntu -u root -- bash -lc 'bash "/mnt/d/Users/Administrator/Desktop/圖片生成/cloudflare/scripts/deploy-wsl.sh"'
#
# Auth: copies the Windows wrangler OAuth credentials (with refresh_token) into
# WSL so wrangler can refresh an expired oauth_token itself, then syncs any
# refreshed token back. CLOUDFLARE_API_TOKEN must NOT be set or it would
# override the OAuth flow.
#
# Judge success by the output markers (Uploaded / Deployed / Current Version ID),
# not the exit code.
set -u
unset CLOUDFLARE_API_TOKEN 2>/dev/null
WIN_CREDS="/mnt/c/Users/Administrator/.wrangler/config/default.toml"
mkdir -p ~/.wrangler/config
cp "$WIN_CREDS" ~/.wrangler/config/default.toml
cd ~
PROJ="/mnt/d/Users/Administrator/Desktop/圖片生成/cloudflare"
npx -y wrangler@4 deploy "$PROJ/dist/_worker.bundle.js" \
  --no-bundle \
  --config "$PROJ/wrangler.deploy.toml" \
  </dev/null 2>&1
echo "WRANGLER_EXIT=$?"
if ! cmp -s ~/.wrangler/config/default.toml "$WIN_CREDS"; then
  cp ~/.wrangler/config/default.toml "$WIN_CREDS"
  echo "TOKEN_SYNCED_BACK=yes"
fi
