# Cloudflare Workers 版

此目錄是與 FastAPI 版同步的 Cloudflare Workers 部署版本：

1. 白話中文轉專業英文提示詞：`POST /prompt/transform`
2. 圖片生成：`POST /generate`，透過 NVIDIA FLUX，支援 `prompt / model / size / seed`
3. 客製梗卡：前端 `localStorage` 儲存、匯入、匯出
4. 使用者教學：首次開啟自動顯示，也可按「？教學」
5. 迭代體驗功能：歷史記錄牆、一鍵再生、複製設定、Seed 控制與排除描述輔助

## 目錄

- `src/index.js`：Worker API，包含 `/health`、`/prompt/transform`、`/generate`
- `public/index.html`：靜態頁面
- `public/static/`：前端互動腳本與樣式
- `tests/`：Node 內建測試

## 迭代體驗功能（與 FastAPI 同步）

Cloudflare Workers 版與 FastAPI 版同步支援以下功能：

- 歷史記錄牆：使用 `localStorage` 保存最近生成結果，支援重新下載、複製提示詞與從歷史卡片再生。
- 一鍵再生：按「再生一張」會沿用上一張圖的提示詞、模型與尺寸，並把 Seed 重設為 `0` 以產生新變體。
- 複製設定：可一鍵複製目前圖片的提示詞、模型、尺寸與 Seed，方便分享或重現。
- Seed 控制：`0` 或空白代表隨機；輸入固定正整數可重現同一組設定，或在原設定上微調。
- 排除描述輔助：前端會把「不要出現什麼」合併進 prompt（例如 `avoid ...`），不會送出 NVIDIA 目前未支援的 `negative_prompt` 欄位。

## v1.4 作品管理與分享

- 作品詳情面板：查看圖片、白話描述、最終 prompt、排除描述、model、size、seed、provider、生成時間。
- Prompt 版本比較：從歷史作品再生時會形成版本鏈，可切換比較不同 prompt / seed / model。
- 分享卡片：可複製分享文案、複製設定 JSON、匯出作品 JSON、下載圖片；可選擇分享時隱藏 prompt。
- Prompt 強化器：提供更寫實、電影感、產品照、可愛、乾淨構圖、修正常見瑕疵等規則式強化，不增加 API 成本。
- 失敗修正建議：依 `content_filtered`、`rate_limited`、`timeout`、`bad_provider_response`、`missing_api_key` 等錯誤提供下一步建議。
- 歷史搜尋與標籤：可搜尋 prompt、篩選 model/size、收藏星號、編輯標籤。
- PWA / 手機體驗：提供 manifest、service worker、手機底部生成列與響應式歷史牆。
- 錯誤監控：前端錯誤與生成 API 失敗會送到 `POST /client-error`，Worker 會回 `x-request-id` 並記錄已截斷的白名單欄位。
- 效能 QA：`npm run qa:perf` 會量 TTFB、FCP、LCP、CLS、資源數與傳輸量，避免回歸到大型字型 payload。

不包含每日額度、冷卻、防濫用、帳號系統或公開作品牆。

### `/generate` Seed 行為

```json
{
  "prompt": "a cute corgi astronaut floating in space",
  "model": "schnell",
  "size": "square",
  "seed": 0
}
```

`seed: 0` 或空白代表隨機；固定正整數可用於重現與微調。Worker 只會把合併後的 prompt、尺寸與 Seed 送往 NVIDIA，不會送出 `negative_prompt`。

## 本機開發

```powershell
cd D:\Users\Administrator\Desktop\圖片生成\cloudflare
npm install
npm test
npm run check
npm run deploy:dry-run
npx wrangler dev --local --port 8787
```

本機金鑰放在 `.dev.vars`：

```text
NVIDIA_API_KEY=你的金鑰
```

## 部署

正式部署前，請用 Wrangler secret 設定金鑰，避免把密鑰寫進程式碼或 `wrangler.toml`：

```powershell
npx wrangler secret put NVIDIA_API_KEY
npm run deploy
```

`npm run deploy` 會包住 `wrangler deploy`，並在 Wrangler 已明確輸出部署成功、但 process exit code 異常時，把結果正規化為成功，避免 CI/CD 誤判。若要跑正式上線前檢查：

```powershell
npm test
npm run check
npm run deploy:dry-run
```

部署後可跑瀏覽器 QA 與效能 QA；第一次執行或 Playwright 瀏覽器版本更新時，先安裝依賴與 Chromium：

```powershell
npm install
npm run qa:browser:install
npm run qa:browser
npm run qa:perf
```

`npm run qa:perf` 會輸出 `output/playwright/cloudflare-perf-qa.json`。目前預算包含 LCP ≤ 2500ms、CLS ≤ 0.1、總傳輸量 ≤ 900KB、資源數 ≤ 40。

`NVIDIA_BASE_URL` 是非密鑰設定，放在 `wrangler.toml` 的 `[vars]`。
