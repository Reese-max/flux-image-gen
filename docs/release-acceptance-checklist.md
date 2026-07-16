# Fluxi Release Acceptance Checklist

這份 checklist 用於把 `docs/spec-coverage.md` 中仍標示「需部署驗證／需人工驗證／需真機抽驗／需法務確認」的項目，轉成公開發布前可逐項簽核的驗收表。

> 原則：自動化 gate 綠燈只代表可進入人工驗收；正式公開前仍需完成本文件中標為 **Release blocker** 的項目。

## 0. 自動化 gate

| 狀態 | 項目 | 命令 / 證據 | Release blocker |
|---|---|---|---|
| [ ] | 公開 bundle secret scan | `python scripts\scan_public_secrets.py` | 是 |
| [ ] | Cloudflare deployment preflight | `python scripts\check_deployment_preflight.py` | 是 |
| [ ] | Public Turnstile preflight | `python scripts\check_deployment_preflight.py --public`，需先設定 `TURNSTILE_REQUIRED = "true"` 與正式 `TURNSTILE_SITE_KEY` | 是 |
| [ ] | Wrangler 登入與設定診斷 | `npm --prefix cloudflare run check:wrangler`，需確認 `wrangler whoami` 與 `wrangler deploy --dry-run` 都可驗證；診斷輸出需遮罩帳號 email / account id / token | 是 |
| [ ] | 全量 verify | `node scripts\verify.mjs` | 是 |
| [ ] | Wrangler dry-run | `npm --prefix cloudflare run deploy:dry-run` | 是 |
| [ ] | Node LTS for Wrangler | 若 Wrangler dry-run crash，需改用 Node 20 或 22 LTS 後重跑 `check:wrangler` 與 `deploy:dry-run` | 是 |
| [ ] | 乾淨部署來源 | 正式 deploy 前 `git status --porcelain` 必須無輸出；wrapper 通過 readiness gate 後才可用 HEAD 標記版本 | 是 |
| [ ] | 固定 production 目標 | Wrapper 只接受無參數正式 deploy 或 `--dry-run`；不得用 `--env`、`--name`、`--config`、自訂 entrypoint、`--tag` 或 `--message` 改寫目標／版本對照 | 是 |
| [ ] | Production secrets inventory | `node cloudflare\scripts\check-deploy-readiness.mjs` 唯讀確認 `TURNSTILE_SECRET_KEY`、`GALLERY_TOKEN_SECRET`、`GALLERY_ADMIN_TOKEN`、`NVIDIA_API_KEY`、`GEMINI_API_KEY` 全部存在；輸出不得含 secret 值 | 是 |
| [ ] | GitHub Actions CI | `.github/workflows/ci.yml` 的 `verify` job 在目標 commit 通過；repo 尚無 remote 時不得勾選 | 是 |
| [ ] | Version metadata／observability | `wrangler.toml` 有 `CF_VERSION_METADATA` 與取樣後 Workers Logs；部署後 health 可對應 active Version ID | 是 |
| [ ] | Rollback rehearsal | 依 `docs/deployment-checklist.md` 執行 `wrangler versions list`／`wrangler versions view` 的唯讀步驟，確認已知正常版本與 `wrangler rollback <VERSION_ID>` 指令；不要為演練真的 rollback | 是 |

## 1. 正式網域與 health / provider 一致性

| 狀態 | 項目 | 驗收方式 | 對應任務 | Release blocker |
|---|---|---|---|---|
| [ ] | 正式網址可讀 `/api/health` | `python scripts\smoke_live_provider.py --base-url https://<正式網域> --expect-mode live` | TASK-001, TASK-002 | 是 |
| [ ] | Health 不混用 Demo / Live 文案 | 確認首頁同一時間只顯示一種主狀態；不得同時出現「Demo 模式」與「真實出圖」 | TASK-001 | 是 |
| [ ] | Live 出圖一致性 | 明確授權成本後執行：`python scripts\smoke_live_provider.py --base-url https://<正式網域> --expect-mode live --check-generate --confirm-cost` | TASK-002, TASK-008 | 是 |
| [ ] | Provider timeout / 5xx 友善錯誤 | 用 staging 或 mock upstream 驗證不白屏、不暴露 stack trace / key | TASK-003, TASK-050 | 是 |
| [ ] | Cloudflare production logs 抽查 | 取樣確認沒有完整 API key、prompt 敏感全文、原始 IP | TASK-038, TASK-039, TASK-040 | 是 |

