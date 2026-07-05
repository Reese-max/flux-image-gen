# AI 圖片產生器（FastAPI 版）

這是依照參考站 `https://tonny-0955--flux-image-gen-web.modal.run` 製作的本機 FastAPI 版圖片生成網站。

- 前端：單頁深色 UI、prompt、模型選擇、尺寸選擇、Seed、排除描述輔助、點子卡、隨機提示詞、下載、複製與再生。
- 後端：`POST /generate`，接收 `prompt / model / size / seed`，回傳 `{ image, provider, model, width, height, seed }`。
- 無金鑰：自動使用本機 Demo PNG fallback，方便先驗證網站流程。
- 有金鑰：設定 `NVIDIA_API_KEY` 後，會改走 NVIDIA FLUX API。

## 新功能

- AI 改圖（`POST /edit`）：上傳 1–4 張自訂圖片＋文字指令，交給 Cloudflare Workers AI FLUX.2 klein 做指令式編輯（換色、換背景、多圖合成、風格轉移）。前端會先把每張圖等比縮到 <512×512 再上傳；需設定 `CF_ACCOUNT_ID` / `CF_API_TOKEN`，未設定時回乾淨 503。（NVIDIA hosted 的 flux.1-kontext-dev 只支援內建範例圖、無法上傳自訂圖，故改走 Workers AI。）
- 白話中文轉專業英文提示詞：`POST /prompt/transform` 可把中文想法轉成更適合圖片模型的英文 prompt，並可搭配風格參數調整語氣。
- Tab 中文補全：在白話中文輸入框按 `Tab` 會呼叫 Gemma（預設 `GEMINI_COMPLETE_MODEL=gemma-4-26b-a4b-it`）把短中文描述補成更完整的繁中畫面描述。
- 客製梗卡：前端使用 `localStorage` 儲存使用者自己的點子卡，支援新增、編輯、刪除、匯出與匯入，重新整理頁面後仍會保留。
- 使用者教學：第一次進站會自動顯示教學，也可以隨時按右上角「？教學」重新開啟。

## 迭代體驗功能

FastAPI 版與 `cloudflare/` Cloudflare Workers 版同步支援以下功能：

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

不包含每日額度、冷卻、防濫用、帳號系統或公開作品牆。

## 品質 QA、效能與錯誤監控

- 線上功能 QA：Cloudflare 版提供 `npm run qa:browser`，會實際點擊 Prompt 強化器、歷史牆、詳情面板、標籤、PWA 與手機底部生成列。
- 線上效能 QA：Cloudflare 版提供 `npm run qa:perf`，會量 TTFB、FCP、LCP、CLS、資源數與傳輸量，輸出到 `cloudflare/output/playwright/cloudflare-perf-qa.json`。
- 錯誤監控：前端會把 `window.error`、`unhandledrejection` 與生成 API 失敗送到同源 `POST /client-error`；Worker 會回 `x-request-id` 並記錄已截斷的白名單欄位。
- 效能最佳化：已移除 Google Fonts 外部字型，改用系統字型，降低首屏 payload。
- 變更清單：本輪提交包在 `docs/release-package-2026-06-25.md`，版本紀錄在 `CHANGELOG.md`。

## 專案位置

```powershell
D:\Users\Administrator\Desktop\圖片生成
```

## 部署狀態

目前完成且已驗證的主要路徑包含 **FastAPI 版**（`app/`、`tests/`）與 **Cloudflare Workers 版**（`cloudflare/`）。兩個版本同步支援白話中文轉專業英文提示詞、客製梗卡、使用者教學與迭代體驗功能。

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

### `POST /prompt/transform`

把白話中文描述轉成專業英文提示詞。

Request：

```json
{
  "source": "一隻可愛柴犬在月球上吃拉麵",
  "style": "cute"
}
```

### `POST /prompt/complete`

把短中文描述補成較完整的繁體中文畫面描述；供前端 `plainPrompt` 按 `Tab` 使用。

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

Response：

```json
{
  "source": "一隻可愛柴犬在月球上吃拉麵",
  "prompt": "Shiba Inu, dog, on the moon, eating ramen, adorable, soft rounded shapes, warm pastel colors, highly detailed",
  "provider": "rule_based",
  "warnings": []
}
```

### `POST /generate`

Request：

```json
{
  "prompt": "a cute corgi astronaut floating in space",
  "model": "schnell",
  "size": "square",
  "seed": 0
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
node --test tests\frontend\idea-store.test.cjs tests\frontend\generation-settings.test.cjs tests\frontend\history-store.test.cjs
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
    idea-store.js        # 客製點子卡 localStorage 儲存
    idea-cards.js        # 點子卡 UI 操作
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
    idea-store.test.cjs
cloudflare/
  README.md              # Cloudflare Workers 版部署與同步功能說明
```

## 參考

- NVIDIA FLUX.1-schnell API：`https://docs.api.nvidia.com/nim/reference/black-forest-labs-flux_1-schnell-infer`
- NVIDIA FLUX.1-dev API：`https://docs.api.nvidia.com/nim/reference/black-forest-labs-flux_1-dev-infer`
