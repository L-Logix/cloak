const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {
  containsMediaIntent,
  createMasker,
  isTargetRequest,
  restoreStream
} = require('../intercept.js');

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
});

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

test('masks a name after a title and a US street address in the reported prompt', () => {
  const masker = createMasker();
  const original = 'write an email to principal chadwick at 123 reedy creek ln saying i need my psat test scores back at alex@example.test';
  const masked = masker.maskText(original);
  const entries = masker.takePendingEntries();

  assert.match(masked, /principal \[PERSON_1_[a-z0-9-]+\] at \[ADDRESS_2_[a-z0-9-]+\].*\[EMAIL_3_[a-z0-9-]+\]/i);
  assert.equal(masked.includes('chadwick'), false);
  assert.equal(masked.includes('123 reedy creek ln'), false);
  assert.deepEqual(entries.map(({ original: value }) => value), [
    'chadwick', '123 reedy creek ln', 'alex@example.test'
  ]);
  assert.equal(masker.restoreText(masked), original);
});

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

test('detects media generation requests for the unmasked fallback', () => {
  assert.equal(containsMediaIntent('Please draw a picture of a dog'), true);
  assert.equal(containsMediaIntent('What is in this picture?'), false);
});

test('respects per-category settings', () => {
  const masker = createMasker();
  masker.configure({ enabled: true, settings: { names: false, emails: true, phones: false, addresses: false } });
  const masked = masker.rewriteBody(JSON.stringify({ text: 'My name is John Doe, email john@example.com, phone 415-555-0137, address 123 Reedy Creek Ln' }));

  assert.match(JSON.parse(masked).text, /^My name is John Doe, email \[EMAIL_1_[a-z0-9-]+\], phone 415-555-0137, address 123 Reedy Creek Ln$/i);
});

test('response restoration preference is configurable', () => {
  const masker = createMasker();
  assert.equal(masker.shouldRestoreResponses(), true);
  masker.configure({ enabled: true, settings: { restoreResponses: false } });
  assert.equal(masker.shouldRestoreResponses(), false);
});

test('detects media intent in URL-encoded request bodies', () => {
  assert.equal(containsMediaIntent('f.req=Please+draw+a+picture'), true);
});

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
    fetch: async (_input, init) => {
      const params = new URLSearchParams(init.body);
      const outer = JSON.parse(params.get('f.req'));
      transmittedPrompt = JSON.parse(outer[1])[0][0];
      const token = transmittedPrompt.match(/\[EMAIL_[^\]]+\]/)[0];
      return new Response(`data: ${JSON.stringify({ text: token })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
  };
  const source = fs.readFileSync(require.resolve('../intercept.js'), 'utf8');
  vm.runInNewContext(source, {
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder,
    crypto: { randomUUID: () => 'test-session' }
  });
  listeners.get('message')({
    source: pageWindow,
    origin: pageWindow.location.origin,
    data: { type: 'CLOAK_CONFIG', enabled: true, settings: {} }
  });

  const nested = JSON.stringify([['Contact alex@example.test']]);
  const response = await pageWindow.fetch(
    'https://gemini.google.com/_/BardChatUi/data/StreamGenerate',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'f.req': JSON.stringify([null, nested]) }).toString()
    }
  );
  const restored = await response.text();

  assert.match(transmittedPrompt, /\[EMAIL_1_test-ses\]/);
  assert.equal(transmittedPrompt.includes('alex@example.test'), false);
  assert.match(restored, /alex@example\.test/);
  assert.equal(messages.some(({ type }) => type === 'CLOAK_MASKED_DATA'), true);
  assert.equal(consoleMessages.some((message) => message.includes('Gemini request sent with protection enabled; 1 new sensitive value')), true);
  assert.equal(consoleMessages.some((message) => message.includes('Gemini server responded with HTTP 200')), true);
  assert.equal(consoleMessages.some((message) => message.includes('response delivered after local token restoration') && message.includes('alex@example.test')), true);
});

test('fetch wrapper masks ChatGPT unauth-mweb conversation updates requests', async () => {
  const listeners = new Map();
  let transmittedBody;
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
    postMessage() {},
    fetch: async (_input, init) => {
      transmittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  };
  const source = fs.readFileSync(require.resolve('../intercept.js'), 'utf8');
  vm.runInNewContext(source, {
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder,
    crypto: { randomUUID: () => 'chat-test' }
  });
  listeners.get('message')({
    source: pageWindow,
    origin: pageWindow.location.origin,
    data: { type: 'CLOAK_CONFIG', enabled: true, settings: {} }
  });

  await pageWindow.fetch(
    'https://chatgpt.com/unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=test',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'hi my name is bob and my phone number is 919-123-4567'
      })
    }
  );

  assert.match(transmittedBody.prompt, /\[PERSON_1_chat-tes\]/);
  assert.match(transmittedBody.prompt, /\[PHONE_2_chat-tes\]/);
  assert.equal(transmittedBody.prompt.includes('bob'), false);
  assert.equal(transmittedBody.prompt.includes('919-123-4567'), false);
});

test('preserves the inferred form content type when rewriting URLSearchParams', async () => {
  const listeners = new Map();
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
    postMessage() {},
    fetch: async (_input, init) => {
      sentContentType = new Headers(init.headers).get('content-type');
      sentBody = new URLSearchParams(init.body).get('prompt');
      return new Response('ok');
    }
  };
  const source = fs.readFileSync(require.resolve('../intercept.js'), 'utf8');
  vm.runInNewContext(source, {
    window: pageWindow,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TransformStream,
    TextEncoder,
    TextDecoder,
    crypto: { randomUUID: () => 'form-test' }
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
  assert.match(sentBody, /\[PERSON_1_form-tes\]/);
  assert.match(sentBody, /\[PHONE_2_form-tes\]/);
});
