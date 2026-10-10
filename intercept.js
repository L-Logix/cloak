(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = { names: true, emails: true, phones: true };
  const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const PHONE_PATTERN = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;
  const PERSON_PATTERN = /\b((?:my name is|i am|i'm|this is)\s+)([a-zA-Z]+(?:[-'][a-zA-Z]+)?(?:\s+[a-zA-Z]+(?:[-'][a-zA-Z]+)?)?)/gi;
  const NAME_STOPWORDS = new Set(['a', 'an', 'and', 'at', 'email', 'for', 'in', 'my', 'number', 'of', 'on', 'or', 'phone', 'the', 'to', 'with']);
  const MEDIA_PATTERN = /\b(?:draw|generate|create|make)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|video)\b|\bimage generation\b/i;

  function createMasker() {
    let settings = { ...DEFAULT_SETTINGS };
    let enabled = true;
    let nextIndex = 1;
    let sessionId = createSessionId();
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
      if (settings.names) {
        text = text.replace(PERSON_PATTERN, (match, prefix, name) => {
          const words = name.split(/\s+/);
          while (words.length > 1 && NAME_STOPWORDS.has(words.at(-1).toLowerCase())) words.pop();
          if (NAME_STOPWORDS.has(words[0].toLowerCase())) return match;
          const matchedName = words.join(' ');
          const trailingText = name.slice(matchedName.length);
          return `${prefix}${register('PERSON', matchedName)}${trailingText}`;
        });
      }
      if (settings.emails) text = text.replace(EMAIL_PATTERN, (email) => register('EMAIL', email));
      if (settings.phones) text = text.replace(PHONE_PATTERN, (phone) => register('PHONE', phone));
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
      maskText,
      maxTokenLength: () => Math.max(0, ...[...tokenToOriginal.keys()].map((token) => token.length)),
      restoreText,
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

// Place log here where 'url' exists:
root.console?.info('[Cloak] Intercepted outgoing AI request:', url);

      const hasInitBody = init && Object.prototype.hasOwnProperty.call(init, 'body');
      let body = hasInitBody ? init.body : request ? await request.clone().text() : undefined;
      if (body == null) return nativeFetch.call(this, input, init);
      if (body instanceof URLSearchParams) body = body.toString();
      if (typeof body !== 'string') {
        throw new TypeError('PromptMask blocked a chat request because its body could not be safely inspected');
      }

      if (containsMediaIntent(body)) {
        root.console?.info('[PromptMask] Gemini media request detected; sending full prompt without text masking.');
        root.postMessage({ type: 'CLOAK_MEDIA_BYPASS' }, root.location.origin);
        return nativeFetch.call(this, input, init);
      }

      const headers = new Headers(init?.headers || request?.headers || {});
      const rewrittenBody = masker.rewriteBody(body, headers.get('content-type') || '');
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
        responseInput = new Request(request, { body: rewrittenBody });
      } else {
        responseInit = { ...(init || {}), body: rewrittenBody };
      }
      const response = await nativeFetch.call(this, responseInput, responseInit);
      if (root.location.hostname === 'gemini.google.com') {
        root.console?.info(`[PromptMask] Gemini server responded with HTTP ${response.status}.`);
      }
      if (!masker.hasMappings() || !response.body || [204, 205, 304].includes(response.status)) return response;
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
  }

  if (typeof process !== 'undefined' && process.versions?.node && typeof module !== 'undefined') {
    module.exports = { containsMediaIntent, createMasker, isTargetRequest, restoreStream };
  }
  if (root && typeof root.fetch === 'function') install();
})(typeof window === 'undefined' ? null : window);