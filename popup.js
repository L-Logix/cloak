// ---------------------------------------------------------------------------
// Cloak — popup controller (popup.js)
//
// Loads the persisted state (enabled / settings / vault / stats) from
// chrome.storage.local, renders every page of the popup from that single
// `state` object, and writes changes straight back. Live updates arrive via
// chrome.storage.onChanged, so the popup never goes stale while it is open.
//
// The "Try it" page additionally uses window.CloakPreview (exposed by
// intercept.bundle.js inside extension pages) to run the real masking engine
// locally — the exact code the chat-page hook uses, with zero side effects.
// ---------------------------------------------------------------------------

// Defaults mirrored in content.js and intercept.js. Merging them over stored
// values means new settings added in later versions appear automatically.
const DEFAULT_SETTINGS = {
  names: true,
  emails: true,
  phones: true,
  addresses: true,
  restoreResponses: true,
  showBadge: true,
  customTerms: []
};
// Sites the content script and interceptor are injected into. The popup uses
// this list to decide whether the current tab is being protected.
const SUPPORTED_SITES = [
  { host: 'chatgpt.com', label: 'ChatGPT' },
  { host: 'gemini.google.com', label: 'Gemini' },
  { host: 'claude.ai', label: 'Claude' }
];

// One lookup of every element the popup touches, collected once at startup so
// no handler ever does repeated getElementById work.
const ui = {
  masterToggle: document.getElementById('master-toggle'),
  powerLabel: document.getElementById('power-label'),
  protectionDetail: document.getElementById('protection-detail'),
  siteStatus: document.getElementById('site-status'),
  statusLabel: document.getElementById('status-label'),
  statusCaption: document.getElementById('status-caption'),
  siteMark: document.getElementById('site-mark'),
  valuesMasked: document.getElementById('values-masked'),
  requestsChecked: document.getElementById('requests-checked'),
  vaultCount: document.getElementById('vault-count'),
  vaultSearch: document.getElementById('vault-search'),
  vaultList: document.getElementById('vault-list'),
  clearVault: document.getElementById('clear-vault'),
  exportVault: document.getElementById('export-vault'),
  vaultMessage: document.getElementById('vault-message'),
  coverageTotal: document.getElementById('coverage-total'),
  customTermForm: document.getElementById('custom-term-form'),
  customTermInput: document.getElementById('custom-term-input'),
  customTermList: document.getElementById('custom-term-list'),
  termsTotal: document.getElementById('terms-total'),
  termFeedback: document.getElementById('term-feedback'),
  resetActivity: document.getElementById('reset-activity'),
  tryInput: document.getElementById('try-input'),
  tryOutput: document.getElementById('try-output'),
  tryChips: document.getElementById('try-chips'),
  tryCount: document.getElementById('try-count'),
  tryExample: document.getElementById('try-example'),
  tryClear: document.getElementById('try-clear'),
  // Collections: every category switch, every page, every nav button.
  settings: [...document.querySelectorAll('[data-setting]')],
  pages: [...document.querySelectorAll('[data-page-view]')],
  navigation: [...document.querySelectorAll('[data-page-target]')]
};

// Single source of truth for rendering. Everything the UI shows is derived
// from this object; every mutation is followed by render() and, if it should
// survive a popup close, save().
let state = {
  enabled: true,
  settings: { ...DEFAULT_SETTINGS },
  vault: {},
  vaultQuery: '',
  revealedTokens: new Set(), // reveal is intentionally NOT persisted
  stats: { requestsChecked: 0, valuesMasked: 0 },
  site: null
};
let messageTimeout; // timer for the transient vault feedback line

// ---- page navigation -------------------------------------------------------

