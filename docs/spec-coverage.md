# FLUX 圖片產生器產品化規格覆蓋稽核

本文件用來追蹤 TASK-001～TASK-050 是否已由程式碼、UI、API、測試或部署文件覆蓋。狀態定義：

- **已覆蓋**：已有實作與自動測試或靜態驗證。
- **部分覆蓋**：已有 UI / API / 規則基礎，但仍缺少真實模型、真實雲端、登入系統或人工視覺驗證。
- **需部署驗證**：本機與 Worker 測試可過，但需要 Cloudflare 實際環境、R2 / D1 / KV / Turnstile 綁定或真實 provider 金鑰驗證。
- **需人工驗證**：需要人工看圖、看分享預覽、看行動裝置或確認外部服務行為。

## 目前自動驗證入口

- 全量驗證：`node scripts\verify.mjs`
- FastAPI / Python：`python -m pytest -q`
- 前端靜態與 store：`node --test tests/frontend/*.test.cjs`
- Cloudflare Worker：`npm --prefix cloudflare test`
- 部署前檢查：`docs/deployment-checklist.md`
- Release acceptance：`docs/release-acceptance-checklist.md`

## Milestone 1：P0 基礎可信度修正

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-001 ProviderStatus | 已覆蓋 | `app/static/app.js` 的 `providerStatus`、首頁 status pill、`tests/test_static_ui.py`、Worker health tests | 真實 provider 狀態仍需部署金鑰驗證。 |
| TASK-002 Health API | 已覆蓋、需部署抽驗 | `app/main.py` `/api/health`、`cloudflare/src/index.js` health route、`tests/test_app.py`、`cloudflare/tests/worker-transform.test.mjs`、`scripts/smoke_live_provider.py` | 已有部署 smoke 腳本；仍需對正式網址執行。 |
| TASK-003 GenerationState | 已覆蓋 | `app/static/app.js` 的 `generationState`、loading / retry / cancelled UI、靜態測試 | 長時間 provider timeout 需真實環境測。 |
| TASK-007 空狀態 | 已覆蓋 | `app/static/index.html` stage empty copy、結果操作成功後才顯示、靜態測試 | 無。 |
| TASK-038 API Key 安全檢查 | 已覆蓋 | 後端呼叫 provider、`.env.example`、錯誤遮罩、`scripts/scan_public_secrets.py`、`docs/deployment-checklist.md`、`node scripts\verify.mjs` | 已有公開 bundle / deployable source secret scan；Cloudflare production logs 仍需部署後抽查。 |

## Milestone 2：首頁新手流程重構

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-004 首頁第一屏 | 已覆蓋 | `app/static/index.html` hero 僅主打中文輸入、風格、用途、CTA；`tests/test_static_ui.py` | 實際首屏高度需行動裝置人工驗證。 |
| TASK-005 進階設定折疊 | 已覆蓋 | `advancedSettings` details、模型 / seed / negative / provider prompt / 尺寸 / 張數 | 無。 |
| TASK-006 固定生成按鈕 | 已覆蓋 | `mobileGenerateBar`、桌機浮動列 CSS、loading / retry 文案、`tests/e2e/mobile-generation-qa.mjs` | 仍建議真機滑動抽驗。 |
| TASK-008 中文一鍵生成 | 已覆蓋 | 中文 prompt 直接 compile + generate、provider prompt 預設隱藏、保留 original / final prompt | 真實 FLUX prompt 效果需人工看圖。 |
| TASK-011 中文一鍵強化按鈕 | 已覆蓋 | 首屏「幫我補完整」明確呼叫 `/prompt/complete`，進階區提供提示詞轉換與強化按鈕；靜態測試覆蓋事件綁定與忙碌狀態 | 無。 |

## Milestone 3：中文原生 Prompt 流程

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-009 Prompt Compiler | 已覆蓋 | `app/image_service.py` prompt compile、`cloudflare/src/image.js` transform、prompt tests | 規則式 compiler，不等同大型語言模型理解。 |
| TASK-010 Prompt 品質提示 | 已覆蓋 | prompt warning UI、矛盾 / 太短 / 文字風險提示測試 | 高階語義矛盾仍可能漏判。 |
| TASK-011 一鍵強化 | 已覆蓋 | 同 Milestone 2 TASK-011；中文補全與效果強化皆有 Gemini 優先、離線規則 fallback，缺少外部金鑰時仍可操作 | 真實 Gemini 改寫品質仍需部署抽驗。 |

## Milestone 4：用途導向模型與尺寸

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-012 用途導向模型 | 已覆蓋 | 模型 preset label、進階顯示實際 model、推薦理由 metadata | 模型可用性需 provider 金鑰驗證。 |
| TASK-013 用途尺寸 Presets | 已覆蓋 | `generation-settings.js`、FastAPI / Worker `SIZE_MAP`、自訂尺寸測試 | 特殊 provider 尺寸限制需實測。 |
| TASK-014 用途自動選擇 | 已覆蓋 | `inferUseCaseFromPrompt` / `sizePresetForUseCase`、靜態與前端測試 | 中文語句變體需持續擴充。 |

