"""Live Gemini API test for masked prompt and local response restoration."""

import json
import os
import re
import unittest
import urllib.error
import urllib.parse
import urllib.request

EMAIL_PATTERN = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
PHONE_PATTERN = re.compile(r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b")


def mask_prompt(text: str) -> tuple[str, dict[str, str]]:
    """Apply the email and phone patterns currently used by intercept.js."""
    vault: dict[str, str] = {}
    token_index = 1

    def replace(match: re.Match[str], category: str) -> str:
        nonlocal token_index
        token = f"[{category}_{token_index}]"
        token_index += 1
        vault[token] = match.group(0)
        return token

    text = EMAIL_PATTERN.sub(lambda match: replace(match, "EMAIL"), text)
    text = PHONE_PATTERN.sub(lambda match: replace(match, "PHONE"), text)
    return text, vault


def restore_response(text: str, vault: dict[str, str]) -> str:
    for token, original in vault.items():
        text = text.replace(token, original)
    return text


def send_to_gemini(masked_prompt: str) -> tuple[dict, str]:
    api_key = os.environ["GEMINI_API_KEY"]
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{urllib.parse.quote(model, safe='')}:generateContent"
    )
    payload = {
        "contents": [{"parts": [{"text": masked_prompt}]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 128},
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Gemini API returned HTTP {error.code}") from None

    candidates = result.get("candidates", [])
    if not candidates:
        raise RuntimeError("Gemini returned no response candidate")
    response_text = "".join(
        part.get("text", "")
        for part in candidates[0].get("content", {}).get("parts", [])
    )
    if not response_text:
        raise RuntimeError("Gemini response contained no text")
    return payload, response_text


@unittest.skipUnless(
    os.environ.get("GEMINI_API_KEY"),
    "Set GEMINI_API_KEY to run the live Gemini integration test",
)
class LiveGeminiPipelineTests(unittest.TestCase):
    def test_real_gemini_receives_masked_text_and_response_is_restored(self):
        original_prompt = (
            "Return exactly these values separated by |, with no extra text: "
            "alex@example.test | 415-555-0137"
        )
        masked_prompt, vault = mask_prompt(original_prompt)
        expected_tokens = list(vault)
        self.assertEqual(expected_tokens, ["[EMAIL_1]", "[PHONE_2]"])
        self.assertNotIn("alex@example.test", masked_prompt)
        self.assertNotIn("415-555-0137", masked_prompt)

        payload, gemini_response = send_to_gemini(masked_prompt)
        transmitted_text = payload["contents"][0]["parts"][0]["text"]
        self.assertTrue(all(token in transmitted_text for token in expected_tokens))
        self.assertNotIn("alex@example.test", transmitted_text)
        self.assertNotIn("415-555-0137", transmitted_text)
        self.assertTrue(
            all(token in gemini_response for token in expected_tokens),
            f"Gemini did not preserve all test tokens: {gemini_response!r}",
        )
        restored_response = restore_response(gemini_response, vault)

        print("\n1. Original prompt (synthetic test data)")
        print(original_prompt)
        print("\n2. Actual request payload sent to Gemini")
        print(json.dumps(payload, indent=2))
        print("\n3. Actual response returned by Gemini")
        print(gemini_response)
        print("\n4. Response after local token restoration")
        print(restored_response)


if __name__ == "__main__":
    unittest.main(verbosity=2)