// ---------------------------------------------------------------------------
// Cloak — test suite (tests/intercept.test.js)
//
// Runs on Node's built-in test runner (node --test) — no framework, no
// network, no real browser. `npm test` rebuilds intercept.bundle.js first so
// the suite always exercises the artifact the extension actually ships.
//
// Two levels of testing:
//   1. Unit      — createMasker / isTargetRequest / containsMediaIntent /
//                  restoreStream called directly (fast, precise).
//   2. Integration — the minified bundle loaded into a fake page window via
//                  node:vm, with a stubbed fetch or XMLHttpRequest. This is
//                  how the real MAIN-world wiring is verified: config
//                  messages, request rewriting, response restoration, and the
//                  CloakPreview contract used by the popup's "Try it" tab.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// The public surface of intercept.js — the same functions the bundle wraps.
const {
  containsMediaIntent,
  createMasker,
  isTargetRequest,
  restoreStream,
  // Reveal protocol (consent flow): notice injection + reply scanner.
  createRevealScanner,
  amendLastProseWithInstruction,
  REVEAL_INSTRUCTION,
  REVEAL_LINE_PATTERN
} = require('../intercept.js');

// ---------------------------------------------------------------------------
// Masking unit tests
// ---------------------------------------------------------------------------

// The baseline happy path: one prompt with a name, an email, and a phone
// number, nested the way ChatGPT/Gemini nest prompts inside JSON bodies.
// Asserts the token FORMAT, the exact restore round-trip, the vault entries
// reported for this rewrite, and the masked-occurrence count.
test('masks names, emails, and phone numbers and restores them', () => {
  const masker = createMasker();
  const original = 'My name is John Doe. Email me at john@example.com or call 415-555-0137.';
  const masked = masker.rewriteBody(JSON.stringify({ contents: [{ parts: [{ text: original }] }] }), 'application/json');
  const payload = JSON.parse(masked);
  const text = payload.contents[0].parts[0].text;

  assert.match(text, /^My name is \[PERSON_1_[a-z0-9-]+\]\. Email me at \[EMAIL_2_[a-z0-9-]+\] or call \[PHONE_3_[a-z0-9-]+\]\.$/i);
  assert.equal(masker.restoreText(text), original);
  assert.deepEqual(masker.takePendingEntries().map(({ original }) => original), [
    'John Doe', 'john@example.com', '415-555-0137'
  ]);
  assert.equal(masker.takeMaskedCount(), 3);
});

// Regression for the duplicate-vault bug: tokens used to embed a random
// per-page-load id, so the same value minted a new vault entry on every
// navigation. Tokens must now be content-derived and therefore identical
// across independent masker instances (page loads).
test('mints the same token for the same value across masker instances', () => {
  const first = createMasker();
  first.rewriteBody(JSON.stringify({ prompt: 'my name is bob and my phone number is 919-123-4567' }));
  const firstEntries = first.takePendingEntries();

  const second = createMasker();
  second.rewriteBody(JSON.stringify({ prompt: 'my name is bob and my phone number is 919-123-4567' }));
  const secondEntries = second.takePendingEntries();

  assert.deepEqual(
    secondEntries.map(({ token }) => token),
    firstEntries.map(({ token }) => token),
    'the same value must reuse its token so the vault does not grow on every page load'
  );
  assert.equal(new Set(secondEntries.map(({ token }) => token)).size, secondEntries.length);
});

// A value seen twice in one session must be masked twice (count goes up) but
// reported to the vault only once (entries drained on first sight).
test('counts each masked occurrence even when the original already has a token', () => {
  const masker = createMasker();
  masker.rewriteBody(JSON.stringify({ prompt: 'Email alex@example.test.' }));
  assert.equal(masker.takeMaskedCount(), 1);
  assert.equal(masker.takePendingEntries().length, 1);
  masker.rewriteBody(JSON.stringify({ prompt: 'Email alex@example.test again.' }));
  assert.equal(masker.takePendingEntries().length, 0);
  assert.equal(masker.takeMaskedCount(), 1);
});

// Reported ChatGPT prompt (lowercase "bob" followed by "and my phone…"):
// the name span must stop at the clause boundary instead of swallowing it.
test('masks lowercase name in the reported ChatGPT prompt without consuming following words', () => {
  const masker = createMasker();
  const original = '1. my name is bob and my phone number is 919-123-4567';
  const masked = masker.maskText(original);

  assert.match(masked, /^1\. my name is \[PERSON_1_[a-z0-9-]+\] and my phone number is \[PHONE_2_[a-z0-9-]+\]$/i);
  assert.deepEqual(masker.takePendingEntries().map(({ original: value }) => value), [
    'bob', '919-123-4567'
  ]);
  assert.equal(masker.restoreText(masked), original);
});

// Letter-writing prompts: "to <title+name> at <address>" must mask the titled
// name and the street address, with the email slot left for the email pass.
test('masks a name after a title and a US street address in the reported prompt', () => {
  const masker = createMasker();
  const original = 'write an email to principal chadwick at 123 reedy creek ln saying i need my psat test scores back at alex@example.test';
  const masked = masker.maskText(original);
  const entries = masker.takePendingEntries();

  assert.match(masked, /\[PERSON_1_[a-z0-9-]+\] at \[ADDRESS_2_[a-z0-9-]+\].*\[EMAIL_3_[a-z0-9-]+\]/i);
  assert.equal(masked.includes('principal chadwick'), false);
  assert.equal(masked.includes('123 reedy creek ln'), false);
  assert.deepEqual(entries.map(({ original: value }) => value), [
    'principal chadwick', '123 reedy creek ln', 'alex@example.test'
  ]);
  assert.equal(masker.restoreText(masked), original);
});

// The same prompt arriving with an email ALREADY replaced by a token (a
// re-submitted conversation): remaining spans mask, the existing token is
// left alone, and the counter only counts the two new replacements.
test('masks title name and address in reported payload when email is already tokenized', () => {
  const masker = createMasker();
  const original = '1. write an email to principal chadwick at 123 reedy creek ln saying i need my psat test scores back at [EMAIL_3_ea931cb0]\n2.';
  const body = JSON.stringify({ prompt: original });
  const rewrittenBody = masker.rewriteBody(body, 'application/json');
  const prompt = JSON.parse(rewrittenBody).prompt;

  assert.match(prompt, /\[PERSON_1_[a-z0-9-]+\] at \[ADDRESS_2_[a-z0-9-]+\]/i);
  assert.match(prompt, /\[EMAIL_3_ea931cb0\]/);
  assert.equal(prompt.includes('principal chadwick'), false);
  assert.equal(prompt.includes('123 reedy creek ln'), false);
  assert.equal(masker.takeMaskedCount(), 2);
});

// International coverage: a titled name plus a full UK address (street, city,
// postcode, country) must collapse into ONE address token, not four pieces.
test('recognizes generic person names and international address formats locally', () => {
  const masker = createMasker();
  const original = 'Please send the package to Dr. Noam Chomsky at 221B Baker Street, London NW1 6XE, United Kingdom.';
  const rewritten = JSON.parse(masker.rewriteBody(JSON.stringify({ prompt: original }))).prompt;
  const entries = masker.takePendingEntries();

  assert.equal(entries[0].original, 'Dr. Noam Chomsky');
  assert.match(entries[1].original, /^221B Baker Street, London NW1 6XE, United Kingdom$/);
  assert.match(rewritten, /\[PERSON_1_[a-z0-9-]+\] at \[ADDRESS_2_[a-z0-9-]+\]\./i);
  assert.equal(masker.restoreText(rewritten), original);
});

// US address with city/state/ZIP: the trailing sentence ("Please email soon.")
// must survive — the span grows to the ZIP and stops there.
test('masks parsed US city state and ZIP without swallowing following prose', () => {
  const masker = createMasker();
  const original = 'Alex Kim lives at 742 Evergreen Terrace, Springfield, IL 62704. Please email soon.';
  const rewritten = JSON.parse(masker.rewriteBody(JSON.stringify({ prompt: original }))).prompt;
  const entries = masker.takePendingEntries();

  assert.equal(entries[0].original, 'Alex Kim');
  assert.equal(entries[1].original, '742 Evergreen Terrace, Springfield, IL 62704');
  assert.equal(rewritten, `${entries[0].token} lives at ${entries[1].token}. Please email soon.`);
  assert.equal(masker.restoreText(rewritten), original);
});

