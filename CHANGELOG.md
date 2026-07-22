# Changelog

## Unreleased

### Changed

- 手機版首屏直達輸入框：≤620px 隱藏 hero 副標語與教學按鈕（教學入口改為頂欄 44px「?」鈕）、主標題縮為單行，描述輸入框在 iPhone 13 首屏即完整可見（promptTop 598→412px）。範例 Gallery 改為橫向滑動卡片，生成分頁總長 5552→2747px。
- 手機版再瘦身：生成前的空預覽畫布整段收起（生成開始或已有結果即恢復；不支援 `:has()` 的舊瀏覽器維持原樣）、「幫我想梗」與自訂風格卡改單列橫滑、風格卡說明文收起。生成分頁總長 2747→2005px。

- 畫質選單合併為單一模型：快速／高品質兩檔實際上都走 NVIDIA FLUX.1-dev，前端移除下拉選單、調參欄位（steps／cfg_scale）永遠顯示。隱藏的 `#model` select 保留在 DOM，歷史再生、分享連結與舊點子卡的 model 值仍可回填，後端也持續接受 `schnell` 值。
- Cloudflare Worker 補上 `steps`／`cfgScale` 參數支援：先前只有 FastAPI 版接收調參，Worker 一律寫死 30／5；現在 `/generate` 與 `/generate/batch` 會驗證並傳給 NVIDIA，超界回 400。
- 調參範圍對齊 NVIDIA flux.1-dev 實測邊界：steps 5–50、cfg_scale 1.5–9（原 1–50／1–10 超界值會被 NVIDIA 422 拒絕）。前端輸入框、FastAPI 與 Worker 驗證三處同步。
- NVIDIA 422 錯誤訊息不再顯示「[object Object]」：FastAPI 式 detail 陣列攤平成「欄位＋原因」，錯誤 body 讀取上限 300→600 字避免截斷。
- 「生成後 AI 檢查」勾選框只在後端真的啟用 Vision QA 時顯示：`/api/health` 新增 `visionQa` 欄位（Worker 與 FastAPI 同步），未啟用時整列收起，不再讓使用者勾了沒效果。
- 「不想出現的東西」加誠實提示：FLUX 沒有真正的負面提示詞，該欄位只是把 avoid 文字併進描述，不保證排除。
- 移除 `/api/health` 的 `providers.modal` 遺跡欄位：本站早已改跑 Cloudflare Workers，該旗標恆為 `false`、前端對應分支永不觸發，屬純遺跡。Worker、FastAPI 與 app.js 同步清除。

### Fixed

- 快速檔改為優先走 NVIDIA（schnell 映射到 FLUX.1-dev）：Workers AI 的模型端內容過濾較嚴、易誤殺一般描述，現在只有未設定 NVIDIA 金鑰時才退回 Workers AI。Cloudflare Worker 與 FastAPI REST twin 行為一致。

- 快速檔依尺寸分流以降低成本並保住尺寸設定：預設 1024×1024 正方形改走較便宜的 Cloudflare FLUX.1 schnell（JSON、`steps=4`、不帶自訂尺寸），非正方形與自訂尺寸仍走 FLUX.2 klein（支援 width/height）。Cloudflare Worker 與 FastAPI REST twin 行為一致。
- 防止隱性重複計費：Workers AI 生圖／改圖每個使用者請求最多一次 `AI.run`，啟動後不自動重送或跨供應商；NVIDIA、Gemini 與 Vision QA 則記錄實際 Provider 嘗試次數與保守估算成本。
- Batch 改用完整收斂結果：部分成功回傳成功圖片與逐張錯誤，全部失敗維持非 2xx；前端會顯示成功／失敗張數，不再把空結果當成功。
- Turnstile 加入 5 秒預設 timeout、bounded 設定與 `action=turnstile-spin-v1` 驗證；缺少 `GALLERY_TOKEN_SECRET` 時 R2 圖庫寫入改為 fail-closed。
- 手機切換分頁後回到新 panel 起點；歷史再生完整帶回中文／Provider prompt、負面提示、尺寸與解析度，且先顯示生成分頁再送出。
- Service Worker 不再安裝後自行接管；只有本分頁按下更新才 `skipWaiting` 並重載，network-first 快取寫入也納入事件生命週期。
- 成本 Dashboard 共用 `GALLERY_ADMIN_TOKEN` 呼叫受保護的 `/api/usage`，新增 Provider 嘗試與成功事件，並修正手機查詢列遮擋／壓縮。

