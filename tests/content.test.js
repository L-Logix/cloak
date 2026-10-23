// Cloak — content-script tests. content.js is an IIFE with no exports, so
// these load the real file into a node:vm sandbox faking the browser and
// chrome.* APIs. Pins: the stats/vault bridge persists interceptor messages,
// and an invalidated extension context goes dormant without throwing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ORIGIN = 'https://gemini.google.com';

// Build a fake page + chrome.* environment around the real content.js.
function loadContentScript() {
  const storageData = {
    enabled: true,
    settings: {},
    vault: {},
    stats: { requestsChecked: 0, valuesMasked: 0 }
  };
  // Flip via the handle to simulate Chrome severing the extension context:
  // every chrome.storage call then throws.
  const harness = { storageBroken: false, warnings: [], messages: [], storageData, onMessage: null };

  const windowObj = {
    location: { origin: ORIGIN, hostname: 'gemini.google.com' },
    addEventListener(type, listener) {
      if (type === 'message') harness.onMessage = listener;
    },
    postMessage(message) { harness.messages.push(message); }
  };
  windowObj.window = windowObj;
  harness.window = windowObj; // content.js compares event.source === window

  const chromeMock = {
    runtime: { lastError: null },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(_keys, callback) {
          if (harness.storageBroken) throw new Error('Extension context invalidated');
          callback(structuredClone(storageData));
        },
        set(patch, callback) {
          if (harness.storageBroken) throw new Error('Extension context invalidated');
          Object.assign(storageData, structuredClone(patch));
          if (callback) callback();
        }
      }
    }
  };

  const sandbox = {
    window: windowObj,
    location: windowObj.location,
    chrome: chromeMock,
    console: {
      info() {},
      warn(message) { harness.warnings.push(String(message)); }
    },
    document: {
      documentElement: {},
      addEventListener() {},
      querySelectorAll() { return []; }
    },
    MutationObserver: class { observe() {} },
    requestAnimationFrame() {}, // never run composer discovery in these tests
    setTimeout,
    clearTimeout
  };
  Object.assign(sandbox, { self: sandbox, globalThis: sandbox });

  const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'content.js' });
  return harness;
}

// Let the stats write queue (promise-chained) settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

// Deliver one interceptor message the way the MAIN world would.
function deliver(harness, data) {
  harness.onMessage({ source: harness.window, origin: ORIGIN, data });
}

test('persists stats and vault messages from the interceptor', async () => {
  const harness = loadContentScript();
  assert.ok(harness.onMessage, 'content script must register a message listener');

  deliver(harness, { type: 'CLOAK_REQUEST_STATS', requestsChecked: 1, valuesMasked: 3 });
  await flush();
  assert.equal(harness.storageData.stats.requestsChecked, 1);
  assert.equal(harness.storageData.stats.valuesMasked, 3);

  deliver(harness, {
    type: 'CLOAK_MASKED_DATA',
    entries: [{ token: '[PERSON_1_2pkqc9]', original: 'Bob Carter' }]
  });
  await flush();
  assert.equal(harness.storageData.vault['[PERSON_1_2pkqc9]'], 'Bob Carter');
  assert.equal(harness.warnings.length, 0);
});

test('goes dormant after extension-context invalidation without warning', async () => {
  const harness = loadContentScript();
  // Prove the bridge works while the context is alive.
  deliver(harness, { type: 'CLOAK_REQUEST_STATS', requestsChecked: 1, valuesMasked: 1 });
  await flush();
  assert.equal(harness.storageData.stats.requestsChecked, 1);

  // Chrome severs the context (extension reloaded, tab stays open).
  harness.storageBroken = true;

  // The old interceptor keeps posting — this used to warn once per request.
  deliver(harness, { type: 'CLOAK_REQUEST_STATS', requestsChecked: 1, valuesMasked: 2 });
  deliver(harness, { type: 'CLOAK_REQUEST_STATS', requestsChecked: 1, valuesMasked: 2 });
  deliver(harness, {
    type: 'CLOAK_MASKED_DATA',
    entries: [{ token: '[EMAIL_2_v5h4j4]', original: 'bob@example.com' }]
  });
  await flush();

  // No throw reached the page, no warning was logged, nothing was written.
  assert.equal(harness.warnings.length, 0, 'an invalidated context must go quiet, not warn per request');
  assert.equal(harness.storageData.stats.requestsChecked, 1, 'counters stop advancing once the context is dead');
  assert.equal(harness.storageData.vault['[EMAIL_2_v5h4j4]'], undefined);
});
