'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const engine = window.CloakPreview;
  const chunkSize = $('#chunk-size');
  const runStream = $('#run-stream');
  if (!engine?.restoreStream) {
    $('#stream-status').textContent = 'Reload to load the engineering demo.';
    runStream.disabled = true;
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
  showStream();
})();
