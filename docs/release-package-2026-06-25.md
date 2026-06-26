# Release Package：2026-06-25 Cloudflare QA／監控／效能

## 目標

本次整理三件事：

1. 做可重跑的線上效能 QA。
2. 補前端與 Cloudflare Worker 錯誤監控。
3. 整理可交付的變更清單、驗證命令與 changelog。

## 部署資訊

- 站台：`https://flux-image-gen.irisx-tracker.workers.dev`
- Cloudflare Worker：`flux-image-gen`
- 最新部署版本：`bc28edcb-ab62-4a67-ae2e-73a87b60add3`
- 部署命令：

```powershell
cd D:\Users\Administrator\Desktop\圖片生成\cloudflare
npm run deploy
```

Wrangler 仍可能在成功部署後回傳非 0 exit code；目前由 `scripts/deploy.mjs` 依成功訊息正規化為 exit 0。

## 功能對照表

| 功能 | 檔案 | 說明 |
| --- | --- | --- |
| 前端錯誤上報 | `app/static/app.js`、`cloudflare/public/static/app.js` | 監聽 `window.error`、`unhandledrejection`、生成 API 失敗。 |
| Worker 錯誤收件端點 | `cloudflare/src/index.js` | 新增 `POST /client-error`，白名單欄位、短字串截斷、回傳 `x-request-id`。 |
| 效能 QA 腳本 | `tests/e2e/cloudflare-perf-qa.mjs` | Playwright 量測 TTFB、FCP、LCP、CLS、資源數、傳輸量。 |
| QA 指令 | `cloudflare/package.json`、`cloudflare/package-lock.json` | 新增 `qa:perf`、Playwright devDependency。 |
| 字型 payload 最佳化 | `app/static/index.html`、`app/static/styles.css` | 移除 Google Fonts，改用系統字型。 |
| PWA 首訪 reload 修正 | `app/static/app.js` | `controllerchange` 只在已有舊 controller 時重新整理。 |
| 回歸測試 | `tests/test_static_ui.py`、`cloudflare/tests/worker-transform.test.mjs` | 覆蓋監控、效能腳本、PWA 邊界與靜態同步。 |
| 文件 | `README.md`、`cloudflare/README.md`、`CHANGELOG.md` | 補操作方式、驗證結果與變更紀錄。 |

## 線上效能結果

最後一次 `npm run qa:perf`：

| 指標 | 結果 | 預算 | 狀態 |
| --- | ---: | ---: | --- |
| TTFB | 71ms | 800ms | PASS |
| FCP | 768ms | 1800ms | PASS |
| LCP | 768ms | 2500ms | PASS |
| CLS | 0 | 0.1 | PASS |
| 總傳輸量 | 133.3KB | 900KB | PASS |
| Script 傳輸量 | 83.8KB | 180KB | PASS |
| Stylesheet 傳輸量 | 28.9KB | 180KB | PASS |
| 資源數 | 13 | 40 | PASS |

最佳化前曾量到 Google Fonts 造成約 2.5MB、51 個資源；移除外部字型後降到約 133.3KB、13 個資源。

## 驗證命令

```powershell
cd D:\Users\Administrator\Desktop\圖片生成
python -m pytest -q
node --test tests\frontend\idea-store.test.cjs tests\frontend\generation-settings.test.cjs tests\frontend\history-store.test.cjs tests\frontend\prompt-enhancer.test.cjs tests\frontend\failure-advice.test.cjs

cd D:\Users\Administrator\Desktop\圖片生成\cloudflare
npm test
npm run check
npm run qa:browser
npm run qa:perf
```

線上監控 smoke：

```powershell
Invoke-WebRequest -Uri 'https://flux-image-gen.irisx-tracker.workers.dev/client-error' `
  -Method POST `
  -ContentType 'application/json' `
  -Body '{"message":"qa-monitoring-smoke","type":"manual_smoke","userAgent":"codex"}' `
  -SkipHttpErrorCheck
```

期望結果：HTTP 204，且 response header 有 `x-request-id`。

## 注意事項

- 目前不是 Git repo，無法產生 `git diff` 或 commit。提交時請以本文件的檔案清單為準。
- `cloudflare/output/playwright/` 是 QA 產物，不應進正式版控。
- `/client-error` 目前只做 Cloudflare Worker log，不含第三方監控平台。若後續要接 Sentry、Logpush 或 Analytics Engine，可以沿用同一個 payload。