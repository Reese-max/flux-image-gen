# Fluxi 公開部署前 Checklist

這份清單用於把本機 Demo／Cloudflare 預覽升級成可公開使用的產品站。每次上線前請逐項確認；不要把任何 secret 寫進前端 bundle、公開 repo 或 `wrangler.toml [vars]`。

> 正式公開前還需要完成 `docs/release-acceptance-checklist.md`；該文件把真實網域、真機、Vision QA、R2 gallery save、分享隱私、Turnstile / Rate limit、成本、隱私政策、授權與商用說明等人工簽核項目列成 Release blocker。

## 1. 必要 secrets

在 `cloudflare/` 目錄執行：

```powershell
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put GALLERY_TOKEN_SECRET
npx wrangler secret put GALLERY_ADMIN_TOKEN
```

- `NVIDIA_API_KEY`：供 FLUX live 出圖使用。
- `GEMINI_API_KEY`：供中文 prompt 補全／轉換／強化使用；若 `VISION_QA_ENABLED="true"`，也會用於智慧體視覺 QA。
- `GEMINI_VISION_MODEL` / `VISION_QA_ENABLED`：公開站預設可先維持 `VISION_QA_ENABLED="false"` 控制成本；開啟前需確認每日預算與用量告警。
- `TURNSTILE_SECRET_KEY`：後端驗證人機 token；驗證失敗不得呼叫模型。
- `GALLERY_TOKEN_SECRET`：簽發短效雲端儲存 token；未設定時 `/gallery` 會拒絕寫入，因此公開站不得省略。
- `GALLERY_ADMIN_TOKEN`：站長雲端圖庫 `GET /api/gallery` 使用；前端只由站長手動輸入並送 `X-Gallery-Admin-Token`，不可持久化到 `localStorage`。

正式 deploy 會透過專案鎖定的 Wrangler 唯讀執行 `secret list --format json`，並要求上述五個名稱全部存在。檢查只解析與輸出 secret 名稱，不讀取或顯示 secret 值；缺少任一名稱即在上傳前停止。

## 2. Public vars 與 Worker binding

確認 `cloudflare/wrangler.toml`：

- `[assets]` 指向 `./public`，確保 SPA 與 `/static/*` 由 Worker assets 服務。
- `[ai] binding = "AI"` 已存在，供 Workers AI FLUX.2 klein 快速模型與 AI 改圖使用。
- `[[r2_buckets]] binding = "IMAGE_BUCKET"` 已存在，bucket 名稱為 `flux-image-gallery` 或正式環境指定名稱。
- `[[ratelimits]] name = "GENERATE_RATE_LIMITER"` 已存在，公開站必須保留後端硬限制。
- `TURNSTILE_REQUIRED = "true"`、`TURNSTILE_SITE_KEY` 填入公開 site key；只有本機或內部預覽可暫時維持 `false`。
- `USAGE_ESTIMATED_COST_USD_PER_IMAGE`、`USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST` 與 `USAGE_ALERT_DAILY_GENERATIONS` 已設定；prompt／Vision 單價未校準時維持 `0`，但 Provider 嘗試仍會持久記錄，不得誤稱為完整成本。
- `[version_metadata] binding = "CF_VERSION_METADATA"` 已存在，讓 health／記錄可對應 Cloudflare Version ID。
- `[observability]` 與 `[observability.logs]` 已啟用，並使用明確取樣率控制記錄量。
- 部署設定只有 `cloudflare/wrangler.toml`；不得恢復 `wrangler.deploy.toml` 或部署被 Git 忽略的 `dist/_worker.bundle.js`。

## 3. 安全與隱私檢查

- 前端 bundle 不得包含 `NVIDIA_API_KEY`、`GEMINI_API_KEY`、`TURNSTILE_SECRET_KEY`、`GALLERY_ADMIN_TOKEN`。
- `/api/health` 只能回公開 site key 與服務狀態，不得回 secret。
- `/api/gallery` 必須要求 `X-Gallery-Admin-Token`，且回應不得包含 `deleteTokenHash`、刪除 token 或未公開完整 prompt。
- 雲端保存預設 `promptPublic=false`；分享頁預設隱藏完整 prompt。
- Moderation 擋下高風險 prompt 後，不可把敏感全文寫入錯誤訊息或用量 log。
- 用量 Dashboard 只顯示聚合資料；不得保存 prompt、圖片內容或原始 IP。

## 4. 上線前驗證命令

從 repo 根目錄執行：

