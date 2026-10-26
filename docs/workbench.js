'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const engine = window.CloakPreview;
  const chunkSize = $('#chunk-size');
  const runStream = $('#run-stream');
  const runChecks = $('#run-checks');
  if (!engine?.restoreStream) {
    $('#stream-status').textContent = 'Reload to load the engineering demo.';
    runStream.disabled = runChecks.disabled = true;
    return;
  }
  const make = settings => {
    const masker = engine.createMasker();
    masker.configure({ enabled: true, settings: settings || {} });
    return masker;
  };
  async function streamSample(size) {
    const masker = make();
    masker.maskText('Email alex@example.com');
    const token = masker.takePendingEntries()[0].token;
    const wire = `Contact ${token}. Thank you!`;
    const bytes = new TextEncoder().encode(wire);
    const chunks = [];
    for (let n = 0; n < bytes.length; n += size) chunks.push(bytes.slice(n, n + size));
    const input = new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    } });
    const restored = await new Response(engine.restoreStream(input, masker)).text();
    return { restored, expected: 'Contact alex@example.com. Thank you!', chunks, token };
  }
  async function showStream() {
    runStream.disabled = true;
    $('#stream-status').textContent = 'Running real stream restoration…';
    try {
      const result = await streamSample(Number(chunkSize.value));
      const nodes = result.chunks.map((chunk, index) => {
        const span = document.createElement('span');
        span.textContent = new TextDecoder().decode(chunk);
        span.title = `Incoming chunk ${index + 1}`;
        return span;
      });
      $('#stream-chunks').replaceChildren(...nodes);
      $('#stream-output').textContent = result.restored;
      $('#stream-status').textContent = result.restored === result.expected
        ? `✓ ${result.chunks.length} chunks. One intact reply.` : 'Result differs from expected output.';
      $('#stream-status').dataset.pass = String(result.restored === result.expected);
    } catch {
      $('#stream-status').textContent = 'Stream test could not complete in this browser.';
      $('#stream-status').dataset.pass = 'false';
    } finally { runStream.disabled = false; }
  }
  chunkSize.addEventListener('input', () => {
    $('#chunk-value').textContent = `${chunkSize.value} ${chunkSize.value === '1' ? 'byte' : 'bytes'}`;
    $('#stream-status').textContent = 'Ready. Run with the selected chunk size.';
    delete $('#stream-status').dataset.pass;
  });
  runStream.addEventListener('click', showStream);
  const checks = [
    ['Five detection categories', () => {
      const m = make({ customTerms: ['Project Firefly'] });
      const result = m.maskText('My name is Alex Morgan. Email alex@example.com or call 919-555-0142. My address is 123 Main Street, Raleigh, NC 27601. Project Firefly.');
      return ['PERSON', 'EMAIL', 'PHONE', 'ADDRESS', 'CUSTOM'].every(c => result.includes(`[${c}_`));
    }],
    ['Exact text restoration', () => {
      const m = make(); const text = 'Email alex@example.com. Café — hello!';
      return m.restoreText(m.maskText(text)) === text;
    }],
    ['One-byte stream chunks', async () => { const r = await streamSample(1); return r.restored === r.expected; }],
    ['Coverage switches respected', () => {
      const m = make({ names: false, emails: false, phones: false, addresses: false });
      const text = 'My name is Alex Morgan. Email alex@example.com or call 919-555-0142.';
      return m.maskText(text) === text;
    }],
    ['Chat endpoint allowlist', () => [
      ['https://chatgpt.com/backend-api/conversation', true],
      ['https://gemini.google.com/_/BardChatUi/data/StreamGenerate', true],
      ['https://claude.ai/api/organizations/1/completion', true],
      ['https://chatgpt.com/backend-api/telemetry', false],
      ['https://gemini.google.com/settings', false],
      ['https://example.com/chat', false]
    ].every(([url, expected]) => engine.isTargetRequest(url) === expected)],
    ['Media intent recognized', () => engine.containsMediaIntent('Please draw a picture of a dog') && !engine.containsMediaIntent('What is in this picture?')]
  ];
  const checkRows = checks.map(([name]) => {
    const row = document.createElement('li');
    const label = document.createElement('span');
    const state = document.createElement('b');
    label.textContent = name;
    state.textContent = 'READY';
    row.append(label, state);
    $('#check-results').append(row);
    return { row, state };
  });
  runChecks.addEventListener('click', async () => {
    runChecks.disabled = true;
    $('#checks-summary').textContent = 'Running six local checks…';
    let passed = 0;
    for (let i = 0; i < checks.length; i++) {
      let ok = false;
      try { ok = await checks[i][1](); } catch { ok = false; }
      passed += Number(ok);
      checkRows[i].state.textContent = ok ? 'PASS' : 'FAIL';
      checkRows[i].row.dataset.pass = String(ok);
    }
    $('#checks-summary').textContent = `${passed} / ${checks.length} checks passed in this browser.`;
    runChecks.disabled = false;
  });
  showStream();
})();
