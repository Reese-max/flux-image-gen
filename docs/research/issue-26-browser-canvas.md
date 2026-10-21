# #26 Browser Canvas 窄研究：NARROW

2026-10-04，在 `main@dfadcf30ca1d3daf479e05dd97aa457afa265333` 的隔離
Linux 環境實際啟動 Chromium。此交付只包含可重播研究腳本與結果，沒有新增產品入口。

先前研究的 Browser Canvas 環境阻塞已在本環境排除。三個非敏感合成背景使用
本機 `Noto Sans CJK TC`，以 Canvas `fillText` 疊一行指定中文字，輸出 PNG：

| Fixture | 指定字串 | 尺寸 | PNG bytes | 本次執行時間 |
|---|---|---|---:|---:|
| poster | 明日開幕 | 480 × 600 | 10,945 | 87 ms |
| thumbnail | 三分鐘看懂 | 640 × 360 | 11,813 | 45 ms |
| social | 秋季限定 | 480 × 480 | 12,242 | 49 ms |

時間只涵蓋腳本中的本機處理與下載，沒有測量真人完成時間、外部工具切換時間或省時幅度。
圖片沒有使用真實生成 provider，也不是效能 benchmark。

## 已執行的邊界

- `3/3`：Canvas 收到 exact codepoint 字串；每個字元都有正寬度且 raster
  不同於未指派 codepoint 的 missing-glyph control。每張圖也不同於無字背景與
  故意改錯末字的 control。這不是 OCR 或人類可讀性研究。
- `3/3`：Chromium 的真正 download event 儲存檔案；PNG bytes 與 Canvas
  data URL 完全一致，IHDR 尺寸符合 fixture。
- `3/3`：直接使用 current-main `ImageHistoryStore` 在瀏覽器 localStorage
  保存 source + derived revision；export/import 後圖片 bytes、指定字串、
  `sourceRecordId`、`versionGroupId`、version 2 都保留。reload 後最後一組資料仍存在。
- 全程只允許 localhost 請求，沒有 provider、Cloudflare binding、transformation
  或第三方網路呼叫，沒有付費 usage。
- **未通過的產品契約**：current-main history normalization 會丟棄提交的
  `credentialStatus: unknown_after_transform`。輸出是重新編碼的合成 PNG；沒有
  含 C2PA 的 input fixture，因此不宣稱 upstream metadata 保留或 credential 有效。
  此限制需要與 #18 的既有 provenance candidate 協調。

## A / B / C 比較與決策

A（不改）維持生成背景、下載後用外部工具加字。本輪保留無字背景作 control，
沒有真人外部工具操作資料，因此 A 的實際痛點與切換成本仍為 unknown。

B（browser-local）已證明單行短中文字、固定位置、PNG 下載及現有 history
revision lineage 可以在本機完成。它不需要新增 image provider、帳號或 storage service。

C（Cloudflare Images）沒有執行：B 的這個有界 primitive 已可用，没有證據需要
增加 binding／transformation 費用來解決該 primitive 的問題。

**NARROW**：保留「單行短標題 + 少數固定樣式／位置 + 另存 derived PNG」方向。
目前不能升格 BUILD：未測手機／鍵盤 finishing UX、真實含 credential 的圖片、
current-main 的 transform evidence roundtrip，也沒有真人使用頻率與 A/B 操作時間。
若這些後續證據支持功能，先消除 credential invalidation 的遺失，再考慮薄的 preset；
不需要完整 layers/editor、Cloudflare Images 或持久 session 系統。

Issue 保持 `RESEARCH / NEEDS_EVIDENCE`；沒有實作產品控制、合併、部署或公開寫入面。

## 重播

需要已安裝的 Node、Chromium 與本機 Noto Sans CJK TC。腳本對字型不可用明確失敗，
不以 fallback tofu 當成功。

```sh
npm ci --prefix cloudflare
npm --prefix cloudflare run qa:browser:install
node scripts/research-text-overlay.mjs
```

前兩步是環境準備；實驗本身拒絕非 localhost 網路。
PNG 與 `result.json` 存於 `output/research/text-overlay/`，不影響產品 history。

本次環境：Node `v24.19.0`、Chromium `149.0.7827.55`。原始 history-store
SHA-256 與每張輸出 hash 見 [結果 receipt](issue-26-browser-canvas-result.json)。
本機字型檔 `NotoSansCJK-Regular.ttc` 的 SHA-256 是
`b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a`。
不同 Chromium／字型版本可改變 raster bytes；hash 是本次 receipt，並非跨環境 golden。
