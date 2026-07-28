# AI 圖片產生器（FastAPI 版）

這是依照參考站 `https://tonny-0955--flux-image-gen-web.modal.run` 製作的本機 FastAPI 版圖片生成網站。

- 前端：單頁深色 UI、prompt、模型選擇、尺寸選擇、Seed、排除描述輔助、隨機提示詞、下載、複製與再生。
- 後端：`POST /generate`，接收 `prompt / model / size / seed`，回傳 `{ image, provider, model, width, height, seed }`。
- 無金鑰：自動使用本機 Demo PNG fallback，方便先驗證網站流程。
- 有金鑰：設定 `NVIDIA_API_KEY` 後，會改走 NVIDIA FLUX API。

## 新功能

- AI 改圖（`POST /edit`）：上傳 1–4 張自訂圖片＋文字指令，交給 Cloudflare Workers AI FLUX.2 klein 做指令式編輯（換色、換背景、多圖合成、風格轉移）。前端會先把每張圖等比縮到 <512×512 再上傳；需設定 `CF_ACCOUNT_ID` / `CF_API_TOKEN`，未設定時回乾淨 503。（NVIDIA hosted 的 flux.1-kontext-dev 只支援內建範例圖、無法上傳自訂圖，故改走 Workers AI。）
- 白話中文轉專業英文提示詞：`POST /prompt/transform` 可把中文想法轉成更適合圖片模型的英文 prompt，並可搭配風格參數調整語氣。
- 中文描述補全：按「幫我補完整」會優先呼叫 Gemma（預設 `GEMINI_COMPLETE_MODEL=gemma-4-31b-it`）把短中文描述補成更完整的繁中畫面描述；未設定金鑰或服務暫時失敗時會改用離線規則補全，`Tab` 保留標準鍵盤導覽行為。
- 效果強化：輸入「更夢幻、加霓虹、背景虛化、黃昏光、高級精品感」等要求時優先由 Gemini 重寫提示詞；沒有金鑰或服務暫時失敗時會改用離線視覺規則，按鈕不會直接失效。
- 使用者教學：第一次進站會自動顯示教學，也可以隨時按右上角「？教學」重新開啟。

## 迭代體驗功能

FastAPI 版與 `cloudflare/` Cloudflare Workers 版同步支援以下功能：

- 歷史記錄牆：使用 `localStorage` 保存最近生成結果，支援重新下載、複製提示詞與從歷史卡片再生。
- 一鍵再生：按「再生一張」會沿用上一張圖的提示詞、模型與尺寸，並把 Seed 重設為 `0` 以產生新變體。
- 複製設定：可一鍵複製目前圖片的提示詞、模型、尺寸與 Seed，方便分享或重現。
- Seed 控制：`0` 或空白代表隨機；輸入固定正整數可重現同一組設定，或在原設定上微調。
- 排除描述輔助：前端會把「不要出現什麼」合併進 prompt（例如 `avoid ...`），不會送出 NVIDIA 目前未支援的 `negative_prompt` 欄位。
- 後端限流：FastAPI 會依 IP 對 `/generate`、`/generate/batch`、`/edit` 與可能消耗 Gemini 配額的 `/prompt/transform`、`/prompt/complete`、`/prompt/enhance` 做硬性 rate limit；Cloudflare 版使用 `wrangler.toml` 的 `GENERATE_RATE_LIMITER` binding。達上限時回 `429 rate_limited` 與 `retry_after`，不會呼叫模型。
- Turnstile 防機器人：公開站可設定 `TURNSTILE_REQUIRED=true`、`TURNSTILE_SITE_KEY`，並把 `TURNSTILE_SECRET_KEY` 放在後端/Worker secret。前端只拿 site key，後端在呼叫模型前驗證 token；驗證失敗不會出圖。
- Prompt moderation：`/generate`、`/generate/batch`、`/edit` 在呼叫模型前先擋高風險描述（色情、未成年敏感、血腥暴力、仿冒證件、詐欺、隱私侵犯、政治誤導與商標濫用）。拒絕訊息不回顯敏感全文。
- 成本 Dashboard：網站「用量」分頁與 `GET /api/usage` 可查今日生成次數、失敗次數、估計成本、每模型／provider／匿名 IP 用量、錯誤率與平均生成時間。FastAPI 另寫入 `logs/usage-YYYY-MM-DD.jsonl`；Worker 輸出 `usage_event` 結構化 log。用量資料不保存 prompt、圖片內容或金鑰。