// False-positive guard: bare numbers ("123 items") must NOT be treated as
// street addresses just because they look like house numbers.
test('does not mask numbers that do not parse as street addresses', () => {
  const masker = createMasker();
  const original = 'I have 123 items and 42 test scores.';
  assert.equal(masker.maskText(original), original);
  assert.equal(masker.takePendingEntries().length, 0);
});

// The personal dictionary: multi-word and single-word custom terms mask, but
// substrings inside longer words ("Juniperish") must be left alone.
test('masks custom names and phrases without built-in entity rules', () => {
  const masker = createMasker();
  masker.configure({ enabled: true, settings: { customTerms: ['Project Juniper', 'Mara'] } });
  const original = 'Send Project Juniper notes to Mara; mention Juniperish only if needed.';
  const rewritten = masker.rewriteBody(JSON.stringify({ prompt: original }));
  const prompt = JSON.parse(rewritten).prompt;
  const entries = masker.takePendingEntries();

  assert.match(prompt, /\[CUSTOM_1_[a-z0-9-]+\]/i);
  assert.match(prompt, /\[CUSTOM_2_[a-z0-9-]+\]/i);
  assert.match(prompt, /Juniperish/);
  assert.equal(entries[0].original, 'Project Juniper');
  assert.equal(entries[1].original, 'Mara');
  assert.equal(masker.restoreText(prompt), original);
});

// Gemini's wire format: a form-encoded body whose f.req field holds JSON
// whose first element holds MORE JSON. The engine must recurse to the prompt
// instead of masking raw syntax characters.
test('rewrites Gemini f.req form payloads containing nested JSON', () => {
  const masker = createMasker();
  const innerPayload = JSON.stringify([['Contact john@example.com']]);
  const body = new URLSearchParams({ 'f.req': JSON.stringify([null, innerPayload]) }).toString();
  const rewrittenBody = masker.rewriteBody(body, 'application/x-www-form-urlencoded;charset=UTF-8');
  const outerPayload = JSON.parse(new URLSearchParams(rewrittenBody).get('f.req'));
  const rewrittenInner = JSON.parse(outerPayload[1]);

  assert.match(rewrittenInner[0][0], /^Contact \[EMAIL_1_[a-z0-9-]+\]$/i);
  assert.equal(masker.takePendingEntries()[0].original, 'john@example.com');
});

// ---------------------------------------------------------------------------
// Response restoration (streaming)
// ---------------------------------------------------------------------------

// Servers stream replies in chunks; a token can straddle a chunk boundary.
// The stream must hold back the partial token and restore it once complete.
test('restores tokens even when a token is split across response chunks', async () => {
  const masker = createMasker();
  masker.rewriteBody(JSON.stringify({ text: 'john@example.com' }), 'application/json');
  const token = masker.takePendingEntries()[0].token;
  const encoder = new TextEncoder();
  const split = Math.floor(token.length / 2);
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`Gemini replied with ${token.slice(0, split)}`));
      controller.enqueue(encoder.encode(`${token.slice(split)}.`));
      controller.close();
    }
  });

  const restored = await new Response(restoreStream(source, masker)).text();
  assert.equal(restored, 'Gemini replied with john@example.com.');
});

// Liveness guard: restoration must never stall an open stream waiting for a
// token that is not there. Feed a 5-byte-at-a-time SSE stream and assert the
// [DONE] sentinel arrives before the timeout — i.e. the tail is released.
test('streams the tail immediately so an open stream cannot truncate the reply', async () => {
  const masker = createMasker();
  masker.rewriteBody(JSON.stringify({ text: 'My name is John Doe' }), 'application/json');
  const token = masker.takePendingEntries()[0].token;
  const encoder = new TextEncoder();
  const payload = `data: {"text":"${token} finished the sentence."}\n\ndata: [DONE]\n\n`;
  const bytes = encoder.encode(payload);
  let offset = 0;
  const source = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return;
      controller.enqueue(bytes.slice(offset, offset + 5));
      offset += 5;
    }
  });

  const reader = restoreStream(source, masker).getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const outcome = await Promise.race([
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return 'closed';
        seen += decoder.decode(value, { stream: true });
        if (seen.includes('[DONE]')) return 'sentinel';
      }
    })(),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500))
  ]);

  assert.equal(outcome, 'sentinel');
  assert.match(seen, /John Doe finished the sentence\./);
  assert.equal(seen.includes(token), false);
  await reader.cancel();
});

// ---------------------------------------------------------------------------
// Classification unit tests
// ---------------------------------------------------------------------------

// The interception allowlist. Chat-completion endpoints pass; telemetry,
// settings, and other first-party paths must never be rewritten.
test('targets Gemini, ChatGPT, and Claude chat endpoints only', () => {
  assert.equal(isTargetRequest('https://gemini.google.com/_/BardChatUi/data/StreamGenerate'), true);
  assert.equal(isTargetRequest('https://chatgpt.com/backend-api/conversation'), true);
  assert.equal(isTargetRequest('https://chatgpt.com/backend-api/f/conversation'), true);
  assert.equal(isTargetRequest('https://chatgpt.com/unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=test'), true);
  assert.equal(isTargetRequest('https://chatgpt.com/backend-api/sentinel/ping'), false);
  assert.equal(isTargetRequest('https://chatgpt.com/backend-api/telemetry'), false);
  assert.equal(isTargetRequest('https://claude.ai/api/organizations/1/completion'), true);
  assert.equal(isTargetRequest('https://gemini.google.com/settings'), false);
});

// Image-generation requests bypass masking (the model paints from context),
// so a "draw a picture" prompt triggers the fallback while an ordinary
// question about a picture does not.
test('detects media generation requests for the unmasked fallback', () => {
  assert.equal(containsMediaIntent('Please draw a picture of a dog'), true);
  assert.equal(containsMediaIntent('What is in this picture?'), false);
});

// Coverage toggles: with names/phones/addresses off, only the email is
// masked and everything else passes through verbatim.
test('respects per-category settings', () => {
  const masker = createMasker();
  masker.configure({ enabled: true, settings: { names: false, emails: true, phones: false, addresses: false } });
  const masked = masker.rewriteBody(JSON.stringify({ text: 'My name is John Doe, email john@example.com, phone 415-555-0137, address 123 Reedy Creek Ln' }));

  assert.match(JSON.parse(masked).text, /^My name is John Doe, email \[EMAIL_1_[a-z0-9-]+\], phone 415-555-0137, address 123 Reedy Creek Ln$/i);
});

// The "Restore replies" preference in Settings maps to this flag; the fetch
// wrapper consults it before rewrapping any response.
test('response restoration preference is configurable', () => {
  const masker = createMasker();
  assert.equal(masker.shouldRestoreResponses(), true);
  masker.configure({ enabled: true, settings: { restoreResponses: false } });
  assert.equal(masker.shouldRestoreResponses(), false);
});

// Media detection also has to see through URL-encoding (form bodies).
test('detects media intent in URL-encoded request bodies', () => {
  assert.equal(containsMediaIntent('f.req=Please+draw+a+picture'), true);
});

// ---------------------------------------------------------------------------
// Integration tests — the real bundle in a fake page window
// ---------------------------------------------------------------------------

// Each integration test follows the same recipe:
//   1. build a fake page window (location, fetch/XHR stubs, message sink)
//   2. run intercept.bundle.js in node:vm with that window
//   3. deliver a CLOAK_CONFIG message (what content.js would send)
//   4. fire a request through the wrapped fetch/XHR
//   5. assert on the transmitted body, the restored reply, and the messages

