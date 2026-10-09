(function () {
  // 1. Save reference to native fetch
  const originalFetch = window.fetch;

  // Simple Regex patterns for demonstration
  const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_REGEX = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;

  // Helper to mask PII in text strings and notify content.js
  function maskPII(text) {
    let maskedText = text;
    let tokenIndex = 1;

    // Mask Emails
    maskedText = maskedText.replace(EMAIL_REGEX, (match) => {
      const token = `[EMAIL_${tokenIndex++}]`;
      window.postMessage({
        type: 'CLOAK_MASKED_DATA',
        token: token,
        original: match
      }, '*');
      return token;
    });

    // Mask Phone Numbers
    maskedText = maskedText.replace(PHONE_REGEX, (match) => {
      const token = `[PHONE_${tokenIndex++}]`;
      window.postMessage({
        type: 'CLOAK_MASKED_DATA',
        token: token,
        original: match
      }, '*');
      return token;
    });

    return maskedText;
  }

  // 2. Override window.fetch
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const options = args[1] || {};

    // 3. Target specific AI endpoints (e.g., ChatGPT conversation endpoint)
    if (options.method === 'POST' && options.body && typeof options.body === 'string') {
      try {
        const bodyObj = JSON.parse(options.body);

        // 4 & 5. Inspect and mutate prompt fields
        if (bodyObj.messages && Array.isArray(bodyObj.messages)) {
          bodyObj.messages.forEach((msg) => {
            if (msg.content && msg.content.parts) {
              msg.content.parts = msg.content.parts.map((part) =>
                typeof part === 'string' ? maskPII(part) : part
              );
            }
          });

          // 6. Re-stringify updated payload back into options
          options.body = JSON.stringify(bodyObj);
        }
      } catch (e) {
        // If JSON parsing fails, let the original request proceed normally
      }
    }

    // Call the original native fetch with modified arguments
    return originalFetch.apply(this, args);
  };
})();