## v1.4 作品管理與分享

- 作品詳情面板：查看圖片、白話描述、最終 prompt、排除描述、model、size、seed、provider、生成時間。
- Prompt 版本比較：從歷史作品再生時會形成版本鏈，可切換比較不同 prompt / seed / model。
- 分享卡片／分享頁：可複製分享文案、複製設定 JSON、匯出作品 JSON、下載圖片；雲端分享頁會顯示圖片、模式、風格、用途、尺寸、prompt 公開狀態與「再生成」入口，可選擇分享時隱藏 prompt；上傳成功後會產生一次性刪除連結，使用者打開連結確認後可自助刪除 R2 圖片與 metadata。
- Prompt 強化器：提供更寫實、電影感、產品照、可愛、乾淨構圖、修正常見瑕疵等規則式強化，不增加 API 成本。
- 失敗修正建議：依 `content_filtered`、`rate_limited`、`timeout`、`bad_provider_response`、`missing_api_key` 等錯誤提供下一步建議。
- 歷史搜尋與標籤：可搜尋 prompt、篩選 model/size、收藏星號、編輯標籤。
- PWA / 手機體驗：提供 manifest、service worker、手機底部生成列與響應式歷史牆。

不包含帳號系統；公開站已具備後端限流、Turnstile 防機器人入口與雲端分享基礎。

## 品質 QA、效能與錯誤監控

- 線上功能 QA：Cloudflare 版提供 `npm run qa:browser`，會實際點擊 Prompt 強化器、歷史牆、詳情面板、標籤、PWA 與手機底部生成列。
- 線上效能 QA：Cloudflare 版提供 `npm run qa:perf`，會量 TTFB、FCP、LCP、CLS、資源數與傳輸量，輸出到 `cloudflare/output/playwright/cloudflare-perf-qa.json`。
- 錯誤監控：前端會把 `window.error`、`unhandledrejection` 與生成 API 失敗送到同源 `POST /client-error`；Worker 會回 `x-request-id` 並記錄已截斷的白名單欄位。
- 生成後視覺 QA：勾「生成後 AI 檢查」才會執行（預設不勾），交給視覺模型評分構圖／畫質／符合度並指出問題。後端由 `VISION_QA_PROVIDER` 決定：`nvidia`（預設）與生圖共用同一把 `NVIDIA_API_KEY`、不另外吃付費配額，中位多花約 8 秒；`gemini` 較快（約 4 秒）但要另備金鑰。指定的後端缺金鑰時會自動退到另一邊，`/api/health` 的 `visionQaProvider` 會回報實際選中的後端。
- 效能最佳化：已移除 Google Fonts 外部字型；Cloudflare deploy copy 會壓縮 JavaScript，範例圖與額外靈感模組則延後到接近可視區才載入。
- 變更清單：本輪提交包在 `docs/release-package-2026-06-25.md`，版本紀錄在 `CHANGELOG.md`。

## 專案位置

```powershell
D:\Users\Administrator\Desktop\圖片生成
```

## 部署狀態

目前完成且已驗證的主要路徑包含 **FastAPI 版**（`app/`、`tests/`）與 **Cloudflare Workers 版**（`cloudflare/`）。兩個版本同步支援白話中文轉專業英文提示詞、使用者教學與迭代體驗功能。

公開上線前請先跑完 `docs/deployment-checklist.md` 與 `docs/release-acceptance-checklist.md`：前者集中確認 Wrangler secrets、Turnstile、R2、Workers AI binding、rate limit、雲端圖庫、用量 Dashboard 與 smoke test；後者追蹤正式網域、真機、Vision QA、雲端保存、隱私與法務 sign-off 等 Release blocker。

