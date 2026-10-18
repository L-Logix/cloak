// ---------------------------------------------------------------------------
// Cloak — content script, isolated world (content.js)
//
// This script runs beside every supported chat page and is the bridge between
// the popup (chrome.storage) and the interceptor (intercept.bundle.js, which
// runs in the page's MAIN world — the only world that can reach page fetch).
//
//   popup.js ── chrome.storage ──▶ content.js ── postMessage ──▶ interceptor
//                    ▲                                        │
//                    └────────── vault + stats ◀──────────────┘
//
// Responsibilities
//   1. publish CLOAK_CONFIG (enabled + settings) to the interceptor
//   2. persist the vault (token → value) reported by CLOAK_MASKED_DATA
//   3. accumulate activity counters from CLOAK_REQUEST_STATS
//   4. draw the composer badge and the media-bypass banner on the page
//   5. run the reveal consent flow: dialog when Gemini requests a masked
//      value, then auto-send the user's answer back through the composer
// ---------------------------------------------------------------------------
(() => {
  'use strict';

  // Mirrored in popup.js and intercept.js — same defaults everywhere.
  const DEFAULT_SETTINGS = {
    names: true,
    emails: true,
    phones: true,
    addresses: true,
    restoreResponses: true,
    showBadge: true,
    customTerms: []
  };
  // Cheap on-page hint (not the real detector) used only to light the badge:
  // "looks like a name" | "has an email/phone/address pattern".
  const mediaIntent = /\b(?:draw|generate|create|make)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|video)\b|\bimage generation\b/i;
  const piiHint = /[A-Z][a-z]+\s+[A-Z][a-z]+|\b(?:principal|professor|doctor|dr\.?|mr\.?|mrs\.?|ms\.?|miss|coach|teacher)\s+[a-z]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{1,6}\s+(?:[a-z0-9]+\s+){1,5}(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|circle|cir\.?|way|parkway|pkwy\.?|terrace|ter\.?|place|pl\.?|trail|trl\.?)\b|\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/i;

  // Live configuration, refreshed from storage on every change.
  let config = { enabled: true, settings: { ...DEFAULT_SETTINGS } };
  let currentComposer;   // the chat textarea/contenteditable we are watching
  let badge;             // the small lock badge pinned to the composer
  let banner;            // the "image generation bypasses masking" notice
  let bannerTimeout;
  let refreshQueued = false;      // coalesce DOM-mutation refresh bursts
  let statsWriteQueue = Promise.resolve(); // serialize counter read-modify-writes
  const revealQueue = []; // consent requests waiting for the dialog (FIFO)
  let revealActive = null; // the consent request currently shown to the user

  // ---- extension-context liveness ------------------------------------------
  // When the extension is reloaded or updated while this tab stays open,
  // Chrome invalidates this content script's context: the script keeps
  // running, but every chrome.* call throws "Extension context invalidated".
  // Masking itself is unaffected (the interceptor is plain MAIN-world page
  // JS and survives), so instead of warning on every request we detect the
  // invalidation once, go dormant, and leave storage alone for good.
  let contextValid = true;

  function markContextInvalid() {
    contextValid = false;
  }

  // Only the specific invalidation error flips the flag; other storage errors
  // (quota, corrupted data) are transient and must not shut the bridge down.
  function isContextInvalidated(error) {
    return /Extension context invalidated/i.test(String((error && error.message) || error));
  }

  // Collapse duplicate vault entries that map to the same value. Older versions
  // minted a fresh token for the same value on every page load, so a vault could
  // fill with many tokens that all restore to e.g. "bob". Keep one token per
  // distinct value and drop the rest.
  function dedupeVault(vault) {
    const tokenByValue = new Map();
    const out = {};
    for (const [token, original] of Object.entries(vault || {})) {
      if (typeof original !== 'string') { out[token] = original; continue; }
      const kept = tokenByValue.get(original);
      if (kept === undefined) {
        tokenByValue.set(original, token);
        out[token] = original;
      } else if (token.startsWith('[') ) {
        // Prefer the deterministic token produced by the current version.
        delete out[kept];
        tokenByValue.set(original, token);
        out[token] = original;
      }
    }
    return out;
  }

  // Fold one CLOAK_REQUEST_STATS message into the stored counters. Stats
  // updates are queued (not fired straight away) because several requests can
  // report in the same tick and a plain read-modify-write would lose counts.
  // Every chrome.* touch is guarded so an invalidated context goes quiet
  // instead of throwing once per request.
  function recordRequestStats(message) {
    if (!contextValid) return;
    const requestsChecked = Number.isSafeInteger(message.requestsChecked) ? Math.max(0, message.requestsChecked) : 0;
    const valuesMasked = Number.isSafeInteger(message.valuesMasked) ? Math.max(0, message.valuesMasked) : 0;
    if (!requestsChecked) return;

    statsWriteQueue = statsWriteQueue.then(() => new Promise((resolve) => {
      if (!contextValid) {
        resolve();
        return;
      }
      try {
        chrome.storage.local.get({ stats: { requestsChecked: 0, valuesMasked: 0 } }, (result) => {
          if (!contextValid || chrome.runtime.lastError) {
            resolve();
            return;
          }
          const stats = result.stats || { requestsChecked: 0, valuesMasked: 0 };
          try {
            chrome.storage.local.set({
              stats: {
                requestsChecked: (stats.requestsChecked || 0) + requestsChecked,
                valuesMasked: (stats.valuesMasked || 0) + valuesMasked
              }
            }, resolve);
          } catch (error) {
            if (isContextInvalidated(error)) markContextInvalid();
            resolve();
          }
        });
      } catch (error) {
        // chrome.storage.local.get throws synchronously once the context is
        // dead — latch the flag and drop this update.
        if (isContextInvalidated(error)) markContextInvalid();
        resolve();
      }
    })).catch(() => {});
  }

  // Push the current enabled/settings pair to the interceptor. Targeted at our
  // own origin only — no other frame can read the configuration.
  function publishConfig() {
    window.postMessage({
      type: 'CLOAK_CONFIG',
      enabled: config.enabled,
      settings: config.settings
    }, location.origin);
  }

  // Show the "image generation needs full context" banner for a few seconds.
  // Created lazily so an idle page carries no Cloak DOM at all.
  function showMediaBanner() {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'cloak-media-banner';
      banner.setAttribute('role', 'status');
      banner.textContent = 'PromptMask paused: Image generation requires full context.';
    }
    if (!banner.isConnected) (document.body || document.documentElement).append(banner);
    banner.dataset.visible = 'true';
    clearTimeout(bannerTimeout);
    bannerTimeout = setTimeout(() => {
      if (banner) banner.dataset.visible = 'false';
    }, 4000);
  }

  // ---- Cloak reveal consent (the "Gemini wants information" dialog) -------
  // Flow, end to end:
  //   1. The interceptor masks PII and appends a notice telling Gemini that
  //      bracketed values are local placeholders.
  //   2. If Gemini truly needs one (e.g. to schedule a meeting), it replies
  //      with the magic line "Requesting access to know <TOKEN> from Cloak".
  //   3. The interceptor's reply scanner HIDES that line and posts
  //      CLOAK_REVEAL_REQUEST here.
  //   4. This section shows the dialog below; the user picks Share / Don't
  //      share.
  //   5. We post CLOAK_CONSENT (so a Share un-masks that value in the
  //      interceptor) and auto-send a follow-up message through the page's
  //      own composer telling Gemini which happened — the conversation then
  //      continues with the correct, visible message.
  const CATEGORY_LABELS = { PERSON: 'name', ADDRESS: 'address', EMAIL: 'email', PHONE: 'phone', CUSTOM: 'custom term' };

  // Human name of the current AI site for dialog copy.
  function revealSiteName() {
    const host = location.hostname;
    if (host.includes('gemini')) return 'Gemini';
    if (host.includes('chatgpt')) return 'ChatGPT';
    if (host.includes('claude')) return 'Claude';
    return 'The AI';
  }

  // Queue a reveal request from the interceptor. Duplicate tokens are
  // dropped so a re-streamed reply cannot stack identical dialogs, and a
  // missing original falls back to the stored vault (the interceptor may
  // have restarted since the token was minted).
  function enqueueReveal(token, original) {
    if (!contextValid) return;
    if (!/^\[(PERSON|ADDRESS|EMAIL|PHONE|CUSTOM)_\d+_[a-z0-9-]+\]$/.test(String(token || ''))) return;
    const alreadyQueued = revealActive?.token === token || revealQueue.some((entry) => entry.token === token);
    if (alreadyQueued) return;
    const push = (value) => {
      revealQueue.push({ token, original: value });
      if (!revealActive) showNextReveal();
    };
    if (typeof original === 'string' && original) {
      push(original);
      return;
    }
    try {
      chrome.storage.local.get({ vault: {} }, (result) => {
        if (!contextValid || chrome.runtime.lastError) return;
        const value = (result.vault || {})[token];
        if (typeof value === 'string' && value) push(value);
      });
    } catch (error) {
      if (isContextInvalidated(error)) markContextInvalid();
    }
  }

  // Render the next queued request (if any) as a centered modal. The dialog
  // is the only Cloak element that captures pointer events — the badge and
  // banner stay click-through.
  function showNextReveal() {
    revealActive = revealQueue.shift() || null;
    removeRevealDialog();
    if (!revealActive) return;
    const category = revealActive.token.slice(1, revealActive.token.indexOf('_'));
    const label = CATEGORY_LABELS[category] || 'information';
    const site = revealSiteName();

    const overlay = document.createElement('div');
    overlay.className = 'cloak-reveal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `${site} wants information`);

    const card = document.createElement('div');
    card.className = 'cloak-reveal-card';

    const title = document.createElement('h2');
    title.className = 'cloak-reveal-title';
    title.id = 'cloak-reveal-title';
    title.textContent = `${site} wants information`;

    const body = document.createElement('p');
    body.className = 'cloak-reveal-body';
    // "Share email lucalogix12@gmail.com with Gemini?" — value in a chip so
    // the exact string being released is unmistakable.
    const verb = document.createElement('span');
    verb.textContent = `Share ${label} `;
    const value = document.createElement('code');
    value.className = 'cloak-reveal-value';
    value.textContent = revealActive.original;
    const tail = document.createElement('span');
    tail.textContent = ` with ${site} for this request?`;
    body.append(verb, value, tail);

    const actions = document.createElement('div');
    actions.className = 'cloak-reveal-actions';

    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'cloak-reveal-deny';
    deny.textContent = "Don't share";
    deny.addEventListener('click', () => decideReveal(false));

    const grant = document.createElement('button');
    grant.type = 'button';
    grant.className = 'cloak-reveal-grant';
    grant.textContent = 'Share';
    grant.addEventListener('click', () => decideReveal(true));

    actions.append(deny, grant);

    const note = document.createElement('p');
    note.className = 'cloak-reveal-note';
    note.textContent = 'Cloak sends your answer to the AI automatically — nothing is shared until you choose.';

    card.append(title, body, actions, note);
    overlay.append(card);
    (document.body || document.documentElement).append(overlay);
    // Privacy-first focus: keyboard users start on "Don't share", so an
    // accidental Enter never releases PII.
    deny.focus();
  }

  function removeRevealDialog() {
    document.querySelectorAll('.cloak-reveal').forEach((node) => node.remove());
  }

  // The user decided. Record the consent in the interceptor (Share un-masks
  // exactly this value), close the dialog, and tell Gemini what happened by
  // sending a follow-up through the page's own composer — so session state,
  // history, and the rendered UI all stay exactly as the site expects.
  function decideReveal(granted) {
    const item = revealActive;
    removeRevealDialog();
    revealActive = null;
    if (!item) return;
    const category = item.token.slice(1, item.token.indexOf('_'));
    const label = CATEGORY_LABELS[category] || 'information';
    window.postMessage({ type: 'CLOAK_CONSENT', token: item.token, granted }, location.origin);
    const message = granted
      ? `The user has approved sharing their ${label} for this request: ${item.original}. It is no longer a placeholder — please continue the original task using this real value.`
      : `The user declined to share their ${label}. Do not ask for it again. Continue the original task using the placeholder as-is, and tell the user what you were able to do without it.`;
    sendFollowUp(message);
    // Show any request that queued up behind this one.
    setTimeout(showNextReveal, 400);
  }

  // Type the follow-up into the site's composer and submit it, using the
  // page's OWN send path (Quill keydown → app submit) so history/session
  // bookkeeping stays correct. A Send-button click covers the case where
  // Enter is not the submit key for this build of the UI.
  function sendFollowUp(text) {
    // CLOAK_CONSENT travels by postMessage (async); give the interceptor a
    // tick to apply it before this text is rewritten on the way out.
    setTimeout(() => {
      try {
        const composer = currentComposer?.isConnected ? currentComposer : findComposer();
        if (!composer) return;
        composer.focus();
        if (composer.isContentEditable) {
          // Replace the existing draft with the follow-up text.
          document.execCommand('selectAll', false, null);
          if (!document.execCommand('insertText', false, text)) composer.textContent = text;
        } else {
          composer.value = text;
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Submit: Enter keydown/keypress/keyup trio on the editor (what the
        // physical keyboard sends). keyCode is deprecated but still what
        // older Quill hotkey tables read.
        const press = (type) => composer.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
        press('keydown');
        press('keypress');
        press('keyup');
        // Fallback: if the draft is still sitting there after a moment,
        // click the site's own Send button instead.
        setTimeout(() => {
          if (!readComposerText(composer).trim()) return; // Enter worked
          const send = [...document.querySelectorAll('button, [role="button"]')].find((b) =>
            /^send\b/i.test((b.getAttribute('aria-label') || '').trim())
          );
          send?.click();
        }, 700);
      } catch {
        // Never break the page over a failed auto-send; the user can always
        // type their own follow-up.
      }
    }, 150);
  }

  // Composers are either contenteditable divs (innerText) or <textarea>s.
  function readComposerText(element) {
    return element.isContentEditable ? element.innerText : element.value || '';
  }

  // Keep the badge glued to the composer's bottom-right corner, clamped to
  // the viewport, and the banner centred above the composer.
  function positionElements() {
    if (badge && currentComposer?.isConnected) {
      const rect = currentComposer.getBoundingClientRect();
      badge.style.left = `${Math.max(8, Math.min(window.innerWidth - 34, rect.right - 31))}px`;
      badge.style.top = `${Math.max(8, Math.min(window.innerHeight - 34, rect.bottom - 31))}px`;
      if (banner) {
        banner.style.left = `${Math.max(16, Math.min(window.innerWidth - 436, rect.left + rect.width / 2))}px`;
        banner.style.bottom = `${Math.max(16, window.innerHeight - rect.top + 12)}px`;
      }
    }
  }

  // Every keystroke: light the badge if the draft looks like it holds PII,
  // and flash the banner if the user is clearly asking for an image.
  function onComposerInput(event) {
    const text = readComposerText(event.currentTarget);
    if (badge) badge.dataset.active = String(config.enabled && piiHint.test(text));
    if (mediaIntent.test(text)) showMediaBanner();
  }

  // (Re)create the composer badge honouring the showBadge preference.
  function createBadge() {
    if (config.settings.showBadge === false) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'cloak-mask-badge';
      badge.dataset.active = 'false';
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', 'PromptMask protection status');
      badge.title = 'PromptMask protection';
      // Padlock glyph, injected as inline SVG so no external asset is fetched.
      badge.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"></rect><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"></path></svg>';
    }
    if (!badge.isConnected) (document.body || document.documentElement).append(badge);
  }

  // Find the site's chat composer. Each provider needs a different selector
  // order, and the first visible candidate wins.
  function findComposer() {
    const host = location.hostname;
    const preferred = host === 'gemini.google.com'
      ? ['rich-textarea [contenteditable="true"]', 'textarea', '[contenteditable="true"]']
      : host.endsWith('claude.ai')
        ? ['[contenteditable="true"].ProseMirror', 'textarea', '[contenteditable="true"]']
        : ['#prompt-textarea', 'textarea', '[contenteditable="true"]'];

    for (const selector of preferred) {
      const candidate = [...document.querySelectorAll(selector)].find((element) => {
        // Never mistake our own badge/banner for a composer.
        if (element.closest('.cloak-mask-badge, .cloak-media-banner')) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0; // visible only
      });
      if (candidate) return candidate;
    }
    return null;
  }

  // Re-run composer discovery; the page re-renders its DOM constantly, so this
  // is called (debounced) on every mutation burst.
  function refreshComposer() {
    refreshQueued = false;
    const found = findComposer();
    if (found === currentComposer) {
      // Same composer as before: just keep the badge attached and positioned.
      createBadge();
      positionElements();
      return;
    }
    // Composer changed: move the input listener across.
    currentComposer?.removeEventListener('input', onComposerInput);
    currentComposer = found;
    if (!currentComposer) return;
    createBadge();
    currentComposer.addEventListener('input', onComposerInput);
    onComposerInput({ currentTarget: currentComposer });
    positionElements();
  }

  // MutationObserver fires far more often than frames; coalesce to one
  // refresh per animation frame.
  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(refreshComposer);
  }

  // ---- interceptor → storage bridge ---------------------------------------
  // Accepts vault entries, media bypass notices, and stats from the MAIN
  // world. Origin + source checks stop any other frame from injecting data;
  // once the extension context dies we ignore messages entirely (the
  // interceptor keeps masking — only this storage bridge goes dormant).
  window.addEventListener('message', (event) => {
    if (!contextValid) return;
    if (event.source !== window || !event.data || event.origin !== location.origin) return;
    if (event.data.type === 'CLOAK_MASKED_DATA' && Array.isArray(event.data.entries)) {
      try {
        chrome.storage.local.get({ vault: {} }, (result) => {
          if (!contextValid || chrome.runtime.lastError) return;
          const vault = { ...(result.vault || {}) };
          for (const entry of event.data.entries) {
            // Strict shape checks: only well-formed tokens and short strings
            // are persisted, so a hostile page cannot flood extension storage.
            if (!entry || !/^\[(PERSON|ADDRESS|EMAIL|PHONE|CUSTOM)_\d+_[a-z0-9-]+\]$/i.test(entry.token)) continue;
            if (typeof entry.original !== 'string' || entry.original.length > 500) continue;
            vault[entry.token] = entry.original;
          }
          // Dedupe on every write so old duplicate vaults keep shrinking.
          try {
            chrome.storage.local.set({ vault: dedupeVault(vault) });
          } catch (error) {
            if (isContextInvalidated(error)) markContextInvalid();
          }
        });
      } catch (error) {
        if (isContextInvalidated(error)) markContextInvalid();
      }
    } else if (event.data.type === 'CLOAK_MEDIA_BYPASS') {
      showMediaBanner();
    } else if (event.data.type === 'CLOAK_REQUEST_STATS') {
      recordRequestStats(event.data);
    } else if (event.data.type === 'CLOAK_REVEAL_REQUEST') {
      // Gemini asked for a real value behind a placeholder — open the
      // consent dialog (hidden magic line never reaches the page).
      enqueueReveal(event.data.token, event.data.original);
    }
  });

  // One-time cleanup so vaults already polluted by older versions collapse
  // without waiting for the next masked send.
  try {
    chrome.storage.local.get({ vault: {} }, (result) => {
      if (!contextValid || chrome.runtime.lastError) return;
      const original = result.vault || {};
      const cleaned = dedupeVault(original);
      if (Object.keys(cleaned).length !== Object.keys(original).length) {
        try {
          chrome.storage.local.set({ vault: cleaned });
        } catch (error) {
          if (isContextInvalidated(error)) markContextInvalid();
        }
      }
    });
  } catch (error) {
    if (isContextInvalidated(error)) markContextInvalid();
  }

  // Initial configuration read; publish once so the interceptor is never
  // left guessing before the first request.
  try {
    chrome.storage.local.get(['enabled', 'settings'], (result) => {
      if (contextValid && !chrome.runtime.lastError) {
        config.enabled = result.enabled !== false;
        config.settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
      }
      publishConfig();
      queueRefresh();
    });
  } catch (error) {
    if (isContextInvalidated(error)) markContextInvalid();
    publishConfig();
    queueRefresh();
  }

  // Live updates: the popup writes storage, we republish and re-render.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.enabled) config.enabled = changes.enabled.newValue !== false;
    if (changes.settings) config.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    // An emptied vault means the user pressed "Clear vault" — wipe the
    // interceptor's in-memory token map too, so old tokens cannot restore.
    if (changes.vault && Object.keys(changes.vault.newValue || {}).length === 0) {
      window.postMessage({ type: 'CLOAK_CLEAR_MEMORY' }, location.origin);
    }
    publishConfig();
    queueRefresh();
    if (currentComposer) onComposerInput({ currentTarget: currentComposer });
  });

  // ---- page watching -------------------------------------------------------
  // Chat apps are single-page apps: the composer appears and disappears as
  // conversations switch, so watch the whole document for structural changes.
  const observer = new MutationObserver(queueRefresh);
  function startObserver() {
    if (!document.documentElement) {
      // document_start can run before <html> exists; wait for it once.
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
      return;
    }
    observer.observe(document.documentElement, { childList: true, subtree: true });
    queueRefresh();
  }

  startObserver();
  // The badge is position:fixed — reflow it on scroll/resize.
  window.addEventListener('resize', positionElements, { passive: true });
  window.addEventListener('scroll', positionElements, { passive: true, capture: true });
})();
