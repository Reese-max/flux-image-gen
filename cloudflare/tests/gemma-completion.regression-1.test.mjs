import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Regression: ISSUE-001 — the 31B completion model exceeded the 5-second UI budget
// Found by /qa on 2026-07-14
// Report: .gstack/qa-reports/qa-report-flux-image-gen-irisx-tracker-workers-dev-2026-07-14.md
test('production uses the faster Gemma 4 MoE model for completion', async () => {
  const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');

  assert.match(wrangler, /^GEMINI_COMPLETE_MODEL = "gemma-4-26b-a4b-it"$/m);
});
