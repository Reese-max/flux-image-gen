# Changelog

## 2026-06-27

### Added

- 種子碼 / 構圖鎖定（先前未入帳）：前端「🎲 每次都不一樣 / 🔒 鎖定這張構圖」雙模式、「以這張構圖再變化」、自訂種子碼進階區，可重現或微調同一構圖。
- 生圖 transient retry：`app/image_service.py` 與 Cloudflare Worker 對逾時 / 網路 / 5xx 重試（最多 2 次 + backoff），429 仍即時回 `retry_after`。
- 批次生成 API：`POST /generate/batch`（一個 prompt 出 1–4 張變體，首張可沿用指定 seed、其餘隨機），FastAPI 與 Worker 皆支援。（前端 UI 待接）
- 可選 edge rate limiting：Worker `/generate` 在配置 `GENERATE_RATE_LIMITER` binding 時依 client IP 限流，未配置則 no-op。
- 可選 R2 雲端圖庫：Worker `POST /gallery` 存圖、`GET /gallery/:id` 取圖（需 `IMAGE_BUCKET` binding），未配置回 503。（前端 UI 待接）
- 本機 CI gate：`node scripts/verify.mjs` 一次跑完 pytest、前端 JS 測試、Cloudflare sync/check/worker 測試。
- 前端同步腳本：`cloudflare/scripts/sync-static.mjs`（`npm run sync` / `sync:check`），部署前自動擋不一致。

### Changed

- prompt 轉換常數（systemInstruction / styleHints / responseSchema 等）抽成單一來源 `shared/prompt-constants.json`，由 `app/prompt_llm.py` 與 `cloudflare/src/index.js` 共用，消除 Python/JS 雙寫漂移。
- Worker 抽出 `generateOneImage` 共用核心（`/generate` 與 `/generate/batch` 共用）。

### Fixed

- 修正既有紅燈測試：移除 `cloudflare/public/static/` 內 stray 的 `manifest.webmanifest` 與 `service-worker.js`（PWA root-scope 檔只應存在於 `public/` 根目錄）。

### Infra

- 專案首次納入 git 版控，補上 `.gitignore`（含 `.env` / `.dev.vars` / `node_modules` / `.wrangler` / `*.pid` 等）。

### Verified

- 全套離線測試通過：Python 72 passed（含 23 subtests）、前端 JS 41、Cloudflare Worker 32。
- `node scripts/verify.mjs` 綠燈；esbuild 可成功 bundle Worker（含 `shared/prompt-constants.json` inline）。
- 注意：本輪尚未部署上線；rate limiting 與 R2 binding 預設關閉，啟用需建立資源並部署。

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