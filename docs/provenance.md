# 來源與驗證（Issue #18）

此功能提供本產品的未簽章稽核收據與 upstream C2PA 驗證。SHA-256 相符只表示目前圖片與收據一致；使用者可修改資料並重新計算收據，因此不證明作者、畫面真實性或跨環境逐像素重現。未進行 C2PA signing、正式信任清單整合或 conformance 認證。

## 收據與保存

`app/static/provenance.js` 定義 `receipt_schema_version: 1`，沿用 history schema v2 的可選 `provenance` 欄位。舊作品不會補造來源。每次生成、批次、版本再生與改圖建立新 record；既有 `createVersionRecord()` 分配版本，子收據保存 source record IDs、parent receipt hash 與 version group，保留父作品。

收據包含 record ID、provider、實際上游 model、seed/size/width/height/steps/cfg/mode、時間、原圖 SHA-256、兩種 prompt 的 SHA-256、app version、可取得的 build version、可取得的 model revision、credential status 與收據本身的 SHA-256。Python 與 Worker provider 在共用的 generation result 回報實際 payload 設定；未提供的 revision、build ID 或 provider 預設參數保留空值，不以 UI 請求值猜測。收據使用排序後的 canonical JSON 計算雜湊，不包含自己的 `receipt_sha256` 欄位。

作品先同步保存含 `unsupported` 狀態的待完成收據，之後補雜湊與檢查結果。憑證檢查上限為 15 秒；SDK 失敗或檢查逾時不會刪除作品、不會重送生成／改圖請求。完成前重新整理仍保留作品，載入時依時間／版本順序恢復未完成收據；完成前詳情顯示無法驗證。儲存仍受既有 localStorage 容量與保留筆數限制。

HTTPS provider 圖片 URL 只能由瀏覽器以 CORS 讀取，省略 cookies、referrer 並拒絕 redirect，限制 15 秒與 24 MiB；可讀取時轉成保留原始 bytes 的 data URL。沒有 server URL proxy。CORS、格式、大小或網路限制導致 bytes 無法取得時，保留歷史作品及明確的 `unsupported` 收據，`output_sha256` 留空，**不能宣稱 output hash verified**。這是無法取得原始 bytes 時的明確限制。

改圖在 canvas 之前雜湊原始檔案，並另計算上傳 `/edit` 的重編碼 PNG 雜湊，保存 `original_credential_status` 與 `resize_reencode`。不保存來源檔名、EXIF/GPS 或私人 assertions。`submitted_sha256` 指 API 上傳 bytes；Python 後端既有的再次縮圖／PNG 編碼仍可能改變 provider 最終輸入，並未宣稱兩者相同。

## Content Credentials

使用固定版本 `@contentauth/c2pa-web@0.15.3` 的真實 WASM validator，並開啟內容、簽章與信任驗證。SDK、module worker、WASM 與授權檔由 `cloudflare/scripts/build-provenance.mjs` 建置到 canonical `app/static/vendor/`，再由現有 sync-static 流程同步到部署資產。WASM 延後載入，約 9 MB，不加入 service-worker 預快取。部署 CSP 允許同源 module worker 與 `wasm-unsafe-eval`；不需要 CDN 或 `unsafe-eval`。本機 HTTP 使用 SDK 的 inline worker。

不下載 remote manifest、OCSP 或第三方驗證結果；圖片檢查全部在瀏覽器。本 MVP 未加入正式 trust list。受測試信任根明確信任的 fixture 才於該測試得到 `verified`；測試公用根憑證不載入產品的預設設定。

| 狀態 | 意義 |
| --- | --- |
| `verified` | 目前 validator 的內容／簽章／信任檢查通過 |
| `present_untrusted` | 可解析且內容／簽章有效，但未建立簽發者信任 |
| `invalid` | validator 回報內容、簽章、解析或其他驗證失敗 |
| `absent` | validator 成功檢查，目前 bytes 無可辨識 credential |
| `unknown_after_transform` | 已知 edit/re-encode 後無 credential；不可沿用來源 badge |
| `unsupported` | SDK、格式、大小、逾時或原始 bytes 不可用，無法判定 |

