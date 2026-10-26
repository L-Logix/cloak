// Cloak — main-world interceptor: masks outgoing prompts, restores tokens
// in incoming replies. Injected into the MAIN world of the supported chat
// sites (see manifest) — the only place a content script can reach the
// page's own fetch/XHR. Bundled into intercept.bundle.js via `npm run build:interceptor`.
// Rewrites traffic the page was already sending; never talks to the network
// on Cloak's behalf.
const nlp = require('compromise');
const parseAddress = require('addressit');

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

  // Gemini's processSession writes one form field per protobuf part:
  // count=2&ofs=0&req0___data__=<base64>&req1___data__=<base64>.
  const GEMINI_RPC_FORM_PATTERN = /^count=\d+&ofs=\d+&req\d+___data__=/;

  // ---- Cloak reveal protocol (consent flow — PARKED FOR v2) ----------------
  // The notice append (rewriteBody) and the reply scanner (response paths)
  // are unwired for the store submission: the scanner held stream tails
  // waiting for the magic sentence and froze Gemini mid-stream. The pieces
  // below stay defined and unit-tested so v2 can re-attach them.
  const REVEAL_HEAD = 'Requesting access to know ';
  const REVEAL_TAIL = ' from Cloak';
  // The reply line Cloak looks for, tolerant of markdown wrappers, leading
  // whitespace, and trailing punctuation.
  const REVEAL_LINE_PATTERN = /^[ \t]*[*_`]{0,3}[ \t]*Requesting access to know (\[(?:PERSON|ADDRESS|EMAIL|PHONE|CUSTOM)_\d+_[a-z0-9-]+\]) from Cloak[.!?,;]*[*_`]{0,3}[ \t]*$/i;
  // Any masked token — used to find the prompt field that needs the notice.
  const TOKEN_PATTERN = /\[(?:PERSON|ADDRESS|EMAIL|PHONE|CUSTOM)_\d+_[a-z0-9-]+\]/;
  const REVEAL_INSTRUCTION = `[Cloak privacy notice] Values shown in square brackets like [EMAIL_1_ab12cd] are placeholders inserted by the Cloak browser extension on the user's device; the real values were never sent to you. If you need a specific placeholder's real value to complete this request, reply with ONE line in exactly this format and nothing else:
${REVEAL_HEAD}<PLACEHOLDER>${REVEAL_TAIL}
Cloak will ask the user for consent and, if granted, will resend this conversation with the real value filled in. Do not request access unless the value is truly required to finish the task.`;
  // Detects a prompt that already carries the notice (re-sends stay single-notice).
  const NOTICE_MARKER = '[Cloak privacy notice]';
  // The reply sentence, in either the raw token or the restored value form
  // (restoration runs first on both response paths). /gi, used only through
  // matchAll/replace — both reset lastIndex — so one instance is safe.
  const REVEAL_MAGIC_PATTERN = /[*_`]*[ \t]*Requesting access to know (.+?) from Cloak[.!?,;]*[*_`]{0,3}[ \t]*/gi;

  // ---- Small helpers ------------------------------------------------------

  // Make a literal safe to embed in a RegExp (".", "(" etc. must stay literal).
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---- Name detection -----------------------------------------------------

  // All plausible name strings in the prompt, longest first so longer names
  // mask before their substrings can be claimed.
  function personCandidates(text) {
    const candidates = new Set();
    // Pass 1: NLP model output.
    try {
      for (const name of nlp(text).people().out('array')) {
        if (typeof name !== 'string') continue;
        const cleaned = name.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').trim();
        if (cleaned) candidates.add(cleaned);
      }
    } catch {
      // Passes 2 and 3 still run.
    }

    // Pass 2: "my name is …" / "I'm …" introductions.
    for (const match of text.matchAll(PERSON_INTRODUCER)) {
      const words = match[1].trim().split(/\s+/);
      // Drop trailing stopwords so "bob and my phone" yields "bob".
      while (words.length > 1 && NAME_STOPWORDS.has(words.at(-1).toLowerCase())) words.pop();
      if (words.length && !NAME_STOPWORDS.has(words[0].toLowerCase())) candidates.add(words.join(' '));
    }

    // Pass 3: "to <recipient> at <email>" slots in letter-writing prompts.
    for (const match of text.matchAll(RECIPIENT_CUE)) {
      const recipient = match[1].trim();
      // Skip slots that already hold a token (text is re-scanned).
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
  // code, so the whole address masks as ONE value.
  function extendAddressSpan(candidate, parsed, streetEnd) {
    // Cities the parser recognised after the street.
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

  // Deterministic 6-char hash: the same value always maps to the same token,
  // so the vault stays deduped across page loads (djb2).
  function stableSuffixFor(value) {
    let h = 5381;
    for (let i = 0; i < value.length; i += 1) h = ((h * 33) ^ value.charCodeAt(i)) >>> 0;
    // Base-36 keeps tokens short; pad so tiny hashes still look like the rest.
    return h.toString(36).padStart(6, '0').slice(-6);
  }

  // One masker per page load: token↔value maps, masking rules, restoration.
  function createMasker() {
    let settings = { ...DEFAULT_SETTINGS };
    let enabled = true;
    let maskedCount = 0; // occurrences replaced in the most recent rewrite
    const tokenToOriginal = new Map(); // restore direction: token → value
    const originalToToken = new Map(); // dedupe direction: value → token
    const suffixIndex = new Map();     // hash suffix → display index ([PERSON_1_…])
    const pendingEntries = [];         // new vault rows waiting to be reported
    const consented = new Set();       // tokens the user APPROVED sharing in clear text
    let sortedTokens = null;           // cached restore order (see restoreText)

    // Mint (or reuse) the token for a value — reuse keeps the vault small.
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

    // Mask one occurrence — unless the user consented to share this exact
    // value (CLOAK_CONSENT), which passes through in clear text instead.
    function substitute(category, original) {
      const existing = originalToToken.get(original);
      if (existing && consented.has(existing)) return original;
      maskedCount += 1;
      return register(category, original);
    }

    // Mask one prompt string. Order matters: custom terms first (user
    // intent), then names, addresses, emails, phones.
    function maskText(value) {
      if (!enabled || typeof value !== 'string') return value;
      let text = value;
      const customTerms = Array.isArray(settings.customTerms)
        ? [...new Set(settings.customTerms.filter((term) => typeof term === 'string').map((term) => term.trim()).filter((term) => term.length >= 2 && term.length <= 80))]
          .sort((a, b) => b.length - a.length)
        : [];
      for (const term of customTerms) {
        const expression = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'giu');
        text = text.replace(expression, (match) => substitute('CUSTOM', match));
      }
      if (settings.names) {
        // Spans are right-to-left, so splicing never shifts later offsets.
        for (const span of findPersonSpans(text)) {
          text = `${text.slice(0, span.start)}${substitute('PERSON', span.value)}${text.slice(span.end)}`;
        }
      }
      if (settings.addresses) {
        for (const span of findAddressSpans(text)) {
          text = `${text.slice(0, span.start)}${substitute('ADDRESS', span.value)}${text.slice(span.end)}`;
        }
      }
      if (settings.emails) text = text.replace(EMAIL_PATTERN, (email) => substitute('EMAIL', email));
      if (settings.phones) text = text.replace(PHONE_PATTERN, (phone) => substitute('PHONE', phone));
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

    // Entry point for outgoing bodies: Gemini's processSession protobuf form
    // (detected by body pattern — Google sometimes omits Content-Type), then
    // generic form-encoded, JSON, and plain text. Masking always runs first;
    // when something was masked, the reveal notice rides along (max one).
    function rewriteBody(body, contentType = '') {
      if (typeof body !== 'string') throw new TypeError('PromptMask requires a textual request body');
      maskedCount = 0; // fresh count per request, read via takeMaskedCount()
      if (GEMINI_RPC_FORM_PATTERN.test(body)) {
        const params = new URLSearchParams(body);
        for (const key of [...new Set(params.keys())]) {
          if (!/^req\d+___data__$/.test(key)) continue;
          const original = params.get(key);
          let bytes;
          try {
            bytes = decodeBase64Flexible(original);
          } catch {
            continue; // not base64 — leave the part alone
          }
          const mapped = mapProtobufProse(bytes, (text) => maskText(text));
          if (mapped.changed) {
            // v2: the reveal notice (amendLastProseWithInstruction) re-attaches
            // here when the consent workflow ships.
            params.set(key, encodeBase64Flexible(mapped.bytes, isUrlSafeBase64(original)));
          }
        }
        return params.toString();
      }
      if (/application\/x-www-form-urlencoded/i.test(contentType)) {
        const params = new URLSearchParams(body);
        for (const [key, value] of params.entries()) params.set(key, rewriteEmbeddedString(value));
        return params.toString();
      }
      try {
        // v2: amendTreeWithInstruction re-attaches here for the notice.
        return JSON.stringify(rewriteValue(JSON.parse(body)));
      } catch {
        // Not JSON — mask the whole body as plain text.
        return maskText(body);
      }
    }

    // Swap tokens back to originals, longest first so a token inside another
    // token's text can't be clobbered. Cached: runs once per network chunk.
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
        consented.clear();
        sortedTokens = null;
        pendingEntries.length = 0;
      },
      // User clicked "Share" on the consent dialog: this token's real value
      // may now travel in clear text for subsequent requests.
      grantConsent(token) {
        if (tokenToOriginal.has(token)) consented.add(token);
      },
      // Look up the real value behind a token (used to build the consent UI).
      originalFor: (token) => tokenToOriginal.get(token) || '',
      // Reverse lookup for reveal requests captured after restoration —
      // they arrive carrying the value, not the token.
      tokenFor: (original) => originalToToken.get(original) || '',
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
    // Gemini: the BardChatUi StreamGenerate endpoint, plus the newer
    // processSession transport (base64 protobuf form parts).
    if (hostname === 'gemini.google.com' && /^\/_\/BardChatUi\/data\//.test(pathname)) return true;
    if (hostname === 'geminiweb-pa.clients6.google.com' && pathname === '/v1/processSession') return true;
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

  // ---- minimal protobuf codec (Gemini's processSession transport) --------
  // Gemini's current endpoint (geminiweb-pa.clients6.google.com/v1/
  // processSession) carries the user message as a prose string field inside
  // a base64 protobuf form field, and streams replies as length-prefixed
  // RPC frames whose JSON nests the same base64 protobufs. Masking and
  // restoration therefore need to walk protobuf without a schema: every
  // length-delimited field that decodes as prose is offered to a mapper;
  // anything malformed or binary is copied byte-for-byte, so unknown fields
  // and nonstandard fragments (the session blob has one) survive untouched.

  function readVarint(bytes, offset) {
    let value = 0;
    let shift = 0;
    let cursor = offset;
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      cursor += 1;
      value += (byte & 0x7f) * (2 ** shift);
      if (byte < 0x80) return { value, next: cursor };
      shift += 7;
      if (shift > 35) return null; // absurdly long — treat as malformed
    }
    return null;
  }

  function appendVarint(out, value) {
    let remaining = value;
    do {
      let byte = remaining % 128;
      remaining = Math.floor(remaining / 128);
      if (remaining > 0) byte += 128;
      out.push(byte);
    } while (remaining > 0);
  }

  // Strict parse: returns the field list, or null if ANY byte is not a
  // well-formed field (unknown wire type, truncated length, overrun).
  function parseProtobuf(bytes) {
    const fields = [];
    let offset = 0;
    while (offset < bytes.length) {
      const tag = readVarint(bytes, offset);
      if (!tag) return null;
      offset = tag.next;
      const field = Math.floor(tag.value / 8);
      const wireType = tag.value % 8;
      if (field === 0) return null;
      if (wireType === 0) {
        const varint = readVarint(bytes, offset);
        if (!varint) return null;
        offset = varint.next;
        fields.push({ field, wireType, varint: varint.value });
      } else if (wireType === 1) {
        if (offset + 8 > bytes.length) return null;
        fields.push({ field, wireType, raw: bytes.slice(offset, offset + 8) });
        offset += 8;
      } else if (wireType === 2) {
        const length = readVarint(bytes, offset);
        if (!length) return null;
        offset = length.next;
        if (offset + length.value > bytes.length) return null;
        fields.push({ field, wireType, bytes: bytes.slice(offset, offset + length.value) });
        offset += length.value;
      } else if (wireType === 5) {
        if (offset + 4 > bytes.length) return null;
        fields.push({ field, wireType, raw: bytes.slice(offset, offset + 4) });
        offset += 4;
      } else {
        return null; // group start/end or reserved — nonstandard, bail out
      }
    }
    return fields;
  }

  function serializeProtobuf(fields) {
    const out = [];
    for (const entry of fields) {
      appendVarint(out, entry.field * 8 + entry.wireType);
      if (entry.wireType === 0) {
        appendVarint(out, entry.varint);
      } else if (entry.wireType === 2) {
        appendVarint(out, entry.bytes.length);
        for (const byte of entry.bytes) out.push(byte);
      } else {
        for (const byte of entry.raw) out.push(byte);
      }
    }
    return Uint8Array.from(out);
  }

  const protoTextDecoder = new TextDecoder('utf-8', { fatal: true });
  const protoTextEncoder = new TextEncoder();

  // Prose test: real user text contains whitespace; session GUIDs, hex ids,
  // and the opaque auth blob never do, so they are skipped (and therefore
  // can never be corrupted by a false-positive PII match).
  const looksLikeProse = (text) => /\s/.test(text);

  // Map every prose string field through mapText, recursing into cleanly
  // parsed submessages. Returns { bytes, changed }; on any malformed field
  // the whole original buffer is returned untouched.
  function mapProtobufProse(bytes, mapText) {
    const fields = parseProtobuf(bytes);
    if (!fields) return { bytes, changed: false };
    let changed = false;
    const out = [];
    for (const entry of fields) {
      if (entry.wireType !== 2) {
        out.push(entry);
        continue;
      }
      // Structure beats text: a field whose bytes parse as a COMPLETE
      // message is a submessage and must be recursed into — even when it
      // also decodes as text. A submessage with a printable length byte
      // (e.g. 0x7E for a 126-char string) is valid UTF-8; masking it as one
      // flat sentence would leave the stale structure bytes in place and
      // corrupt the message (the server then rejects the request).
      if (parseProtobuf(entry.bytes)?.length) {
        const nested = mapProtobufProse(entry.bytes, mapText);
        if (nested.changed) {
          changed = true;
          out.push({ field: entry.field, wireType: 2, bytes: nested.bytes });
        } else {
          out.push(entry);
        }
        continue;
      }
      let text = null;
      try {
        text = protoTextDecoder.decode(entry.bytes);
      } catch {
        text = null; // not valid UTF-8 — binary, leave it alone
      }
      if (text !== null && looksLikeProse(text)) {
        const mapped = mapText(text);
        if (mapped !== text) {
          changed = true;
          out.push({ field: entry.field, wireType: 2, bytes: protoTextEncoder.encode(mapped) });
        } else {
          out.push(entry);
        }
      } else {
        out.push(entry);
      }
    }
    return changed ? { bytes: serializeProtobuf(out), changed: true } : { bytes, changed: false };
  }

  // base64 with automatic standard/url-safe alphabet detection (Gemini's
  // RPC bodies use both across fields).
  function decodeBase64Flexible(text) {
    const urlSafe = /[-_]/.test(text) && !/[+/]/.test(text);
    const normalized = urlSafe ? text.replace(/-/g, '+').replace(/_/g, '/') : text;
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function encodeBase64Flexible(bytes, urlSafe) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    const standard = btoa(binary);
    return urlSafe ? standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : standard;
  }

  const isUrlSafeBase64 = (text) => /[-_]/.test(text) && !/[+/]/.test(text);

  // One complete RPC frame ("<byte-length>\n<json>"): parse the JSON, offer
  // every plausible base64 field to the protobuf prose mapper (restore
  // direction), and re-emit the frame with a corrected length prefix so the
  // page's chunk parser stays in sync with the restored bytes.
  function restoreRpcChunk(lengthText, frameText, restoreProse) {
    let payload;
    try {
      payload = JSON.parse(frameText);
    } catch {
      return `${lengthText}\n${frameText}`;
    }
    let changed = false;
    const visit = (value) => {
      if (typeof value === 'string') {
        if (value.length < 24 || !/^[A-Za-z0-9+/_=-]+$/.test(value)) return value;
        let bytes;
        try {
          bytes = decodeBase64Flexible(value);
        } catch {
          return value;
        }
        const mapped = mapProtobufProse(bytes, restoreProse);
        if (!mapped.changed) return value;
        changed = true;
        return encodeBase64Flexible(mapped.bytes, isUrlSafeBase64(value));
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) value[key] = visit(value[key]);
        return value;
      }
      return value;
    };
    const restored = visit(payload);
    if (!changed) return `${lengthText}\n${frameText}`;
    const json = JSON.stringify(restored);
    return `${protoTextEncoder.encode(json).length}\n${json}`;
  }

  // ---- Reveal protocol: prompt notice + reply scanner ----------------------

  // Append REVEAL_INSTRUCTION to the LAST prose field holding a token — in
  // Gemini's wire format that is the newest prompt. The tree is rebuilt
  // bottom-up so every length prefix stays correct.
  function amendLastProseWithInstruction(bytes) {
    const fields = parseProtobuf(bytes);
    if (!fields) return { bytes, changed: false };
    // Find the target as an index PATH ([0,1,0] = field 0 → sub 1 → sub 0).
    // The rebuild pass re-parses the buffer, so it gets different entry
    // objects — identity comparison would silently miss nested prompts.
    let target = null;
    const findTarget = (list, path) => {
      for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];
        if (entry.wireType !== 2) continue;
        const sub = parseProtobuf(entry.bytes);
        // A real submessage keeps its token text one level deeper.
        if (sub && sub.length) findTarget(sub, [...path, index]);
        // Prompt strings can parse as messages too (a leading letter plus
        // token digits mimics tags), so empty levels are re-checked as
        // text: printable start + prose + token. LAST hit wins.
        try {
          const text = protoTextDecoder.decode(entry.bytes);
          if (/^[^\u0000-\u001F\u007F]/.test(text) && looksLikeProse(text) && TOKEN_PATTERN.test(text)) {
            target = { path: [...path, index], text };
          }
        } catch {
          // Binary field, never a candidate.
        }
      }
    };
    findTarget(fields, []);
    if (!target) return { bytes, changed: false };
    // Already-noticed prompts are left alone (no stacked copies).
    if (target.text.includes(NOTICE_MARKER)) return { bytes, changed: false };
    // Rebuild along the path; every ancestor is re-serialized with
    // corrected length prefixes.
    const amendedBytes = protoTextEncoder.encode(`${target.text}\n\n${REVEAL_INSTRUCTION}`);
    const rebuild = (list, depth) => {
      let changed = false;
      const out = list.map((entry, index) => {
        const onPath = index === target.path[depth];
        if (onPath && depth === target.path.length - 1) {
          changed = true; // the leaf itself — swap in the amended text
          return { field: entry.field, wireType: 2, bytes: amendedBytes };
        }
        if (onPath && entry.wireType === 2) {
          const sub = parseProtobuf(entry.bytes);
          if (sub && sub.length) {
            const next = rebuild(sub, depth + 1);
            if (next.changed) {
              changed = true;
              return { field: entry.field, wireType: 2, bytes: serializeProtobuf(next.fields) };
            }
          }
        }
        return entry;
      });
      return { fields: out, changed };
    };
    const rebuilt = rebuild(fields, 0);
    if (!rebuilt.changed) return { bytes, changed: false };
    return { bytes: serializeProtobuf(rebuilt.fields), changed: true };
  }

  // ---- Notice helpers for the non-protobuf wire shapes --------------------
  // ChatGPT/Claude speak JSON, Gemini's other flows speak plain or
  // embedded-JSON form fields. Same contract as the protobuf path: mask
  // first, notice the last token-bearing prose string, one per request,
  // idempotent.

  // Append the notice to one prose string — only when it holds a token and
  // doesn't already carry a notice.
  function amendProseString(text) {
    if (typeof text !== 'string') return text;
    if (!TOKEN_PATTERN.test(text) || !looksLikeProse(text) || text.includes(NOTICE_MARKER)) return text;
    return `${text}\n\n${REVEAL_INSTRUCTION}`;
  }

  // Find the last token-bearing prose string inside a parsed JSON value and
  // append the notice ("last wins" = newest prompt in a messages array).
  // Embedded JSON strings (Gemini's double-encoded f.req) are recursed into,
  // never amended as raw text — that would glue the notice after the JSON.
  // Containers write through to their setter after visiting children, so a
  // parsed embedded level re-stringifies upward AFTER the winner is swapped.
  function amendTreeWithInstruction(root) {
    let slot = null; // current winner: { set, original }; a later candidate
    //                 reverts it first, so exactly one notice ever lands
    let changed = false;
    let top = null;  // replacement for root, when root itself is a string
    const visit = (value, setter) => {
      if (typeof value === 'string') {
        // Embedded JSON structure — walk inside instead of treating it as prose.
        if (/^[[{]/.test(value.trimStart())) {
          try {
            const inner = JSON.parse(value);
            if (inner && typeof inner === 'object') {
              visit(inner, (next) => setter(JSON.stringify(next)));
              return;
            }
          } catch {
            // Not JSON after all — prose candidate below.
          }
        }
        if (TOKEN_PATTERN.test(value) && looksLikeProse(value)) {
          const amended = amendProseString(value);
          if (amended !== value) {
            if (slot) slot.set(slot.original); // last wins: undo the earlier candidate
            slot = { set: setter, original: value };
            setter(amended);
            changed = true;
          }
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, (next) => { value[index] = next; }));
        setter(value); // no-op for plain parents, re-stringifies embedded ones
        return;
      }
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) visit(value[key], (next) => { value[key] = next; });
        setter(value);
      }
    };
    visit(root, (next) => { top = next; });
    return { value: top === null ? root : top, changed };
  }

  // One form-encoded value: a string, possibly embedded JSON — the tree
  // walk handles both; the result goes back as a string.
  function amendValueString(value) {
    return amendTreeWithInstruction(value).value;
  }

  // Response-side scanner: hides Gemini's access-request sentence from the
  // page and reports the value it asked for. The sentence arrives with the
  // raw token or the restored value — install() resolves the shape.
  //
  // Append-only (Gemini's reader tracks offsets): feed() only ever appends
  // to `display`. Complete lines extract immediately; the trailing partial
  // is scanned in place, then everything before the last possibly-
  // incomplete sentence ships and the suspect suffix waits for more bytes.
  function createRevealScanner(onReveal) {
    let display = ''; // committed text — always safe to deliver, append-only
    let hold = '';    // unresolved tail (possible partial magic sentence)
    // Private /gi copy — matchAll/replace never leak lastIndex state anyway.
    const magicSentence = new RegExp(REVEAL_MAGIC_PATTERN.source, 'gi');
    // Strip every completed magic sentence, reporting what it captured.
    const extractMagic = (text) => {
      if (!/Requesting access to know/i.test(text)) return text; // cheap reject
      for (const hit of [...text.matchAll(magicSentence)]) onReveal(hit[1]);
      return text.replace(magicSentence, '');
    };
    // True while `text` may end mid-sentence: head present or the tail is
    // itself a prefix of the head.
    const startsOrBuildsHead = (text) => {
      const lower = text.toLowerCase();
      const headLower = REVEAL_HEAD.toLowerCase();
      const at = lower.lastIndexOf(headLower);
      if (at !== -1) return true; // head present — sentence may be incomplete
      // Longest suffix of the text that is a proper prefix of the head.
      const max = Math.min(text.length, headLower.length - 1);
      for (let len = max; len > 0; len -= 1) {
        if (headLower.startsWith(lower.slice(lower.length - len))) return true;
      }
      return false;
    };
    const feed = (chunk, transferFinished) => {
      hold += chunk;
      // 1. Complete lines: newline proves the line is final — extract
      //    whatever magic it holds and ship the rest.
      for (;;) {
        const newline = hold.indexOf('\n');
        if (newline === -1) break;
        display += `${extractMagic(hold.slice(0, newline))}\n`;
        hold = hold.slice(newline + 1);
      }
      // 2. Trailing partial, no newline yet.
      if (transferFinished) {
        display += extractMagic(hold); // stream over — flush the tail
        hold = '';
      } else {
        hold = extractMagic(hold); // completed sentences (frame-embedded) fire now
        const at = hold.toLowerCase().lastIndexOf(REVEAL_HEAD.toLowerCase());
        const cut = at !== -1
          ? at // hold from the last full head — the sentence may be incomplete
          : startsOrBuildsHead(hold) ? headCut(hold) : hold.length;
        if (cut > 0) {
          display += hold.slice(0, cut);
          hold = hold.slice(cut);
        }
      }
      return display;
    };
    // Start index of the suffix that is (a prefix of) the head — the point
    // past which bytes must wait for the rest of the sentence.
    const headCut = (text) => {
      const lower = text.toLowerCase();
      const headLower = REVEAL_HEAD.toLowerCase();
      const max = Math.min(text.length, headLower.length - 1);
      for (let len = max; len > 0; len -= 1) {
        if (headLower.startsWith(lower.slice(lower.length - len))) return text.length - len;
      }
      return text.length;
    };
    return { feed };
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
      // The user answered the consent dialog: "Share" lets this one value
      // travel in clear text from now on; "Don't share" changes nothing
      // (the value stays masked) — the content script's follow-up message
      // tells Gemini which happened.
      if (event.data.type === 'CLOAK_CONSENT' && event.data.token) {
        if (event.data.granted) {
          masker.grantConsent(event.data.token);
          root.console?.info(`[Cloak] User approved sharing ${event.data.token} with the AI in clear text.`);
        } else {
          root.console?.info(`[Cloak] User declined to share ${event.data.token}; it stays masked.`);
        }
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

      // True for Gemini's current processSession transport (the prompt POST
      // and the long-poll GET that streams replies back).
      const isProcessSession = (url) => {
        try {
          const parsed = new URL(url, root.location.href);
          return parsed.hostname === 'geminiweb-pa.clients6.google.com' && parsed.pathname === '/v1/processSession';
        } catch {
          return false;
        }
      };

      // Response-side restoration for one XHR instance. Classic chat streams
      // (StreamGenerate etc.) use the append-only text path; Gemini's
      // processSession uses length-prefixed RPC frames, so each COMPLETE
      // frame is parsed, restored from the inside out, and re-emitted with a
      // corrected length prefix while partial frames are held (or flushed at
      // readyState 4).
      // v2 note: the reveal scanner + frame strip that used to run here are
      // parked with the consent workflow. They held back stream tails waiting
      // for a "Requesting access to know…" sentence that never arrived, which
      // froze Gemini mid-stream. Restoration is now pure append-only.
      const installResponseGetters = (xhr, geminiRpc) => {
        const responseType = xhr.responseType || '';
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
        const restoredTextSoFar = (raw) => {
          if (!raw.startsWith(streamed.delivered)) {
            // Defensive: a different payload than the one we were restoring
            // (should not happen on a single XHR) — restart cleanly.
            streamed.delivered = '';
            streamed.restored = '';
          }
          const transferFinished = xhr.readyState === 4;
          const safeLength = transferFinished ? raw.length : holdBackLength(raw);
          if (safeLength > streamed.delivered.length) {
            streamed.restored += masker.restoreText(raw.slice(streamed.delivered.length, safeLength));
            streamed.delivered = raw.slice(0, safeLength);
          }
          return streamed.restored;
        };
        // ProcessSession frames: "<byte-length>\n<json>". Tokens live inside
        // base64 protobuf strings nested in that JSON (the reply text is a
        // prose field), so restoration is per complete frame; the length
        // prefix is recomputed from the restored JSON's UTF-8 byte length so
        // the page's frame parser stays in sync. Inter-frame whitespace and
        // incomplete frames pass through verbatim.
        const restoredRpcSoFar = (raw) => {
          if (!raw.startsWith(streamed.delivered)) {
            streamed.delivered = '';
            streamed.restored = '';
          }
          const transferFinished = xhr.readyState === 4;
          let position = streamed.delivered.length;
          let out = streamed.restored;
          while (position < raw.length) {
            const character = raw[position];
            if (character === '\n' || character === '\r') {
              out += character;
              position += 1;
              continue;
            }
            const newline = raw.indexOf('\n', position);
            if (newline === -1) {
              if (transferFinished) {
                out += raw.slice(position);
                position = raw.length;
              }
              break;
            }
            const lengthText = raw.slice(position, newline);
            if (!/^\d{1,8}$/.test(lengthText)) {
              // Not a length line (anti-XSSI ")]}'" prefix, stray bytes):
              // pass it through verbatim. Holding it would deadlock a
              // long-poll whose first bytes are never a frame.
              out += `${lengthText}\n`;
              position = newline + 1;
              continue;
            }
            const frameLength = Number(lengthText);
            const frameStart = newline + 1;
            if (raw.length < frameStart + frameLength) {
              if (transferFinished) {
                out += raw.slice(position);
                position = raw.length;
              }
              break;
            }
            // Restore tokens inside the frame's prose (v2: the reveal strip
            // re-attaches here with the consent workflow).
            out += restoreRpcChunk(lengthText, raw.slice(frameStart, frameStart + frameLength), (text) => masker.restoreText(text));
            position = frameStart + frameLength;
          }
          if (position > streamed.delivered.length) {
            streamed.delivered = raw.slice(0, position);
            streamed.restored = out;
          }
          return streamed.restored;
        };
        const restoredSoFar = geminiRpc ? restoredRpcSoFar : restoredTextSoFar;
        const addRestoredGetter = (property, descriptor) => {
          if (!descriptor?.get) return;
          try {
            Object.defineProperty(xhr, property, {
              configurable: true,
              enumerable: descriptor.enumerable,
              get() {
                const result = descriptor.get.call(xhr);
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
      };

      xhrPrototype.send = function (body) {
        const requestInfo = xhrRequests.get(this);
        if (!requestInfo || !isTargetRequest(requestInfo.url, root.location.href)) {
          return nativeSend.call(this, body);
        }
        // Replies ride on the processSession long-poll (a GET), so wrap the
        // response side for every method — not just the POST carrying the
        // prompt. The long-poll has no body to rewrite.
        const geminiRpc = isProcessSession(requestInfo.url);
        if (geminiRpc) installResponseGetters(this, true);
        if (requestInfo.method !== 'POST' || body == null) {
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

        // Classic (non-RPC) providers also stream replies; wrap their getters
        // with the append-only text path. STREAMING SAFETY: Gemini reads
        // responseText after every progress event and tracks how much text it
        // has already consumed. Restoring a token SHRINKS the text (token →
        // original value), so restoring over already-delivered text shifts
        // every offset the page has recorded — its frame parser desyncs, the
        // completion frame is never consumed, and the UI freezes mid-sentence
        // with the stop button up. So restoration here is APPEND-ONLY: we
        // hand out a growing prefix that NEVER changes retroactively, holding
        // back any tail that could still turn into a token, and flush the
        // held tail at readyState 4 (DONE) when no more bytes can arrive.
        if (!geminiRpc) installResponseGetters(this, false);
        return nativeSend.call(this, rewrittenBody);
      };
    }
  }

  // ---- Entry points --------------------------------------------------------

  // Node (the test suite) gets the internals via module.exports.
  if (typeof process !== 'undefined' && process.versions?.node && typeof module !== 'undefined') {
    module.exports = {
      containsMediaIntent,
      createMasker,
      isTargetRequest,
      restoreStream,
      // Reveal protocol pieces (consent flow) — unit-tested directly.
      createRevealScanner,
      amendLastProseWithInstruction,
      REVEAL_INSTRUCTION,
      REVEAL_LINE_PATTERN
    };
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
