const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'Unique IDs');
for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  if (target.startsWith('#') && target.length > 1) assert.ok(ids.includes(target.slice(1)), `Anchor ${target}`);
  else if (!target.startsWith('#') && !/^https?:/.test(target)) assert.ok(fs.existsSync(path.join(__dirname, target)), `Asset ${target}`);
}
const forbidden = () => { throw new Error('Unexpected network or storage operation'); };
const win = { fetch: forbidden, XMLHttpRequest: forbidden, localStorage: new Proxy({}, { get: forbidden }), chrome: new Proxy({}, { get: forbidden }) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'assets/preview-engine.js'), 'utf8'), { window: win, console, setTimeout, clearTimeout, TextDecoder, TextEncoder });
assert.equal(win.fetch, forbidden, 'No fetch hooks');
assert.equal(win.XMLHttpRequest, forbidden, 'No XHR hooks');
const samples = [
  ['My name is Alex Morgan. Email alex@example.com or call 919-555-0142.', ['PERSON', 'EMAIL', 'PHONE']],
  ['My address is 123 Main Street, Raleigh, NC 27601.', ['ADDRESS']],
  ['Project Firefly is ready.', ['CUSTOM']]
];
for (const [sample, categories] of samples) {
  const masker = win.CloakPreview.createMasker();
  masker.configure({ enabled: true, settings: { customTerms: ['Project Firefly'] } });
  const masked = masker.maskText(sample);
  for (const category of categories) assert.ok(masked.includes(`[${category}_`), `Detect ${category}`);
  assert.equal(masker.restoreText(masked), sample, 'Exact round trip');
}
const disabled = win.CloakPreview.createMasker();
disabled.configure({ enabled: true, settings: { names: false, emails: false, phones: false, addresses: false } });
const plain = 'My name is Alex Morgan. Email alex@example.com or call 919-555-0142.';
assert.equal(disabled.maskText(plain), plain, 'Disabled categories');
assert.equal(disabled.maskText(''), '', 'Empty input');
const source = fs.readFileSync(path.join(__dirname, '../intercept.js'), 'utf8');
const provenance = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets/engine-source.json'), 'utf8'));
assert.equal(crypto.createHash('sha256').update(source).digest('hex'), provenance.sha256);
console.log('PASS: assets, anchors, detection, round trips, toggles, preview isolation, source provenance.');
