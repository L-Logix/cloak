# Cloak website guide

The site is a plain HTML, CSS, and JavaScript project. It runs without a build
step, and every interactive demo processes data locally in the browser.

## Preview locally

```sh
npm run docs:serve
```

Open `http://127.0.0.1:4173`.

## Verify

In a second terminal:

```sh
npm run docs:verify
```

The verifier checks local asset paths, fragment targets, unique element IDs,
preview isolation, masking and restoration, category toggles, and engine source
provenance.

## Package the extension

```sh
npm run docs:package
```

This refreshes `docs/downloads/cloak-extension.zip` and writes
`docs/downloads/manifest.json` with archive and source hashes.

## Reproduce the benchmark

```sh
npm run docs:benchmark
```