```powershell
python scripts\scan_public_secrets.py
python scripts\check_deployment_preflight.py
python scripts\smoke_live_provider.py --base-url https://<your-domain> --expect-mode live
python -m pytest tests/test_app.py -q
python -m pytest tests/test_static_ui.py -q
npm --prefix cloudflare run sync:check
npm --prefix cloudflare run check:wrangler
npm --prefix cloudflare run check
npm --prefix cloudflare test
npm --prefix cloudflare run qa:network
npm --prefix cloudflare run qa:mobile
npm --prefix cloudflare run qa:a11y
npm --prefix cloudflare run deploy:dry-run
node scripts\verify.mjs
node cloudflare\scripts\check-deploy-readiness.mjs
```

`deploy:dry-run` 必須看到 wrapper 印出 `Wrangler dry-run output verified.`，代表 Wrangler 已跑到 `--dry-run: exiting now.` 與 assets directory 摘要；若只看到 telemetry banner 或缺少 success markers，視為未完成部署預演。

`npm run deploy` 與 `npm run deploy:dry-run` 都會先執行 `node scripts\verify.mjs`；正式 deploy 還會強制執行 `python scripts\check_deployment_preflight.py --public` 與 `check-deploy-readiness.mjs`。後者要求 Git worktree 完全乾淨（包含 staged、unstaged 與 untracked 檔案），再唯讀確認 production secrets，通過後才取得 HEAD 作為 tag／message；因此版本中繼資料一定對應實際上傳的已提交內容。Wrapper 固定部署 `wrangler.toml` 的 `flux-image-gen` production 與 `src/index.js`，外部唯一允許的參數是 `--dry-run`；`--env`、`--name`、`--config`、`--profile`、自訂 entrypoint、`--tag`、`--message` 等覆寫一律拒絕。不得以直接呼叫 `wrangler deploy` 規避 gate。

`check:wrangler` 會先跑 `wrangler whoami`，再跑 `wrangler deploy --dry-run` 做登入與部署設定診斷；預設不輸出帳號 email / account id / token。若失敗，先處理 `npx wrangler login`、`CLOUDFLARE_API_TOKEN`、帳號權限、R2 bucket、AI binding 或 rate limit binding；需要更多診斷時可用 `npm --prefix cloudflare run check:wrangler -- --verbose`，輸出仍會遮罩敏感資訊。

若 `check:wrangler` 回報 Wrangler / Node 子程序 crash，優先切到 Node 20 或 22 LTS 再重跑；Node 25 曾在 Windows 上讓 Wrangler 4.106 的 `deploy --dry-run` 只印 banner 後非正常結束。

公開正式部署前，請在設定好 `TURNSTILE_REQUIRED = "true"` 與 `TURNSTILE_SITE_KEY` 後再跑嚴格模式：

```powershell
python scripts\check_deployment_preflight.py --public
```

同時逐項完成 `docs/release-acceptance-checklist.md` 的 Release blocker；未完成前只能做內部預覽，不應公開站點。

若有改 `app/static/*`，先執行：

```powershell
npm --prefix cloudflare run sync
```

## 5. 部署與上線後 smoke test

部署：

```powershell
cd cloudflare
npm run deploy
```

Windows Node 25 若仍發生原生 Wrangler crash，可改用固定 Wrangler `4.104.0` 的 WSL fallback；它使用相同的 `wrangler.toml` 與 `src/index.js`，不再接受預先 bundle：

```powershell
wsl.exe -d Ubuntu -u root -- bash -lc 'bash "/mnt/d/Users/Administrator/Desktop/圖片生成/cloudflare/scripts/deploy-wsl.sh"'
```

WSL 必須使用 Node 20 或 22 LTS。腳本會先在 Windows 跑完整 verify 與 public preflight，再用相同 readiness helper 檢查乾淨 worktree 與 production secret 名稱；任一失敗即停止。為 Wrangler 借用的 Windows OAuth 檔案會在結束時還原原有 WSL 登入；即使 readiness／deploy 失敗，只要 refresh token 已更新，EXIT cleanup 仍會先建立同日不覆寫的 `default.toml.bak-YYYYMMDD` 並同步回 Windows，再還原 WSL 憑證。

部署後請用正式網址人工檢查：

