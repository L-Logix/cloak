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
  function recordRequestStats(message) {
    const requestsChecked = Number.isSafeInteger(message.requestsChecked) ? Math.max(0, message.requestsChecked) : 0;
    const valuesMasked = Number.isSafeInteger(message.valuesMasked) ? Math.max(0, message.valuesMasked) : 0;
    if (!requestsChecked) return;

    statsWriteQueue = statsWriteQueue.then(() => new Promise((resolve) => {
      chrome.storage.local.get({ stats: { requestsChecked: 0, valuesMasked: 0 } }, (result) => {
        if (chrome.runtime.lastError) {
          resolve();
          return;
        }
        const stats = result.stats || { requestsChecked: 0, valuesMasked: 0 };
        chrome.storage.local.set({
          stats: {
            requestsChecked: (stats.requestsChecked || 0) + requestsChecked,
            valuesMasked: (stats.valuesMasked || 0) + valuesMasked
          }
        }, resolve);
      });
    })).catch((error) => console.warn('[Cloak] Could not update local activity totals:', error));
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
  // world. Origin + source checks stop any other frame from injecting data.
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.origin !== location.origin) return;
    if (event.data.type === 'CLOAK_MASKED_DATA' && Array.isArray(event.data.entries)) {
      chrome.storage.local.get({ vault: {} }, (result) => {
        if (chrome.runtime.lastError) return;
        const vault = { ...(result.vault || {}) };
        for (const entry of event.data.entries) {
          // Strict shape checks: only well-formed tokens and short strings are
          // persisted, so a hostile page cannot flood extension storage.
          if (!entry || !/^\[(PERSON|ADDRESS|EMAIL|PHONE|CUSTOM)_\d+_[a-z0-9-]+\]$/i.test(entry.token)) continue;
          if (typeof entry.original !== 'string' || entry.original.length > 500) continue;
          vault[entry.token] = entry.original;
        }
        // Dedupe on every write so old duplicate vaults keep shrinking.
        chrome.storage.local.set({ vault: dedupeVault(vault) });
      });
    } else if (event.data.type === 'CLOAK_MEDIA_BYPASS') {
      showMediaBanner();
    } else if (event.data.type === 'CLOAK_REQUEST_STATS') {
      recordRequestStats(event.data);
    }
  });

  // One-time cleanup so vaults already polluted by older versions collapse
  // without waiting for the next masked send.
  chrome.storage.local.get({ vault: {} }, (result) => {
    if (chrome.runtime.lastError) return;
    const original = result.vault || {};
    const cleaned = dedupeVault(original);
    if (Object.keys(cleaned).length !== Object.keys(original).length) {
      chrome.storage.local.set({ vault: cleaned });
    }
  });

  // Initial configuration read; publish once so the interceptor is never
  // left guessing before the first request.
  chrome.storage.local.get(['enabled', 'settings'], (result) => {
    if (!chrome.runtime.lastError) {
      config.enabled = result.enabled !== false;
      config.settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
    }
    publishConfig();
    queueRefresh();
  });

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