## 2. 新手首頁與中文一鍵生成

| 狀態 | 項目 | 驗收方式 | 對應任務 | Release blocker |
|---|---|---|---|---|
| [ ] | 首屏新手流程 | 桌機與手機第一屏只看到中文輸入、風格、用途、生成 CTA；進階設定預設收起 | TASK-004, TASK-005 | 是 |
| [ ] | 中文一鍵生成品質 | 用 `eval/product-test-prompts.json` 抽 5 則短中文 prompt，人工看圖確認主體、場景、構圖合理 | TASK-008, TASK-009, TASK-049 | 是 |
| [ ] | Prompt 品質提示 | 短 prompt / 矛盾 prompt 顯示可忽略警告，不阻斷主流程 | TASK-010 | 否 |
| [ ] | 一鍵強化按鈕 | 桌機與手機驗證「幫我補完整、寫實、動漫、產品照、簡報插圖、避免 AI 味」可更新描述或 prompt | TASK-011 | 否 |

## 3. 手機與無障礙人工抽驗

| 狀態 | 項目 | 驗收方式 | 對應任務 | Release blocker |
|---|---|---|---|---|
| [ ] | iPhone Safari | iPhone 尺寸完成：輸入中文 → 生成 → 多張左右滑 → 下載或長按保存 | TASK-006, TASK-044 | 是 |
| [ ] | Android Chrome | Android Chrome 完成：輸入中文 → 生成 → 固定底部列可用 → 結果卡可操作 | TASK-006, TASK-044 | 是 |
| [ ] | 鍵盤主流程 | 不用滑鼠完成輸入、生成、下載 / 複製 prompt；Tab 順序合理 | TASK-045 | 是 |
| [ ] | 螢幕閱讀器 | NVDA 或 VoiceOver 確認錯誤、loading、成功狀態會被讀到 | TASK-045 | 是 |
| [ ] | 色弱 / 對比 | 狀態不只靠顏色；文字對比可讀，焦點框清楚 | TASK-045 | 是 |

## 4. 單一路徑與多張生成

| 狀態 | 項目 | 驗收方式 | 對應任務 | Release blocker |
|---|---|---|---|---|
| [ ] | 用途帶入尺寸 | 變更用途時帶入對應尺寸；之後手動改尺寸，生成前不再覆寫 | TASK-013, TASK-014 | 是 |
| [ ] | 張數明確可控 | 預設 1 張；進階設定可選 1～4 張，送出路由與 `count` 正確 | TASK-020 | 是 |
| [ ] | 多張結果操作 | 每張可切換主預覽、下載並鎖定目前構圖；不顯示未經看圖驗證的最佳圖推薦 | TASK-020, TASK-022 | 是 |
| [ ] | 舊智慧體紀錄相容 | 既有 Agent / QAReport 歷史紀錄仍可載入與查看，不需資料遷移 | TASK-021, TASK-026 | 否 |

## 5. 風格卡、歷史、專案與 localStorage

| 狀態 | 項目 | 驗收方式 | 對應任務 | Release blocker |
|---|---|---|---|---|
| [ ] | 舊資料 migration | 用一份舊 localStorage 樣本驗證歷史與風格卡 migration | TASK-026, TASK-028 | 是 |
| [ ] | localStorage quota | 用瀏覽器人工灌滿 localStorage，確認歷史 / 風格卡 / 專案會保留新資料並友善降載 | TASK-028, TASK-050 | 是 |
| [ ] | 風格卡 JSON 匯入 / 匯出 | 匯出會提醒含完整 prompt；匯入 schema version 錯誤會友善失敗 | TASK-026, TASK-027 | 是 |
| [ ] | 專案整理 | 建立專案、加入作品與風格卡、從專案繼續生成 | TASK-029 | 否 |

## 6. 雲端保存、分享與圖庫管理

| 狀態 | 項目 | 驗收方式 | 對應任務 | Release blocker |
|---|---|---|---|---|
| [ ] | R2 gallery save | 正式 Worker + R2 綁定後，保存作品成功回分享頁與刪除連結 | TASK-030, TASK-031 | 是 |
| [ ] | 雲端保存失敗 fallback | 模擬 R2 失敗，確認本機歷史保留且錯誤友善 | TASK-030, TASK-050 | 是 |
| [ ] | 分享頁隱藏 prompt | `promptPublic=false` 時分享頁不顯示完整 prompt，也不把 prompt 放進模板 URL | TASK-043, TASK-048 | 是 |
| [ ] | 分享頁公開 prompt | 使用者明確公開時才顯示 prompt；HTML escape 正確 | TASK-043, TASK-048 | 是 |
| [ ] | OG / social preview | 正式網域分享到 Discord / LINE / X，確認 title、description、OG image 可讀 | TASK-046, TASK-048 | 是 |
| [ ] | 站長雲端圖庫 | 用量分頁手動輸入 `GALLERY_ADMIN_TOKEN` 可讀 `/api/gallery`；不得顯示 `deleteTokenHash` 或未公開 prompt | TASK-039, TASK-043 | 是 |

