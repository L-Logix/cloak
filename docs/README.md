# Cloak showcase website

A self-contained HTML website for GitHub Pages, following Cloak’s dark protection-on theme. All website files are in `docs/`. Extension frontend release labels now identify ChatGPT as the only supported platform. The interceptor, storage bridge, manifest permissions, bundle, dependencies, and package scripts are unchanged.

## Publish

1. Commit and push `docs/` to the branch you want to publish.
2. Open the repository's **Settings → Pages** on GitHub.
3. Choose **Deploy from a branch**, select that branch and the **/docs** folder, then save.
4. GitHub displays the public URL when deployment finishes. The expected project URL is `https://l-logix.github.io/cloak/`; this has not been published or verified by this task.

All asset paths are relative and work under the `/cloak/` project prefix. No build step, CDN, remote font, account, API key, or analytics service is required. `.nojekyll` enables plain static hosting.

## Local preview and checks

The opening screen uses the actual Home screenshot. The page features real ChatGPT/DevTools captures and an expandable fictional patient-history demo; the real engine masks its name, address, email, and phone. Visitors can switch between masked text, exact restoration, and the memory-only demo vault. Advanced masking controls and the engineering workbench are expandable to keep the page uncluttered.

The three counters show 49 documented NC organizations with AI privacy limits and guidance, 267,382 fall 2025 student enrollments across 14 cited universities, and 97,274 modeled sensitive messages per day if every student in the enrollment subtotal used ChatGPT with Cloak (approximately 35.5 million/year). This combines 4.28 daily prompts per weekly active user from Epoch AI with Harmonic’s 8.5% sensitive-prompt rate; it is an exposure scenario, not measured PII prevention. Recalculate them from the sourced register with `node docs/update-impact.cjs`. The count is not a statewide census, enrollment is not a count of people blocked by bans, and modeled exposure is not measured prevention or a legal-compliance claim. Each counter opens the sources and methodology disclosure. The original synthetic results remain in `assets/synthetic-benchmark.json` and the root README. Section fades and number animation respect reduced-motion preferences; static content remains available without JavaScript. The healthcare example demonstrates identifier masking and does not claim HIPAA compliance or complete PHI de-identification; a linked FAQ cites HHS guidance. The video and extension backend remain unchanged. Only popup presentation and release-status labels were edited.

`downloads/cloak-extension.zip` contains the current extension, source, license, and JavaScript tests. Every archived file was compared byte-for-byte with the repository. `downloads/manifest.json` records the archive and file hashes. Refresh it after future extension changes with `node docs/package-download.cjs`; set `CLOAK_PYTHON` to a Python 3 executable if `python` is not on PATH. Extract the ZIP and load its `cloak` folder in Chrome. The website makes no ranking or award guarantees.

Run from the repository root:

```sh
node docs/serve.cjs
node docs/verify.cjs
```

The preview runs at `http://127.0.0.1:4173`. Stop with Ctrl+C. You can also open `index.html` directly in a browser.

The verification script checks anchors, relative assets, masking categories, exact restoration, disabled coverage, empty input, preview isolation, and source provenance. Browser QA additionally covers widths of 320, 390, 768, 1024, and 1440 pixels, interactive presets, the demo vault, keyboard tabs, clear, and safe rendering of typed HTML.

## Real engine, separate copy

`assets/preview-engine.js` is a preview-only build of the actual `intercept.js` engine. `build-preview.cjs` reads the extension source, replaces its entry-point section in memory, and writes only website assets. Masking and restoration logic is unchanged. The website exposes `CloakPreview.createMasker`; it does not install fetch/XHR hooks or access extension storage.

To refresh the snapshot after a future extension change, run `node docs/build-preview.cjs` with the repository's existing dependencies installed. `assets/engine-source.json` records the input source's SHA-256. The generated bundle is already included, so visitors need no build step.

