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
  restoreStream
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
