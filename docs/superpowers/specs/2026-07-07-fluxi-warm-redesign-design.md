# Fluxi 溫暖創作風改版設計（2026-07-07）

## 背景與目標

- 定位：**公開上線給一般大眾**的中文 AI 圖片生成器。
- 使用者決策：大幅換風格 → **溫暖創作風**；功能調整四項全做（簡化生成首屏、資訊架構精簡、清除樁按鈕、行動版修整）；**FastAPI 版與 Cloudflare 版同步**。
- 執行方案 B：兩階段。階段一「換膚」（DOM 幾乎不動、測試照跑），階段二「重組」（資訊架構＋首屏，連動改測試）。
- 回退點：commit `b54d8e1`。

## 視覺系統（階段一核心）

### 設計 tokens（`:root`，全面取代現有深色 token）

色彩——奶油紙感底、陶土橘主色、暖棕文字：

```css
--bg: #FAF5EE;            /* 頁面底：奶油紙感 */
--bg-2: #F3EBDF;          /* 次層底：淺杏 */
--surface: #FFFFFF;       /* 卡片 */
--surface-2: #FDFAF4;     /* 卡片內次區塊 */
--line: #E9DFCF;          /* 邊線 */
--line-2: #D8CBB5;        /* 強邊線 */
--text: #3B3229;          /* 主文字：深暖棕 */
--muted: #74685A;         /* 次文字 */
--faint: #A29377;         /* 弱文字（僅裝飾性文字，勿用於必讀資訊） */
--accent: #D96C43;        /* 主色：陶土橘 */
--accent-2: #C25A33;      /* 主色 hover/深 */
--accent-ink: #FFF9F4;    /* 主色上的文字 */
--accent-soft: #F9E4D8;   /* 主色淡底（selected/tag） */
--sage: #6F8F65;          /* 輔色：鼠尾草綠 = 成功/done */
--sage-soft: #E7EEE2;
--sun: #E0A431;           /* 暖黃 = 警示/busy/demo 提示 */
--sun-soft: #F9EED3;
--danger: #BF4B38;        /* 失敗/危險 */
--danger-soft: #F6DFD9;
--violet / --magenta：移除（不再使用螢光紫/洋紅）。
```

- 對比要求：`--text` on `--bg` ≥ 10:1；`--muted` on `--surface` ≥ 4.5:1；`--accent-ink` on `--accent` ≥ 4.5:1。所有狀態色配 `-soft` 底時文字用深色版本。
- 狀態語意：`.status.busy`=sun、`.done`=sage、`.fail`=danger、`.warn`=sun；pill `.online`=sage、`.degraded`=sun、`.demo`=sun、`.offline`=danger。

字型／圓角／陰影／間距：

```css
--font: 系統棧不變（效能決策維持，不引外部字型）；標題 700–800、body 1.6 行高
--mono: 保留（badge/eyebrow/數據）
--radius-lg: 24px; --radius: 16px; --radius-sm: 10px;（膠囊 999px 僅按鈕/pill）
--shadow: 0 10px 30px rgba(93, 64, 38, .10);（暖棕軟陰影）
--shadow-sm: 0 2px 8px rgba(93, 64, 38, .08);
--space-1..8: 4/8/12/16/24/32/48/64px（新增間距 scale，重寫時逐步採用）
--ease 保留
```

質感與氛圍：

- 移除深色 aurora 光暈與玻璃擬態 backdrop-blur；`.glass` class 名保留（測試/JS 可能引用），視覺改為「白卡＋暖邊線＋軟陰影」。
- 背景：`--bg` 底＋既有 SVG grain 噪點調至極淡（不透明度 ≤ .35）＋兩顆極淡桃/杏色 blob（模糊、不動畫或極慢），維持「紙上創作」氛圍。
- 手作感細節：區塊分隔可用 1px `--line`；「我的風格卡」等自訂區塊可用虛線邊框（`border: 1.5px dashed var(--line-2)`）表達「可自行貼上」。
- 動效：卡片 hover 微上移 2px＋陰影加深；按鈕 active scale(.98)；全部尊重既有 `prefers-reduced-motion` 規則。
- 深色模式：**本次不做**（亮色定位）；列入後續事項。

## 階段一範圍（換膚＋清雜訊＋行動版）

1. **styles.css 全面重寫**成上述 token 系統。硬規則：**不得改動任何 class 名／DOM hooks**（JS 與測試綁定），只改視覺宣告。散落的硬編碼色（slate 系 `rgba(15,23,42,…)`、`#f87171`、`#fbbf24`、`#93c5fd` 等）全數收斂進 token。圓角魔術數字收斂到三檔。`.mobile-generate-bar` 的三處重複定義整併為一處＋media query。
2. **index.html 小改**：
   - 移除 AI 改圖分頁 6 個 disabled「即將推出」樁按鈕（約 `index.html:425-432`）及其容器標題。
   - `<meta name="theme-color">` 改 `#FAF5EE`；title/文案不動。