Demo inputs and mappings stay in transient page memory and are never submitted by this site. “Restored text” reverses the sample locally; it is not an AI-generated reply. Hero and vault art are labeled illustrations. The actual extension stores its separate vault in `chrome.storage.local`.

## Content and provenance

Product claims are grounded in the repository's manifest, popup, implementation, and tests. The local demo videos were visually reviewed, including their emphasis on inspecting outgoing request payloads. No accuracy rates, adoption statistics, awards, testimonials, or creator biography are invented.

Installation and technical links target the existing `unreleased` branch inspected during creation. Change those links if the release branch changes. The competition link uses the official [participating-districts page](https://www.congressionalappchallenge.us/students/participating-districts/). The showcase does not claim congressional endorsement or an award.

Cloak is GPL-3.0; a license copy is included. Bundled dependency notices are in `THIRD_PARTY_NOTICES.txt`. Source: https://github.com/L-Logix/cloak .

## Judging evidence and screenshots

The site now emphasizes the three national criteria in the [2026 rules, section 7](https://www.congressionalappchallenge.us/wp-content/uploads/2026/05/2026-CAC-Rules.pdf) and the official [judging toolkit](https://www.congressionalappchallenge.us/congress/congressional-toolkit/):

- **Idea:** concrete everyday uses and request-level tokenization with local restoration.
- **Implementation and design:** editable real-engine demo, coverage controls, and a keyboard-accessible screenshot gallery.
- **Programming skill:** the real `restoreStream` function operating on adjustable chunk sizes, six executable browser checks, and a source-code map.

These are evidence for judging, not additional official scoring categories or a prediction of placement. No separate NC-04 weighting was verified. The submission video and answers remain part of the official review.

The engineering preview also exports the original `restoreStream`, `isTargetRequest`, and `containsMediaIntent` functions. It still installs no request hooks. Stream inputs are explicitly synthetic. The six checks test fixed examples and report their actual runtime outcome.

The existing repository suite passed 49/49 tests on October 24, 2026, using `node --test tests/intercept.test.js tests/content.test.js` without rebuilding or modifying the extension. `assets/test-report.json` records the command, scope, and source hashes.

The four screenshots in `assets/screenshots/` were rendered from the existing `popup.html`, `styles.css`, and `popup.js` with an isolated in-memory Chrome API fixture and the preview engine. They are actual interface renders with fictional data, not screenshots of the user's live extension state. Source hashes and fixture details are recorded in `assets/screenshots/provenance.json`. Captions identify sample data. Original extension files were not changed.

## Video-aligned copy

Website copy follows the narration of `full_cac_draft_1.mp4`, transcribed locally from the user's Downloads folder. The source video and transcript are not included in the website. The main narrative is:

- 0:00–0:42: privacy and AI progress, Research Triangle context, eighth-grade creator in NC-04.
- 0:42–1:18: inspect outgoing tokens, then demonstrate local restoration.
- 1:18–2:10: Manifest V3 execution contexts, fetch/XHR interception, postMessage, payload parsing, and local detection.
- 2:10–2:38: streaming token fragments and the restoration buffer.
- 2:38–2:57: future permission-based sharing and the project's forward direction.

Technical copy is also checked against the implementation. The page conveys the video's motivation without repeating unsupported numerical, institutional-policy, compliance, or absolute-security claims. Future permission-based sharing is explicitly identified as planned functionality. The video’s uncertain automated transcription of the creator’s surname is not used.

## Real ChatGPT capture sequence

The three unaltered PNGs in assets/medical-capture were captured from one real Chrome conversation with Cloak enabled. Four website tabs show the original prompt, outgoing request, raw response, and restored UI. The last stage uses a CSS viewport onto the left pane of the response screenshot; it is explicitly identified as the same capture. No generated screenshot is presented as evidence. The patient data is fictional.

Run `node docs/benchmark.cjs` to reproduce the numbered synthetic exercise. Its generated report explains its limited scope. Platform status distinguishes ChatGPT support from experimental Gemini and Claude code paths.
