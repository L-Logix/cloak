'use strict';
(() => {
  const tabs = [...document.querySelectorAll('[data-medical]')];
  const panel = document.getElementById('medical-panel');
  const image = document.getElementById('medical-image');
  const stages = {
    original: ['01-original.png', 'The original prompt, before sending.', 'Personal identifiers and medical context are visible in ChatGPT’s composer. All patient details in this demonstration are fictional.'],
    payload: ['02-payload.png', 'What the browser actually sends.', 'DevTools shows PERSON, EMAIL, PHONE, and ADDRESS tokens in the outgoing prompt. The medical history remains readable.'],
    response: ['03-response.png', 'What ChatGPT actually returns.', 'The raw response contains the PERSON and EMAIL tokens. The restored name and email are visible in the conversation alongside it.'],
    restored: ['03-response.png', 'The reply you can read.', 'Alex Morgan and alex@example.com appear in ChatGPT’s UI. This focuses the left pane of the same unaltered response screenshot.']
  };
  function select(tab, focus = false) {
    const key = tab.dataset.medical;
    const [file, title, caption] = stages[key];
    tabs.forEach(item => { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; });
    const src = `assets/medical-capture/${file}`;
    image.src = src;
    image.alt = `${title} ${caption}`;
    panel.dataset.focus = key === 'restored' ? 'restored' : 'full';
    panel.setAttribute('aria-labelledby', tab.id);
    document.getElementById('medical-caption-title').textContent = title;
    document.getElementById('medical-caption').textContent = caption;
    for (const id of ['medical-full', 'medical-open']) document.getElementById(id).href = src;
    document.getElementById('medical-full').setAttribute('aria-label', `Open full screenshot: ${title}`);
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const destinations = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (destinations[event.key] !== undefined) { event.preventDefault(); select(tabs[destinations[event.key]], true); }
    });
  });
})();
