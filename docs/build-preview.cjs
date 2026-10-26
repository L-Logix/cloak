// Read-only extraction. Only writes the website's own assets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'intercept.js'), 'utf8');
const offset = source.indexOf('  // ---- Entry points');
if (offset < 0) throw new Error('Preview boundary not found; refusing to build.');
const preview = source.slice(0, offset) + '\n  root.CloakPreview = { createMasker, restoreStream, isTargetRequest, containsMediaIntent };\n})(window);\n';
esbuild.buildSync({ stdin: { contents: preview, resolveDir: root, sourcefile: 'cloak-website-preview.js' }, bundle: true, minify: true, platform: 'browser', format: 'iife', target: 'es2020', legalComments: 'eof', outfile: path.join(__dirname, 'assets', 'preview-engine.js'), banner: { js: '/* Cloak GPL-3.0 website preview. No interception or persistence. See README.md and LICENSE. */' } });
fs.writeFileSync(path.join(__dirname, 'assets', 'engine-source.json'), JSON.stringify({ source: 'intercept.js', sha256: crypto.createHash('sha256').update(source).digest('hex'), mode: 'Preview-only entry point; masking logic unchanged.' }, null, 2) + '\n');
console.log('Website engine built. Extension files unchanged.');
