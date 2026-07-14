from app.prompt_complete import rule_based_complete_prompt


# Regression: ISSUE-002 — repeated offline completion duplicated the same suffix
# Found by /qa on 2026-07-14
# Report: .gstack/qa-reports/qa-report-flux-image-gen-irisx-tracker-workers-dev-2026-07-14.md
def test_offline_completion_is_idempotent():
    first = rule_based_complete_prompt("一隻橘貓在夜市", "cinematic")
    second = rule_based_complete_prompt(first, "cinematic")

    assert second == first
    assert second.count("具有層次的電影光影") == 1