### Added

- 生成後 AI 視覺檢查有了實際入口：進階設定新增「生成後 AI 檢查」勾選框，單張生成時會把 `visionQa` 送給後端，完成訊息直接顯示符合度／構圖／畫質分數與偵測到的問題。後端 `/generate` 早已支援此欄位，先前只是前端從未送出，等同永遠關閉。
- 高品質（FLUX.1-dev）可逐次調參：選到「高品質」時顯示 `steps`（1–50）與 `cfg_scale`（1–10）欄位，留空則沿用 `NVIDIA_DEV_STEPS`／`NVIDIA_DEV_CFG_SCALE`。先前這兩個值只能改環境變數並全域生效。
- 用量事件以既有 `IMAGE_BUCKET` 的 `usage-events/YYYY-MM-DD/` metadata 持久保存；摘要不含 prompt、圖片、原始 IP 或 IP 雜湊，超過單日 1,000 筆時明確標示部分資料。
- Prompt／Vision 單次成本可用 `USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST` 校準；目前預設 `0`，只保證嘗試次數完整，不宣稱美元估值完整。

### Infrastructure

- 移除會部署過期、未追蹤 bundle 的 `wrangler.deploy.toml` 路徑；原生與 WSL deploy 現在共用 `wrangler.toml` 與 `src/index.js`，WSL fallback 固定 Wrangler `4.104.0`。
- `npm run deploy`／`deploy:dry-run` 強制先跑完整離線 verify；正式 deploy 另強制 public Turnstile preflight，未設定正式 widget／site key／secret 時會安全停止。
- 加入 `CF_VERSION_METADATA` binding 與 10% Workers Logs observability sampling；traces 暫不啟用，待成本另行核准。
- 新增最小 GitHub Actions CI，在 Windows／Node 22／Python 3.12 執行既有完整 verify，不含 deploy。
- 補齊可執行 rollback runbook：版本列舉／檢視、明確 Version ID 回滾、health／assets smoke，以及 commit／Version ID 紀錄格式。
- 正式 Windows／WSL deploy 新增共用 fail-closed gate：worktree 有 staged、unstaged 或 untracked 變更即停止，並在上傳前唯讀確認五個必要 production secret 名稱；輸出不含 secret 值。
- 部署 wrapper 固定 `flux-image-gen` production 目標與 `git-<HEAD12>`／`commit <HEAD>` 版本標記；僅接受 `--dry-run`，拒絕 target、entrypoint、tag 或 message 覆寫。
- WSL fallback 將 OAuth refresh 同步移入 EXIT cleanup；readiness 或 deploy 失敗時也會先備份／更新 Windows 憑證，再還原原有 WSL 登入。

### Not deployed

- 本節變更尚未部署。正式站仍缺 `TURNSTILE_SECRET_KEY` 與公開 site key，需完成外部設定後才能通過公開 release gate。（repo 已建立私有 Git remote `Reese-max/flux-image-gen`。）

## 2026-07-11

### Fixed