## Milestone 5：單一路徑生成

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-015 模式切換 | 已退役 | 首屏改為單一路徑，不再顯示名不副實的 AI 模式 | 無。 |
| TASK-016 AgentStep | 已退役 | Agent 進度面板與前端狀態程式已移除 | 無。 |
| TASK-017 需求解析 Agent | 已退役 | 規則式假分析已移除；用途改由使用者明確選擇 | 無。 |
| TASK-018 自動補全 Agent | 已替代 | 單一路徑沿用 `/prompt/transform`，失敗會保留輸入並顯示錯誤 | 需持續抽驗真實轉換品質。 |
| TASK-019 自動選模型與尺寸 Agent | 已替代 | `sizeForUseCase`／`applyUseCaseSize`；用途改變時帶入尺寸，手動尺寸不在送出時覆寫 | 無。 |
| TASK-020 智慧體多張生成 | 已替代 | `batchCount` 1～4、單張與 batch 路由、縮圖切換、下載與構圖鎖定 E2E | 真實多張仍會增加時間與額度。 |

## Milestone 6：品質檢查與最佳圖推薦

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-021 QAReport | 後端保留、前端退役 | 後端選用 `visionQa` 契約與測試保留；前端不主動請求，舊歷史 QAReport 仍可讀取 | 若未來重新公開，必須先啟用真實 Vision QA 並完成人工抽驗。 |
| TASK-022 最佳圖推薦 | 已退役 | 多張結果改由使用者直接挑選，不再顯示未經真實看圖驗證的推薦 | 無。 |
| TASK-023 自動重試策略 | 已退役 | 前端不再因假評分額外消耗一次生成額度 | 無。 |
| TASK-024 下一步修改建議 | 已退役 | 既有結果操作與「以這張構圖再變化」保留 | 無。 |

## Milestone 7：提示詞卡 / 風格卡 / 歷史

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-025 梗卡改名風格卡 | 已覆蓋 | UI 顯示「我的風格卡 / 提示詞卡」、別名保留 | 無。 |
| TASK-026 PromptCard schema | 已覆蓋 | `idea-store.js` / `idea-cards.js` schema、匯入 schema version 驗證 | 舊資料 migration 需用真實舊 localStorage 樣本驗證。 |
| TASK-027 成功後存風格卡 | 已覆蓋 | 結果操作「儲存成風格卡」、preview / seed / prompt 帶入 | 無。 |
| TASK-028 歷史記錄升級 | 已覆蓋 | `history-store.js`、搜尋 / 篩選 / 收藏 / 批次刪除 / migration tests | localStorage 滿載需瀏覽器人工測。 |

## Milestone 8：專案與雲端保存

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-029 專案概念 | 已覆蓋 | `project-store.js`、`project-board.js`、專案加入作品 / 卡片測試 | 無。 |
| TASK-030 雲端保存明確化 | 部分覆蓋、需部署驗證 | UI 隱私說明、Worker share / cloud API、local fallback | FastAPI 本機雲端保存可停用；真實 R2 分享連結需部署驗證。 |
| TASK-031 雲端資料架構 | 部分覆蓋、需部署驗證 | Worker R2 metadata、分享 prompt 隱藏、deployment checklist | D1 / KV 長期 metadata 與使用者設定仍是建議架構，非完整登入雲端產品。 |

## Milestone 9：參考圖與圖片編輯

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-032 參考圖上傳入口 | 已覆蓋 | `image-edit.js`、參考圖數量 / 格式 / 排序 / 移除測試 | 真實 provider image-to-image 支援需部署驗證。 |
| TASK-033 角色一致模式 | 部分覆蓋 | UI 要求參考圖、metadata 保存、提示不可保證完全一致 | 缺少真正角色一致模型評估。 |
| TASK-034 產品照模式 | 部分覆蓋 | 產品照模式 UI、背景 / 光線 / 尺寸、產品 metadata | 產品一致性評估仍偏規則式或文案。 |
| TASK-035 局部編輯預留介面 | 已覆蓋（以不誤導方式收斂） | 已移除無實作的 inpainting / 換背景 / 擴圖 / 去背 / 加文字 / 比例 stub；介面只保留可實際送出的通用、角色一致與產品照模式，`tests/test_static_ui.py` 驗證不再出現「即將推出」空承諾 | 若日後接入真正局部編輯模型，再以完整可用流程重新加入。 |

