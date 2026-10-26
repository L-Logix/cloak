'use strict';
(() => {
  const $ = (selector) => document.querySelector(selector);
  const prompt = $('#prompt');
  const custom = $('#custom-term');
  const result = $('#result');
  const rows = $('#vault-rows');
  const tabs = [...document.querySelectorAll('[data-view]')];
  const presets = [...document.querySelectorAll('[data-example]')];
  const coverage = [...document.querySelectorAll('.coverage input')];
  const examples = {
    hospital: "Patient name: Alex Morgan\nEmail: alex@example.com\nPhone: 919-555-0142\nAddress: 123 Main Street, Raleigh, NC 27601\n\nMedical history: 52-year-old with type 2 diabetes and hypertension. Takes metformin and lisinopril. Reports fatigue; recent HbA1c is 8.2%.\n\nAnalyze this history in three brief bullets: key patterns, missing information, and questions for clinician review. Do not recommend treatment. Begin with the patient name and email exactly as provided.",
    intro: 'My name is Alex Morgan. Help me write a short introduction. You can reach me at alex@example.com or 919-555-0142.',
    contact: 'My name is Jordan Lee. Please draft a contact card with jordan@example.com, 919-555-0178, and 123 Main Street, Raleigh, NC 27601.',
    custom: 'Help me write a project update about Project Firefly. Please ask the team to send feedback to alex@example.com.'
  };
  const explanations = {
    masked: 'These tokens replace the detected details in a supported outgoing request.',
    restored: 'Restoration brings the original details back on your device. This is a local round-trip of the sample, not an AI-generated reply.',
    vault: 'Temporary demo mappings, shown for inspection. The extension’s separate vault hides values until revealed.'
  };
  let view = 'masked';
  let snapshot = { masked: '', restored: '', entries: [] };
  let timer;

  function paint() {
    result.hidden = view === 'vault';
    rows.hidden = view !== 'vault';
    result.replaceChildren();
    rows.replaceChildren();
    $('#view-explanation').textContent = explanations[view];
    if (view === 'vault') {
      if (!snapshot.entries.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-vault';
        empty.textContent = 'No detected values in this sample. Try a fictional email or enable another category.';
        rows.append(empty);
      }
      for (const entry of snapshot.entries) {
        const row = document.createElement('div');
        row.className = 'demo-vault-row';
        const token = document.createElement('code');
        const original = document.createElement('span');
        token.textContent = entry.token;
        original.textContent = entry.original;
        row.append(token, original);
        rows.append(row);
      }
      return;
    }
    const text = snapshot[view];
    if (!text) {
      result.textContent = 'Your preview will appear here. Type above or choose an example.';
      return;
    }
    if (view === 'restored') {
      result.textContent = text;
      return;
    }
    // Only engine-created tokens receive markup; user text is never interpreted as HTML.
    const tokens = new Set(snapshot.entries.map(entry => entry.token));
    const parts = text.split(/(\[(?:PERSON|EMAIL|PHONE|ADDRESS|CUSTOM)_\d+_[a-z0-9-]+\])/g);
    for (const part of parts) {
      if (tokens.has(part)) {
        const mark = document.createElement('mark');
        mark.textContent = part;
        result.append(mark);
      } else result.append(document.createTextNode(part));
    }
  }

  function update() {
    clearTimeout(timer);
    $('#char-count').textContent = `${prompt.value.length.toLocaleString()} / 6,000`;
    if (!window.CloakPreview?.createMasker) {
      $('#masked-count').textContent = 'Engine unavailable';
      $('#round-trip').textContent = 'The preview could not load. Reload the page to try again.';
      result.textContent = 'Project details and installation instructions are still available below.';
      return;
    }
    try {
      // Fresh memory-only instance per edit: no browser storage, network interception, or AI calls.
      const masker = window.CloakPreview.createMasker();
      const settings = Object.fromEntries(coverage.map(input => [input.value, input.checked]));
      settings.customTerms = custom.value.trim() ? [custom.value.trim()] : [];
      masker.configure({ enabled: true, settings });
      const masked = masker.maskText(prompt.value);
      snapshot = { masked, restored: masker.restoreText(masked), entries: masker.takePendingEntries() };
      const count = snapshot.entries.length;
      $('#masked-count').textContent = `${count} ${count === 1 ? 'value' : 'values'} masked`;
      $('#round-trip').textContent = !prompt.value ? 'Ready when you are' : snapshot.restored === prompt.value ? '✓ Round-trip restore verified' : 'Restore differs — review the result';
      paint();
    } catch {
      $('#masked-count').textContent = 'Preview paused';
      $('#round-trip').textContent = 'Unable to process this sample. Try a shorter example.';
      result.textContent = 'This sample could not be processed.';
      rows.replaceChildren();
    }
  }

  function selectView(tab, focus = false) {
    view = tab.dataset.view;
    for (const item of tabs) {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    $('#result-panel').setAttribute('aria-labelledby', tab.id);
    if (focus) tab.focus();
    paint();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectView(tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); selectView(tabs[next], true); }
    });
  });
  presets.forEach(button => button.addEventListener('click', () => {
    prompt.value = examples[button.dataset.example];
    custom.value = button.dataset.example === 'custom' ? 'Project Firefly' : '';
    $('.demo-settings').open = button.dataset.example === 'custom';
    coverage.forEach(input => { input.checked = true; });
    presets.forEach(item => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    selectView(tabs[0]);
    update();
  }));
  prompt.addEventListener('input', () => {
    presets.forEach(button => { button.classList.remove('selected'); button.setAttribute('aria-pressed', 'false'); });
    clearTimeout(timer);
    timer = setTimeout(update, 180);
  });
  custom.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 180); });
  coverage.forEach(input => input.addEventListener('change', update));
  $('#clear').addEventListener('click', () => {
    prompt.value = '';
    custom.value = '';
    presets.forEach(button => { button.classList.remove('selected'); button.setAttribute('aria-pressed', 'false'); });
    update();
    prompt.focus();
  });
  update();
})();
