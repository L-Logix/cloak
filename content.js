function injectInterceptor() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('intercept.js');
  script.type = "text/javascript";
  (document.head || document.documentElement).appendChild(script)
}

injectInterceptor()

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
