# Cloak

Cloak is a local-first Chrome extension that replaces detected prompt details with reversible tokens before supported chat requests are sent.

## Build and test

Install the local parser and bundler dependencies, then build the main-world interceptor bundle:

```sh
npm install
npm run build:interceptor
```

Load this project directory as an unpacked extension from `chrome://extensions`. After editing the interceptor, rebuild the bundle and reload the extension and chat tab.

Run the interception tests with:

```sh
npm test
```

`npm test` rebuilds the same browser bundle loaded by the extension before running its tests.

## Detection and privacy

Person and place recognition runs locally with the bundled `compromise` NLP package. Street addresses are parsed locally with `addressit`; email and phone formats use local patterns. Prompt text is not sent to either package or to a Cloak service.

Detection is best-effort, not complete. NLP can miss unfamiliar names or misclassify text, and address formats vary internationally. Review sensitive prompts before sending; do not treat Cloak as a guarantee that every identifier was removed.