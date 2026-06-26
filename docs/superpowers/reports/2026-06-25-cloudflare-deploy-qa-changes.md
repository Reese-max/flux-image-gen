# Cloudflare Deploy / Browser QA / Change List

Date: 2026-06-25
Project: D:\Users\Administrator\Desktop\圖片生成
Deployed URL: https://flux-image-gen.irisx-tracker.workers.dev
Cloudflare Version ID: 74127a49-c7fd-47b5-9250-44bcbee7fd94
QA screenshot: output/playwright/cloudflare-v14-qa.png

## Deployment

- Ran `npm test`: 17 passed.
- Ran `npm run check`: Checked 13 JavaScript files.
- Ran `npx wrangler deploy`.
- Wrangler printed deployment success and deployed trigger URL:
  - https://flux-image-gen.irisx-tracker.workers.dev
  - Version ID: 74127a49-c7fd-47b5-9250-44bcbee7fd94
- Note: Wrangler process returned exit code 1 despite success output, so deployed URL and `wrangler versions list` were used as live verification.

## Browser QA

Target: https://flux-image-gen.irisx-tracker.workers.dev

Passed checks:

- Home page loads.
- Manifest link exists.
- First-run tutorial modal can be closed.
- Prompt enhancer button click updates final prompt.
- History wall loads records from localStorage.
- Favorite star toggles.
- History search filters records.
- Model filter filters records.
- Artwork detail modal opens.
- Version comparison chips render.
- Tag editor saves tags.
- Share text copy works and hidden-prompt mode omits prompt text.
- Artwork JSON export downloads `history_qa-v2.json`.
- PWA service worker registers with site scope.
- Mobile bottom generate bar displays on 390px viewport.
- Screenshot saved to `output/playwright/cloudflare-v14-qa.png`.

No browser console or page errors were reported by the QA script.

## Feature-to-file mapping

### Prompt enhancer

- `app/static/prompt-enhancer.js`
- `tests/frontend/prompt-enhancer.test.cjs`
- `app/static/index.html`
- `app/static/app.js`
- `app/static/styles.css`
- Synced Cloudflare copies under `cloudflare/public/`.

### Failure advice

- `app/static/failure-advice.js`
- `tests/frontend/failure-advice.test.cjs`
- `app/static/app.js`
- `app/static/styles.css`
- Synced Cloudflare copies under `cloudflare/public/`.

### History metadata / versions / favorites / tags

- `app/static/history-store.js`
- `tests/frontend/history-store.test.cjs`
- `app/static/history-wall.js`
- `app/static/index.html`
- `app/static/styles.css`
- Synced Cloudflare copies under `cloudflare/public/`.

### Artwork detail modal / share / export / regenerate version

- `app/static/index.html`
- `app/static/history-wall.js`
- `app/static/app.js`
- `app/static/styles.css`
- `tests/test_static_ui.py`
- Synced Cloudflare copies under `cloudflare/public/`.

### PWA / mobile

- `app/static/manifest.webmanifest`
- `app/static/service-worker.js`
- `app/main.py`
- `app/static/index.html`
- `app/static/app.js`
- `app/static/styles.css`
- `tests/test_app.py`
- `tests/test_static_ui.py`
- `cloudflare/public/manifest.webmanifest`
- `cloudflare/public/service-worker.js`

### Cloudflare sync / static drift prevention

- `cloudflare/public/index.html`
- `cloudflare/public/manifest.webmanifest`
- `cloudflare/public/service-worker.js`
- `cloudflare/public/static/*`
- `cloudflare/tests/worker-transform.test.mjs`
- `cloudflare/scripts/check-js.mjs`

### Docs / implementation plan / report

- `docs/superpowers/plans/2026-06-25-creative-workspace-ux.md`
- `README.md`
- `cloudflare/README.md`
- `docs/superpowers/reports/2026-06-25-cloudflare-deploy-qa-changes.md`

### Safety / compatibility fixes

- `eval/eval_prompt_transform.py`
  - Removed API-key-shaped hardcoded default.
  - Now requires `CODEX_API_KEY` from environment.
- `app/static/prompt-transform.js`
- `app/static/idea-cards.js`
  - Replaced `async/await` with ES5-friendly Promise chains.
- `tests/test_static_ui.py`
  - Expanded production JS guard across `app/static/*.js`.

## Scope exclusions verified

- No local quota feature.
- No cooldown feature.
- No abuse-control / Turnstile / account system / public gallery feature.
- No `negative_prompt` provider send path.
- QA did not execute successful real NVIDIA image generation.
