(() => {
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
  const mediaIntent = /\b(?:draw|generate|create|make)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|video)\b|\bimage generation\b/i;
  const piiHint = /[A-Z][a-z]+\s+[A-Z][a-z]+|\b(?:principal|professor|doctor|dr\.?|mr\.?|mrs\.?|ms\.?|miss|coach|teacher)\s+[a-z]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{1,6}\s+(?:[a-z0-9]+\s+){1,5}(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|circle|cir\.?|way|parkway|pkwy\.?|terrace|ter\.?|place|pl\.?|trail|trl\.?)\b|\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/i;

  let config = { enabled: true, settings: { ...DEFAULT_SETTINGS } };
  let currentComposer;
  let badge;
  let banner;
  let bannerTimeout;
  let refreshQueued = false;
  let statsWriteQueue = Promise.resolve();

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

  function publishConfig() {
    window.postMessage({
      type: 'CLOAK_CONFIG',
      enabled: config.enabled,
      settings: config.settings
    }, location.origin);
  }

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

  function readComposerText(element) {
    return element.isContentEditable ? element.innerText : element.value || '';
  }

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

  function onComposerInput(event) {
    const text = readComposerText(event.currentTarget);
    if (badge) badge.dataset.active = String(config.enabled && piiHint.test(text));
    if (mediaIntent.test(text)) showMediaBanner();
  }

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

  function findComposer() {
    const host = location.hostname;
    const preferred = host === 'gemini.google.com'
      ? ['rich-textarea [contenteditable="true"]', 'textarea', '[contenteditable="true"]']
      : host.endsWith('claude.ai')
        ? ['[contenteditable="true"].ProseMirror', 'textarea', '[contenteditable="true"]']
        : ['#prompt-textarea', 'textarea', '[contenteditable="true"]'];

    for (const selector of preferred) {
      const candidate = [...document.querySelectorAll(selector)].find((element) => {
        if (element.closest('.cloak-mask-badge, .cloak-media-banner')) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (candidate) return candidate;
    }
    return null;
  }

  function refreshComposer() {
    refreshQueued = false;
    const found = findComposer();
    if (found === currentComposer) {
      createBadge();
      positionElements();
      return;
    }
    currentComposer?.removeEventListener('input', onComposerInput);
    currentComposer = found;
    if (!currentComposer) return;
    createBadge();
    currentComposer.addEventListener('input', onComposerInput);
    onComposerInput({ currentTarget: currentComposer });
    positionElements();
  }

  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(refreshComposer);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.origin !== location.origin) return;
    if (event.data.type === 'CLOAK_MASKED_DATA' && Array.isArray(event.data.entries)) {
      chrome.storage.local.get({ vault: {} }, (result) => {
        if (chrome.runtime.lastError) return;
        const vault = { ...(result.vault || {}) };
        for (const entry of event.data.entries) {
          if (!entry || !/^\[(PERSON|ADDRESS|EMAIL|PHONE|CUSTOM)_\d+_[a-z0-9-]+\]$/i.test(entry.token)) continue;
          if (typeof entry.original !== 'string' || entry.original.length > 500) continue;
          vault[entry.token] = entry.original;
        }
        chrome.storage.local.set({ vault });
      });
    } else if (event.data.type === 'CLOAK_MEDIA_BYPASS') {
      showMediaBanner();
    } else if (event.data.type === 'CLOAK_REQUEST_STATS') {
      recordRequestStats(event.data);
    }
  });

  chrome.storage.local.get(['enabled', 'settings'], (result) => {
    if (!chrome.runtime.lastError) {
      config.enabled = result.enabled !== false;
      config.settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
    }
    publishConfig();
    queueRefresh();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.enabled) config.enabled = changes.enabled.newValue !== false;
    if (changes.settings) config.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    if (changes.vault && Object.keys(changes.vault.newValue || {}).length === 0) {
      window.postMessage({ type: 'CLOAK_CLEAR_MEMORY' }, location.origin);
    }
    publishConfig();
    queueRefresh();
    if (currentComposer) onComposerInput({ currentTarget: currentComposer });
  });

  const observer = new MutationObserver(queueRefresh);
  function startObserver() {
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
      return;
    }
    observer.observe(document.documentElement, { childList: true, subtree: true });
    queueRefresh();
  }

  startObserver();
  window.addEventListener('resize', positionElements, { passive: true });
  window.addEventListener('scroll', positionElements, { passive: true, capture: true });
})();