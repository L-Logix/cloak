// Reproducible synthetic masking exercise. No network, storage, or extension hooks.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, 'assets/preview-engine.js'));
const window = {};
vm.runInNewContext(source.toString(), { window, console, TextEncoder, TextDecoder, setTimeout, clearTimeout });
const total = 1024;
let restored = 0, maskedValues = 0, detectedAll = 0;
const tasks = ['Draft an appointment reminder.', 'Summarize this fictional intake record.', 'Prepare a contact card.', 'Write a follow-up email.'];
for (let i = 0; i < total; i++) {
  const prompt = `${tasks[i % tasks.length]}\nPatient name: Alex Morgan\nEmail: patient${i}@example.com\nPhone: 919-555-${String(i).padStart(4, '0')}\nAddress: ${100 + i} Main Street, Raleigh, NC 27601`;
  const masker = window.CloakPreview.createMasker();
  masker.configure({ enabled: true, settings: {} });
  const masked = masker.maskText(prompt);
  maskedValues += masker.takePendingEntries().length;
  detectedAll += Number(['PERSON', 'EMAIL', 'PHONE', 'ADDRESS'].every(type => masked.includes(`[${type}_`)));
  restored += Number(masker.restoreText(masked) === prompt);
}
const report = {
  measuredAt: new Date().toISOString(), prompts: total, maskedValues, exactRoundTrips: restored,
  promptsWithAllFourCategories: detectedAll,
  scope: `${total.toLocaleString('en-US')} generated samples across four task phrases, with a fixed fictional name and varying email, phone, and street number. Not a real-world accuracy benchmark, user count, or clinical validation.`,
  command: 'node docs/benchmark.cjs',
  previewSha256: crypto.createHash('sha256').update(source).digest('hex')
};
fs.writeFileSync(path.join(__dirname, 'assets/synthetic-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (restored !== total || detectedAll !== total || maskedValues !== 4 * total) process.exitCode = 1;
