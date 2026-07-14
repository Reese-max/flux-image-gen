import assert from 'node:assert/strict';
import test from 'node:test';
import { completePlainPrompt } from '../src/prompt.js';

// Regression: ISSUE-002 — repeated offline completion duplicated the same suffix
// Found by /qa on 2026-07-14
// Report: .gstack/qa-reports/qa-report-flux-image-gen-irisx-tracker-workers-dev-2026-07-14.md
test('offline completion is idempotent', async () => {
  const first = await completePlainPrompt('一隻橘貓在夜市', 'cinematic');
  const second = await completePlainPrompt(first.prompt, 'cinematic');

  assert.equal(second.prompt, first.prompt);
  assert.equal(second.prompt.match(/具有層次的電影光影/g)?.length, 1);
});
