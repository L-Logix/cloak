// Phase 1: Inject intercept.js into the main world context
function injectInterceptor() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('intercept.js');
  script.type = "text/javascript";
  (document.head || document.documentElement).appendChild(script);
}

injectInterceptor();

// Phase 2: Listen for masked data from intercept.js and save to Chrome storage
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data.type !== 'CLOAK_MASKED_DATA') return;

  const token = event.data.token;
  const original = event.data.original;

  chrome.storage.local.get(['vault'], (result) => {
    const currentVault = result.vault || {};
    currentVault[token] = original;
    chrome.storage.local.set({ vault: currentVault });
  });
});

// Phase 3: Unmasking helper and DOM Observer
function walkTextNodes(node, vault) {
  if (node.nodeType === Node.TEXT_NODE) {
    let text = node.nodeValue;
    let modified = false;

    for (const [token, original] of Object.entries(vault)) {
      if (text.includes(token)) {
        text = text.replaceAll(token, original);
        modified = true;
      }
    }

    if (modified) {
      node.nodeValue = text;
    }
  } else {
    for (const child of node.childNodes) {
      walkTextNodes(child, vault);
    }
  }
}

const observer = new MutationObserver((mutations) => {
  chrome.storage.local.get(['vault'], (result) => {
    const vault = result.vault || {};
    if (Object.keys(vault).length === 0) return;

    walkTextNodes(document.body, vault);
  });
});

// Start watching the page for incoming text updates
observer.observe(document.body, {
  childList: true,
  subtree: true
});