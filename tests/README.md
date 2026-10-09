# Live Gemini integration test

This test sends a synthetic email address and phone number to the real Gemini API only after replacing them with PromptMask-style tokens. It prints the original prompt, actual request payload, actual Gemini response, and locally restored response. No real personal information is used.

Set `GEMINI_API_KEY` in the environment, then run:

```sh
python3 -m unittest discover -s tests -v
```

The model defaults to `gemini-2.5-flash`. Set `GEMINI_MODEL` to use another model available to your API key. The API key is sent in an HTTP header and is never printed.

This tests the real Gemini API and the masking/restoration round trip, not Chrome's live `window.fetch` interception. The current `intercept.js` handles a `messages` request shape; Gemini uses `contents[].parts[].text`, so the backend must support that shape before this can be considered an end-to-end extension test.