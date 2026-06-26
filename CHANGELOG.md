# Changelog

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