// Show one page-view and hide the rest, syncing the nav's active styling.
function showPage(pageName) {
  // Bail if the page is already visible (avoids re-animating on double click).
  if (ui.pages.find((page) => page.dataset.pageView === pageName)?.hidden === false) return;
  for (const page of ui.pages) {
    page.hidden = page.dataset.pageView !== pageName;
  }
  for (const button of ui.navigation) {
    const active = button.dataset.pageTarget === pageName;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  // Small entrance animation, skipped for users who asked for reduced motion.
  const targetPage = ui.pages.find((page) => page.dataset.pageView === pageName);
  if (targetPage && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    targetPage.animate(
      [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' }
    );
  }
}

// ---- odometer (animated counters) -----------------------------------------

// Render a number as a stack of digit reels and slide each reel to its digit.
// The element's dataset.layout remembers the digit count so a re-render with
// the same width only slides reels instead of rebuilding the DOM.
function renderOdometer(element, value) {
  const number = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const formatted = new Intl.NumberFormat('en-US').format(number);
  element.setAttribute('aria-label', formatted);
  const layout = formatted.replace(/\d/g, '0');
  // Same shape (e.g. "000" → "004"): just move the existing reels.
  if (element.dataset.layout === layout) {
    const reels = [...element.querySelectorAll('.odometer-reel')];
    let index = 0;
    for (const character of formatted) {
      if (!/\d/.test(character)) continue;
      reels[index++].style.transform = `translateY(-${character}em)`;
    }
    return;
  }

  // Different shape (gained a digit, or a comma appeared): rebuild.
  element.replaceChildren();
  element.dataset.layout = layout;
  for (const character of formatted) {
    // Separators (commas) render as static spans, not reels.
    if (!/\d/.test(character)) {
      const separator = document.createElement('span');
      separator.className = 'odometer-separator';
      separator.textContent = character;
      element.append(separator);
      continue;
    }
    // Each digit is a window over a 0–9 reel; sliding the reel shows a digit.
    const windowElement = document.createElement('span');
    windowElement.className = 'odometer-window';
    windowElement.setAttribute('aria-hidden', 'true');
    const reel = document.createElement('span');
    reel.className = 'odometer-reel';
    for (let digit = 0; digit <= 9; digit += 1) {
      const cell = document.createElement('span');
      cell.textContent = String(digit);
      reel.append(cell);
    }
    windowElement.append(reel);
    element.append(windowElement);
  }
  // Wait one frame so the transition animates from 0 to the real digit.
  requestAnimationFrame(() => {
    const reels = [...element.querySelectorAll('.odometer-reel')];
    let index = 0;
    for (const character of formatted) {
      if (!/\d/.test(character)) continue;
      reels[index++].style.transform = `translateY(-${character}em)`;
    }
  });
}

// ---- site detection --------------------------------------------------------

// Is this tab URL one of the three supported chat sites? Subdomains count.
function supportedSite(url) {
  try {
    const hostname = new URL(url).hostname;
    return SUPPORTED_SITES.find(({ host }) => hostname === host || hostname.endsWith(`.${host}`)) || null;
  } catch {
    return null; // unparseable URL → treat as unsupported
  }
}

// ---- main render -----------------------------------------------------------

// Rebuild every dynamic part of the popup from `state`. Called after any state
// change; the DOM work is small enough that batching is unnecessary.
function render() {
  // Protection drives the accent colour: green on a supported site, red when
  // paused, indigo when idle on an unsupported site.
  const protectionState = !state.enabled ? 'off' : state.site ? 'on' : 'idle';
  const stateChanged = state.protectionState !== undefined && state.protectionState !== protectionState;
  state.protectionState = protectionState;
  document.body.dataset.protectionState = protectionState;
  // Replay the ring animation only when the state actually flipped.
  if (stateChanged && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    ui.masterToggle.classList.remove('state-change');
    void ui.masterToggle.offsetWidth; // force reflow so the animation restarts
    ui.masterToggle.classList.add('state-change');
  }

  // Master toggle copy + ARIA state.
  ui.masterToggle.setAttribute('aria-checked', String(state.enabled));
  ui.masterToggle.dataset.enabled = String(state.enabled);
  ui.powerLabel.textContent = state.enabled ? 'Cloak protection on' : 'Cloak protection paused';
  ui.masterToggle.setAttribute('aria-label', state.enabled ? 'Turn Cloak protection off' : 'Turn Cloak protection on');
  ui.protectionDetail.textContent = state.enabled
    ? 'Sensitive details are checked on this device.'
    : 'Paused. Prompts will pass through unmasked.';

  // Site status card: three states, each with its own two-line message.
  const active = protectionState === 'on';
  ui.siteStatus.dataset.active = String(active);
  // Two-letter mark per provider (GPT / G / C), generic "AI" otherwise.
  ui.siteMark.textContent = state.site?.label === 'ChatGPT' ? 'GPT' : state.site?.label === 'Gemini' ? 'G' : state.site?.label === 'Claude' ? 'C' : 'AI';
  if (!state.enabled) {
    ui.statusLabel.textContent = 'Protection off';
    ui.statusCaption.textContent = 'Prompts pass through unmasked';
  } else if (!state.site) {
    ui.statusLabel.textContent = 'Idle';
    ui.statusCaption.textContent = 'Unsupported site';
  } else {
    ui.statusLabel.textContent = `Protecting ${state.site.label}`;
    ui.statusCaption.textContent = 'Protection is on';
  }

  // ---- vault ----
  const entries = Object.entries(state.vault || {});
  // Sanitise custom terms on every render: strings only, trimmed, capped at
  // 100 so a corrupted storage value can never freeze the popup.
  state.settings.customTerms = Array.isArray(state.settings.customTerms)
    ? state.settings.customTerms.filter((term) => typeof term === 'string' && term.trim()).slice(0, 100)
    : [];
  const query = state.vaultQuery.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter(([token, original]) =>
    !query || token.toLocaleLowerCase().includes(query) || String(original).toLocaleLowerCase().includes(query)
  );

  // Coverage chip reflects how many categories are switched on.
  const categories = ['names', 'emails', 'phones', 'addresses'];
  ui.coverageTotal.textContent = `${categories.filter((category) => state.settings[category] !== false).length} active`;

  // Header count, destructive/export buttons gated on emptiness.
  ui.vaultCount.textContent = String(entries.length);
  ui.clearVault.disabled = entries.length === 0;
  ui.exportVault.disabled = entries.length === 0;
  ui.vaultList.replaceChildren();
  renderOdometer(ui.valuesMasked, state.stats.valuesMasked);
  renderOdometer(ui.requestsChecked, state.stats.requestsChecked);

  // Empty states: one message for "nothing yet", another for "no search hit".
  if (entries.length === 0 || visibleEntries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-vault';
    empty.textContent = entries.length === 0
      ? 'Nothing masked yet. Your tokens will appear here.'
      : 'No vault entries match that search.';
    ui.vaultList.append(empty);
  } else {
    // One row per token: [TOKEN] → value, masked until revealed.
    for (const [token, original] of visibleEntries) {
      const row = document.createElement('div');
      row.className = 'vault-row';
      const tokenLabel = document.createElement('code');
      tokenLabel.className = 'vault-token';
      tokenLabel.textContent = token;
      const arrow = document.createElement('span');
      arrow.className = 'vault-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '\u2192';
      const value = document.createElement('span');
      value.className = 'vault-value';
      const revealed = state.revealedTokens.has(token);
      // Bullets by default: a shoulder-surfer should learn nothing from a
      // screen-sharing session with the popup open.
      value.textContent = revealed ? String(original) : '••••••••';
      value.classList.toggle('is-hidden', !revealed);
      const revealButton = document.createElement('button');
      revealButton.className = 'vault-reveal';
      revealButton.type = 'button';
      revealButton.dataset.revealToken = token;
      revealButton.setAttribute('aria-pressed', String(revealed));
      revealButton.textContent = revealed ? 'Hide' : 'Reveal';
      row.append(tokenLabel, arrow, value, revealButton);
      ui.vaultList.append(row);
    }
  }

  // Category switches mirror the stored settings (checked = detection on).
  for (const input of ui.settings) {
    input.checked = state.settings[input.dataset.setting] !== false;
  }
  renderCustomTerms();
  // Keep the live preview honest: coverage edits re-mask its text instantly.
  schedulePreview();
}

// ---- custom terms page -----------------------------------------------------

// Render the personal dictionary list plus its "N saved" counter.
function renderCustomTerms() {
  const terms = state.settings.customTerms;
  ui.termsTotal.textContent = `${terms.length} saved`;
  ui.customTermList.replaceChildren();
  if (terms.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'custom-terms-empty';
    empty.textContent = 'No custom terms yet.';
    ui.customTermList.append(empty);
    return;
  }
  for (const term of terms) {
    const row = document.createElement('li');
    row.className = 'custom-term-row';
    const label = document.createElement('span');
    label.textContent = term;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'term-remove';
    remove.dataset.removeTerm = term;
    remove.setAttribute('aria-label', `Remove ${term}`);
    remove.textContent = 'Remove';
    row.append(label, remove);
    ui.customTermList.append(row);
  }
}

// ---- "Try it" live preview -------------------------------------------------

// A fresh masker per run would re-run the NLP over the whole text on every
// keystroke; reusing one and clearing it is cheaper and behaves identically
// for the preview's single-string use case.
const previewMasker = window.CloakPreview?.createMasker ? window.CloakPreview.createMasker() : null;
let previewTimer; // debounce handle for typing bursts

// Human labels for the token categories the engine reports.
const CATEGORY_LABELS = {
  PERSON: 'Names',
  ADDRESS: 'Addresses',
  EMAIL: 'Emails',
  PHONE: 'Phones',
  CUSTOM: 'Terms'
};

// Mask the current textarea content locally and repaint the output panel.
function renderPreview() {
  if (!previewMasker) return;
  const text = ui.tryInput.value;

  // Empty input: friendly placeholder, no chips.
  if (!text.trim()) {
    ui.tryOutput.textContent = 'Type or paste above to preview masking.';
    ui.tryOutput.classList.remove('has-output');
    ui.tryChips.replaceChildren();
    ui.tryCount.textContent = '0 masked';
    return;
  }

  // Reconfigure from the live settings so Coverage toggles apply here too.
  // enabled is forced on: the preview is a sandbox, not a reflection of the
  // master switch (it never touches real traffic either way).
  previewMasker.clear();
  previewMasker.configure({ enabled: true, settings: state.settings });

  const masked = previewMasker.maskText(text);
  const entries = previewMasker.takePendingEntries();

  ui.tryOutput.textContent = masked;
  ui.tryOutput.classList.add('has-output');
  ui.tryCount.textContent = `${entries.length} masked`;

  // Chips: one per category that fired, sized by how many values it caught.
  const counts = {};
  for (const { token } of entries) {
    const category = token.slice(1).split('_')[0]; // "[PERSON_1_…]" → PERSON
    counts[category] = (counts[category] || 0) + 1;
  }
  ui.tryChips.replaceChildren();
  for (const [category, count] of Object.entries(counts)) {
    const chip = document.createElement('span');
    chip.className = 'try-chip';
    chip.dataset.category = category;
    chip.textContent = `${CATEGORY_LABELS[category] || category} ×${count}`;
    ui.tryChips.append(chip);
  }

  // Round-trip proof: restoring the masked text must reproduce the input.
  const restoreCheck = document.createElement('span');
  const restored = previewMasker.restoreText(masked);
  restoreCheck.className = 'try-chip try-chip-restore';
  restoreCheck.textContent = restored === text
    ? 'Restore check passed'
    : 'Restore check differs';
  restoreCheck.dataset.ok = String(restored === text);
  ui.tryChips.append(restoreCheck);
}

// Debounced entry point — called from input events and from render().
function schedulePreview() {
  if (!previewMasker) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

// ---- vault export ----------------------------------------------------------

// Download the vault as a pretty-printed JSON file. Runs entirely in the
// popup: a Blob URL is created, clicked, and revoked immediately.
function exportVaultFile() {
  const entries = Object.entries(state.vault || {});
  if (!entries.length) return;
  const payload = {
    extension: 'Cloak',
    exportedAt: new Date().toISOString(),
    note: 'Local backup of masked token → value pairs. Treat as sensitive.',
    vault: Object.fromEntries(entries)
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = payload.exportedAt.slice(0, 10); // YYYY-MM-DD
  anchor.href = url;
  anchor.download = `cloak-vault-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showVaultMessage('Vault exported as JSON.');
}

// ---- event wiring ----------------------------------------------------------

ui.navigation.forEach((button) => {
  button.addEventListener('click', () => showPage(button.dataset.pageTarget));
});

// Vault search re-filters the already-loaded vault (no storage round trip).
ui.vaultSearch.addEventListener('input', () => {
  state.vaultQuery = ui.vaultSearch.value;
  render();
});

// Reveal toggles are handled by delegation: rows are rebuilt on every render,
// so one listener on the list outlives them all.
ui.vaultList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-reveal-token]');
  if (!button) return;
  const token = button.dataset.revealToken;
  if (state.revealedTokens.has(token)) state.revealedTokens.delete(token);
  else state.revealedTokens.add(token);
  render();
});

// Adding a custom term: validate length and uniqueness before persisting.
ui.customTermForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const term = ui.customTermInput.value.trim();
  if (term.length < 2) {
    ui.termFeedback.textContent = 'Enter at least two characters.';
    return;
  }
  if (state.settings.customTerms.some((saved) => saved.toLocaleLowerCase() === term.toLocaleLowerCase())) {
    ui.termFeedback.textContent = 'That term is already saved.';
    return;
  }
  if (state.settings.customTerms.length >= 100) {
    ui.termFeedback.textContent = 'Custom term limit reached.';
    return;
  }
  state.settings.customTerms.push(term);
  ui.customTermInput.value = '';
  ui.termFeedback.textContent = 'Term saved on this device.';
  render();
  save({ settings: state.settings });
});

// Removing a term (delegated — rows are rebuilt on every render).
ui.customTermList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-term]');
  if (!button) return;
  state.settings.customTerms = state.settings.customTerms.filter((term) => term !== button.dataset.removeTerm);
  ui.termFeedback.textContent = 'Term removed.';
  render();
  save({ settings: state.settings });
});

// Reset the two dashboard counters (vault is untouched — that is separate).
ui.resetActivity.addEventListener('click', () => {
  state.stats = { requestsChecked: 0, valuesMasked: 0 };
  render();
  save({ stats: state.stats });
});

// ---- storage helpers -------------------------------------------------------

// Persist a partial state patch. Guarded so the popup still renders when it
// is opened outside Chrome (the static preview mode used during design).
function save(changes) {
  if (!globalThis.chrome?.storage?.local) return;
  chrome.storage.local.set(changes, () => {
    if (chrome.runtime.lastError) console.warn('PromptMask could not save settings:', chrome.runtime.lastError.message);
  });
}

// Transient confirmation line in the vault footer; self-clears after 2.4s.
function showVaultMessage(message) {
  clearTimeout(messageTimeout);
  ui.vaultMessage.textContent = message;
  messageTimeout = setTimeout(() => {
    ui.vaultMessage.textContent = '';
  }, 2400);
}

// Master switch: flip, repaint, persist. The content script picks the change
// up via storage.onChanged and republishes CLOAK_CONFIG to the page.
ui.masterToggle.addEventListener('click', () => {
  state.enabled = !state.enabled;
  render();
  save({ enabled: state.enabled });
});

// Every category/preference checkbox writes the same settings object.
ui.settings.forEach((input) => {
  input.addEventListener('change', () => {
    state.settings[input.dataset.setting] = input.checked;
    render();
    save({ settings: state.settings });
  });
});

// Clearing the vault also wipes the interceptor's in-memory token map (the
// content script notices the empty vault and posts CLOAK_CLEAR_MEMORY).
ui.clearVault.addEventListener('click', () => {
  state.vault = {};
  state.revealedTokens.clear();
  render();
  showVaultMessage('Vault cleared from this device.');
  save({ vault: {} });
});

// Export button → JSON download (see exportVaultFile above).
ui.exportVault.addEventListener('click', exportVaultFile);

// ---- "Try it" page events --------------------------------------------------

// Example prompt with one value per category, so a single click demos the
// whole engine (name + email + phone + address all light up).
ui.tryExample.addEventListener('click', () => {
  ui.tryInput.value = 'Hi, my name is Bob Carter. You can reach me at bob.carter@example.com or 919-123-4567, or visit 742 Evergreen Terrace.';
  renderPreview();
});

ui.tryClear.addEventListener('click', () => {
  ui.tryInput.value = '';
  renderPreview();
  ui.tryInput.focus();
});

// Typing re-masks after a short pause (see schedulePreview for the delay).
ui.tryInput.addEventListener('input', schedulePreview);

// ---- startup ---------------------------------------------------------------

function initialize() {
  // Outside Chrome (or without extension APIs) fall back to a static preview
  // so the popup can still be opened as a plain HTML file while designing.
  if (!globalThis.chrome?.storage?.local || !globalThis.chrome?.tabs) {
    render();
    ui.statusLabel.textContent = 'Preview mode';
    ui.statusCaption.textContent = 'Open this popup in Chrome';
    return;
  }

  // Initial read of all persisted keys in one call.
  chrome.storage.local.get(['enabled', 'settings', 'vault', 'stats'], (result) => {
    if (chrome.runtime.lastError) {
      ui.statusLabel.textContent = 'Unable to read vault';
      ui.statusCaption.textContent = 'Check extension storage access';
      return;
    }
    state.enabled = result.enabled !== false;
    state.settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
    state.vault = result.vault || {};
    state.stats = result.stats || { requestsChecked: 0, valuesMasked: 0 };
    render();
  });

  // Which site is the user on right now? Drives the status card and accent.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    state.site = supportedSite(tabs[0]?.url);
    render();
  });

  // Stay live: any storage write (from any tab) repaints the popup at once.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.enabled) state.enabled = changes.enabled.newValue !== false;
    if (changes.settings) state.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    if (changes.vault) state.vault = changes.vault.newValue || {};
    if (changes.stats) state.stats = changes.stats.newValue || { requestsChecked: 0, valuesMasked: 0 };
    render();
  });
}

initialize();