- 修正中文描述補全只有內部函式、沒有可操作入口的功能斷點；首屏新增「幫我補完整」按鈕，並加入重複送出防護與忙碌狀態。
- PWA 靜態資產改採 network-first 並更新 cache 版本，避免部署後第一次開啟時混用新版 HTML 與舊版 JavaScript。
- FastAPI 補上提示詞轉換、中文補全與效果強化的後端限流，與 Worker 的 Gemini 配額保護行為一致。
- 提示詞補全／轉換／強化在前後端統一加入輸入長度上限，避免超大文字造成不必要的模型配額與記憶體消耗。
- 智慧體「補全畫面」步驟改為依實際提示詞整理結果更新，不再尚未補全就提前顯示成功；整理失敗也會正確標示步驟錯誤。
- 修正首次生成後修改中文描述或風格仍沿用舊英文提示詞的核心錯誤；自動產生的英文提示詞會追蹤來源，輸入條件變更時自動失效，手動編輯的英文內容則保留。
- 中文描述補全新增離線 fallback；未設定 Gemini 或暫時連線失敗時仍可完成操作，不再讓首屏按鈕直接回 503。
- 「用 AI 套用效果」新增離線視覺規則 fallback；夢幻、霓虹、景深、黃昏、明亮、黑白、精品與可愛等常見需求在沒有 Gemini 時仍可用。
- 修正無效 URL hash 回復目前分頁時的 history 更新邏輯，`#usage` 與一般分頁切換測試恢復通過。
- 部署 smoke request 加入固定 `User-Agent`，避免 Cloudflare 對 Python 預設請求回 403；正式網址 health smoke 已恢復通過。
- Wrangler 診斷改走專案既有 `deploy.mjs --dry-run` 包裝器，避免 Node 25 原生子程序已產生成功輸出後仍以 crash code 誤判失敗。
- 移除已下架「即將推出」改圖按鈕遺留的無效 CSS。

### Performance

- Cloudflare deploy copy 在 `npm run sync` 時自動壓縮 JavaScript，FastAPI 原始碼仍保持可讀，並由 Worker 測試驗證壓縮結果與來源一致。
- `sync-static.mjs` 改為遞迴同步 `app/static/`，新增或更新巢狀範例圖與 prompt-pack 素材時不再依賴人工複製。
- 範例 Gallery、靈感圖與提示詞包縮圖改用 `IntersectionObserver` 到達可視區才載入；HF 靈感面板也延後到提示詞包接近畫面時載入。
- 正式站 Wrangler 效能 QA：首屏 `311.8 KiB`、JavaScript `147.5 KiB`、18 個資源，所有既定效能預算通過。

## 2026-06-28

### Refactor

- **拆分 Worker `index.js`（999 行）成模組**：依職責分為 `constants.js` / `http.js` / `prompt.js` / `image.js` / `gallery.js`，`index.js` 縮為 259 行（6 個 handler + router + `transformPlainPrompt` 再匯出）。最大模組 234 行、全部 <800、無循環相依、函式逐字搬移零行為變動。worker 33 tests / verify.mjs / esbuild bundle / 線上 smoke test 皆通過（Version `046f11d3`）。

### Performance & hardening（三 agent 平行審查後的優化輪）

- **批次生成並行化**：`/generate/batch`（Worker `Promise.all`）與後端 `generate_batch`（`asyncio.gather`）由序列改並行。線上實測 count=2 由 ~4s 降到 ~2s（≈單張時間）。
- **堵 body 大小繞過**：Worker `readJsonPayload` 改有界串流讀取，不再信任可偽造 / 可省略的 `Content-Length`；`decodeImageDataUrl` 加 5MB 解碼前上限。線上實測超大 body 回 413。
- **補限流與輸入上限**：`/prompt/transform` 補 `checkRateLimit` 與 source 長度上限（保護 Gemini 配額）。
- **可觀測性**：Gemini/Codex prompt 轉換 fallback 失敗由靜默吞掉改為結構化 log（Worker `console.error` / 後端 `logging.WARNING`）。
- **正確性修復**：LLM transient retry 加 backoff；`_response_error_message` 不再回傳原始 provider dict；`demo_image` 修 `font.size` 在 fallback 字型的 `AttributeError`；`/gallery` GET 的 `decodeURIComponent` 加防護（畸形編碼→404）；前端 `saveToCloud` 處理 `copyText` promise 與非 JSON 回應時按鈕永久鎖死。
- 部署：`Current Version ID: dd287940-f815-4694-9d6a-6ece179a7954`。

### Changed

- 啟用 edge rate limiting：`cloudflare/wrangler.toml` 取消註解並改用 GA `[[ratelimits]]` binding（`GENERATE_RATE_LIMITER`，12 requests / 60s，key=`cf-connecting-ip`）。`/generate` 與 `/generate/batch` 皆在最前面做限流檢查。
- 啟用 R2 雲端圖庫：帳號於 Dashboard 開通 R2 後 `wrangler r2 bucket create flux-image-gallery`，`wrangler.toml` 取消 `[[r2_buckets]]` 註解（binding `IMAGE_BUCKET`）。`/gallery` 由 503 改為實際存取 R2。