`absent` 不代表真人製作或非 AI。詳情重新檢查目前 bytes，輸出或收據被改動時顯示 `modified`，不信任匯入 JSON 自稱的 credential badge。

## 匯出、下載與分享

作品詳情可下載原圖、另外下載 `.receipt.json`，或匯出含原圖及收據的作品 JSON。data URL → Blob → download 不經 canvas，保留 upstream C2PA。單件作品 JSON 可由既有 `parseRecords()` 匯入；預設不公開 prompt，使用者明確選擇後才包含經敏感值過濾的 prompt。

分享維持原有 prompt privacy control。Worker 先執行既有 rate limit／gallery token 驗證，再核對收據與上傳 bytes 的 SHA-256；不相符回 `400 invalid_provenance` 且不寫 R2。公開 metadata 僅含 allowlisted provider/model、output/receipt hashes、時間、版本與 lineage；不含 prompt hashes、原始來源 metadata、delete URL、API key 或 Turnstile token。R2 原圖 bytes 與兩個雜湊一併保存。

Worker 未重跑 C2PA，因此分享頁明示 credential status 來自瀏覽器，並將瀏覽器自稱的 `verified` 降為 `present_untrusted`；公開 receipt hash 是對私人完整收據的承諾，不代表精簡公開 metadata 本身的 JSON 雜湊。舊客戶端未附收據的 gallery 儲存仍相容。

## 驗收與可重播證據

在 repo 根目錄執行（Git Bash 相容）：

```bash
node scripts/verify.mjs
```

這會執行既有 Python、前端與 Worker 測試，network/mobile/accessibility browser QA，新增的 `qa:provenance`，靜態同步、JS syntax、秘密掃描與部署 preflight。專案沒有獨立 lint、typecheck、coverage ratchet、CRAP 或 mutation 指令；未為本 issue 安裝額外品質工具。

本次基準為 238 Python／76 前端／138 Worker，共 452 個測試；完成後為 239／91／142，共 472 個，另有 1 個真實 provenance browser integration test、30 個 Python subtests，以及原有 3 組 browser QA。完整指令結束碼為 0。

真實 fixtures 位於 `tests/fixtures/provenance/`，`sources.json` 記錄 contentauth/c2pa-rs 的固定 commit、來源、SHA-256 與授權。`fixture-root.pem` 只含公用測試根憑證。瀏覽器測試使用真實 WASM、圖片與產品 UI／Worker handlers；AI 與 R2 是本機 fixture adapters，不產生付費呼叫。

| Issue 驗收條件 | 實作與檢查 |
| --- | --- |
| 每個新 generation/edit 有 versioned receipt | 同步 pending receipt、完成後 output/receipt SHA-256；單張、批次共用歷史事件；不可讀遠端 bytes 的限制如上 |
| input/source hashes，不帶 EXIF/GPS | canvas 前原始雜湊、API upload 雜湊；前端契約與真實 edit UI 測試 |
| 修改 output 不得維持 valid | 重算 output 與 canonical receipt、驗證 record ID；tamper regression |
| C2PA 解析與驗證，不假成功 | 真實 signed fixture、本機公用 trust anchor、竄改 entropy、SDK error/timeout 測試 |
| absent/invalid/unknown 分開 | 六種狀態、詳情說明與 canvas re-encode fixture |
| 原圖 download byte preserve | 真實 C2PA fixture 的 download/R2 roundtrip 逐 byte 比對 |
| 再生/edit 新收據連 parent | 既有版本函式；父資料不變、子 receipt hash/input/source/version 檢查 |
| Artwork JSON roundtrip、公開白名單 | export/import 後重新驗證；Worker metadata 與 share HTML 斷言 |
| prompt-private 可顯示來源 | private export、R2/share 實際 handlers，不含 prompt 全文 |
| sensitive URL/key/token 不外洩 | 白名單、敏感字串過濾、credential-like identifier regression、既有秘密掃描 |
| runtime generation/edit/share/download | Chromium UI、真實 SDK 與本機 Worker handlers 整合測試 |

未執行 Preview／Production 部署、遠端 CI、真實 provider 付費請求或正式信任清單驗收。本機 browser QA 不取代這些層級；#11 的部署安全邊界仍適用。
