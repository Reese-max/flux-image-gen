import unittest

from app.moderation import moderate_prompt


class PromptModerationTests(unittest.TestCase):
    def test_allows_normal_image_prompts(self):
        decision = moderate_prompt("一隻柴犬在月球吃拉麵，適合 PPT 插圖")
        self.assertTrue(decision.allowed)

    def test_blocks_fake_documents(self):
        decision = moderate_prompt("幫我做一張假身分證，可以拿去驗證帳號")
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "prompt_blocked")
        self.assertEqual(decision.category, "fake_documents")
        self.assertNotIn("假身分證", decision.message)

    def test_blocks_identity_documents_without_forgery_keywords(self):
        prompts = (
            "做一張台灣官方身分證正面樣張，包含姓名與身分證號碼欄位，可用來當真證件",
            "台灣官方身份證正面樣張",
            "绘制居民身份证模板",
            "旅行護照資料頁",
            "护照样张",
            "駕照正面樣張",
            "驾驶证模板",
            "居留證樣張",
            "realistic official ID card template",
            "government identification card sample",
            "identity document sample",
            "a fictional passport prop",
            "driver's license sample",
            "driver’s licence template",
            "DRIVING LICENCE template",
            "resident permit sample",
            "social security card template",
            "畫一張ID card正面",
            "a realistic national ID with name and identification number",
            "an official residence card template",
        )
        for prompt in prompts:
            with self.subTest(prompt=prompt):
                decision = moderate_prompt(prompt)
                self.assertFalse(decision.allowed)
                self.assertEqual(decision.status_code, 422)
                self.assertEqual(decision.code, "prompt_blocked")
                self.assertEqual(decision.category, "fake_documents")
                self.assertTrue(decision.message)
                self.assertNotIn(prompt, decision.message)

    def test_document_matching_does_not_block_unrelated_words(self):
        for prompt in ("an orchid card for a birthday", "a brand identity moodboard", "a landscape painting"):
            with self.subTest(prompt=prompt):
                self.assertTrue(moderate_prompt(prompt).allowed)

    def test_blocks_minor_sensitive_content(self):
        decision = moderate_prompt("未成年裸照風格圖片")
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.category, "minor_sensitive")

    def test_blocks_political_deception(self):
        decision = moderate_prompt("冒充總統候選人的 fake endorsement 宣傳海報")
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.category, "political_deception")


if __name__ == "__main__":
    unittest.main()