## 安裝

```powershell
cd "D:\Users\Administrator\Desktop\圖片生成"
python -m pip install -r requirements.txt
```

## 啟動（Demo 模式）

```powershell
cd "D:\Users\Administrator\Desktop\圖片生成"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

打開：

```text
http://127.0.0.1:8001
```

本專案目前本機服務使用 `127.0.0.1:8001`；`8000` 可能由其他服務佔用，請避免打到錯誤服務。

## 啟動（NVIDIA FLUX）

先複製環境檔：

```powershell
Copy-Item .env.example .env
notepad .env
```

填入：

```text
NVIDIA_API_KEY=nvapi-你的金鑰
IMAGE_PROVIDER=auto
```

再啟動：

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload --env-file .env
```

> `IMAGE_PROVIDER=auto`：有 `NVIDIA_API_KEY` 時用 NVIDIA，沒有時用 Demo。  
> `IMAGE_PROVIDER=demo`：強制 Demo。  
> `IMAGE_PROVIDER=nvidia`：強制 NVIDIA，缺金鑰會回錯誤。

## API

### `GET /health`

回傳的 `provider` 會依 `IMAGE_PROVIDER` / `NVIDIA_API_KEY` 顯示 `demo` 或 `nvidia`：

```json
{"status":"ok","provider":"<demo|nvidia>"}
```

### `GET /api/usage`

回傳 prompt-free 成本／用量摘要；可加 `?date=YYYY-MM-DD` 查指定日期。前端「用量」分頁會呼叫此端點並顯示站長摘要。

```json
{
  "date": "2026-07-07",
  "generatedImages": 12,
  "failedRequests": 1,
  "estimatedCostUsd": 0.036,
  "byModel": {"schnell": {"requests": 12, "successes": 12, "failures": 0, "images": 12}},
  "byProvider": {"nvidia": {"requests": 12, "successes": 12, "failures": 0, "images": 12}},
  "byActor": {"ip:匿名雜湊": {"requests": 3, "images": 3}},
  "errorRate": 0.0769,
  "averageGenerationMs": 4100,
  "alerts": []
}
```

### `GET /api/gallery`（Cloudflare Worker）

站長雲端圖庫清單，讀取 R2 的 `gallery-meta/*.json` 摘要；本機 FastAPI 會回 `503 gallery_disabled`，因為本機沒有 R2 binding。

部署前請把站長 token 設成 Worker secret：

```powershell
cd cloudflare
npx wrangler secret put GALLERY_ADMIN_TOKEN
```

呼叫時必須帶 header：

```http
GET /api/gallery?limit=50
X-Gallery-Admin-Token: <GALLERY_ADMIN_TOKEN>
```

回傳只包含管理摘要與安全連結，不包含 `deleteTokenHash`、刪除 token，也不包含未公開的完整 prompt：

```json
{
  "items": [
    {
      "id": "example.png",
      "imageUrl": "/gallery/example.png",
      "shareUrl": "/share/example.png",
      "visibility": "public",
      "promptPublic": false,
      "title": "簡報封面",
      "model": "schnell",
      "size": "landscape",
      "createdAt": "2026-07-07T00:00:00.000Z",
      "storage": "r2"
    }
  ],
  "count": 1,
  "truncated": false,
  "cursor": null,
  "checkedAt": "2026-07-07T00:00:01.000Z"
}
```

### `POST /prompt/transform`

把白話中文描述轉成專業英文提示詞。

Request：

```json
{
  "source": "一隻可愛柴犬在月球上吃拉麵",
  "style": "cute"
}
```

Response：

```json
{
  "source": "一隻可愛柴犬在月球上吃拉麵",
  "prompt": "Shiba Inu, dog, on the moon, eating ramen, adorable, soft rounded shapes, warm pastel colors, highly detailed",
  "provider": "rule_based",
  "warnings": []
}
```

### `POST /prompt/complete`

把短中文描述補成較完整的繁體中文畫面描述；供前端「幫我補完整」按鈕使用。

Request：

