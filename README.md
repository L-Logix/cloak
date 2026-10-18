# Cloak — AI Privacy Layer

**Cloak is a local-first Chrome extension that replaces the personal details in your AI prompts with reversible tokens before the prompt leaves your device — and puts them back when the reply comes home.**

You type "my name is Bob Carter, email me at bob@example.com". ChatGPT, Gemini, and Claude receive "my name is `[PERSON_1_2pkqc9]`, email me at `[EMAIL_2_v5h4j4]`". Your reply still reads "Bob Carter" — Cloak restores it on the way back.

No accounts. No servers. No telemetry. The vault that maps tokens to your real values never leaves `chrome.storage.local`.

---

## Why this exists

Every prompt you send to a chatbot is stored, logged, and often used to train models. That means your full name, home address, phone number, and email can end up in someone else's training corpus — usually with no way to undo it.

Existing privacy tools work at the wrong layer. Browser "send scrubbers" clear history; password managers protect credentials; VPNs hide your IP. None of them sit *inside the request body*, where the personal details actually are. Cloak does.

## How it works

```
┌─ popup.js ──────────── chrome.storage.local ───────────┐
│  settings · vault (token → value) · activity counters  │
└───────────────┬────────────────────────────────────────┘
                │ CLOAK_CONFIG / CLOAK_CLEAR_MEMORY
                ▼
┌─ content.js (isolated world) ──── postMessage ─────────┐
│  bridge · composer badge · media-bypass banner         │
└───────────────┬────────────────────────────────────────┘
                ▼
┌─ intercept.bundle.js (MAIN world) ─────────────────────┐
│  wraps page fetch + XHR                                │
│  1. masks the outgoing body  ──▶  AI server            │
│  2. restores the reply       ◀──  AI server            │
└────────────────────────────────────────────────────────┘
```

**Detection runs entirely on-device** with two bundled libraries:

| Category | Engine |
|---|---|
| Names | `compromise` (local NLP) + introduction/recipient phrasings ("my name is…", "to X at…") |
| Street addresses | `addressit` (local parser), grown through city/state/postcode |
| Emails, phones | auditable regular expressions |
| Custom terms | your own dictionary (project codenames, usernames, …) |

Interception is scoped by an allowlist: only `POST`s to the three providers' chat-completion endpoints are ever rewritten. Image/video generation requests bypass masking (the model needs full context to paint), and Cloak tells you when they do.

## Features

- **Stable tokens** — the same value always maps to the same token, so the vault holds one row per value, forever.
- **Live "Try it" demo** — paste any text into the popup and watch the real engine mask it, category by category, with a round-trip restore check. Nothing is saved.
- **Vault** — searchable token → value table with per-row reveal, JSON export, and clear.
- **Coverage toggles** — turn any detection category off; the next request obeys.
- **Custom terms** — mask anything the built-in rules cannot know about.
- **Restore replies** — tokens in the AI's answer are swapped back before you see them (streaming-safe: tokens split across chunk boundaries are handled).
- **Activity dashboard** — lifetime counts of masked values and checked requests.

Supported today: **ChatGPT**, **Gemini**, **Claude**.

## Privacy model

- All detection and token minting happen in your browser. There is no Cloak server, and the extension makes no network requests of its own.
- The token→value vault is written to `chrome.storage.local` and never synced or transmitted.
- Vault values are hidden behind a reveal toggle by default (shoulder-surfing protection).
- The interceptor validates every message it accepts from the page, so a hostile page cannot write arbitrary data into extension storage.

## Honest limitations

Pattern detection is best-effort. The NLP model can miss unfamiliar names or misclassify words; address formats vary internationally; a prompt that deliberately avoids common phrasings may slip details through. Cloak reduces exposure — it does not guarantee it. Review sensitive prompts before sending.

## Build and test

```sh
npm install                 # local parser + bundler dependencies
npm run build:interceptor   # bundle intercept.js → intercept.bundle.js
npm test                    # rebuilds the bundle, then runs the test suite
```

Load this directory as an unpacked extension from `chrome://extensions`. After editing `intercept.js`, rebuild the bundle, then reload the extension and the chat tab.

The suite (`tests/intercept.test.js`, 24 tests) covers name/email/phone/address/custom-term masking, nested `f.req` payloads, streaming restoration across chunk boundaries, per-category settings, media-intent bypass, XHR + fetch wrappers for all three providers, and the popup-preview contract.

## Project layout

| File | Role |
|---|---|
| `intercept.js` | masking engine + fetch/XHR interception (source; bundled) |
| `intercept.bundle.js` | the artifact the manifest injects into chat pages and the popup |
| `content.js` | isolated-world bridge: storage ↔ interceptor, composer badge |
| `popup.html` / `popup.js` / `styles.css` | the 380×560 control panel (Home, Try, Vault, Coverage, Terms, Settings) |
| `content.css` | styles for the two elements Cloak injects into chat pages |
| `tests/` | unit + integration suite (Node's built-in test runner, no framework) |

## License

GPL-3.0 — see `LICENSE`.
