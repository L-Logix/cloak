const nlp = require('compromise');
const parseAddress = require('addressit');

(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = {
    names: true,
    emails: true,
    phones: true,
    addresses: true,
    restoreResponses: true,
    showBadge: true,
    customTerms: []
  };
  const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const PHONE_PATTERN = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;
  const PERSON_INTRODUCER = /\b(?:my name is|i am|i'm|this is)\s+([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3})/giu;
  const RECIPIENT_CUE = /\bto\s+([^,.;!?\n]+?)\s+at\b/giu;
  const UK_POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i;
  const NAME_STOPWORDS = new Set(['a', 'an', 'and', 'at', 'email', 'for', 'in', 'is', 'my', 'name', 'number', 'of', 'on', 'or', 'phone', 'the', 'to', 'with']);
  const MEDIA_PATTERN = /\b(?:draw|generate|create|make)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|video)\b|\bimage generation\b/i;

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function personCandidates(text) {
    const candidates = new Set();
    try {
      for (const name of nlp(text).people().out('array')) {
        if (typeof name !== 'string') continue;
        const cleaned = name.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').trim();
        if (cleaned) candidates.add(cleaned);
      }
    } catch {
      // Contextual extraction below remains available if the NLP pass fails.
    }

    for (const match of text.matchAll(PERSON_INTRODUCER)) {
      const words = match[1].trim().split(/\s+/);
      while (words.length > 1 && NAME_STOPWORDS.has(words.at(-1).toLowerCase())) words.pop();
      if (words.length && !NAME_STOPWORDS.has(words[0].toLowerCase())) candidates.add(words.join(' '));
    }

    for (const match of text.matchAll(RECIPIENT_CUE)) {
      const recipient = match[1].trim();
      if (!recipient || recipient.includes('[')) continue;
      let recognized = [];
      try {
        recognized = nlp(recipient).people().out('array');
      } catch {
        recognized = [];
      }
      if (recognized.length) {
        recognized.forEach((name) => candidates.add(name.trim()));
      } else {
        const words = recipient.split(/\s+/).filter((word) => !NAME_STOPWORDS.has(word.toLowerCase()));
        if (words.length) candidates.add(words.slice(-3).join(' '));
      }
    }
    return [...candidates].sort((a, b) => b.length - a.length);
  }

  function findPersonSpans(text) {
    const spans = [];
    for (const candidate of personCandidates(text)) {
      const expression = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(candidate)}(?![\\p{L}\\p{N}_])`, 'giu');
      for (const match of text.matchAll(expression)) {
        if (match[0].includes('[')) continue;
        if (!spans.some(({ start, end }) => match.index < end && match.index + match[0].length > start)) {
          spans.push({ start: match.index, end: match.index + match[0].length, value: match[0], category: 'PERSON' });
        }
      }
    }
    return spans.sort((a, b) => b.start - a.start);
  }

  function extendAddressSpan(candidate, parsed, streetEnd) {
    const placeMatches = [];
    for (const region of parsed.regions || []) {
      let places = [];
      try {
        places = nlp(region).places().out('array');
      } catch {
        places = [];
      }
      for (const place of places) {
        const cleanPlace = String(place).replace(/[\p{P}\p{S}]+$/gu, '').trim();
        if (!cleanPlace) continue;
        const index = candidate.toLocaleLowerCase().indexOf(cleanPlace.toLocaleLowerCase(), streetEnd);
        if (index >= streetEnd) placeMatches.push({ start: index, end: index + cleanPlace.length });
      }
    }
    placeMatches.sort((a, b) => a.start - b.start);

    let spanEnd = streetEnd;
    for (const place of placeMatches) {
      if (place.start < spanEnd) continue;
      if (!/^[\s,]*$/.test(candidate.slice(spanEnd, place.start))) continue;
      spanEnd = place.end;
      while (true) {
        const suffix = candidate.slice(spanEnd);
        const separator = suffix.match(/^[\s,]*/)?.[0] || '';
        const remainder = suffix.slice(separator.length);
        let metadata = '';
        if (parsed.state && remainder.startsWith(parsed.state) && !/[\p{L}]/u.test(remainder[parsed.state.length] || '')) {
          metadata = parsed.state;
        }
        if (metadata) {
          spanEnd += separator.length + metadata.length;
          continue;
        }
        if (parsed.postalcode && remainder.toLocaleLowerCase().startsWith(String(parsed.postalcode).toLocaleLowerCase())) {
          const end = String(parsed.postalcode).length;
          if (!/[\p{L}\d]/u.test(remainder[end] || '')) {
            spanEnd += separator.length + end;
            continue;
          }
        }
        const ukPostcode = remainder.match(UK_POSTCODE);
        if (ukPostcode && ukPostcode.index === 0) {
          spanEnd += separator.length + ukPostcode[0].length;
          continue;
        }
        break;
      }
    }

    if (parsed.state && parsed.postalcode) {
      const postalcode = String(parsed.postalcode);
      const postalIndex = candidate.indexOf(postalcode, streetEnd);
      const stateIndex = postalIndex < 0
        ? -1
        : candidate.lastIndexOf(String(parsed.state), postalIndex);
      if (stateIndex >= streetEnd && postalIndex > stateIndex) {
        const cityAndState = candidate.slice(streetEnd, stateIndex);
        const stateToPostal = candidate.slice(stateIndex + String(parsed.state).length, postalIndex);
        if (
          cityAndState.length <= 100
          && /^[,\s]+(?:[\p{L}\p{M}'’.-]+[,\s]*){1,8}$/u.test(cityAndState)
          && /^[,\s]+$/.test(stateToPostal)
        ) {
          spanEnd = Math.max(spanEnd, postalIndex + postalcode.length);
        }
      }
    }

    return spanEnd;
  }

  function findAddressSpans(text) {
    const spans = [];
    const numberPattern = /\b\d{1,6}[a-z]?\b/gi;
    let numberMatch;
    let checked = 0;
    while ((numberMatch = numberPattern.exec(text)) && checked < 40) {
      checked += 1;
      const start = numberMatch.index;
      const limit = Math.min(text.length, start + 240);
      const boundaryMatch = text.slice(start, limit).match(/[\n;!?]/);
      const endLimit = boundaryMatch ? start + boundaryMatch.index : limit;
      const tail = text.slice(start, endLimit);
      const words = [...tail.matchAll(/\S+/g)].slice(0, 24);
      let bestEnd = 0;
      for (let wordIndex = 1; wordIndex < words.length; wordIndex += 1) {
        const candidateEnd = words[wordIndex].index + words[wordIndex][0].length;
        const candidate = tail.slice(0, candidateEnd);
        let parsed;
        try {
          parsed = parseAddress(candidate);
        } catch {
          continue;
        }
        if (String(parsed.number || '') !== numberMatch[0] || !parsed.street) continue;
        const streetStart = candidate.toLocaleLowerCase().lastIndexOf(String(parsed.street).toLocaleLowerCase());
        if (streetStart < numberMatch[0].length) continue;
        const streetEnd = streetStart + String(parsed.street).length;
        const addressEnd = extendAddressSpan(candidate, parsed, streetEnd);
        bestEnd = Math.max(bestEnd, addressEnd);
      }
      if (bestEnd > 0) {
        const absoluteEnd = start + bestEnd;
        if (!spans.some(({ start: priorStart, end: priorEnd }) => start < priorEnd && absoluteEnd > priorStart)) {
          spans.push({ start, end: absoluteEnd, value: text.slice(start, absoluteEnd), category: 'ADDRESS' });
        }
      }
    }
    return spans.sort((a, b) => b.start - a.start);
  }

  function createMasker() {
    let settings = { ...DEFAULT_SETTINGS };
    let enabled = true;
    let nextIndex = 1;
    let sessionId = createSessionId();
    let maskedCount = 0;
    const tokenToOriginal = new Map();
    const originalToToken = new Map();
    const pendingEntries = [];

    function register(category, original) {
      const existing = originalToToken.get(original);
      if (existing) return existing;
      const token = `[${category}_${nextIndex++}_${sessionId}]`;
      tokenToOriginal.set(token, original);
      originalToToken.set(original, token);
      pendingEntries.push({ token, original });
      return token;
    }

    function maskText(value) {
      if (!enabled || typeof value !== 'string') return value;
      let text = value;
      const customTerms = Array.isArray(settings.customTerms)
        ? [...new Set(settings.customTerms.filter((term) => typeof term === 'string').map((term) => term.trim()).filter((term) => term.length >= 2 && term.length <= 80))]
          .sort((a, b) => b.length - a.length)
        : [];
      for (const term of customTerms) {
        const expression = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'giu');
        text = text.replace(expression, (match) => {
          maskedCount += 1;
          return register('CUSTOM', match);
        });
      }
      if (settings.names) {
        for (const span of findPersonSpans(text)) {
          maskedCount += 1;
          text = `${text.slice(0, span.start)}${register('PERSON', span.value)}${text.slice(span.end)}`;
        }
      }
      if (settings.addresses) {
        for (const span of findAddressSpans(text)) {
          maskedCount += 1;
          text = `${text.slice(0, span.start)}${register('ADDRESS', span.value)}${text.slice(span.end)}`;
        }
      }
      if (settings.emails) text = text.replace(EMAIL_PATTERN, (email) => {
        maskedCount += 1;
        return register('EMAIL', email);
      });
      if (settings.phones) text = text.replace(PHONE_PATTERN, (phone) => {
        maskedCount += 1;
        return register('PHONE', phone);
      });
      return text;
    }

    function rewriteEmbeddedString(value) {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object') return JSON.stringify(rewriteValue(parsed));
        } catch {
          // Treat non-JSON strings as prompt text.
        }
      }
      return maskText(value);
    }

    function rewriteValue(value) {
      if (typeof value === 'string') return rewriteEmbeddedString(value);
      if (Array.isArray(value)) return value.map(rewriteValue);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteValue(child)]));
      }
      return value;
    }

    function rewriteBody(body, contentType = '') {
      if (typeof body !== 'string') throw new TypeError('PromptMask requires a textual request body');
      maskedCount = 0;
      if (/application\/x-www-form-urlencoded/i.test(contentType)) {
        const params = new URLSearchParams(body);
        for (const [key, value] of params.entries()) params.set(key, rewriteEmbeddedString(value));
        return params.toString();
      }
      try {
        return JSON.stringify(rewriteValue(JSON.parse(body)));
      } catch {
        return maskText(body);
      }
    }

    function restoreText(value) {
      let text = value;
      for (const [token, original] of [...tokenToOriginal].sort((a, b) => b[0].length - a[0].length)) {
        text = text.split(token).join(original);
      }
      return text;
    }

    function restoreValue(value) {
      if (typeof value === 'string') return restoreText(value);
      if (Array.isArray(value)) return value.map(restoreValue);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restoreValue(child)]));
      }
      return value;
    }

    return {
      configure(next) {
        enabled = next.enabled !== false;
        settings = { ...DEFAULT_SETTINGS, ...(next.settings || {}) };
      },
      clear() {
        tokenToOriginal.clear();
        originalToToken.clear();
        pendingEntries.length = 0;
        nextIndex = 1;
        sessionId = createSessionId();
      },
      hasMappings: () => tokenToOriginal.size > 0,
      shouldRestoreResponses: () => settings.restoreResponses !== false,
      activeCategories: () => ['names', 'emails', 'phones', 'addresses'].filter((category) => settings[category] !== false),
      takeMaskedCount: () => {
        const count = maskedCount;
        maskedCount = 0;
        return count;
      },
      maskText,
      maxTokenLength: () => Math.max(0, ...[...tokenToOriginal.keys()].map((token) => token.length)),
      restoreText,
      restoreValue,
      rewriteBody,
      tokens: () => [...tokenToOriginal.keys()],
      takePendingEntries: () => pendingEntries.splice(0, pendingEntries.length)
    };
  }

  function createSessionId() {
    return globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  }

  function containsMediaIntent(text) {
    if (MEDIA_PATTERN.test(text)) return true;
    try {
      return MEDIA_PATTERN.test(decodeURIComponent(String(text).replace(/\+/g, ' ')));
    } catch {
      return false;
    }
  }

  function isTargetRequest(url, baseUrl = 'https://example.invalid/') {
    let parsed;
    try {
      parsed = new URL(url, baseUrl);
    } catch {
      return false;
    }
    const { hostname, pathname } = parsed;
    if ((hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')) && (
      /^\/backend-api\/(?:conversation|f\/conversation)(?:\/|$)/.test(pathname)
      || pathname === '/unauth-mweb/conversation/updates'
    )) return true;
    if (hostname === 'gemini.google.com' && /^\/_\/BardChatUi\/data\//.test(pathname)) return true;
    if ((hostname === 'claude.ai' || hostname.endsWith('.claude.ai')) && /^\/api\/.*\/(?:completion|append_message)$/.test(pathname)) return true;
    return false;
  }

  function restoreStream(stream, masker, TransformStreamClass = TransformStream, onRestoredText = () => {}, onComplete = () => {}) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const carryLength = Math.max(0, masker.maxTokenLength() - 1);
    let carry = '';
    return stream.pipeThrough(new TransformStreamClass({
      transform(chunk, controller) {
        carry += decoder.decode(chunk, { stream: true });
        let safeLength = Math.max(0, carry.length - carryLength);
        for (const token of masker.tokens()) {
          let tokenStart = carry.indexOf(token);
          while (tokenStart !== -1) {
            if (tokenStart < safeLength && tokenStart + token.length > safeLength) {
              safeLength = tokenStart;
            }
            tokenStart = carry.indexOf(token, tokenStart + 1);
          }
        }
        if (safeLength) {
          const restored = masker.restoreText(carry.slice(0, safeLength));
          onRestoredText(restored);
          controller.enqueue(encoder.encode(restored));
          carry = carry.slice(safeLength);
        }
      },
      flush(controller) {
        carry += decoder.decode();
        const restored = masker.restoreText(carry);
        onRestoredText(restored);
        controller.enqueue(encoder.encode(restored));
        onComplete();
      }
    }));
  }

  function install() {
    const nativeFetch = root.fetch;
    const masker = createMasker();
    let enabled = true;

    root.addEventListener('message', (event) => {
      if (event.source !== root || event.origin !== root.location.origin || !event.data) return;
      if (event.data.type === 'CLOAK_CONFIG') {
        enabled = event.data.enabled !== false;
        masker.configure(event.data);
        root.console?.info(`[PromptMask] Protection ${enabled ? 'enabled' : 'disabled'}.`);
      }
      if (event.data.type === 'CLOAK_CLEAR_MEMORY') {
        masker.clear();
        root.console?.info('[PromptMask] Local token vault cleared.');
      }
    });

    root.fetch = async function (input, init) {
      const request = typeof root.Request === 'function' && input instanceof root.Request ? input : null;
      const url = request ? request.url : String(input);
      const method = String(init?.method || request?.method || 'GET').toUpperCase();
      if (method !== 'POST' || !isTargetRequest(url, root.location.href)) {
        return nativeFetch.call(this, input, init);
      }

      const hasInitBody = init && Object.prototype.hasOwnProperty.call(init, 'body');
      let body = hasInitBody ? init.body : request ? await request.clone().text() : undefined;
      if (body == null) return nativeFetch.call(this, input, init);
  const wasUrlSearchParams = body instanceof URLSearchParams;
  if (wasUrlSearchParams) body = body.toString();
      if (typeof body !== 'string') {
        throw new TypeError('PromptMask blocked a chat request because its body could not be safely inspected');
      }

      if (containsMediaIntent(body)) {
        root.console?.info('[PromptMask] Gemini media request detected; sending full prompt without text masking.');
        root.postMessage({ type: 'CLOAK_MEDIA_BYPASS' }, root.location.origin);
        return nativeFetch.call(this, input, init);
      }

      const headers = new Headers(init?.headers || request?.headers || {});
      if (wasUrlSearchParams && !headers.has('content-type')) {
        headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
      }
      root.console?.info(
        `[Cloak] Intercepted outgoing AI request: ${method} ${new URL(url, root.location.href).pathname}; Content-Type: ${headers.get('content-type') || '(browser default)'}`
      );
      const rewrittenBody = masker.rewriteBody(body, headers.get('content-type') || '');
      const maskedCount = masker.takeMaskedCount();
      const activeCategories = masker.activeCategories();
      root.console?.info(
        `[Cloak] Request inspected; protection=${enabled ? 'on' : 'off'}; categories=${activeCategories.join(',') || 'none'}; values replaced=${maskedCount}; payload changed=${rewrittenBody !== body}.`
      );
      root.postMessage({
        type: 'CLOAK_REQUEST_STATS',
        requestsChecked: 1,
        valuesMasked: maskedCount
      }, root.location.origin);
      const entries = masker.takePendingEntries();
      if (entries.length) root.postMessage({ type: 'CLOAK_MASKED_DATA', entries }, root.location.origin);
      if (root.location.hostname === 'gemini.google.com') {
        root.console?.info(enabled
          ? `[PromptMask] Gemini request sent with protection enabled; ${entries.length} new sensitive value(s) added to the local vault.`
          : '[PromptMask] Gemini request sent without masking because protection is disabled.');
      }

      let responseInput = input;
      let responseInit = init;
      if (request && !init) {
        responseInput = new Request(request, { body: rewrittenBody, headers });
      } else {
        responseInit = { ...(init || {}), body: rewrittenBody, headers };
      }
      const response = await nativeFetch.call(this, responseInput, responseInit);
      if (root.location.hostname === 'gemini.google.com') {
        root.console?.info(`[PromptMask] Gemini server responded with HTTP ${response.status}.`);
      }
      if (!masker.hasMappings() || !masker.shouldRestoreResponses() || !response.body || [204, 205, 304].includes(response.status)) return response;
      if (!/(?:text|json|javascript|protobuf|x-ndjson)/i.test(response.headers.get('content-type') || '')) return response;

      try {
        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete('content-length');
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-md5');
        let restoredResponse = '';
        let responseTruncated = false;
        const restoredStream = restoreStream(response.body, masker, root.TransformStream, (text) => {
          if (restoredResponse.length >= 200000) {
            responseTruncated = true;
            return;
          }
          const remaining = 200000 - restoredResponse.length;
          restoredResponse += text.slice(0, remaining);
          if (text.length > remaining) responseTruncated = true;
        }, () => {
          if (root.location.hostname === 'gemini.google.com') {
            root.console?.info(
              `[PromptMask] Gemini response delivered after local token restoration${responseTruncated ? ' (truncated)' : ''}.\n${restoredResponse}`
            );
          }
        });
        return new Response(restoredStream, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      } catch {
        return response;
      }
    };

    const xhrPrototype = root.XMLHttpRequest?.prototype;
    if (xhrPrototype) {
      const nativeOpen = xhrPrototype.open;
      const nativeSend = xhrPrototype.send;
      const nativeSetRequestHeader = xhrPrototype.setRequestHeader;
      const xhrRequests = new WeakMap();
      const findDescriptor = (prototype, property) => {
        for (let current = prototype; current; current = Object.getPrototypeOf(current)) {
          const descriptor = Object.getOwnPropertyDescriptor(current, property);
          if (descriptor) return descriptor;
        }
        return null;
      };
      const responseTextDescriptor = findDescriptor(xhrPrototype, 'responseText');
      const responseDescriptor = findDescriptor(xhrPrototype, 'response');

      xhrPrototype.open = function (method, url, ...args) {
        xhrRequests.set(this, {
          method: String(method || 'GET').toUpperCase(),
          url: String(url),
          headers: new Headers()
        });
        return nativeOpen.call(this, method, url, ...args);
      };

      xhrPrototype.setRequestHeader = function (name, value) {
        const requestInfo = xhrRequests.get(this);
        if (requestInfo) {
          try { requestInfo.headers.set(name, value); } catch { /* Keep native XHR header behavior. */ }
        }
        return nativeSetRequestHeader.call(this, name, value);
      };

      xhrPrototype.send = function (body) {
        const requestInfo = xhrRequests.get(this);
        if (!requestInfo || requestInfo.method !== 'POST' || !isTargetRequest(requestInfo.url, root.location.href) || body == null) {
          return nativeSend.call(this, body);
        }

        const wasUrlSearchParams = body instanceof root.URLSearchParams;
        const originalBody = wasUrlSearchParams ? body.toString() : body;
        if (typeof originalBody !== 'string') return nativeSend.call(this, body);
        if (containsMediaIntent(originalBody)) {
          root.console?.info('[Cloak] Gemini media request bypassed text masking.');
          root.postMessage({ type: 'CLOAK_MEDIA_BYPASS' }, root.location.origin);
          return nativeSend.call(this, body);
        }

        if (wasUrlSearchParams && !requestInfo.headers.has('content-type')) {
          const contentType = 'application/x-www-form-urlencoded;charset=UTF-8';
          requestInfo.headers.set('content-type', contentType);
          nativeSetRequestHeader.call(this, 'Content-Type', contentType);
        }

        const rewrittenBody = masker.rewriteBody(originalBody, requestInfo.headers.get('content-type') || '');
        const maskedCount = masker.takeMaskedCount();
        const entries = masker.takePendingEntries();
        root.console?.info(
          `[Cloak] Intercepted XHR ${requestInfo.method} ${new URL(requestInfo.url, root.location.href).pathname}; categories=${masker.activeCategories().join(',')}; values replaced=${maskedCount}; payload changed=${rewrittenBody !== originalBody}.`
        );
        root.postMessage({ type: 'CLOAK_REQUEST_STATS', requestsChecked: 1, valuesMasked: maskedCount }, root.location.origin);
        if (entries.length) root.postMessage({ type: 'CLOAK_MASKED_DATA', entries }, root.location.origin);

        const responseType = this.responseType || '';
        const addRestoredGetter = (property, descriptor) => {
          if (!descriptor?.get) return;
          try {
            Object.defineProperty(this, property, {
              configurable: true,
              enumerable: descriptor.enumerable,
              get() {
                const result = descriptor.get.call(this);
                return masker.restoreValue(result);
              }
            });
          } catch {
            root.console?.warn(`[Cloak] Could not restore XMLHttpRequest ${property}; response tokens may remain visible.`);
          }
        };
        if (responseType === '' || responseType === 'text') addRestoredGetter('responseText', responseTextDescriptor);
        if (responseType === '' || responseType === 'text' || responseType === 'json') addRestoredGetter('response', responseDescriptor);
        return nativeSend.call(this, rewrittenBody);
      };
    }
  }

  if (typeof process !== 'undefined' && process.versions?.node && typeof module !== 'undefined') {
    module.exports = { containsMediaIntent, createMasker, isTargetRequest, restoreStream };
  }
  if (root && typeof root.fetch === 'function') install();
})(typeof window === 'undefined' ? null : window);