```json
{
  "source": "女生雨中",
  "style": "cinematic"
}
```

Response：

```json
{
  "source": "女生雨中",
  "prompt": "一位年輕女生站在夜晚的雨中街道，身穿深色外套，濕潤柏油路反射霓虹燈光，背景有柔和散景，畫面帶有電影感，氛圍安靜而孤獨。",
  "provider": "gemini",
  "warnings": []
}
```

### `POST /generate`

Request：

```json
{
  "prompt": "a cute corgi astronaut floating in space",
  "userPrompt": "一隻柴犬太空人在太空漂浮",
  "model": "schnell",
  "size": "square",
  "seed": 0,
  "turnstileToken": "cf-turnstile-response，僅公開站必填"
}
```

Response：

```json
{
  "image": "data:image/png;base64,...",
  "provider": "demo",
  "model": "schnell",
  "width": 1024,
  "height": 1024,
  "seed": 0
}
```

## 模型與尺寸

| UI 選項 | NVIDIA 尺寸 |
|---|---:|
| `square` | `1024×1024` |
| `landscape` | `1344×768` |
| `portrait` | `768×1344` |

| UI 模型 | NVIDIA endpoint |
|---|---|
| `schnell` | `https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell` |
| `dev` | `https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev` |

## 測試

```powershell
cd "D:\Users\Administrator\Desktop\圖片生成"
python -m pytest -q
node --test tests\frontend\generation-settings.test.cjs tests\frontend\history-store.test.cjs
```

### 產品化測試 Prompt 集

TASK-049 的回歸清單放在 `eval/product-test-prompts.json`，涵蓋短中文、長中文、PPT、IG、人像、產品照、動漫、文字渲染、Negative prompt、Seed、多張生成、Demo 模式、API 失敗、金鑰未設定、參考圖改圖與用量 Dashboard。每筆案例都有預期 UI / API 行為，可人工驗收；其中可離線判斷的 prompt 轉換條件會由驗證腳本自動檢查：

```powershell
python scripts\validate_test_prompts.py
```

### 錯誤情境測試矩陣

TASK-050 的錯誤情境回歸清單放在 `eval/error-scenarios.json`，涵蓋 API key 未設定、provider timeout / 500、rate limit、Turnstile、prompt moderation、雲端保存失敗、localStorage 滿、JSON 匯入錯誤、網路中斷、連點生成、手機版生成、清空歷史誤觸、參考圖用途缺漏、用量 Dashboard 讀取失敗、非生成分頁深連結被 onboarding 教學彈窗遮住、分享頁 prompt 隱私，以及雲端作品刪除 token 失效。驗證腳本會確認每個情境都有對應自動化測試或靜態證據：

```powershell
python scripts\validate_error_scenarios.py
```

## 檔案結構

```text
app/
  main.py                # FastAPI routes 與靜態檔服務
  image_service.py       # provider 選擇、驗證、NVIDIA 呼叫、錯誤映射
  demo_image.py          # 無金鑰時產生本機 Demo PNG
  prompt_transform.py    # 白話中文轉專業英文提示詞
  settings.py            # 環境設定
  static/
    index.html
    styles.css
    app.js
    prompt-transform.js  # 提示詞轉換前端互動
    generation-settings.js  # Seed、排除描述與設定序列化
    history-store.js     # 圖片歷史記錄 localStorage 儲存
    history-wall.js      # 歷史記錄牆 UI、下載、複製與再生
    tutorial.js          # 使用者教學彈窗
tests/
  test_app.py
  test_content_filter.py
  test_image_service.py
  test_prompt_transform.py
  test_static_ui.py
  frontend/
    generation-settings.test.cjs
    history-store.test.cjs
cloudflare/
  README.md              # Cloudflare Workers 版部署與同步功能說明
```

## 參考

- NVIDIA FLUX.1-schnell API：`https://docs.api.nvidia.com/nim/reference/black-forest-labs-flux_1-schnell-infer`
- NVIDIA FLUX.1-dev API：`https://docs.api.nvidia.com/nim/reference/black-forest-labs-flux_1-dev-infer`