## Milestone 10：安全、成本、濫用防護

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-036 Rate Limit | 部分覆蓋、需部署驗證 | `app/rate_limit.py` 與 Worker rate limiter binding 同步保護生成、批次、改圖及可能消耗 Gemini 配額的提示詞轉換／補全／強化路由；rate limit tests | 無登入系統，因此已登入每日額度尚未實作。 |
| TASK-037 Turnstile | 部分覆蓋、需部署驗證 | `app/turnstile.py`、Worker Turnstile 驗證、`TURNSTILE_REQUIRED` checklist | 需要 Cloudflare site key / secret 實測。 |
| TASK-038 API Key 安全 | 已覆蓋 | 同 Milestone 1 TASK-038 | Cloudflare production logs 仍需部署後抽查。 |
| TASK-039 成本 Dashboard | 部分覆蓋 | `usage_metrics.py`、`usage-dashboard.js`、Worker usage logs | 成本估算需依實際 provider 價格校準。 |
| TASK-040 Prompt Moderation | 已覆蓋 | `app/moderation.py`、`cloudflare/src/moderation.js`、moderation tests | 高風險語意需持續補規則或接外部 moderation。 |

## Milestone 11：隱私、授權、使用條款

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-041 隱私說明 | 已覆蓋 | Footer / modal / cloud save before-confirm copy、靜態測試 | 需法務確認正式條款。 |
| TASK-042 授權與商用說明 | 已覆蓋 | Footer 授權入口、模型選擇授權提示 | 需依實際 provider TOS 更新。 |
| TASK-043 分享隱藏 prompt | 已覆蓋 | Worker share privacy tests、`promptPublic=false`、JSON 匯出提醒 | 私密作品授權需與未來登入系統整合。 |

## Milestone 12：行動版與無障礙

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-044 手機版重構 | 已覆蓋、需真機抽驗 | `tests/e2e/mobile-generation-qa.mjs`、mobile generate bar、卡片式結果、responsive CSS、靜態測試 | 已有 Chromium 行動 viewport E2E；仍建議 iPhone / Android Chrome 實機抽驗。 |
| TASK-045 無障礙改善 | 已覆蓋、需人工抽驗 | `tests/e2e/accessibility-keyboard-qa.mjs`、aria-live、aria-label、焦點、錯誤文字、鍵盤操作測試；已移除中文輸入框 Tab 攔截 | 已有瀏覽器鍵盤 E2E；仍建議螢幕閱讀器與色弱人工檢查。 |

## Milestone 13：SEO、分享與產品化

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-046 正式產品名稱與描述 | 已覆蓋 | `Fluxi` branding、meta title / description / OG / manifest / icon 測試 | OG 圖需部署 URL 實際可讀驗證。 |
| TASK-047 範例 Gallery | 已覆蓋 | 首頁 Gallery、八類分類、一鍵套用不自動生成測試 | 範例圖版權需人工確認。 |
| TASK-048 作品分享頁 | 部分覆蓋、需部署驗證 | Worker share page、模板套用、prompt 隱藏測試 | 分享連結與 OG 預覽需公開網域測試。 |

## Milestone 14：測試與驗收

| Task | 狀態 | 覆蓋證據 | 剩餘風險 |
|---|---|---|---|
| TASK-049 測試 Prompt 集 | 已覆蓋 | `eval/product-test-prompts.json`、`scripts/validate_test_prompts.py`、`tests/test_product_prompt_set.py` | 仍需定期人工抽看真實出圖。 |
| TASK-050 錯誤情境測試 | 已覆蓋 | `eval/error-scenarios.json`、`scripts/validate_error_scenarios.py`、`tests/test_error_scenarios.py`、`tests/e2e/network-interrupted-qa.mjs`、`scripts/smoke_live_provider.py`、`scripts/check_deployment_preflight.py`、`tests/frontend/history-store.test.cjs`、`tests/frontend/idea-store.test.cjs`、`tests/frontend/project-store.test.cjs` | localStorage quota 已覆蓋歷史、風格卡與專案 store；斷網已有本機 Playwright E2E，公開部署後仍建議用真實網域抽測。 |

## 已知最高價值後續缺口

1. **真實視覺 QA 部署驗證**：TASK-021 / TASK-023 已接可選 Gemini Vision QA 與自動重試分類；若要對外宣稱智慧體能可靠檢查手指、臉部、文字亂碼，仍需用真實 provider 圖片與 Gemini 金鑰做部署抽驗。
2. **部署驗證**：TASK-030 / TASK-031 / TASK-037 / TASK-048 需要真實 Cloudflare Workers、R2、Turnstile、provider secrets 驗證。
3. **登入與配額**：TASK-036 已有 IP / Worker 限制，但「已登入每日 N 次」需先建立帳號系統。
4. **參考圖一致性**：TASK-033 / TASK-034 有產品化 UI 與 metadata，但是否真的能維持角色 / 產品一致，取決於後端模型能力。
5. **法務與授權**：TASK-041 / TASK-042 已有產品文案，公開前仍應依實際 provider 條款做法務確認。
6. **Release acceptance**：`docs/release-acceptance-checklist.md` 已把正式網域 smoke、真機、雲端保存、分享隱私、Turnstile、Rate limit、成本與法務確認整理成公開前 Release blocker。