// End-to-end Gemini: a real f.req payload is masked on the way out, the mock
// server echoes the tokens back, and the response is restored before the page
// reads it. Also asserts the diagnostic log lines the popup relies on.
test('fetch wrapper masks the real Gemini payload before sending and restores its response', async () => {
  const listeners = new Map();
  const messages = [];
  const consoleMessages = [];
  let transmittedPrompt;
  const pageWindow = {
    location: {
      href: 'https://gemini.google.com/app',
      origin: 'https://gemini.google.com',
      hostname: 'gemini.google.com'
    },
    Request,
    TransformStream,
    console: { info: (...args) => consoleMessages.push(args.join(' ')) },
    addEventListener: (type, listener) => listeners.set(type, listener),
    postMessage: (message) => messages.push(message),
    // The "server": reads the transmitted body and replies with its tokens.
    fetch: async (_input, init) => {
      const params = new URLSearchParams(init.body);
      const outer = JSON.parse(params.get('f.req'));
      transmittedPrompt = JSON.parse(outer[1])[0][0];
      const tokens = transmittedPrompt.match(/\[(?:PERSON|EMAIL|PHONE)_[^\]]+\]/g) || [];
      return new Response(`data: ${JSON.stringify({ text: tokens.join(' | ') })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
  };
  const source = fs.readFileSync(require.resolve('../intercept.bundle.js'), 'utf8');
  vm.runInNewContext(source, {
    require,
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder
  });
  listeners.get('message')({
    source: pageWindow,
    origin: pageWindow.location.origin,
    data: { type: 'CLOAK_CONFIG', enabled: true, settings: {} }
  });

  // Real-shaped prompt + the 7-element nested array Gemini wraps it in.
  const prompt = 'my name is bob and my phone number is 919-123-4567; contact alex@example.test';
  const nested = JSON.stringify([
    [prompt, 0, null, null, null, null, 0],
    ['en'],
    null,
    'opaque-token',
    'response-id',
    null,
    [1]
  ]);
  const response = await pageWindow.fetch(
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=test&f.sid=1&hl=en&_reqid=2&rt=c',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'f.req': JSON.stringify([null, nested]) }).toString()
    }
  );
  const restored = await response.text();

  assert.match(transmittedPrompt, /\[PERSON_[^\]]+\]/);
  assert.match(transmittedPrompt, /\[PHONE_[^\]]+\]/);
  assert.match(transmittedPrompt, /\[EMAIL_[^\]]+\]/);
  assert.equal(transmittedPrompt.includes('bob'), false);
  assert.equal(transmittedPrompt.includes('919-123-4567'), false);
  assert.equal(transmittedPrompt.includes('alex@example.test'), false);
  assert.match(restored, /bob/);
  assert.match(restored, /919-123-4567/);
  assert.match(restored, /alex@example\.test/);
  assert.equal(messages.some(({ type }) => type === 'CLOAK_MASKED_DATA'), true);
  assert.equal(consoleMessages.some((message) => message.includes('Gemini request sent with protection enabled; 3 new sensitive value')), true);
  assert.equal(consoleMessages.some((message) => message.includes('Gemini server responded with HTTP 200')), true);
  assert.equal(consoleMessages.some((message) => message.includes('response delivered after local token restoration') && message.includes('alex@example.test')), true);
});

// The XHR path (some providers still use it): a MockXHR whose send() records
// the body and echoes tokens into its response. Asserts the wrapped send
// transmitted masked text and that responseText/response read back restored.
test('XMLHttpRequest masks Gemini StreamGenerate f.req and restores response getters', () => {
  const listeners = new Map();
  const messages = [];
  class MockXHR {
    constructor() {
      this.headers = {};
      this.responseType = '';
      this.status = 200;
      this._responseText = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    }
    send(body) {
      this.sentBody = body;
      const params = new URLSearchParams(body);
      const outer = JSON.parse(params.get('f.req'));
      const prompt = JSON.parse(outer[1])[0][0];
      const tokens = prompt.match(/\[(?:PERSON|PHONE)_[^\]]+\]/g) || [];
      this._responseText = `reply ${tokens.join(' ')}`;
    }
  }
  // Platform XHR defines these getters up the prototype chain; mirror that so
  // the interceptor's findDescriptor walk has something to find.
  Object.defineProperty(MockXHR.prototype, 'responseText', {
    configurable: true,
    get() { return this._responseText; }
  });
  Object.defineProperty(MockXHR.prototype, 'response', {
    configurable: true,
    get() { return this._responseText; }
  });

  const pageWindow = {
    location: {
      href: 'https://gemini.google.com/app',
      origin: 'https://gemini.google.com',
      hostname: 'gemini.google.com'
    },
    XMLHttpRequest: MockXHR,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    console: { info() {}, warn() {} },
    addEventListener: (type, listener) => listeners.set(type, listener),
    postMessage: (message) => messages.push(message),
    fetch: async () => new Response('ok')
  };
  const source = fs.readFileSync(require.resolve('../intercept.bundle.js'), 'utf8');
  vm.runInNewContext(source, {
    require,
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder
  });
  listeners.get('message')({
    source: pageWindow,
    origin: pageWindow.location.origin,
    data: { type: 'CLOAK_CONFIG', enabled: true, settings: {} }
  });

  const prompt = 'my name is bob and my phone number is 919-123-4567';
  const nested = JSON.stringify([[prompt, 0, null, null, null, null, 0], ['en']]);
  const xhr = new pageWindow.XMLHttpRequest();
  xhr.open('POST', 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate');
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
  xhr.send(new URLSearchParams({ 'f.req': JSON.stringify([null, nested]) }));

  const sentOuter = JSON.parse(new URLSearchParams(xhr.sentBody).get('f.req'));
  const sentPrompt = JSON.parse(sentOuter[1])[0][0];
  const masked = (messages.find(({ type }) => type === 'CLOAK_MASKED_DATA') || { entries: [] }).entries;
  const personToken = masked.find(({ original }) => original === 'bob').token;
  const phoneToken = masked.find(({ original }) => original === '919-123-4567').token;
  assert.match(personToken, /^\[PERSON_\d+_[a-z0-9]+\]$/);
  assert.match(phoneToken, /^\[PHONE_\d+_[a-z0-9]+\]$/);
  assert.equal(sentPrompt.includes(personToken), true);
  assert.equal(sentPrompt.includes(phoneToken), true);
  assert.equal(sentPrompt.includes('bob'), false);
  assert.equal(sentPrompt.includes('919-123-4567'), false);
  // Both getters must read back restored text, not tokens.
  assert.match(xhr.responseText, /bob/);
  assert.match(xhr.responseText, /919-123-4567/);
  assert.equal(xhr.response, xhr.responseText);
  assert.equal(messages.some(({ type }) => type === 'CLOAK_MASKED_DATA'), true);
});

// Shared scaffolding for the XHR streaming tests: the same fake page window
// as the single-read XHR test above, except the mock reply starts EMPTY so a
// test can grow _responseText across simulated progress events — exactly how
// Gemini's StreamGenerate delivers a reply (the page reads responseText after
// every chunk and tracks how much of it it has consumed).
function makeStreamingXHRPage() {
  const listeners = new Map();
  const messages = [];
  class MockXHR {
    constructor() {
      this.headers = {};
      this.responseType = '';
      this.status = 200;
      this.readyState = 2; // LOADING — the transfer is still open
      this._responseText = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    }
    send(body) {
      this.sentBody = body;
      const params = new URLSearchParams(body);
      const outer = JSON.parse(params.get('f.req'));
      const prompt = JSON.parse(outer[1])[0][0];
      // Tokens as they went out on the wire (the masked reply echoes them).
      this.mintedTokens = prompt.match(/\[(?:PERSON|PHONE|EMAIL)_[^\]]+\]/g) || [];
      this._responseText = ''; // reply has not arrived yet
    }
  }
  // Platform XHR defines these getters up the prototype chain; mirror that so
  // the interceptor's findDescriptor walk has something to find.
  Object.defineProperty(MockXHR.prototype, 'responseText', {
    configurable: true,
    get() { return this._responseText; }
  });
  Object.defineProperty(MockXHR.prototype, 'response', {
    configurable: true,
    get() { return this._responseText; }
  });

  const pageWindow = {
    location: {
      href: 'https://gemini.google.com/app',
      origin: 'https://gemini.google.com',
      hostname: 'gemini.google.com'
    },
    XMLHttpRequest: MockXHR,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    console: { info() {}, warn() {} },
    addEventListener: (type, listener) => listeners.set(type, listener),
    postMessage: (message) => messages.push(message),
    fetch: async () => new Response('ok')
  };
  const source = fs.readFileSync(require.resolve('../intercept.bundle.js'), 'utf8');
  vm.runInNewContext(source, {
    require,
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder
  });
  listeners.get('message')({
    source: pageWindow,
    origin: pageWindow.location.origin,
    data: { type: 'CLOAK_CONFIG', enabled: true, settings: {} }
  });

  // Open a StreamGenerate request with the given prompt already sent.
  const startGenerate = (prompt) => {
    const nested = JSON.stringify([[prompt, 0, null, null, null, null, 0], ['en']]);
    const xhr = new pageWindow.XMLHttpRequest();
    xhr.open('POST', 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate');
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
    xhr.send(new URLSearchParams({ 'f.req': JSON.stringify([null, nested]) }));
    const tokens = xhr.mintedTokens;
    return {
      xhr,
      personToken: tokens.find((token) => token.startsWith('[PERSON')) || '',
      emailToken: tokens.find((token) => token.startsWith('[EMAIL')) || ''
    };
  };
  return { pageWindow, messages, startGenerate };
}

// THE Gemini stall regression. Gemini reads responseText after every progress
// event and tracks its offset into it. The old getter restored the ENTIRE
// accumulated text on every read — restoring a token shrinks the string, so
// text the page had already consumed changed under its feet, the frame parser
// desynced, and generation froze mid-sentence with the stop button stuck.
// Restoration must be APPEND-ONLY: each read is a prefix of the next.
test('XHR responseText restoration is append-only across progress events', () => {
  const { startGenerate } = makeStreamingXHRPage();
  const { xhr, personToken, emailToken } = startGenerate('my name is bob. my email is alex@example.test');
  assert.ok(personToken && emailToken, 'prompt must mint both tokens');

  const snapshots = [];
  const read = () => {
    const text = xhr.responseText;
    snapshots.push(text);
    return text;
  };

  // Progress 1: the reply stops mid-token — the network split [PERSON_1…].
  xhr._responseText = `Sure, I will email ${personToken.slice(0, 9)}`;
  assert.equal(read(), 'Sure, I will email '); // partial token held back, not leaked

  // Progress 2: that token completes; a second one starts splitting.
  xhr._responseText = `Sure, I will email ${personToken} now (${emailToken.slice(0, 7)}`;
  const second = read();
  assert.match(second, /bob/); // already restored for the page to render...
  assert.equal(second.startsWith('Sure, I will email '), true); // ...without rewriting the prefix
  assert.equal(second.includes('['), false); // no raw token fragment delivered

  // Progress 3: the transfer finishes — everything flushes.
  xhr.readyState = 4;
  xhr._responseText = `Sure, I will email ${personToken} now (${emailToken}). Done!`;
  const final = read();

  // The regression guard: every read must start with the previous read.
  // The old getter returned `…email [PERSON_1` first and then the SHRUNKEN
  // `…email bob…`, which silently skipped characters for an offset-tracking
  // consumer — that is the desync that froze Gemini's stream.
  for (let i = 1; i < snapshots.length; i += 1) {
    assert.equal(
      snapshots[i].startsWith(snapshots[i - 1]),
      true,
      `read ${i} changed already-delivered text: ${JSON.stringify(snapshots[i - 1])} -> ${JSON.stringify(snapshots[i])}`
    );
  }
  assert.equal(final, 'Sure, I will email bob now (alex@example.test). Done!');
  assert.equal(final.includes('['), false);
});

// The hold-back tail must not eat the end of the reply: readyState 4 means no
// more bytes can arrive, so even text that still LOOKS like a token prefix is
// delivered (otherwise the last characters of a reply could vanish).
test('XHR holds a token-shaped tail only until the transfer finishes', () => {
  const { startGenerate } = makeStreamingXHRPage();
  const { xhr, personToken } = startGenerate('my name is bob');

  // While the transfer is open, a bracket that could grow into a token waits.
  xhr._responseText = `The name is ${personToken.slice(0, 8)}`;
  assert.equal(xhr.responseText, 'The name is ');

  // DONE: flush the held tail verbatim.
  xhr.readyState = 4;
  assert.equal(xhr.responseText, `The name is ${personToken.slice(0, 8)}`);
});

// restoreText caches its longest-first ordering (streaming readers call it
// per network chunk). Minting a new token must invalidate that cache or later
// restores would miss the new mapping.
test('restoreText picks up tokens minted after the cache warmed', () => {
  const masker = createMasker();
  const first = masker.maskText('My name is John Doe.');
  assert.match(masker.restoreText(first), /John Doe/); // warms the sorted cache
  const second = masker.maskText('Email me at alex@example.test.'); // new token
  const restored = masker.restoreText(`${first} ${second}`);
  assert.match(restored, /John Doe/);
  assert.match(restored, /alex@example\.test/);
  assert.equal(restored.includes('['), false);
});

// ChatGPT's unauthenticated mobile-web endpoint is a second real-world shape:
// plain JSON body, plus the stats/vault messages the content script consumes.
test('fetch wrapper masks ChatGPT unauth-mweb conversation updates requests', async () => {
  const listeners = new Map();
  const messages = [];
  const diagnostics = [];
  let transmittedBody;
  const pageWindow = {
    location: {
      href: 'https://chatgpt.com/',
      origin: 'https://chatgpt.com',
      hostname: 'chatgpt.com'
    },
    Request,
    TransformStream,
    console: { info(message) { diagnostics.push(message); } },
    addEventListener: (type, listener) => listeners.set(type, listener),
    postMessage(message) { messages.push(message); },
    fetch: async (_input, init) => {
      transmittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  };
  const source = fs.readFileSync(require.resolve('../intercept.bundle.js'), 'utf8');
  vm.runInNewContext(source, {
    require,
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder
  });
  listeners.get('message')({
    source: pageWindow,
    origin: pageWindow.location.origin,
    data: { type: 'CLOAK_CONFIG', enabled: true, settings: {} }
  });

  // Prompt arrives with an email already tokenized (re-submitted turn).
  await pageWindow.fetch(
    'https://chatgpt.com/unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=test',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '1. write an email to principal chadwick at 123 reedy creek ln saying i need my psat test scores back at [EMAIL_3_ea931cb0]\n2.'
      })
    }
  );

  const masked = (messages.find(({ type }) => type === 'CLOAK_MASKED_DATA') || { entries: [] }).entries;
  const personToken = masked.find(({ original }) => original.toLowerCase() === 'principal chadwick').token;
  const addressToken = masked.find(({ original }) => original.toLowerCase() === '123 reedy creek ln').token;
  assert.match(personToken, /^\[PERSON_\d+_[a-z0-9]+\]$/);
  assert.match(addressToken, /^\[ADDRESS_\d+_[a-z0-9]+\]$/);
  assert.equal(transmittedBody.prompt.includes(personToken), true);
  assert.equal(transmittedBody.prompt.includes(addressToken), true);
  // The pre-existing email token survives untouched.
  assert.match(transmittedBody.prompt, /\[EMAIL_3_ea931cb0\]/);
  assert.equal(transmittedBody.prompt.includes('principal chadwick'), false);
  assert.equal(transmittedBody.prompt.includes('123 reedy creek ln'), false);
  // Stats message carries the counters the popup dashboard reads.
  const statsMessage = messages.find(({ type }) => type === 'CLOAK_REQUEST_STATS');
  assert.equal(statsMessage.requestsChecked, 1);
  assert.equal(statsMessage.valuesMasked, 2);
  // Diagnostics must describe the rewrite WITHOUT leaking the raw values.
  assert.equal(diagnostics.some((message) => message.includes('categories=names,emails,phones,addresses') && message.includes('values replaced=2') && message.includes('payload changed=true')), true);
  assert.equal(diagnostics.some((message) => message.includes('chadwick') || message.includes('123 reedy creek ln')), false);
});

// Stringifying URLSearchParams drops the Content-Type header; the wrapper
// must restore it so the server still parses the form body.
test('preserves the inferred form content type when rewriting URLSearchParams', async () => {
  const listeners = new Map();
  const messages = [];
  let sentContentType;
  let sentBody;
  const pageWindow = {
    location: {
      href: 'https://chatgpt.com/',
      origin: 'https://chatgpt.com',
      hostname: 'chatgpt.com'
    },
    Request,
    TransformStream,
    console: { info() {} },
    addEventListener: (type, listener) => listeners.set(type, listener),
    postMessage(message) { messages.push(message); },
    fetch: async (_input, init) => {
      sentContentType = new Headers(init.headers).get('content-type');
      sentBody = new URLSearchParams(init.body).get('prompt');
      return new Response('ok');
    }
  };
  const source = fs.readFileSync(require.resolve('../intercept.bundle.js'), 'utf8');
  vm.runInNewContext(source, {
    require,
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder
  });
  listeners.get('message')({
    source: pageWindow,
    origin: pageWindow.location.origin,
    data: { type: 'CLOAK_CONFIG', enabled: true, settings: {} }
  });

  await pageWindow.fetch(
    'https://chatgpt.com/unauth-mweb/conversation/updates',
    {
      method: 'POST',
      body: new URLSearchParams({ prompt: 'my name is bob and phone 919-123-4567' })
    }
  );

  assert.match(sentContentType, /^application\/x-www-form-urlencoded/i);
  const masked = (messages.find(({ type }) => type === 'CLOAK_MASKED_DATA') || { entries: [] }).entries;
  const personToken = masked.find(({ original }) => original === 'bob').token;
  const phoneToken = masked.find(({ original }) => original === '919-123-4567').token;
  assert.equal(sentBody.includes(personToken), true);
  assert.equal(sentBody.includes(phoneToken), true);
  assert.equal(sentBody.includes('bob'), false);
  assert.equal(sentBody.includes('919-123-4567'), false);
});

// ---------------------------------------------------------------------------
// Gemini processSession transport (2026): prompts ride as base64 protobuf
// form parts (req0___data__, req1___data__) on
// geminiweb-pa.clients6.google.com/v1/processSession, and replies stream as
// length-prefixed RPC frames ("<byte-length>\n<json>") whose JSON nests the
// same protobufs. Cloak must mask inside the request protobufs and restore
// inside complete reply frames — with a corrected length prefix each time.
// ---------------------------------------------------------------------------

// Tiny protobuf encoders so the suite builds wire-shaped payloads locally
// instead of shipping captured request bytes.
const encVarint = (value) => {
  const out = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte += 128;
    out.push(byte);
  } while (remaining > 0);
  return out;
};
const encTag = (field, wireType) => encVarint(field * 8 + wireType);
const encBytesField = (field, bytes) => [...encTag(field, 2), ...encVarint(bytes.length), ...bytes];
const encStringField = (field, text) => encBytesField(field, [...Buffer.from(text, 'utf8')]);
const encVarintField = (field, value) => [...encTag(field, 0), ...encVarint(value)];
// Strict parser for test assertions: returns [{field, wireType, varint?/bytes?/raw?}]
// or null when ANY byte is not a well-formed, fully consumed field.
const parseProtoStrict = (buf) => {
  const readVarint = (b, o) => {
    let value = 0;
    let shift = 0;
    let x;
    do {
      if (o >= b.length) return null;
      x = b[o];
      o += 1;
      value += (x & 0x7f) * (2 ** shift);
      shift += 7;
    } while (x >= 0x80);
    return [value, o];
  };
  const fields = [];
  let o = 0;
  while (o < buf.length) {
    const tag = readVarint(buf, o);
    if (!tag) return null;
    o = tag[1];
    const field = Math.floor(tag[0] / 8);
    const wireType = tag[0] % 8;
    if (field === 0) return null;
    if (wireType === 0) {
      const v = readVarint(buf, o);
      if (!v) return null;
      o = v[1];
      fields.push({ field, wireType, varint: v[0] });
    } else if (wireType === 1) {
      if (o + 8 > buf.length) return null;
      fields.push({ field, wireType, bytes: buf.subarray(o, o + 8) });
      o += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, o);
      if (!len) return null;
      o = len[1];
      if (o + len[0] > buf.length) return null;
      fields.push({ field, wireType, bytes: buf.subarray(o, o + len[0]) });
      o += len[0];
    } else if (wireType === 5) {
      if (o + 4 > buf.length) return null;
      fields.push({ field, wireType, bytes: buf.subarray(o, o + 4) });
      o += 4;
    } else {
      return null;
    }
  }
  return fields;
};
// Observed req1 shape: field 2 { field 1: varint, field 9 { field 1: string(prompt) } }.
const buildUserPart = (prompt) => encBytesField(2, [
  ...encVarintField(1, 1),
  ...encBytesField(9, encStringField(1, prompt))
]);
// Session metadata: non-prose strings that must pass through byte-identical.
const buildSessionPart = () => encBytesField(1, [
  ...encVarintField(1, 1),
  ...encStringField(2, 'cf41b0e0dd7d53e5'),
  ...encStringField(3, 'en-US')
]);

test('masks PII inside Gemini processSession protobuf request parts', () => {
  const masker = createMasker();
  const sessionPart = buildSessionPart();
  const prompt = 'My name is John Doe. My email is tester@example.test and my phone is 415-555-0199.';
  const body = `count=2&ofs=0&req0___data__=${Buffer.from(sessionPart).toString('base64')}&req1___data__=${Buffer.from(buildUserPart(prompt)).toString('base64')}`;
  // Google sometimes omits Content-Type on this endpoint; detection is by body shape.
  const rewritten = masker.rewriteBody(body, '');
  const params = new URLSearchParams(rewritten);

  // Session metadata is not prose — the part must survive byte-identical.
  assert.equal(params.get('req0___data__'), Buffer.from(sessionPart).toString('base64'));
  // The user part now carries tokens instead of the originals.
  const sentText = Buffer.from(params.get('req1___data__'), 'base64').toString('utf8');
  assert.match(sentText, /\[PERSON_\d+_[a-z0-9-]+\]/);
  assert.match(sentText, /\[EMAIL_\d+_[a-z0-9-]+\]/);
  assert.match(sentText, /\[PHONE_\d+_[a-z0-9-]+\]/);
  assert.equal(sentText.includes('John Doe'), false);
  assert.equal(sentText.includes('tester@example.test'), false);
  assert.equal(sentText.includes('415-555-0199'), false);
  assert.equal(masker.takeMaskedCount(), 3);
  // Same restore map the response path uses brings the originals back.
  const restored = masker.restoreText(sentText);
  assert.match(restored, /John Doe/);
  assert.match(restored, /tester@example\.test/);
  assert.match(restored, /415-555-0199/);
});

// Regression: a submessage whose inner string is <128 chars has a PRINTABLE
// length byte (0x7E for 126), so the whole submessage decodes as "valid
// UTF-8 text". Masking it as one flat sentence left the stale structure
// bytes (0a 7e) inside the string and sent a corrupt protobuf — the server
// rejected the request ("Something went wrong"). Structure must win: bytes
// that parse as a complete message are recursed into, never prose-masked.
test('keeps submessage nesting when the length byte is printable', () => {
  const masker = createMasker();
  const prompt = 'My name is John Doe. My email is tester@example.test and my phone is 415-555-0199. Please repeat all three back to me exactly.';
  assert.equal(prompt.length, 126); // inner string len byte = 0x7E — printable

  const textBytes = [...Buffer.from(prompt, 'utf8')];
  const f1String = [0x0a, ...encVarint(textBytes.length), ...textBytes];
  const f9 = [0x4a, ...encVarint(f1String.length), ...f1String];
  const f2Content = [0x08, 0x01, ...f9];
  const userPart = [0x12, ...encVarint(f2Content.length), ...f2Content];
  const body = `count=1&ofs=1&req0___data__=${Buffer.from(userPart).toString('base64')}`;

  const rewritten = masker.rewriteBody(body, '');
  assert.equal(masker.takeMaskedCount(), 3);

  // Strict structural walk: every level must still parse as a message.
  const top = parseProtoStrict(Buffer.from(new URLSearchParams(rewritten).get('req0___data__'), 'base64'));
  assert.ok(top, 'top level must parse');
  const f2 = top.find(({ field }) => field === 2);
  assert.ok(f2, 'f2 must survive');
  const inner = parseProtoStrict(f2.bytes);
  assert.ok(inner, 'f2 content must parse');
  const f9Field = inner.find(({ field }) => field === 9);
  assert.ok(f9Field, 'f9 must survive');
  const f9Inner = parseProtoStrict(f9Field.bytes);
  assert.ok(f9Inner, 'f9 content must be a message, not a flat string');
  const promptField = f9Inner.find(({ field }) => field === 1);
  assert.ok(promptField, 'prompt must still live in f9/f1');
  const maskedPrompt = Buffer.from(promptField.bytes).toString('utf8');

  assert.match(maskedPrompt, /My name is \[PERSON_1_[a-z0-9-]+\]/);
  assert.equal(maskedPrompt.includes('John Doe'), false);
  assert.equal(maskedPrompt.includes('tester@example.test'), false);
  assert.equal(maskedPrompt.includes('415-555-0199'), false);
  // The corruption signature: stale structure bytes swallowed into the text.
  assert.equal(maskedPrompt.includes('\n~'), false);
  // The prompt itself restores exactly (the reveal notice, appended after
  // masking, is the only extra text and restores with its placeholders intact).
  assert.equal(masker.restoreText(maskedPrompt).startsWith(prompt), true);
  assert.match(maskedPrompt, /\[Cloak privacy notice\]/);
});

// The frame-aware response path is per-XHR-instance bundle wiring, so this
// one runs through the vm bundle like the other integration tests. Note the
// sandbox needs atob/btoa: the codec uses them to decode the nested base64.
test('XHR restores tokens inside processSession RPC response frames', () => {
  const listeners = new Map();
  const messages = [];
  class MockXHR {
    constructor() {
      this.headers = {};
      this.responseType = '';
      this.status = 200;
      this.readyState = 2; // LOADING — the long-poll is still open
      this._responseText = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    }
    send(body) {
      this.sentBody = body;
      const params = new URLSearchParams(body);
      const text = Buffer.from(params.get('req1___data__'), 'base64').toString('utf8');
      this.mintedTokens = text.match(/\[(?:PERSON|PHONE|EMAIL)_[^\]]+\]/g) || [];
      this._responseText = '';
    }
  }
  Object.defineProperty(MockXHR.prototype, 'responseText', {
    configurable: true,
    get() { return this._responseText; }
  });
  Object.defineProperty(MockXHR.prototype, 'response', {
    configurable: true,
    get() { return this._responseText; }
  });

  const pageWindow = {
    location: {
      href: 'https://gemini.google.com/app',
      origin: 'https://gemini.google.com',
      hostname: 'gemini.google.com'
    },
    XMLHttpRequest: MockXHR,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    console: { info() {}, warn() {} },
    addEventListener: (type, listener) => listeners.set(type, listener),
    postMessage: (message) => messages.push(message),
    fetch: async () => new Response('ok')
  };
  const source = fs.readFileSync(require.resolve('../intercept.bundle.js'), 'utf8');
  vm.runInNewContext(source, {
    require,
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64')
  });
  listeners.get('message')({
    source: pageWindow,
    origin: pageWindow.location.origin,
    data: { type: 'CLOAK_CONFIG', enabled: true, settings: {} }
  });

  const prompt = 'my name is bob and my phone number is 919-123-4567';
  const xhr = new pageWindow.XMLHttpRequest();
  xhr.open('POST', 'https://geminiweb-pa.clients6.google.com/v1/processSession');
  xhr.send(new URLSearchParams({
    count: '2',
    ofs: '0',
    req0___data__: Buffer.from(buildSessionPart()).toString('base64'),
    req1___data__: Buffer.from(buildUserPart(prompt)).toString('base64')
  }).toString());

  // Outgoing: tokens on the wire, originals gone.
  const personToken = xhr.mintedTokens.find((token) => token.startsWith('[PERSON')) || '';
  const phoneToken = xhr.mintedTokens.find((token) => token.startsWith('[PHONE')) || '';
  assert.ok(personToken && phoneToken, 'prompt must mint both tokens');
  const sentText = Buffer.from(new URLSearchParams(xhr.sentBody).get('req1___data__'), 'base64').toString('utf8');
  assert.equal(sentText.includes(personToken), true);
  assert.equal(sentText.includes(phoneToken), true);
  assert.equal(sentText.includes('bob'), false);
  assert.equal(sentText.includes('919-123-4567'), false);

  // Reply: a length-prefixed RPC frame whose JSON nests a base64 protobuf
  // holding the token-bearing answer — the shape Gemini streams today.
  const replyProto = encStringField(1, `Sure — ${personToken} stays ${phoneToken}.`);
  const replyJson = JSON.stringify([[0, ['c', Buffer.from(replyProto).toString('base64'), '', 8, 15, 30000]]]);
  const frame = `${Buffer.byteLength(replyJson, 'utf8')}\n${replyJson}`;

  const snapshots = [];
  const read = () => {
    const text = xhr.responseText;
    snapshots.push(text);
    return text;
  };

  // The real stream opens with Google's anti-XSSI prefix; it must pass
  // through verbatim instead of wedging the frame parser (holding it
  // forever would deadlock a long-poll that never ends).
  const xssi = ")]}'\n";

  // Progress 1: prefix delivered, frame split mid-JSON — incomplete held.
  xhr._responseText = xssi + frame.slice(0, Math.floor(frame.length / 2));
  assert.equal(read(), xssi);

  // Progress 2: the frame completes — restored with a corrected length prefix.
  xhr._responseText = xssi + frame;
  const full = read();
  assert.equal(full.startsWith(xssi), true);
  const newline = full.indexOf('\n', xssi.length);
  const lengthText = full.slice(xssi.length, newline);
  const deliveredJson = full.slice(newline + 1);
  assert.match(lengthText, /^\d+$/);
  assert.equal(Number(lengthText), Buffer.byteLength(deliveredJson, 'utf8'), 'length prefix must match the restored frame bytes');
  const deliveredText = Buffer.from(JSON.parse(deliveredJson)[0][1][1], 'base64').toString('utf8');
  assert.match(deliveredText, /bob/);
  assert.match(deliveredText, /919-123-4567/);
  assert.equal(deliveredText.includes(personToken), false);
  assert.equal(deliveredText.includes(phoneToken), false);

  // Progress 3: a second frame arrives behind an inter-frame separator; the
  // first frame must not be re-delivered differently (append-only).
  const tailJson = JSON.stringify([[0, ['c', 'done']]]);
  const tailFrame = `${Buffer.byteLength(tailJson, 'utf8')}\n${tailJson}`;
  xhr._responseText = `${xssi}${frame}\r\n${tailFrame}`;
  const third = read();
  assert.equal(third.startsWith(full), true);
  assert.equal(third.includes('\r\n'), true);
  assert.equal(third.endsWith(tailFrame), true);

  // DONE: any trailing partial bytes flush verbatim instead of being held.
  xhr.readyState = 4;
  xhr._responseText = `${xssi}${frame}\r\n${tailFrame}9\nleft-over`;
  const flushed = read();
  assert.equal(flushed.endsWith('9\nleft-over'), true);

  // Regression guard: every read is a prefix of the next.
  for (let i = 1; i < snapshots.length; i += 1) {
    assert.equal(
      snapshots[i].startsWith(snapshots[i - 1]),
      true,
      `read ${i} changed already-delivered text`
    );
  }
  assert.equal(messages.some(({ type, valuesMasked }) => type === 'CLOAK_REQUEST_STATS' && valuesMasked >= 2), true);
});

// ---------------------------------------------------------------------------
// Deployment-context contract
// ---------------------------------------------------------------------------

// The popup's "Try it" tab reuses this same bundle. Inside an extension page
// the bundle must expose CloakPreview.createMasker and must NOT install the
// fetch/XHR hooks (the popup should never rewrite its own requests).
test('exposes CloakPreview to extension pages without hooking fetch', () => {
  const pageWindow = {
    location: {
      href: 'chrome-extension://obkbnaacfgdcdfoppbmloahombahfndh/popup.html',
      origin: 'chrome-extension://obkbnaacfgdcdfoppbmloahombahfndh',
      hostname: 'obkbnaacfgdcdfoppbmloahombahfndh',
      protocol: 'chrome-extension:'
    },
    addEventListener() {},
    postMessage() {},
    fetch() { return 'native'; }
  };
  const nativeFetch = pageWindow.fetch;
  const source = fs.readFileSync(require.resolve('../intercept.bundle.js'), 'utf8');
  vm.runInNewContext(source, {
    require,
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder
  });

  assert.equal(typeof pageWindow.CloakPreview?.createMasker, 'function');
  assert.equal(pageWindow.fetch, nativeFetch, 'fetch must stay native inside extension pages');

  // The exposed factory produces a working, independent masker instance.
  const masker = pageWindow.CloakPreview.createMasker();
  const masked = masker.maskText('call me at 919-123-4567');
  assert.match(masked, /^call me at \[PHONE_\d+_[a-z0-9]+\]$/);
  assert.equal(masker.restoreText(masked), 'call me at 919-123-4567');
});

// On a real chat page the opposite must hold: hooks installed, no preview API
// (the page must never be handed a masking factory it could misuse).
test('installs interception on chat pages and keeps CloakPreview private', () => {
  const pageWindow = {
    location: {
      href: 'https://gemini.google.com/app',
      origin: 'https://gemini.google.com',
      hostname: 'gemini.google.com',
      protocol: 'https:'
    },
    Request,
    TransformStream,
    console: { info() {}, warn() {} },
    addEventListener() {},
    postMessage() {},
    fetch() { return 'native'; }
  };
  const nativeFetch = pageWindow.fetch;
  const source = fs.readFileSync(require.resolve('../intercept.bundle.js'), 'utf8');
  vm.runInNewContext(source, {
    require,
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder
  });

  assert.notEqual(pageWindow.fetch, nativeFetch, 'chat pages must get the wrapped fetch');
  assert.equal(pageWindow.CloakPreview, undefined, 'the preview factory must not leak into chat pages');
});

// ---------------------------------------------------------------------------
// Reveal protocol (consent flow): the prompt notice, the reply scanner, and
// the consented-value pass-through. Together these let Gemini say "I need
// the real [EMAIL_1_…]" without ever exposing that request to the page —
// Cloak hides the line, shows the user a Share/Decline dialog, and only a
// "Share" makes the real value travel on the wire.
// ---------------------------------------------------------------------------

// The instruction rides along with EVERY masked Gemini prompt. This asserts
// the wire result: one notice, appended to the token-bearing user part,
// AFTER masking (it adds no tokens of its own) and with the exact one-line
// request format the reply scanner is keyed to.
test('appends the Cloak reveal notice to prompts that contain tokens', () => {
  const masker = createMasker();
  const sessionPart = buildSessionPart();
  const prompt = 'My name is John Doe and my email is tester@example.test — book it for me.';
  const body = `count=2&ofs=0&req0___data__=${Buffer.from(sessionPart).toString('base64')}&req1___data__=${Buffer.from(buildUserPart(prompt)).toString('base64')}`;
  const rewritten = masker.rewriteBody(body, '');
  const params = new URLSearchParams(rewritten);

  // Session metadata still ships byte-identical — the notice only ever
  // touches the part that actually carried PII.
  assert.equal(params.get('req0___data__'), Buffer.from(sessionPart).toString('base64'));

  const sentText = Buffer.from(params.get('req1___data__'), 'base64').toString('utf8');
  // Exactly one notice, it sits at the very end of the prompt field, and it
  // spells out the magic line the reply scanner later matches against.
  assert.equal(sentText.split('[Cloak privacy notice]').length - 1, 1);
  assert.equal(sentText.endsWith(REVEAL_INSTRUCTION), true);
  assert.match(REVEAL_INSTRUCTION, /Requesting access to know <PLACEHOLDER> from Cloak/);
  // Appending happened after masking: the count is still just the PII hits,
  // and the originals are still gone from the wire.
  assert.equal(masker.takeMaskedCount(), 2);
  assert.equal(sentText.includes('John Doe'), false);
  assert.equal(sentText.includes('tester@example.test'), false);
});

// No PII → no tokens → nothing to explain → the prompt must ship WITHOUT
// the notice (otherwise every benign conversation gets nagging boilerplate).
test('omits the reveal notice when the prompt contains no tokens', () => {
  const masker = createMasker();
  const prompt = 'What is the boiling point of water at sea level?';
  const body = `count=1&ofs=0&req0___data__=${Buffer.from(buildUserPart(prompt)).toString('base64')}`;
  const rewritten = masker.rewriteBody(body, '');
  const sentText = Buffer.from(new URLSearchParams(rewritten).get('req0___data__'), 'base64').toString('utf8');

  assert.equal(sentText.includes('Cloak privacy notice'), false);
  assert.equal(sentText.includes(prompt), true); // prompt untouched
  assert.equal(masker.takeMaskedCount(), 0);
});

// Direct unit test of the amender: rebuilds the protobuf tree bottom-up, so
// every length prefix stays correct (the class of bug that once made Gemini
// reject live requests). Targets the LAST token-bearing field — in Gemini's
// wire format that is the newest prompt.
test('amends the last token-bearing protobuf field with corrected lengths', () => {
  // Field 1: prose without tokens (left alone). Field 2: token-bearing —
  // both chosen so their leading bytes cannot parse as a nested message.
  const bytes = Uint8Array.from([
    ...encStringField(1, 'no tokens in this field'),
    ...encStringField(2, 'Send this to [EMAIL_1_ab12cd] today')
  ]);
  const result = amendLastProseWithInstruction(bytes);
  assert.equal(result.changed, true);

  // Strict structural walk of the rewritten bytes: both fields still parse,
  // field 1 is untouched, field 2 carries the original text + the notice.
  const fields = parseProtoStrict(result.bytes);
  assert.ok(fields, 'amended buffer must still parse as protobuf');
  const first = Buffer.from(fields.find(({ field }) => field === 1).bytes).toString('utf8');
  const second = Buffer.from(fields.find(({ field }) => field === 2).bytes).toString('utf8');
  assert.equal(first, 'no tokens in this field');
  assert.equal(second, 'Send this to [EMAIL_1_ab12cd] today\n\n' + REVEAL_INSTRUCTION);

  // No token anywhere → unchanged, byte-identical (the rewriteBody gate
  // relies on `changed: false` to skip re-encoding).
  const plain = Uint8Array.from(encStringField(1, 'no tokens in this field'));
  const untouched = amendLastProseWithInstruction(plain);
  assert.equal(untouched.changed, false);
  assert.deepEqual([...untouched.bytes], [...plain]);
});

// Happy path of the reply side: Gemini follows the format, the scanner
// fires exactly one report with the token, and the page (which streams the
// returned string to its renderer) NEVER sees the request line.
test('hides Gemini reveal lines and reports their token', () => {
  const reported = [];
  const scanner = createRevealScanner((captured) => reported.push(captured));
  const reply = 'Sure — done!\nRequesting access to know [EMAIL_1_ab12cd] from Cloak\nAnything else?';

  const delivered = scanner.feed(reply, false);
  assert.deepEqual(reported, ['[EMAIL_1_ab12cd]']);
  assert.equal(delivered.includes('Requesting access'), false);
  assert.equal(delivered.includes('[EMAIL_1_ab12cd]'), false);
  assert.match(delivered, /Sure — done!/); // surrounding prose still renders
  assert.match(delivered, /Anything else\?/);
});

// Models decorate the line with markdown now and then; the exported line
// pattern documents the tolerated drift (wrappers, punctuation, casing).
test('recognizes the reveal line through markdown wrappers', () => {
  assert.match('**Requesting access to know [PHONE_1_zz99qq] from Cloak.**', REVEAL_LINE_PATTERN);
  assert.match('requesting access to know [PHONE_1_zz99qq] from cloak', REVEAL_LINE_PATTERN);
  assert.equal(REVEAL_LINE_PATTERN.test('Requesting access to know more about that'), false);

  // The scanner strips the decorated form whole and reports the token.
  const reported = [];
  const scanner = createRevealScanner((captured) => reported.push(captured));
  const delivered = scanner.feed('**Requesting access to know [PHONE_1_zz99qq] from Cloak.**', false);
  assert.deepEqual(reported, ['[PHONE_1_zz99qq]']);
  assert.equal(delivered, ''); // the line was the entire message
});

// Post-restoration form: response text is restored BEFORE the scanner runs,
// so the capture carries the clear value ("know <real email> from Cloak").
// The scanner reports the capture as-is — install()'s handler maps it back
// to its token via masker.tokenFor (covered by the XHR integration test).
test('reports the restored value form of a reveal line', () => {
  const reported = [];
  const scanner = createRevealScanner((captured) => reported.push(captured));
  const delivered = scanner.feed('Hi — Requesting access to know lucalogix12@gmail.com from Cloak — bye', false);

  assert.deepEqual(reported, ['lucalogix12@gmail.com']);
  assert.equal(delivered.includes('lucalogix12@gmail.com'), false);
  assert.match(delivered, /Hi/);
  assert.match(delivered, /bye/);
});

// Append-only, zero-lag contract: ordinary stream text must pass through
// immediately (Gemini's reader tracks offsets — a committed prefix can never
// be retracted), and nothing may fire without the magic sentence.
test('streams ordinary reply text immediately and append-only', () => {
  const reported = [];
  const scanner = createRevealScanner(() => reported.push('fire'));

  const first = scanner.feed('Hello there — here is ', false);
  assert.equal(first, 'Hello there — here is ');
  const second = scanner.feed('a plain continuation.', false);
  assert.equal(second, 'Hello there — here is a plain continuation.');
  const third = scanner.feed(' All done.', true);
  assert.equal(third, 'Hello there — here is a plain continuation. All done.');
  assert.equal(reported.length, 0);
});

// The core hold rule: a chunk ENDING mid-sentence must wait for its tail
// (the split lands across network chunks all the time), then resolve —
// fire once, strip the whole line, ship everything else.
test('holds a partial reveal sentence across chunks until it completes', () => {
  const reported = [];
  const scanner = createRevealScanner((captured) => reported.push(captured));

  // Chunk 1: the intro line has a newline → final, ships; the sentence
  // fragment has none and builds the magic head → held, not delivered.
  const first = scanner.feed('Sure!\nRequesting acc', false);
  assert.equal(first, 'Sure!\n');
  assert.deepEqual(reported, []);

  // Chunk 2 completes the sentence → reported + removed; remainder ships.
  const second = scanner.feed('ess to know [EMAIL_1_ab12cd] from Cloak\nok', false);
  assert.deepEqual(reported, ['[EMAIL_1_ab12cd]']);
  assert.equal(second, 'Sure!\n\nok');
  assert.equal(second.includes('Requesting'), false);
  assert.equal(second.includes('[EMAIL_1_ab12cd]'), false);
});

// The hold rule must never stall legitimate prose that merely LOOKS like the
// start of the reveal line. The newline proves the line was abandoned → it
// ships verbatim, nothing fires, and even an unfinished stream (no DONE yet)
// unblocks as soon as that newline arrives.
test('does not stall on prose that starts like the reveal line', () => {
  const reported = [];
  const scanner = createRevealScanner(() => reported.push('fire'));

  // No newline after the lookalike yet → held (it could still become real).
  const first = scanner.feed('I would like.\nRequesting access to know more', false);
  assert.equal(first, 'I would like.\n');

  // The newline settles it: prose, not a reveal → ships whole, zero fires.
  const second = scanner.feed(' details.\nDone!\n', false);
  assert.equal(second, 'I would like.\nRequesting access to know more details.\nDone!\n');
  assert.deepEqual(reported, []);
});

// Consent gate on the masker: after the user clicks Share, THAT value
// travels in clear text on follow-up requests (so Gemini can actually act
// on it), while everything else keeps masking — and the shared value does
// not inflate the per-request "masked values" stat.
test('lets consented values pass through in clear text', () => {
  const masker = createMasker();
  const first = masker.maskText('Email lucalogix12@gmail.com today');
  const token = first.match(/\[EMAIL_[^\]]+\]/)[0];
  assert.equal(first.includes('lucalogix12@gmail.com'), false);
  assert.equal(masker.takeMaskedCount(), 1);

  masker.grantConsent(token);

  const followUp = masker.maskText('Email lucalogix12@gmail.com or call 415-555-0199');
  assert.equal(followUp.includes('lucalogix12@gmail.com'), true); // shared → clear
  assert.match(followUp, /\[PHONE_[^\]]+\]/); // everything else still masks
  assert.equal(followUp.includes('415-555-0199'), false);
  assert.equal(masker.takeMaskedCount(), 1); // consented pass is not counted
  assert.equal(masker.tokenFor('lucalogix12@gmail.com'), token); // reverse lookup

  // Consent for an unknown token is ignored (no throw, no stray pass-through).
  masker.grantConsent('[EMAIL_9_unknown-token]');
  assert.equal(masker.maskText('Email lucalogix12@gmail.com again').includes('[EMAIL_'), false);
});

// End-to-end through the shipped bundle: the model replies with the magic
// line (token form — it only ever saw placeholders). The RPC path restores
// the token to its value FIRST, then the frame strip finds the sentence in
// the decoded protobuf prose, maps the value back to its token, removes the
// line from the bytes the page receives, and posts the consent request.
test('XHR strips the reveal line from RPC frames and posts a consent request', () => {
  const listeners = new Map();
  const messages = [];
  class MockXHR {
    constructor() {
      this.headers = {};
      this.responseType = '';
      this.status = 200;
      this.readyState = 2; // LOADING — the long-poll is still open
      this._responseText = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    }
    send(body) {
      this.sentBody = body;
      const params = new URLSearchParams(body);
      const text = Buffer.from(params.get('req1___data__'), 'base64').toString('utf8');
      this.mintedTokens = text.match(/\[(?:PERSON|PHONE|EMAIL)_[^\]]+\]/g) || [];
      this._responseText = '';
    }
  }
  Object.defineProperty(MockXHR.prototype, 'responseText', {
    configurable: true,
    get() { return this._responseText; }
  });
  Object.defineProperty(MockXHR.prototype, 'response', {
    configurable: true,
    get() { return this._responseText; }
  });

  const pageWindow = {
    location: {
      href: 'https://gemini.google.com/app',
      origin: 'https://gemini.google.com',
      hostname: 'gemini.google.com'
    },
    XMLHttpRequest: MockXHR,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    console: { info() {}, warn() {} },
    addEventListener: (type, listener) => listeners.set(type, listener),
    postMessage: (message) => messages.push(message),
    fetch: async () => new Response('ok')
  };
  const source = fs.readFileSync(require.resolve('../intercept.bundle.js'), 'utf8');
  vm.runInNewContext(source, {
    require,
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64')
  });
  listeners.get('message')({
    source: pageWindow,
    origin: pageWindow.location.origin,
    data: { type: 'CLOAK_CONFIG', enabled: true, settings: {} }
  });

  // Turn 1: PII goes out tokenized, and the reveal notice rides along.
  const prompt = 'my name is bob and my phone number is 919-123-4567';
  const xhr = new pageWindow.XMLHttpRequest();
  xhr.open('POST', 'https://geminiweb-pa.clients6.google.com/v1/processSession');
  xhr.send(new URLSearchParams({
    count: '2',
    ofs: '0',
    req0___data__: Buffer.from(buildSessionPart()).toString('base64'),
    req1___data__: Buffer.from(buildUserPart(prompt)).toString('base64')
  }).toString());

  const personToken = xhr.mintedTokens.find((token) => token.startsWith('[PERSON')) || '';
  assert.ok(personToken, 'prompt must mint a person token');
  const sentText = Buffer.from(new URLSearchParams(xhr.sentBody).get('req1___data__'), 'base64').toString('utf8');
  assert.equal(sentText.includes('[Cloak privacy notice]'), true);

  // The model follows the instruction and replies with the magic line
  // (token form — placeholders are all it knows). Restoration will swap the
  // token for "bob" before the strip runs, exercising the value-form
  // capture + tokenFor() mapping. The "S" first byte makes the decoded text
  // fail strict protobuf parsing (group wire-type), so it takes the prose
  // path deterministically — same trick as the existing reply-frame test.
  const replyProto = encStringField(1, `Sure — done.\nRequesting access to know ${personToken} from Cloak\nAnything else?`);
  const replyJson = JSON.stringify([[0, ['c', Buffer.from(replyProto).toString('base64'), '', 8, 15, 30000]]]);
  const frame = `${Buffer.byteLength(replyJson, 'utf8')}\n${replyJson}`;

  const reads = [];
  const read = () => {
    const text = xhr.responseText;
    reads.push(text);
    return text;
  };

  // Progress 1: half a frame arrives — held (incomplete), nothing fires.
  xhr._responseText = frame.slice(0, Math.floor(frame.length / 2));
  assert.equal(read(), '');

  // Progress 2: the frame completes — restored AND stripped.
  xhr._responseText = frame;
  const delivered = read();
  const newline = delivered.indexOf('\n');
  const deliveredJson = delivered.slice(newline + 1);
  assert.equal(Number(delivered.slice(0, newline)), Buffer.byteLength(deliveredJson, 'utf8'), 'length prefix must match the re-encoded frame');
  const deliveredText = Buffer.from(JSON.parse(deliveredJson)[0][1][1], 'base64').toString('utf8');
  // The page receives the reply prose minus the reveal line entirely.
  assert.equal(deliveredText.includes('Requesting access to know'), false);
  assert.equal(deliveredText.includes(personToken), false);
  assert.equal(deliveredText.includes('bob'), false); // only lived inside the hidden line
  assert.match(deliveredText, /done/);
  assert.match(deliveredText, /Anything else\?/);

  // The consent request reached the content script with the token AND the
  // human-readable value (the dialog shows the user what would be shared).
  const reveal = messages.find(({ type }) => type === 'CLOAK_REVEAL_REQUEST');
  assert.ok(reveal, 'reveal request must be posted');
  assert.equal(reveal.token, personToken);
  assert.equal(reveal.original, 'bob');

  // Append-only: every read is a prefix of the next (nothing already
  // delivered is ever retracted or rewritten).
  for (let i = 1; i < reads.length; i += 1) {
    assert.equal(reads[i].startsWith(reads[i - 1]), true, `read ${i} changed already-delivered text`);
  }
});