3. **manifest.webmanifest**：`theme_color`/`background_color` 同步新色。
4. **service-worker.js**：cache 版本字串 bump（避免舊 CSS 快取蓋掉新版）。
5. **行動版修整**：
   - 修頁面橫向溢出（截圖已見橫向捲軸；檢查 hero大字、tab 列、composer 內 clamp 與固定寬元素，`html,body { overflow-x: clip }` 為最後保險而非唯一手段）。
   - 底部固定生成列重排：只留「主生成鈕（全寬）＋一行狀態摘要」，移除目前擠壓換行的「自動判斷｜自動判斷」文字。
   - 觸控目標 ≥ 44×44px（tab、mini 按鈕、範例卡按鈕）。
   - 分頁列：手機改單列橫向滑動＋右緣漸層提示（取代四等分擠壓）。
6. **兩版同步**：`app/static/*` → `cloudflare/public/static/*`；`app/static/index.html` 的變更以相同 patch 應用到 `cloudflare/public/index.html`；`manifest`/`service-worker` 兩邊同步。同步後 `diff -r` 驗證（index.html 允許既有的兩版差異，逐段核對本次改動已入）。

### 階段一驗收

- `python -m pytest tests/test_static_ui.py tests/test_app.py`（不因換膚失敗）。
- `node --test tests/frontend/`。
- Playwright：桌機 1280 與手機 390 寬截圖（生成／改圖／歷史／用量），逐張目檢；手機無橫向捲軸（`document.documentElement.scrollWidth <= innerWidth`）。
- 對比抽驗：主文字/次文字/按鈕文字對比比值。
- 驗收由非實作者執行（fresh-context reviewer agent 或主對話目檢）。
- 過關即 commit（`feat(ui): 溫暖創作風視覺系統`）。

## 階段二範圍（資訊架構＋首屏）

1. **分頁 6 → 4**：`生成圖片｜AI 改圖｜專案｜歷史作品`。
   - 「靈感」併入生成分頁：範例 Gallery 上方加「靈感」區塊（內建 11 顆靈感鈕＋我的風格卡），原 `#panel-ideas` 內容搬移，`#ideas` hash 重導向到生成分頁並捲動至該區。
   - 「用量」（站長工具）移出主導覽：footer 加「站長工具」連結，`#usage` hash 直達仍可用（tabs.js 支援無 tab 按鈕的 panel 顯示）。
2. **首屏簡化（漸進揭露）**：
   - 預設可見：中文輸入框＋主生成鈕＋（手機）底部列。
   - 「一般/智慧體模式、風格、用途」收成輸入框下方一行緊湊「選項列」（chips／小型 select），視覺降級為次要。
   - 進階設定 `<details>` 維持既有結構。
3. **連動更新**：`tabs.js` 過時註解與數字鍵（1–4）、`tutorial.js` 教學文案中的分頁說明、相關測試（`test_static_ui.py`、frontend tests、e2e QA 腳本）。
4. **兩版同步**：同階段一流程。

### 階段二驗收

- 全測試套件（Python＋frontend＋cloudflare worker tests）。
- e2e：`tests/e2e/mobile-generation-qa.mjs`、`accessibility-keyboard-qa.mjs`（若腳本綁舊分頁需先更新）。
- Playwright 截圖目檢：4 分頁桌機/手機、#usage 直達、#ideas 重導向。
- 過關即 commit（`refactor(ui): 資訊架構精簡與首屏漸進揭露`）。

## 風險與對策

| 風險 | 對策 |
|---|---|
| 兩版鏡像漂移 | 每階段同步後 `diff -r app/static cloudflare/public/static` 驗證 |
| Service worker 舊快取 | cache 版本 bump＋驗收時強制 reload |
| 測試綁 class/DOM | 階段一不動 DOM；階段二先跑測試列失敗清單再逐一更新 |
| Edit 工具 CRLF 全檔轉換（踩雷 §21） | commit 前 `git diff --stat` 驗行數異常 |
| 對比不足（亮色系常見） | token 定案時抽驗對比比值 ≥ 4.5:1 |

## 後續事項（本次不做）

- 深色模式（`prefers-color-scheme`）。
- 歷史＋專案合併為「作品」單一分頁（牽動 JS 較大，觀察使用行為後再決定）。
- 建立 `scripts/sync-static` 自動同步腳本。
