import unittest

from app.image_service import ProviderError, is_content_filtered, to_http_error


class ContentFilterDetectionTests(unittest.TestCase):
    def test_detects_content_filtered_artifact(self):
        data = {"artifacts": [{"base64": "AAAA", "finishReason": "CONTENT_FILTERED", "seed": 1}]}
        self.assertTrue(is_content_filtered(data))

    def test_detects_content_filtered_case_insensitive(self):
        data = {"artifacts": [{"finish_reason": "content_filtered"}]}
        self.assertTrue(is_content_filtered(data))

    def test_success_artifact_is_not_filtered(self):
        data = {"artifacts": [{"base64": "AAAA", "finishReason": "SUCCESS", "seed": 1}]}
        self.assertFalse(is_content_filtered(data))

    def test_other_response_shapes_are_not_filtered(self):
        self.assertFalse(is_content_filtered({"image": "data:image/png;base64,AAAA"}))
        self.assertFalse(is_content_filtered({"b64_json": "AAAA"}))
        self.assertFalse(is_content_filtered("just a string"))
        self.assertFalse(is_content_filtered({"artifacts": []}))

    def test_content_filtered_maps_to_422(self):
        err = ProviderError("blocked", status_code=422, code="content_filtered")
        payload, status = to_http_error(err)
        self.assertEqual(status, 422)
        self.assertEqual(payload["code"], "content_filtered")


if __name__ == "__main__":
    unittest.main()
