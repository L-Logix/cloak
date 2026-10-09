# Live Gemini integration test

Run the interceptor unit tests without credentials or network access:

```sh
node --test tests/intercept.test.js
```

These exercise the same masking code used by the extension, including Gemini's nested `f.req` form body and token restoration across response stream chunks.

This test sends a synthetic email address and phone number to the real Gemini API only after replacing them with PromptMask-style tokens. It prints the original prompt, actual request payload, actual Gemini response, and locally restored response. No real personal information is used.

Set `GEMINI_API_KEY` in the environment, then run:

```sh
python3 -m unittest discover -s tests -v
```

The model defaults to `gemini-2.5-flash`. Set `GEMINI_MODEL` to use another model available to your API key. The API key is sent in an HTTP header and is never printed.

The live test verifies the real Gemini Developer API round trip. It does not automate a signed-in Gemini website session. The Node test runs the real interceptor wrapper in a simulated page context; a browser smoke test is still needed to verify Google's current website endpoint and signed-in session behavior.

## Gemini website smoke test

1. Load the project folder as an unpacked extension from `chrome://extensions` with Developer mode enabled.
2. Open `https://gemini.google.com` and submit synthetic data, for example: `My name is John Doe. My email is alex@example.test and my phone is 415-555-0137. Repeat them exactly.`
3. Inspect Gemini's `StreamGenerate` request in DevTools Network. Its prompt should contain `[PERSON_...]`, `[EMAIL_...]`, and `[PHONE_...]` tokens, not the synthetic originals.
4. Gemini's rendered answer should show the original synthetic values after local restoration.

Use only synthetic data for this test. The extension's name recognition is intentionally limited to names introduced with phrases such as `My name is` and is not general-purpose named-entity recognition.