### Deployed

- 重新部署（Windows 原生 wrangler 4.104，本次未出現 native crash）：限流先行 `ba0fa316-…`，加 R2 binding 後 `Current Version ID: d1490387-fcda-41e4-8456-8d790ec221f9`。部署輸出確認 bindings：`env.IMAGE_BUCKET (flux-image-gallery) → R2 Bucket`、`env.GENERATE_RATE_LIMITER (12 requests/60s) → Rate Limit`。

### Verified

- 線上 `/generate` 回歸：`/health` provider=nvidia；schnell / dev valid 生圖皆 HTTP 200 並回合法 JPEG。
- R2 雲端圖庫端到端：`POST /gallery` → 201（回 id/url）；`GET /gallery/:id` → 200、`image/png`、bytes 與上傳相符。「存到雲端」按鈕現可實際存取，不再 503。

### Security

- **`/gallery` POST 加 HMAC token 認證**：`/generate`(`/batch`) 成功時夾帶短效 `galleryToken`（`HMAC-SHA256(ts)`，2h TTL、常數時間比對），`/gallery` 驗 `X-Gallery-Token`。`GALLERY_TOKEN_SECRET` 未設時不強制（向後相容）。已設生產 secret + 部署（`d227812b`），線上實測 401→token→201。前端 `saveToCloud` 全自動帶 token，使用者無感。擋匿名 bulk 寫入 R2。

### Decisions（成本防護，2026-06-28 與 owner 確認）

- **不採用 Turnstile / 不採用伺服器端每日上限**：owner 不要任何使用者端驗證關卡，且選擇接受 `/generate` 的成本濫用風險。
- 後果：`/generate` 與 `/generate/batch` 公開且無有效限流，理論上可被腳本連續呼叫燒 NVIDIA 額度。owner 自行監控用量；屬個人 / 低流量場景的可接受取捨。
- 若日後要防護又不加使用者摩擦，最小侵入解是 Worker 內 KV/Durable Object 的「全站每日總量上限」（使用者無感）。
- edge rate limiting binding（`GENERATE_RATE_LIMITER` 12/60s）保留於 `wrangler.toml`，但實測線上不強制執行（best-effort、官方明示非精準計數）；fail-open，不影響服務，視為無效防護、不依賴它。
- ~~R2 雲端圖庫仍未啟用~~ → **已於 2026-06-28 啟用並驗證**（見 Verified）。卡點實為帳號層級 R2 未開通（API 回 `code: 10042`），非 token scope；使用者於 Dashboard 開通後本工作階段完成建 bucket → 解註解 → 部署 → 端到端驗證。

## 2026-06-27

### Added

- 種子碼 / 構圖鎖定（先前未入帳）：前端「🎲 每次都不一樣 / 🔒 鎖定這張構圖」雙模式、「以這張構圖再變化」、自訂種子碼進階區，可重現或微調同一構圖。
- 生圖 transient retry：`app/image_service.py` 與 Cloudflare Worker 對逾時 / 網路 / 5xx 重試（最多 2 次 + backoff），429 仍即時回 `retry_after`。
- 批次生成 API：`POST /generate/batch`（一個 prompt 出 1–4 張變體，首張可沿用指定 seed、其餘隨機），FastAPI 與 Worker 皆支援。前端 `batchCount` 下拉已接。
- 可選 edge rate limiting：Worker `/generate` 在配置 `GENERATE_RATE_LIMITER` binding 時依 client IP 限流，未配置則 no-op。
- 可選 R2 雲端圖庫：Worker `POST /gallery` 存圖、`GET /gallery/:id` 取圖（需 `IMAGE_BUCKET` binding），未配置回 503。前端「☁️ 存到雲端」按鈕已接；惟生產 R2 binding 尚未啟用，線上點擊會收到 503。
- 本機 CI gate：`node scripts/verify.mjs` 一次跑完 pytest、前端 JS 測試、Cloudflare sync/check/worker 測試。
- 前端同步腳本：`cloudflare/scripts/sync-static.mjs`（`npm run sync` / `sync:check`），部署前自動擋不一致。

### Changed

