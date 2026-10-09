# Live Gemini integration test

Run the interceptor unit tests without credentials or network access:

```sh
node --test tests/intercept.test.js
```

These exercise the same masking code used by the extension, including Gemini's nested `f.req` form body and token restoration across response stream chunks.

`watch_gemini.py` attaches to the Gemini tab you use in Chrome. It prints the request body sent to Gemini, the response received from Gemini, and `[PromptMask]` browser-console status messages. It uses Chrome's local DevTools Protocol; no Gemini API key or proxy is involved.

## Start Chrome for local inspection

Chrome must be started with remote debugging enabled before Python can attach. A normal Chrome process that is already running without this flag cannot be inspected retroactively. Close Chrome first, then launch a separate debug profile:

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.promptmask-debug"
```

If your Chrome executable is named `chrome` or `chromium`, use that command instead. In the opened browser, load this project as an unpacked extension from `chrome://extensions`, sign in to Gemini, and open `https://gemini.google.com`.

Start the watcher in a terminal from the project folder:

```sh
python3 tests/watch_gemini.py
```

When it reports that it attached, use Gemini normally. Press Ctrl+C in the watcher terminal to stop. Options include `--port 9222`, `--wait 120`, and `--max-chars 50000`.

Install the only Python dependency if needed:

```sh
python3 -m pip install websocket-client
```

## What it shows

- `[Browser -> Gemini]` and the decoded request body, including nested Gemini `f.req` prompt text.
- Gemini's HTTP status and the response body captured from the browser network events.
- `[PromptMask]` console status messages, including masking state and the locally restored response when tokens were used.

The watcher connects only to `127.0.0.1`; do not expose Chrome's remote-debugging port to a network. Request and response bodies can contain private chat text. The watcher prints them in your terminal and does not write a log file.

## Tests

Run the interception behavior tests with Node.js:

```sh
node --test tests/intercept.test.js
```

Run the Python watcher parser tests:

```sh
python3 -m unittest discover -s tests -p 'test_watch_gemini.py' -v
```

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