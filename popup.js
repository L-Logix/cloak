const DEFAULT_SETTINGS = {
  names: true,
  emails: true,
  phones: true,
  addresses: true,
  restoreResponses: true,
  showBadge: true
};
const SUPPORTED_SITES = [
  { host: 'chatgpt.com', label: 'ChatGPT' },
  { host: 'gemini.google.com', label: 'Gemini' },
  { host: 'claude.ai', label: 'Claude' }
];

const ui = {
  masterToggle: document.getElementById('master-toggle'),
  powerLabel: document.getElementById('power-label'),
  powerState: document.getElementById('power-state'),
  protectionDetail: document.getElementById('protection-detail'),
  siteStatus: document.getElementById('site-status'),
  statusLabel: document.getElementById('status-label'),
  statusCaption: document.getElementById('status-caption'),
  siteMark: document.getElementById('site-mark'),
  valuesMasked: document.getElementById('values-masked'),
  requestsChecked: document.getElementById('requests-checked'),
  vaultCount: document.getElementById('vault-count'),
  vaultList: document.getElementById('vault-list'),
  clearVault: document.getElementById('clear-vault'),
  vaultMessage: document.getElementById('vault-message'),
  coverageTotal: document.getElementById('coverage-total'),
  settings: [...document.querySelectorAll('[data-setting]')],
  pages: [...document.querySelectorAll('[data-page-view]')],
  navigation: [...document.querySelectorAll('[data-page-target]')]
};

let state = {
  enabled: true,
  settings: { ...DEFAULT_SETTINGS },
  vault: {},
  stats: { requestsChecked: 0, valuesMasked: 0 },
  site: null
};
let messageTimeout;

function showPage(pageName) {
  for (const page of ui.pages) {
    page.hidden = page.dataset.pageView !== pageName;
  }
  for (const button of ui.navigation) {
    const active = button.dataset.pageTarget === pageName;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const targetPage = ui.pages.find((page) => page.dataset.pageView === pageName);
  if (targetPage && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    targetPage.animate(
      [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' }
    );
  }
}

function renderOdometer(element, value) {
  const number = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const formatted = new Intl.NumberFormat('en-US').format(number);
  element.setAttribute('aria-label', formatted);
  const layout = formatted.replace(/\d/g, '0');
  if (element.dataset.layout === layout) {
    const reels = [...element.querySelectorAll('.odometer-reel')];
    let index = 0;
    for (const character of formatted) {
      if (!/\d/.test(character)) continue;
      reels[index++].style.transform = `translateY(-${character}em)`;
    }
    return;
  }

  element.replaceChildren();
  element.dataset.layout = layout;
  for (const character of formatted) {
    if (!/\d/.test(character)) {
      const separator = document.createElement('span');
      separator.className = 'odometer-separator';
      separator.textContent = character;
      element.append(separator);
      continue;
    }
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
  requestAnimationFrame(() => {
    const reels = [...element.querySelectorAll('.odometer-reel')];
    let index = 0;
    for (const character of formatted) {
      if (!/\d/.test(character)) continue;
      reels[index++].style.transform = `translateY(-${character}em)`;
    }
  });
}

function supportedSite(url) {
  try {
    const hostname = new URL(url).hostname;
    return SUPPORTED_SITES.find(({ host }) => hostname === host || hostname.endsWith(`.${host}`)) || null;
  } catch {
    return null;
  }
}

function render() {
  ui.masterToggle.setAttribute('aria-checked', String(state.enabled));
  ui.masterToggle.dataset.enabled = String(state.enabled);
  ui.powerLabel.textContent = state.enabled ? 'Cloak protection on' : 'Cloak protection paused';
  ui.powerState.textContent = state.enabled ? 'ON' : 'OFF';
  ui.masterToggle.setAttribute('aria-label', state.enabled ? 'Turn Cloak protection off' : 'Turn Cloak protection on');
  ui.protectionDetail.textContent = state.enabled
    ? 'Sensitive details are checked on this device.'
    : 'Paused. Prompts will pass through unmasked.';

  const active = Boolean(state.site && state.enabled);
  ui.siteStatus.dataset.active = String(active);
  ui.siteMark.textContent = state.site?.label === 'ChatGPT' ? 'GPT' : state.site?.label === 'Gemini' ? 'G' : state.site?.label === 'Claude' ? 'C' : 'AI';
  if (!state.site) {
    ui.statusLabel.textContent = 'Idle';
    ui.statusCaption.textContent = 'Unsupported site';
  } else if (state.enabled) {
    ui.statusLabel.textContent = `Protecting ${state.site.label}`;
    ui.statusCaption.textContent = 'Protection is on';
  } else {
    ui.statusLabel.textContent = `${state.site.label} is unprotected`;
    ui.statusCaption.textContent = 'Protection is off';
  }

  const entries = Object.entries(state.vault || {});
  const categories = ['names', 'emails', 'phones', 'addresses'];
  ui.coverageTotal.textContent = `${categories.filter((category) => state.settings[category] !== false).length} active`;
  ui.vaultCount.textContent = String(entries.length);
  ui.clearVault.disabled = entries.length === 0;
  ui.vaultList.replaceChildren();
  renderOdometer(ui.valuesMasked, state.stats.valuesMasked);
  renderOdometer(ui.requestsChecked, state.stats.requestsChecked);

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-vault';
    empty.textContent = 'Nothing masked yet. Your tokens will appear here.';
    ui.vaultList.append(empty);
  } else {
    for (const [token, original] of entries) {
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
      value.textContent = String(original);
      row.append(tokenLabel, arrow, value);
      ui.vaultList.append(row);
    }
  }

  for (const input of ui.settings) {
    input.checked = state.settings[input.dataset.setting] !== false;
  }
}

ui.navigation.forEach((button) => {
  button.addEventListener('click', () => showPage(button.dataset.pageTarget));
});

function save(changes) {
  if (!globalThis.chrome?.storage?.local) return;
  chrome.storage.local.set(changes, () => {
    if (chrome.runtime.lastError) console.warn('PromptMask could not save settings:', chrome.runtime.lastError.message);
  });
}

function showVaultMessage(message) {
  clearTimeout(messageTimeout);
  ui.vaultMessage.textContent = message;
  messageTimeout = setTimeout(() => {
    ui.vaultMessage.textContent = '';
  }, 2400);
}

ui.masterToggle.addEventListener('click', () => {
  state.enabled = !state.enabled;
  render();
  save({ enabled: state.enabled });
});

ui.settings.forEach((input) => {
  input.addEventListener('change', () => {
    state.settings[input.dataset.setting] = input.checked;
    render();
    save({ settings: state.settings });
  });
});

ui.clearVault.addEventListener('click', () => {
  state.vault = {};
  render();
  showVaultMessage('Vault cleared from this device.');
  save({ vault: {} });
});

function initialize() {
  if (!globalThis.chrome?.storage?.local || !globalThis.chrome?.tabs) {
    ui.statusLabel.textContent = 'Preview mode';
    ui.statusCaption.textContent = 'Open this popup in Chrome';
    return;
  }

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

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    state.site = supportedSite(tabs[0]?.url);
    render();
  });

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
