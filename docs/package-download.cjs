// Read-only packaging of the extension. Requires the built-in Python runtime or Python 3.
// The ZIP is generated with standard-library zipfile; no repository sources are modified.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const python = process.env.CLOAK_PYTHON || 'python';
const program = `
import hashlib, json, pathlib, zipfile, sys
root = pathlib.Path(sys.argv[1])
files = ['manifest.json','popup.html','popup.js','styles.css','content.js','content.css','intercept.js','intercept.bundle.js','package.json','package-lock.json','LICENSE','README.md','tests/intercept.test.js','tests/content.test.js','tests/README.md']
out = root / 'docs' / 'downloads'
out.mkdir(exist_ok=True)
archive = out / 'cloak-extension.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in files:
        z.write(root / name, 'cloak/' + name)
with zipfile.ZipFile(archive) as z:
    for name in files:
        assert z.read('cloak/' + name) == (root / name).read_bytes(), name
report = {'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}, 'verification': 'Every archived file matches the current repository source byte-for-byte.'}
(out / 'manifest.json').write_text(json.dumps(report, indent=2) + '\\n')
print(f'PASS: extension download packaged and all {len(files)} files verified byte-for-byte.')
`;
const result = spawnSync(python, ['-c', program, root], { encoding: 'utf8' });
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status;
