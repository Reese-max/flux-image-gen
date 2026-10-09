"""Fixed policy examples shared with the Worker; no production provider calls."""
import json
from pathlib import Path
import unittest

from app.moderation import moderate_prompt


class ModerationFormatParityTests(unittest.TestCase):
    def test_fixed_format_and_adjacent_policy_examples(self):
        fixture = json.loads((Path(__file__).parent / "fixtures" / "moderation-cf-parity.json").read_text(encoding="utf-8"))
        self.assertEqual(fixture["schemaVersion"], 1)
        self.assertEqual(len(fixture["cases"]), 14)
        for case in fixture["cases"]:
            with self.subTest(case=case["id"]):
                decision = moderate_prompt(case["prompt"])
                self.assertEqual(decision.allowed, case["allowed"])
                self.assertEqual(decision.category, case["category"] or "ok")
                if not case["allowed"]:
                    self.assertEqual(decision.status_code, 422)
                    self.assertEqual(decision.code, "prompt_blocked")
                    self.assertNotIn(case["prompt"], decision.message)


if __name__ == "__main__":
    unittest.main()