- `python scripts\smoke_live_provider.py --base-url https://<your-domain> --expect-mode live`：檢查 `/api/health` schema、ProviderStatus、Demo/Live 文案一致性。
- 若要實際打一張 live 圖，需明確執行 `python scripts\smoke_live_provider.py --base-url https://<your-domain> --expect-mode live --check-generate --confirm-cost`；公開站 Turnstile 開啟時需另帶合法 token，否則 smoke 只驗證 gate 會擋下模型呼叫。
- `GET /health`：狀態不可同時顯示 Demo 與真實出圖；未設定金鑰時應是 Demo／不可用。
- 首頁：只輸入中文即可生成；進階設定預設收起。
- Turnstile：公開站生成前會出現驗證；驗證失敗不得呼叫模型。
- Rate limit：超過限制時回友善 `429 rate_limited`，不暴露 stack trace。
- 雲端保存：上傳成功後有分享頁與刪除頁；本機歷史會保存連結。
- 分享頁：預設隱藏 prompt；公開 prompt 只在使用者明確勾選時顯示。
- 站長雲端圖庫：用量分頁輸入 `GALLERY_ADMIN_TOKEN` 後可讀取 `/api/gallery`，搜尋與篩選可用。
- 用量 Dashboard：輸入 `GALLERY_ADMIN_TOKEN` 後，可依 UTC 日期查看生成數、Provider 嘗試、失敗數、錯誤率、平均事件時間與模型用量。

## 6. 回滾 Runbook

遇到以下任一項，不要公開或應立即回滾：

- 前端 bundle 或錯誤訊息出現任何完整 secret。
- 生成失敗造成白屏、清空使用者輸入，或回傳 stack trace。
- `/generate`、`/generate/batch`、`/edit` 未通過 Turnstile／rate limit 就呼叫 provider。
- `/api/gallery` 未授權即可列出 R2 metadata。
- 分享頁在 `promptPublic=false` 時仍顯示完整 prompt。

### 6.1 選擇並檢查目標版本

回滾會立即改變正式流量，執行前必須取得 owner 對目標 Version ID 與理由的明確確認。從 `cloudflare/` 執行專案鎖定的 Wrangler：

```powershell
cd "D:\Users\Administrator\Desktop\圖片生成\cloudflare"
$wrangler = ".\node_modules\.bin\wrangler.cmd"
$CurrentCommit = (git -C .. rev-parse HEAD).Trim()

& $wrangler versions list --name flux-image-gen --json --config wrangler.toml
$TargetVersion = "<已確認的 VERSION_ID>"
& $wrangler versions view $TargetVersion --name flux-image-gen --json --config wrangler.toml
```

檢查目標版本的建立時間、tag、message 與 bindings；若 R2 bucket、rate limiter、Workers AI 或其他資源已刪除／改名，不可直接回滾。Cloudflare rollback 只切換 Worker 版本，不會復原 R2 內容、secret 或其他平台資源。

### 6.2 執行回滾

```powershell
& $wrangler rollback $TargetVersion `
  --name flux-image-gen `
  --message "rollback from commit $CurrentCommit：<原因>" `
  --yes `
  --config wrangler.toml
```

### 6.3 回滾後 health 與 assets smoke

```powershell
cd "D:\Users\Administrator\Desktop\圖片生成"
python scripts\smoke_live_provider.py `
  --base-url https://flux-image-gen.irisx-tracker.workers.dev `
  --expect-mode live

$BaseUrl = "https://flux-image-gen.irisx-tracker.workers.dev"
foreach ($Path in "/", "/static/app.js", "/static/styles.css", "/service-worker.js") {
  $Response = Invoke-WebRequest -Uri "$BaseUrl$Path" -Method Head -UseBasicParsing
  if ($Response.StatusCode -ne 200) { throw "Asset smoke failed：$Path HTTP $($Response.StatusCode)" }
}
```

health／assets 通過後，將下列資料追加到 `CHANGELOG.md`：UTC／台北時間、操作者、原因、當時 Git commit、回滾目標 Version ID、回滾後 active Version ID、health 結果與資產 smoke 結果。若 smoke 失敗，立即在 Cloudflare Deployments 頁選回上一個已知正常版本。

## 7. Git remote 與 CI 啟用前置

`.github/workflows/ci.yml` 已準備離線 verify，但目前 repo 沒有 remote，因此 workflow 尚不會執行。先確認 owner 提供的 GitHub HTTPS URL；未確認前不得自行建立 repo 或 push。

```powershell
gh auth status -h github.com
git remote -v

# 只有 owner 明確提供 URL 後才執行：
git remote add origin <HTTPS_GIT_URL>
git remote get-url origin
git push -u origin master
```