- prompt 轉換常數（systemInstruction / styleHints / responseSchema 等）抽成單一來源 `shared/prompt-constants.json`，由 `app/prompt_llm.py` 與 `cloudflare/src/index.js` 共用，消除 Python/JS 雙寫漂移。
- Worker 抽出 `generateOneImage` 共用核心（`/generate` 與 `/generate/batch` 共用）。

### Fixed

- 修正既有紅燈測試：移除 `cloudflare/public/static/` 內 stray 的 `manifest.webmanifest` 與 `service-worker.js`（PWA root-scope 檔只應存在於 `public/` 根目錄）。
- **生產 NVIDIA_API_KEY 失效已修復**：以本機驗證過有效的金鑰（直打 schnell 端點回 HTTP 200）`wrangler secret put NVIDIA_API_KEY` 更新生產 secret。線上 `/generate` 由 `403 Authorization failed` 恢復為 HTTP 200。（`secret put` 為純 API 呼叫，Windows 原生 wrangler 可正常執行，無須繞 WSL；native crash 僅發生於需要 workerd 的 build/deploy 類指令。）

### Infra

- 專案首次納入 git 版控，補上 `.gitignore`（含 `.env` / `.dev.vars` / `node_modules` / `.wrangler` / `*.pid` 等）。

### Verified

- 全套離線測試通過：Python 72 passed（含 23 subtests）、前端 JS 41、Cloudflare Worker 32。
- `node scripts/verify.mjs` 綠燈；esbuild 可成功 bundle Worker（含 `shared/prompt-constants.json` inline）。
- 已部署上線（經 WSL `npx wrangler` 繞過 Windows wrangler native crash）：`Current Version ID: 86d83642-58cb-4226-a074-7c2f0eb91077`。線上驗證：新前端（batchCount / saveToCloud）已上、`/gallery` 回 503（R2 未啟用）、`/health` provider=nvidia。
- ~~已知問題：生產 NVIDIA_API_KEY 失效，`/generate` 與 `/generate/batch` 皆回 `NVIDIA HTTP 403: Authorization failed`~~ → **已於 2026-06-27 23:xx 修復**（見 Fixed）。線上實測：`/generate` schnell HTTP 200（~3s，52KB JPEG）、dev HTTP 200（~6.4s，247KB JPEG），圖檔內容與 prompt 相符。`/health` provider=nvidia。
- rate limiting 與 R2 binding 仍預設關閉；R2 需先於 Cloudflare Dashboard 啟用後 `wrangler r2 bucket create flux-image-gallery`、取消 binding 註解再重部署。

## 2026-06-25

### Added

- 新增 Cloudflare `/client-error` 端點，接收前端錯誤回報並回傳 `x-request-id`，方便追查線上問題。
- 新增前端錯誤監控：`window.error`、`unhandledrejection`、生成 API 失敗會送出同源錯誤報告；優先使用 `navigator.sendBeacon`，失敗時 fallback 到 `fetch(..., keepalive: true)`。
- 新增可重跑的 Playwright 效能 QA：`cloudflare` 目錄下可執行 `npm run qa:perf`，輸出 Core Web Vitals 近似值、資源數、傳輸量與 top resources 到 `cloudflare/output/playwright/cloudflare-perf-qa.json`。
- 新增 Playwright 依賴與安裝指令：`npm install`、`npm run qa:browser:install`。
- 新增 release package 文件：`docs/release-package-2026-06-25.md`。

### Changed

- 移除 Google Fonts 外部字型載入，改用系統字型 stack，降低首屏字型 payload。
- 修正 Service Worker 首次安裝時的 `controllerchange` 行為，只在已有舊 controller 的更新情境自動重新整理，避免首訪重載一次。
- Cloudflare README 與根 README 補上 QA、監控、效能與部署操作。

### Verified

- Cloudflare deploy：`Current Version ID: bc28edcb-ab62-4a67-ae2e-73a87b60add3`
- 線上功能 QA：`npm run qa:browser` 通過。
- 線上效能 QA：`npm run qa:perf` 通過。
  - TTFB：71ms
  - FCP：768ms
  - LCP：768ms
  - CLS：0
  - 總傳輸量：約 133.3KB
  - 資源數：13
- `/client-error` smoke：HTTP 204，並回傳 `x-request-id`。
