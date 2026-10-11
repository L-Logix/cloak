import json
import unittest
import urllib.parse

from watch_gemini import expand_nested_json, is_gemini_endpoint, readable_request_body


class GeminiWatcherTests(unittest.TestCase):
    def test_expands_gemini_nested_f_req_json(self):
        inner = json.dumps([["My name is [PERSON_1_abcd1234]"]])
        outer = json.dumps([None, inner])
        body = urllib.parse.urlencode({"f.req": outer})

        readable = json.loads(readable_request_body(body))
        self.assertEqual(
            readable["f.req"][0][1][0][0],
            "My name is [PERSON_1_abcd1234]",
        )

    def test_expands_json_strings_nested_inside_json(self):
        body = json.dumps({"payload": json.dumps({"text": "sent prompt"})})

        expanded = json.loads(readable_request_body(body))
        self.assertEqual(expanded["payload"]["text"], "sent prompt")

    def test_only_matches_gemini_chat_backend_requests(self):
        self.assertTrue(
            is_gemini_endpoint(
                "https://gemini.google.com/_/BardChatUi/data/StreamGenerate"
            )
        )
        self.assertFalse(is_gemini_endpoint("https://gemini.google.com/app"))
        self.assertFalse(
            is_gemini_endpoint("https://example.com/_/BardChatUi/data/StreamGenerate")
        )


if __name__ == "__main__":
    unittest.main()
