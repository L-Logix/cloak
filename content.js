// Cloak — content script, isolated world: bridges the popup
// (chrome.storage) and the MAIN-world interceptor (postMessage).
// Publishes CLOAK_CONFIG, persists the vault, accumulates counters,
// and draws the composer badge / media banner. (The reveal consent
// flow is parked for v2 — see the commented block mid-file.)
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
  // v2 (reveal consent): the FIFO queue + active request for the parked dialog.
  // const revealQueue = [];
  // let revealActive = null;

  // ---- extension-context liveness ------------------------------------------
  // After an extension reload every chrome.* call throws "Extension context
  // invalidated" — detect it once and go dormant (masking itself is unaffected;
  // the MAIN-world interceptor survives).
  let contextValid = true;

  function markContextInvalid() {
    contextValid = false;
  }

  // Only the invalidation error flips the flag; quota/data errors are transient.
  function isContextInvalidated(error) {
    return /Extension context invalidated/i.test(String((error && error.message) || error));
  }

  // Collapse duplicate vault entries mapping to one value (older versions
  // minted a fresh token for the same value on every page load).
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

  // Fold one CLOAK_REQUEST_STATS message into the stored counters, queued
  // because same-tick reports would lose counts in a plain read-modify-write;
  // every chrome.* touch is guarded so a dead context goes quiet.
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
        // get() throws synchronously once the context is dead — drop quietly.
        if (isContextInvalidated(error)) markContextInvalid();
        resolve();
      }
    })).catch(() => {});
  }

  // Push enabled/settings to the interceptor, targeted at our own origin.
  function publishConfig() {
    window.postMessage({
      type: 'CLOAK_CONFIG',
      enabled: config.enabled,
      settings: config.settings
    }, location.origin);
  }

  // Show the media banner for a few seconds; created lazily so an idle
  // page carries no Cloak DOM at all.
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

  // ---- Cloak reveal consent (parked for v2) --------------------------------
  // The interceptor masks PII; when Gemini truly needs a value it replies
  // "Requesting access to know <TOKEN> from Cloak". The scanner hides that
  // line and posts CLOAK_REVEAL_REQUEST → dialog → CLOAK_CONSENT →
  // auto-sent follow-up. Parked for the store submission: the scanner held
  // stream tails mid-response and froze Gemini. The dialog functions below
  // stay commented-out-ready for v2.
  // const CATEGORY_LABELS = { PERSON: 'name', ADDRESS: 'address', EMAIL: 'email', PHONE: 'phone', CUSTOM: 'custom term' };

  // // Human name of the current AI site for dialog copy.
  // function revealSiteName() {
  //   const host = location.hostname;
  //   if (host.includes('gemini')) return 'Gemini';
  //   if (host.includes('chatgpt')) return 'ChatGPT';
  //   if (host.includes('claude')) return 'Claude';
  //   return 'The AI';
  // }

  // // Queue a reveal request. Duplicates are dropped so a re-streamed reply
  // // cannot stack dialogs; a missing original falls back to the stored vault.
  // function enqueueReveal(token, original) {
  //   if (!contextValid) return;
  //   if (!/^\[(PERSON|ADDRESS|EMAIL|PHONE|CUSTOM)_\d+_[a-z0-9-]+\]$/.test(String(token || ''))) return;
  //   const alreadyQueued = revealActive?.token === token || revealQueue.some((entry) => entry.token === token);
  //   if (alreadyQueued) return;
  //   const push = (value) => {
  //     revealQueue.push({ token, original: value });
  //     if (!revealActive) showNextReveal();
  //   };
  //   if (typeof original === 'string' && original) {
  //     push(original);
  //     return;
  //   }
  //   try {
  //     chrome.storage.local.get({ vault: {} }, (result) => {
  //       if (!contextValid || chrome.runtime.lastError) return;
  //       const value = (result.vault || {})[token];
  //       if (typeof value === 'string' && value) push(value);
  //     });
  //   } catch (error) {
  //     if (isContextInvalidated(error)) markContextInvalid();
  //   }
  // }

  // // Render the next queued request as a centered modal — the only Cloak
  // // element that captures pointer events (badge and banner stay click-through).
  // function showNextReveal() {
  //   revealActive = revealQueue.shift() || null;
  //   removeRevealDialog();
  //   if (!revealActive) return;
  //   const category = revealActive.token.slice(1, revealActive.token.indexOf('_'));
  //   const label = CATEGORY_LABELS[category] || 'information';
  //   const site = revealSiteName();

  //   const overlay = document.createElement('div');
  //   overlay.className = 'cloak-reveal';
  //   overlay.setAttribute('role', 'dialog');
  //   overlay.setAttribute('aria-modal', 'true');
  //   overlay.setAttribute('aria-label', `${site} wants information`);

  //   const card = document.createElement('div');
  //   card.className = 'cloak-reveal-card';

  //   const title = document.createElement('h2');
  //   title.className = 'cloak-reveal-title';
  //   title.id = 'cloak-reveal-title';
  //   title.textContent = `${site} wants information`;

  //   const body = document.createElement('p');
  //   body.className = 'cloak-reveal-body';
  //   // Value in a chip so the exact string being released is unmistakable.
  //   const verb = document.createElement('span');
  //   verb.textContent = `Share ${label} `;
  //   const value = document.createElement('code');
  //   value.className = 'cloak-reveal-value';
  //   value.textContent = revealActive.original;
  //   const tail = document.createElement('span');
  //   tail.textContent = ` with ${site} for this request?`;
  //   body.append(verb, value, tail);

  //   const actions = document.createElement('div');
  //   actions.className = 'cloak-reveal-actions';

  //   const deny = document.createElement('button');
  //   deny.type = 'button';
  //   deny.className = 'cloak-reveal-deny';
  //   deny.textContent = "Don't share";
  //   deny.addEventListener('click', () => decideReveal(false));

  //   const grant = document.createElement('button');
  //   grant.type = 'button';
  //   grant.className = 'cloak-reveal-grant';
  //   grant.textContent = 'Share';
  //   grant.addEventListener('click', () => decideReveal(true));

  //   actions.append(deny, grant);

  //   const note = document.createElement('p');
  //   note.className = 'cloak-reveal-note';
  //   note.textContent = 'Cloak sends your answer to the AI automatically — nothing is shared until you choose.';

  //   card.append(title, body, actions, note);
  //   overlay.append(card);
  //   (document.body || document.documentElement).append(overlay);
  //   // Start focus on "Don't share" so an accidental Enter never releases PII.
  //   deny.focus();
  // }

  // function removeRevealDialog() {
  //   document.querySelectorAll('.cloak-reveal').forEach((node) => node.remove());
  // }

  // // Record consent (Share un-masks exactly this value), close the dialog,
  // // then tell the AI via a composer follow-up so history and session state
  // // stay exactly as the site expects.
  // function decideReveal(granted) {
  //   const item = revealActive;
  //   removeRevealDialog();
  //   revealActive = null;
  //   if (!item) return;
  //   const category = item.token.slice(1, item.token.indexOf('_'));
  //   const label = CATEGORY_LABELS[category] || 'information';
  //   window.postMessage({ type: 'CLOAK_CONSENT', token: item.token, granted }, location.origin);
  //   const message = granted
  //     ? `The user has approved sharing their ${label} for this request: ${item.original}. It is no longer a placeholder — please continue the original task using this real value.`
  //     : `The user declined to share their ${label}. Do not ask for it again. Continue the original task using the placeholder as-is, and tell the user what you were able to do without it.`;
  //   sendFollowUp(message);
  //   // Show any request that queued up behind this one.
  //   setTimeout(showNextReveal, 400);
  // }

  // // Type the follow-up through the page's OWN send path (Quill keydown →
  // // app submit) so session bookkeeping stays correct; a Send-button click
  // // covers builds where Enter is not the submit key.
  // function sendFollowUp(text) {
  //   // CLOAK_CONSENT travels by postMessage — give the interceptor a tick
  //   // to apply it before this text is rewritten on the way out.
  //   setTimeout(() => {
  //     try {
  //       const composer = currentComposer?.isConnected ? currentComposer : findComposer();
  //       if (!composer) return;
  //       composer.focus();
  //       if (composer.isContentEditable) {
  //         document.execCommand('selectAll', false, null);
  //         if (!document.execCommand('insertText', false, text)) composer.textContent = text;
  //       } else {
  //         composer.value = text;
  //         composer.dispatchEvent(new Event('input', { bubbles: true }));
  //       }
  //       // Enter keydown/keypress/keyup trio — keyCode is deprecated but
  //       // still what older Quill hotkey tables read.
  //       const press = (type) => composer.dispatchEvent(new KeyboardEvent(type, {
  //         key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
  //       }));
  //       press('keydown');
  //       press('keypress');
  //       press('keyup');
  //       // Fallback: click the site's own Send button if the draft remains.
  //       setTimeout(() => {
  //         if (!readComposerText(composer).trim()) return; // Enter worked
  //         const send = [...document.querySelectorAll('button, [role="button"]')].find((b) =>
  //           /^send\b/i.test((b.getAttribute('aria-label') || '').trim())
  //         );
  //         send?.click();
  //       }, 700);
  //     } catch {
  //       // Never break the page over a failed auto-send.
  //     }
  //   }, 150);
  // }

  // Composers are either contenteditable divs (innerText) or <textarea>s.
  function readComposerText(element) {
    return element.isContentEditable ? element.innerText : element.value || '';
  }

  // Badge glued to the composer's bottom-right (viewport-clamped); banner
  // centred above the composer.
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

  // Every keystroke: light the badge on PII-looking drafts, flash the
  // banner when the user is clearly asking for an image.
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
      badge.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"></rect><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"></path></svg>';
    }
    if (!badge.isConnected) (document.body || document.documentElement).append(badge);
  }

  // Find the site's chat composer: per-provider selector order, first
  // visible candidate wins.
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

  // Re-run discovery — SPA pages re-render constantly, so this is called
  // (debounced) on every mutation burst.
  function refreshComposer() {
    refreshQueued = false;
    const found = findComposer();
    if (found === currentComposer) {
      // Same composer: keep the badge attached and positioned.
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

  // MutationObserver fires far faster than frames — coalesce per animation frame.
  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(refreshComposer);
  }

  // ---- interceptor → storage bridge ---------------------------------------
  // Vault/stats/bypass messages from the MAIN world, origin + source checked;
  // once the extension context dies we ignore messages entirely (masking
  // keeps running — only this storage bridge goes dormant).
  window.addEventListener('message', (event) => {
    if (!contextValid) return;
    if (event.source !== window || !event.data || event.origin !== location.origin) return;
    if (event.data.type === 'CLOAK_MASKED_DATA' && Array.isArray(event.data.entries)) {
      try {
        chrome.storage.local.get({ vault: {} }, (result) => {
          if (!contextValid || chrome.runtime.lastError) return;
          const vault = { ...(result.vault || {}) };
          for (const entry of event.data.entries) {
            // Strict shape checks so a hostile page cannot flood extension storage.
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
    }
    // v2 (reveal consent): CLOAK_REVEAL_REQUEST → enqueueReveal(...) re-attaches
    // here when the scanner ships back with the consent workflow.
  });

  // One-time cleanup so vaults polluted by older versions collapse now.
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

  // Initial read; publish once so the interceptor never guesses.
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
    // Empty vault = "Clear vault" pressed — wipe the interceptor's memory too.
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
