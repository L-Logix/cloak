// ---------------------------------------------------------------------------
// Cloak — main-world interceptor (intercept.js)
//
// ROLE IN THE ARCHITECTURE
//   content.js (isolated world) ──postMessage──▶ this file (main world)
//        │                                          │
//        │  CLOAK_CONFIG / CLOAK_CLEAR_MEMORY       │  rewrites fetch + XHR
//        ◀──────────────────────────────────────────│  before the AI request
//        │  CLOAK_MASKED_DATA / CLOAK_REQUEST_STATS │  leaves the browser
//        ▼                                          ▼
//   chrome.storage.local (vault)          Gemini / ChatGPT / Claude servers
//
// This file is bundled with esbuild (npm run build:interceptor) into
// intercept.bundle.js, which the manifest injects into the MAIN world of every
// supported chat site at document_start. The main world is required because it
// is the only place a content script can reach the page's own fetch/XHR.
//
// PRIVACY INVARIANT
//   Nothing in this file talks to the network on Cloak's behalf. It only
//   rewrites traffic the page was already going to send, and restores tokens
//   from replies the page was already going to receive.
// ---------------------------------------------------------------------------
const nlp = require('compromise');       // local NLP: person/place recognition
const parseAddress = require('addressit'); // local street-address parser

(function (root) {
  'use strict';

  // Mirrored in popup.js and content.js. Every context keeps the same defaults
  // so a missing storage key always means "safest, all categories on".
  const DEFAULT_SETTINGS = {
    names: true,
    emails: true,
    phones: true,
    addresses: true,
    restoreResponses: true,
    showBadge: true,
    customTerms: []
  };

  // ---- Detection patterns -------------------------------------------------
  // Email/phone are pure regex: cheap, deterministic, easy to audit.
  const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const PHONE_PATTERN = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;
  // Names are harder: combine NLP (below) with these high-signal phrasings.
  // "my name is X" / "I'm X" catch introductions the NLP pass often misses.
  const PERSON_INTRODUCER = /\b(?:my name is|i am|i'm|this is)\s+([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3})/giu;
  // "write to <person> at <email>" — the recipient slot in letter-writing prompts.
  const RECIPIENT_CUE = /\bto\s+([^,.;!?\n]+?)\s+at\b/giu;
  // UK postcodes extend an address span past its street portion.
  const UK_POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i;
  // Words that end an introduction ("my name is bob and my phone...") so the
  // name span stops before the next clause instead of swallowing it.
  const NAME_STOPWORDS = new Set(['a', 'an', 'and', 'at', 'email', 'for', 'in', 'is', 'my', 'name', 'number', 'of', 'on', 'or', 'phone', 'the', 'to', 'with']);
  // Image/video requests need the full prompt (the model paints from context),
  // so those requests bypass masking entirely — see containsMediaIntent().
  const MEDIA_PATTERN = /\b(?:draw|generate|create|make)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|video)\b|\bimage generation\b/i;

  // ---- Small helpers ------------------------------------------------------

  // Make a literal safe to embed in a RegExp (".", "(" etc. must stay literal).
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---- Name detection -----------------------------------------------------

  // Gather every plausible name string in the prompt, longest first so longer
  // names are masked before their shorter substrings can be claimed.
  function personCandidates(text) {
    const candidates = new Set();
    // Pass 1: compromise's people() model — trained, broad, but imperfect.
    try {
      for (const name of nlp(text).people().out('array')) {
        if (typeof name !== 'string') continue;
        // NLP output can arrive wrapped in punctuation; strip it back off.
        const cleaned = name.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').trim();
        if (cleaned) candidates.add(cleaned);
      }
    } catch {
      // Contextual extraction below remains available if the NLP pass fails.
    }

    // Pass 2: "my name is …" / "I'm …" introductions.
    for (const match of text.matchAll(PERSON_INTRODUCER)) {
      const words = match[1].trim().split(/\s+/);
      // Trim trailing stopwords so "bob and my phone" yields just "bob".
      while (words.length > 1 && NAME_STOPWORDS.has(words.at(-1).toLowerCase())) words.pop();
      if (words.length && !NAME_STOPWORDS.has(words[0].toLowerCase())) candidates.add(words.join(' '));
    }

    // Pass 3: "to <recipient> at <email>" slots in letter-writing prompts.
    for (const match of text.matchAll(RECIPIENT_CUE)) {
      const recipient = match[1].trim();
      // Skip if the slot already holds a token (rewritten text is re-scanned).
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
        // No NLP hit: fall back to the last few non-stopwords of the slot.
        const words = recipient.split(/\s+/).filter((word) => !NAME_STOPWORDS.has(word.toLowerCase()));
        if (words.length) candidates.add(words.slice(-3).join(' '));
      }
    }
    return [...candidates].sort((a, b) => b.length - a.length);
  }

  // Turn candidate strings into concrete spans in the text. Word-boundary
  // lookarounds stop "bob" from matching inside "bobby" or "crowbar".
  function findPersonSpans(text) {
    const spans = [];
    for (const candidate of personCandidates(text)) {
      const expression = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(candidate)}(?![\\p{L}\\p{N}_])`, 'giu');
      for (const match of text.matchAll(expression)) {
        if (match[0].includes('[')) continue; // already a token
        // Drop overlapping spans; first (longest-first) claim wins.
        if (!spans.some(({ start, end }) => match.index < end && match.index + match[0].length > start)) {
          spans.push({ start: match.index, end: match.index + match[0].length, value: match[0], category: 'PERSON' });
        }
      }
    }
    // Sort right-to-left so callers can splice replacements without reindexing.
    return spans.sort((a, b) => b.start - a.start);
  }

  // ---- Address detection --------------------------------------------------

  // Grow an address past its street portion to swallow city / state / postal
  // code, so "221B Baker Street, London NW1 6XE" masks as ONE value instead of
  // leaking its postal code.
  function extendAddressSpan(candidate, parsed, streetEnd) {
    // Step 1: find place names (cities) the parser recognised after the street.
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

    // Step 2: walk forward from the street, appending contiguous place /
    // state / postcode text. Anything that is not punctuation+metadata stops it.
    let spanEnd = streetEnd;
    for (const place of placeMatches) {
      if (place.start < spanEnd) continue; // already covered
      // Only extend across whitespace and commas — never across sentences.
      if (!/^[\s,]*$/.test(candidate.slice(spanEnd, place.start))) continue;
      spanEnd = place.end;
      while (true) {
        const suffix = candidate.slice(spanEnd);
        const separator = suffix.match(/^[\s,]*/)?.[0] || '';
        const remainder = suffix.slice(separator.length);
        let metadata = '';
        // Append the state if it appears right here ("Springfield, IL 62704").
        if (parsed.state && remainder.startsWith(parsed.state) && !/[\p{L}]/u.test(remainder[parsed.state.length] || '')) {
          metadata = parsed.state;
        }
        if (metadata) {
          spanEnd += separator.length + metadata.length;
          continue;
        }
        // Append the postal code the parser found.
        if (parsed.postalcode && remainder.toLocaleLowerCase().startsWith(String(parsed.postalcode).toLocaleLowerCase())) {
          const end = String(parsed.postalcode).length;
          if (!/[\p{L}\d]/u.test(remainder[end] || '')) {
            spanEnd += separator.length + end;
            continue;
          }
        }
        // Append a UK postcode when the parser missed it (addressit is US-first).
        const ukPostcode = remainder.match(UK_POSTCODE);
        if (ukPostcode && ukPostcode.index === 0) {
          spanEnd += separator.length + ukPostcode[0].length;
          continue;
        }
        break; // nothing more to absorb
      }
    }

    // Step 3: the parser can report state/postcode without placing them after
    // the street in the raw text; stitch "city, ST" + " 12345" together.
    if (parsed.state && parsed.postalcode) {
      const postalcode = String(parsed.postalcode);
      const postalIndex = candidate.indexOf(postalcode, streetEnd);
      const stateIndex = postalIndex < 0
        ? -1
        : candidate.lastIndexOf(String(parsed.state), postalIndex);
      if (stateIndex >= streetEnd && postalIndex > stateIndex) {
        const cityAndState = candidate.slice(streetEnd, stateIndex);
        const stateToPostal = candidate.slice(stateIndex + String(parsed.state).length, postalIndex);
        // Only accept if the gap is short comma-separated place text.
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

  // Scan for street addresses: every house-number-looking token starts a probe,
  // and we grow each probe word by word until addressit agrees it is a street.
  function findAddressSpans(text) {
    const spans = [];
    const numberPattern = /\b\d{1,6}[a-z]?\b/gi;
    let numberMatch;
    let checked = 0;
    // Cap probes so a number-heavy prompt (a spreadsheet, say) stays cheap.
    while ((numberMatch = numberPattern.exec(text)) && checked < 40) {
      checked += 1;
      const start = numberMatch.index;
      // Never look past the next hard sentence boundary or 240 characters.
      const limit = Math.min(text.length, start + 240);
      const boundaryMatch = text.slice(start, limit).match(/[\n;!?]/);
      const endLimit = boundaryMatch ? start + boundaryMatch.index : limit;
      const tail = text.slice(start, endLimit);
      const words = [...tail.matchAll(/\S+/g)].slice(0, 24);
      let bestEnd = 0;
      // Grow the candidate one word at a time; the parser validates each size.
      for (let wordIndex = 1; wordIndex < words.length; wordIndex += 1) {
        const candidateEnd = words[wordIndex].index + words[wordIndex][0].length;
        const candidate = tail.slice(0, candidateEnd);
        let parsed;
        try {
          parsed = parseAddress(candidate);
        } catch {
          continue;
        }
        // The parsed street number must be the number that started the probe.
        if (String(parsed.number || '') !== numberMatch[0] || !parsed.street) continue;
        const streetStart = candidate.toLocaleLowerCase().lastIndexOf(String(parsed.street).toLocaleLowerCase());
        if (streetStart < numberMatch[0].length) continue;
        const streetEnd = streetStart + String(parsed.street).length;
        // Extend through city/state/postcode, then keep the longest result.
        const addressEnd = extendAddressSpan(candidate, parsed, streetEnd);
        bestEnd = Math.max(bestEnd, addressEnd);
      }
      if (bestEnd > 0) {
        const absoluteEnd = start + bestEnd;
        // Skip if an earlier (longer) address already covers this range.
        if (!spans.some(({ start: priorStart, end: priorEnd }) => start < priorEnd && absoluteEnd > priorStart)) {
          spans.push({ start, end: absoluteEnd, value: text.slice(start, absoluteEnd), category: 'ADDRESS' });
        }
      }
    }
    return spans.sort((a, b) => b.start - a.start);
  }

  // ---- Token minting ------------------------------------------------------

  // Deterministic per value: the same detected value always yields the same
  // token suffix, across page loads and reinjections. The vault is keyed by
  // token, so a random per-load id would grow a fresh entry for the same value
  // on every navigation — this hash is what keeps the vault deduplicated.
  // djb2: a 30-year-old string hash; short, fast, and good enough for 36-bit ids.
  function stableSuffixFor(value) {
    let h = 5381;
    for (let i = 0; i < value.length; i += 1) h = ((h * 33) ^ value.charCodeAt(i)) >>> 0;
    // Base-36 keeps tokens short; pad so tiny hashes still look like the rest.
    return h.toString(36).padStart(6, '0').slice(-6);
  }

  // The masker is the heart of Cloak: one instance per page load, holding the
  // token↔value maps, the masking rules, and the response-restoration logic.
  function createMasker() {
    let settings = { ...DEFAULT_SETTINGS };
    let enabled = true;
    let maskedCount = 0; // occurrences replaced in the most recent rewrite
    const tokenToOriginal = new Map(); // restore direction: token → value
    const originalToToken = new Map(); // dedupe direction: value → token
    const suffixIndex = new Map();     // hash suffix → display index ([PERSON_1_…])
    const pendingEntries = [];         // new vault rows waiting to be reported
    let sortedTokens = null;           // cached restore order (see restoreText)

    // Mint (or reuse) the token for a value. Reuse is what stops the vault
    // from growing: "bob" typed on ten pages is still one vault row.
    function register(category, original) {
      const existing = originalToToken.get(original);
      if (existing) return existing;
      const suffix = stableSuffixFor(original);
      let index = suffixIndex.get(suffix);
      if (index === undefined) {
        index = suffixIndex.size + 1; // stable ordering within this page load
        suffixIndex.set(suffix, index);
      }
      // Format [CATEGORY_index_suffix] — asserted by the test suite.
      const token = `[${category}_${index}_${suffix}]`;
      tokenToOriginal.set(token, original);
      originalToToken.set(original, token);
      sortedTokens = null; // restore order changed
      pendingEntries.push({ token, original }); // new → vault
      return token;
    }

    // Mask one plain string of prompt text. Order matters: custom terms first
    // (user intent wins), then names, addresses, emails, phones — longest and
    // most structural first so inner values are already tokens when later
    // passes run.
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
        // Spans are right-to-left, so splicing never shifts later offsets.
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

    // Some providers nest a JSON document inside a form field (Gemini's f.req).
    // Detect that and recurse into the structure instead of masking raw syntax.
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

    // Walk any parsed body (objects, arrays, strings) masking every string.
    function rewriteValue(value) {
      if (typeof value === 'string') return rewriteEmbeddedString(value);
      if (Array.isArray(value)) return value.map(rewriteValue);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteValue(child)]));
      }
      return value;
    }

    // Entry point for outgoing bodies. Handles the two wire formats the three
    // supported providers actually use: form-encoded and JSON.
    function rewriteBody(body, contentType = '') {
      if (typeof body !== 'string') throw new TypeError('PromptMask requires a textual request body');
      maskedCount = 0; // each rewrite starts a fresh count for the stats message
      if (/application\/x-www-form-urlencoded/i.test(contentType)) {
        const params = new URLSearchParams(body);
        for (const [key, value] of params.entries()) params.set(key, rewriteEmbeddedString(value));
        return params.toString();
      }
      try {
        return JSON.stringify(rewriteValue(JSON.parse(body)));
      } catch {
        // Not JSON — mask the whole thing as plain prompt text.
        return maskText(body);
      }
    }

    // Swap tokens back to their originals. Longest tokens first so a token
    // that contains another token's text can never be clobbered early. The
    // order is cached: streaming readers call this once per network chunk,
    // and re-sorting the whole vault every time is measurable jank.
    function restoreText(value) {
      sortedTokens ??= [...tokenToOriginal.keys()].sort((a, b) => b.length - a.length);
      let text = value;
      for (const token of sortedTokens) {
        text = text.split(token).join(tokenToOriginal.get(token));
      }
      return text;
    }

    // Restore inside a parsed structure (used for XHR JSON responses).
    function restoreValue(value) {
      if (typeof value === 'string') return restoreText(value);
      if (Array.isArray(value)) return value.map(restoreValue);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restoreValue(child)]));
      }
      return value;
    }

    // Public surface used by install() and by the popup's live preview.
    return {
      configure(next) {
        enabled = next.enabled !== false;
        settings = { ...DEFAULT_SETTINGS, ...(next.settings || {}) };
      },
      // Forget all tokens (user cleared the vault, or protection toggled off).
      clear() {
        tokenToOriginal.clear();
        originalToToken.clear();
        sortedTokens = null;
        pendingEntries.length = 0;
      },
      hasMappings: () => tokenToOriginal.size > 0,
      shouldRestoreResponses: () => settings.restoreResponses !== false,
      activeCategories: () => ['names', 'emails', 'phones', 'addresses'].filter((category) => settings[category] !== false),
      // Read-and-reset counter: one rewrite = one stats report.
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
      // Read-and-drain buffer: new vault rows are reported exactly once.
      takePendingEntries: () => pendingEntries.splice(0, pendingEntries.length)
    };
  }

  // ---- Request classification ---------------------------------------------

  // Image/video generation needs the whole prompt to paint from, so those
  // requests skip masking (and we tell the page to show a heads-up banner).
  function containsMediaIntent(text) {
    if (MEDIA_PATTERN.test(text)) return true;
    // Bodies are often URL-encoded; retry on the decoded form before giving up.
    try {
      return MEDIA_PATTERN.test(decodeURIComponent(String(text).replace(/\+/g, ' ')));
    } catch {
      return false;
    }
  }

  // Only POSTs to known chat-completion endpoints are ever rewritten. Anything
  // else — analytics, assets, other Google traffic — passes through untouched.
  function isTargetRequest(url, baseUrl = 'https://example.invalid/') {
    let parsed;
    try {
      parsed = new URL(url, baseUrl);
    } catch {
      return false;
    }
    const { hostname, pathname } = parsed;
    // ChatGPT: conversation API plus the unauthenticated mobile-web variant.
    if ((hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')) && (
      /^\/backend-api\/(?:conversation|f\/conversation)(?:\/|$)/.test(pathname)
      || pathname === '/unauth-mweb/conversation/updates'
    )) return true;
    // Gemini: the BardChatUi StreamGenerate endpoint.
    if (hostname === 'gemini.google.com' && /^\/_\/BardChatUi\/data\//.test(pathname)) return true;
    // Claude: streaming completion + message-append endpoints.
    if ((hostname === 'claude.ai' || hostname.endsWith('.claude.ai')) && /^\/api\/.*\/(?:completion|append_message)$/.test(pathname)) return true;
    return false;
  }

  // ---- Response restoration -----------------------------------------------

  // Stream a response body through token restoration. Responses stream in
  // chunks, and a chunk boundary can split a token mid-way ("[PERSON_1" then
  // "_2pkqc9]"), so we hold back only the tail that could still be the start
  // of a longer token and release everything before it.
  function restoreStream(stream, masker, TransformStreamClass = TransformStream, onRestoredText = () => {}, onComplete = () => {}) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const OPEN_BRACKET = '['.charCodeAt(0);
    let carry = ''; // undelivered text waiting for enough context to restore
    return stream.pipeThrough(new TransformStreamClass({
      transform(chunk, controller) {
        carry += decoder.decode(chunk, { stream: true });
        const tokens = masker.tokens();
        let safeLength = carry.length;
        if (tokens.length) {
          const maxLength = masker.maxTokenLength();
          // Only the last maxLength characters can hide a split token.
          const searchFrom = Math.max(0, carry.length - maxLength);
          for (let index = searchFrom; index < carry.length; index += 1) {
            if (carry.charCodeAt(index) !== OPEN_BRACKET) continue;
            const tail = carry.slice(index);
            // Does the tail look like a prefix of some real token? Then wait.
            const incomplete = tokens.some((token) => token.length > tail.length && token.startsWith(tail));
            if (incomplete) {
              safeLength = index; // hold this bracket-and-after back
              break;
            }
          }
        }
        if (safeLength > 0) {
          const restored = masker.restoreText(carry.slice(0, safeLength));
          onRestoredText(restored);
          controller.enqueue(encoder.encode(restored));
          carry = carry.slice(safeLength);
        }
      },
      flush(controller) {
        carry += decoder.decode(); // flush the decoder's final state
        const restored = masker.restoreText(carry);
        onRestoredText(restored);
        if (restored) controller.enqueue(encoder.encode(restored));
        onComplete();
      }
    }));
  }

  // ---- Page wiring --------------------------------------------------------

  // Runs in a chat page's main world. Wraps fetch and XHR so every outgoing
  // chat request is rewritten and every incoming reply is restored.
  function install() {
    const nativeFetch = root.fetch;
    const masker = createMasker();
    let enabled = true;

    // The isolated-world content script drives us over postMessage. Messages
    // are origin-checked both ways so a hostile iframe cannot reconfigure us.
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

    // ---- fetch -------------------------------------------------------------
    root.fetch = async function (input, init) {
      // Only POSTs to chat endpoints are candidates; everything else is native.
      const request = typeof root.Request === 'function' && input instanceof root.Request ? input : null;
      const url = request ? request.url : String(input);
      const method = String(init?.method || request?.method || 'GET').toUpperCase();
      if (method !== 'POST' || !isTargetRequest(url, root.location.href)) {
        return nativeFetch.call(this, input, init);
      }

      // Resolve the body from either init.body or the Request clone.
      const hasInitBody = init && Object.prototype.hasOwnProperty.call(init, 'body');
      let body = hasInitBody ? init.body : request ? await request.clone().text() : undefined;
      if (body == null) return nativeFetch.call(this, input, init);
      // URLSearchParams must be stringified before it can be rewritten.
      const wasUrlSearchParams = body instanceof URLSearchParams;
      if (wasUrlSearchParams) body = body.toString();
      if (typeof body !== 'string') {
        // Streamed/binary bodies cannot be inspected; fail closed rather than
        // silently send unmasked text.
        throw new TypeError('PromptMask blocked a chat request because its body could not be safely inspected');
      }

      // Image/video requests need full context — bypass and tell the page.
      if (containsMediaIntent(body)) {
        root.console?.info('[PromptMask] Gemini media request detected; sending full prompt without text masking.');
        root.postMessage({ type: 'CLOAK_MEDIA_BYPASS' }, root.location.origin);
        return nativeFetch.call(this, input, init);
      }

      // If we stringified URLSearchParams ourselves, restore its content type.
      const headers = new Headers(init?.headers || request?.headers || {});
      if (wasUrlSearchParams && !headers.has('content-type')) {
        headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
      }
      root.console?.info(
        `[Cloak] Intercepted outgoing AI request: ${method} ${new URL(url, root.location.href).pathname}; Content-Type: ${headers.get('content-type') || '(browser default)'}`
      );

      // The rewrite itself, plus the two reports the content script consumes.
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
      // New tokens go to the content script, which persists them in the vault.
      const entries = masker.takePendingEntries();
      if (entries.length) root.postMessage({ type: 'CLOAK_MASKED_DATA', entries }, root.location.origin);
      if (root.location.hostname === 'gemini.google.com') {
        root.console?.info(enabled
          ? `[PromptMask] Gemini request sent with protection enabled; ${entries.length} new sensitive value(s) added to the local vault.`
          : '[PromptMask] Gemini request sent without masking because protection is disabled.');
      }

      // Rebuild the request: replace the body on init or a cloned Request.
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

      // Restore tokens in the reply only when it is text we can safely rewrap.
      if (!masker.hasMappings() || !masker.shouldRestoreResponses() || !response.body || [204, 205, 304].includes(response.status)) return response;
      if (!/(?:text|json|javascript|protobuf|x-ndjson)/i.test(response.headers.get('content-type') || '')) return response;

      try {
        const responseHeaders = new Headers(response.headers);
        // The body length/encoding no longer match after restoration.
        responseHeaders.delete('content-length');
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-md5');
        // Keep a bounded copy of the restored text for the diagnostic log.
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
        return response; // never break the page over restoration
      }
    };

    // ---- XMLHttpRequest ----------------------------------------------------
    // Some providers still use XHR. Wrap open/setRequestHeader/send so we can
    // see the method, URL, and headers, then rewrite the body on send and wrap
    // response getters so the page reads restored text.
    const xhrPrototype = root.XMLHttpRequest?.prototype;
    if (xhrPrototype) {
      const nativeOpen = xhrPrototype.open;
      const nativeSend = xhrPrototype.send;
      const nativeSetRequestHeader = xhrPrototype.setRequestHeader;
      const xhrRequests = new WeakMap(); // per-instance request metadata
      // Walk the prototype chain for a property's own descriptor — the
      // platform defines responseText on XMLHttpRequestEventTarget, not here.
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
        // Non-POST, non-chat, or no body: nothing to rewrite.
        if (!requestInfo || requestInfo.method !== 'POST' || !isTargetRequest(requestInfo.url, root.location.href) || body == null) {
          return nativeSend.call(this, body);
        }

        const wasUrlSearchParams = body instanceof root.URLSearchParams;
        const originalBody = wasUrlSearchParams ? body.toString() : body;
        // Binary/FormData/blob bodies are passed through untouched.
        if (typeof originalBody !== 'string') return nativeSend.call(this, body);
        if (containsMediaIntent(originalBody)) {
          root.console?.info('[Cloak] Gemini media request bypassed text masking.');
          root.postMessage({ type: 'CLOAK_MEDIA_BYPASS' }, root.location.origin);
          return nativeSend.call(this, body);
        }

        // Same form-encoding repair as the fetch path.
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

        // Wrap this instance's response getters so the page never sees tokens.
        //
        // STREAMING SAFETY: Gemini reads responseText after every progress
        // event and tracks how much text it has already consumed. Restoring
        // a token SHRINKS the text (token → original value), so restoring
        // over already-delivered text shifts every offset the page has
        // recorded — its frame parser desyncs, the completion frame is never
        // consumed, and the UI freezes mid-sentence with the stop button up.
        // So restoration here is APPEND-ONLY: we hand out a growing prefix
        // that NEVER changes retroactively, holding back any tail that could
        // still turn into a token, and flush the held tail at readyState 4
        // (DONE) when no more bytes can arrive.
        const responseType = this.responseType || '';
        const streamed = { delivered: '', restored: '' };
        // Characters from here to the end might be the start of a token
        // ("[PERSON_1" split across progress events) — same rule as
        // restoreStream: only an incomplete prefix of a real token holds.
        const holdBackLength = (raw) => {
          const tokens = masker.tokens();
          if (!tokens.length) return raw.length;
          const maxLength = masker.maxTokenLength();
          const searchFrom = Math.max(0, raw.length - maxLength);
          let safeLength = raw.length;
          for (let index = searchFrom; index < raw.length; index += 1) {
            if (raw.charCodeAt(index) !== 91) continue; // '['
            const tail = raw.slice(index);
            if (tokens.some((token) => token.length > tail.length && token.startsWith(tail))) {
              safeLength = index;
              break;
            }
          }
          return safeLength;
        };
        const restoredSoFar = (raw) => {
          if (!raw.startsWith(streamed.delivered)) {
            // Defensive: a different payload than the one we were restoring
            // (should not happen on a single XHR) — restart cleanly.
            streamed.delivered = '';
            streamed.restored = '';
          }
          const transferFinished = this.readyState === 4;
          const safeLength = transferFinished ? raw.length : holdBackLength(raw);
          if (safeLength > streamed.delivered.length) {
            streamed.restored += masker.restoreText(raw.slice(streamed.delivered.length, safeLength));
            streamed.delivered = raw.slice(0, safeLength);
          }
          return streamed.restored;
        };
        const addRestoredGetter = (property, descriptor) => {
          if (!descriptor?.get) return;
          try {
            Object.defineProperty(this, property, {
              configurable: true,
              enumerable: descriptor.enumerable,
              get() {
                const result = descriptor.get.call(this);
                if (typeof result !== 'string') return masker.restoreValue(result);
                try {
                  return restoredSoFar(result);
                } catch {
                  // Never break the page over restoration.
                  return masker.restoreValue(result);
                }
              }
            });
          } catch {
            root.console?.warn(`[Cloak] Could not restore XMLHttpRequest ${property}; response tokens may remain visible.`);
          }
        };
        // '' (text) and 'text' expose both properties; 'json' only exposes one.
        if (responseType === '' || responseType === 'text') addRestoredGetter('responseText', responseTextDescriptor);
        if (responseType === '' || responseType === 'text' || responseType === 'json') addRestoredGetter('response', responseDescriptor);
        return nativeSend.call(this, rewrittenBody);
      };
    }
  }

  // ---- Entry points --------------------------------------------------------

  // Node (the test suite) gets the internals via module.exports.
  if (typeof process !== 'undefined' && process.versions?.node && typeof module !== 'undefined') {
    module.exports = { containsMediaIntent, createMasker, isTargetRequest, restoreStream };
  }

  // Same bundle, two deployment contexts:
  //  • chrome-extension:// pages (our popup) → expose a preview factory so the
  //    "Try it" tab can mask sample text live. Do NOT install() here: the
  //    popup must never hook its own fetch/XHR.
  //  • chat site main worlds (https) → install the fetch/XHR interception.
  const isExtensionPage = Boolean(root && root.location && root.location.protocol === 'chrome-extension:');
  if (isExtensionPage) {
    root.CloakPreview = { createMasker };
  } else if (root && typeof root.fetch === 'function') {
    install();
  }
})(typeof window === 'undefined' ? null : window);