## 7. 參考圖與圖片編輯

| 狀態 | 項目 | 驗收方式 | 對應任務 | Release blocker |
|---|---|---|---|---|
| [ ] | 參考圖上傳 | 1–4 張、格式、大小、排序、移除皆可用；失敗有明確提示 | TASK-032 | 是 |
| [ ] | 角色一致模式 | 至少一張角色圖才可送出；UI 明確說明不能保證完全一致 | TASK-033 | 否 |
| [ ] | 產品照模式 | 產品圖 + 背景 + 光線 + 用途尺寸可生成；結果保存產品 metadata | TASK-034 | 否 |
| [ ] | 未完成編輯入口不得誤導 | 局部修改、換背景、擴圖、去背、加文字、調整比例若尚未接入完整模型流程，不得顯示可點擊入口或「即將推出」空承諾；目前版本應只顯示可實際送出的通用、角色一致與產品照模式 | TASK-035 | 是 |

## 8. 安全、成本與濫用防護

| 狀態 | 項目 | 驗收方式 | 對應任務 | Release blocker |
|---|---|---|---|---|
| [ ] | Turnstile 真實驗證 | 正式 site key / secret 啟用；未通過不得呼叫 `/generate`、`/generate/batch`、`/edit` | TASK-037 | 是 |
| [ ] | Rate limit | 超過限制回 `429 rate_limited`，不暴露內部錯誤；Worker binding 生效 | TASK-036 | 是 |
| [ ] | Prompt moderation | 高風險 prompt 不呼叫 provider；log 不保存敏感全文 | TASK-040 | 是 |
| [ ] | 成本 Dashboard | 今日生成次數、失敗次數、估計成本、模型用量、錯誤率、平均生成時間可查 | TASK-039 | 是 |
| [ ] | 成本估算校準 | 用實際 provider 價格更新 `USAGE_ESTIMATED_COST_USD_PER_IMAGE` 與 `USAGE_ESTIMATED_PROMPT_COST_USD_PER_REQUEST`；維持 `0` 時只能宣稱已記嘗試，不可宣稱 prompt／Vision 成本完整 | TASK-039 | 是 |

## 9. 隱私、授權與內容來源

| 狀態 | 項目 | 驗收方式 | 對應任務 | Release blocker |
|---|---|---|---|---|
| [ ] | 隱私政策法務確認 | 確認 prompt / 圖片第三方傳輸、localStorage、雲端保存、刪除方式、訓練用途敘述符合實際服務 | TASK-041 | 是 |
| [ ] | 授權與商用說明法務確認 | 依實際 NVIDIA / Cloudflare Workers AI / Gemini 條款更新商用限制、禁止用途與 AI 標示建議 | TASK-042 | 是 |
| [ ] | Gallery 範例素材權利 | 首頁範例圖、OG 圖、icon / favicon 權利可公開使用 | TASK-046, TASK-047 | 是 |
| [ ] | JSON 匯出提醒 | 匯出作品 / 風格卡 JSON 前提醒可能包含 prompt 與 metadata | TASK-026, TASK-043 | 是 |

## 10. Sign-off

| 角色 | 姓名 / 帳號 | 日期 | 備註 |
|---|---|---|---|
| Engineering |  |  |  |
| Product / UX |  |  |  |
| Security / Ops |  |  |  |
| Legal / Policy |  |  |  |

## Release 判定

- **可公開**：所有 Release blocker 皆完成，且 GitHub Actions CI、`node scripts\verify.mjs`、`python scripts\check_deployment_preflight.py --public`、乾淨部署來源、production secrets inventory、正式網址 health smoke 與版本 metadata 對照皆通過。
- **可內部預覽**：自動化 gate 通過，但真機、法務或正式網域項目尚未完成；需限制分享範圍與額度。
- **不可公開**：任一安全、金鑰、Turnstile、Rate Limit、分享隱私、白屏、成本失控項目未通過。
