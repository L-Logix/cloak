const DEFAULT_SETTINGS = { names: true, emails: true, phones: true };
const SUPPORTED_SITES = [
  { host: 'chatgpt.com', label: 'ChatGPT' },
  { host: 'gemini.google.com', label: 'Gemini' },
  { host: 'claude.ai', label: 'Claude' }
];

const ui = {
  masterToggle: document.getElementById('master-toggle'),
  protectionDetail: document.getElementById('protection-detail'),
  siteStatus: document.getElementById('site-status'),
  statusLabel: document.getElementById('status-label'),
  statusCaption: document.getElementById('status-caption'),
  vaultCount: document.getElementById('vault-count'),
  vaultList: document.getElementById('vault-list'),
  clearVault: document.getElementById('clear-vault'),
  vaultMessage: document.getElementById('vault-message'),
  settings: [...document.querySelectorAll('[data-setting]')]
};

let state = {
  enabled: true,
  settings: { ...DEFAULT_SETTINGS },
  vault: {},
  site: null
};
let messageTimeout;

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
  ui.protectionDetail.textContent = state.enabled
    ? 'Mask sensitive details before they leave your device.'
    : 'Prompts will pass through without masking.';

  const active = Boolean(state.site && state.enabled);
  ui.siteStatus.dataset.active = String(active);
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
  ui.vaultCount.textContent = String(entries.length);
  ui.clearVault.disabled = entries.length === 0;
  ui.vaultList.replaceChildren();

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

  chrome.storage.local.get(['enabled', 'settings', 'vault'], (result) => {
    if (chrome.runtime.lastError) {
      ui.statusLabel.textContent = 'Unable to read vault';
      ui.statusCaption.textContent = 'Check extension storage access';
      return;
    }
    state.enabled = result.enabled !== false;
    state.settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
    state.vault = result.vault || {};
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
    render();
  });
}

initialize();
