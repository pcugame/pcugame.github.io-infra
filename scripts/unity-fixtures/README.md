# Local real Unity export acceptance

Run from the repository root with installed lockfile dependencies. These scripts download public artifacts only to a temporary directory, verify pinned sizes/SHA-256 hashes, and package root and single-wrapper ZIPs. They never execute downloaded repository tooling. `catalog.json` records immutable source commits, Unity versions, license qualifications and every downloaded file. No third-party binaries are committed or published.

```sh
python3 scripts/unity-fixtures/download.py
node_modules/.bin/tsx scripts/unity-fixtures/publish.mts
npm run build -w apps/api
node scripts/unity-fixtures/serve.mjs
```

The publisher exercises the actual bounded ZIP validation, archive analysis and object publication code against a disk storage port. It does not authenticate, access a database or create a deployment. Results and SHA-256 manifests are written under `FIXTURE_ROOT` (default `/tmp/pcu-unity-fixture-repro`).

The loopback fixture server binds ports 19011 (assets) and 19012 (trusted API shell). Legacy CSP comes directly from the Nginx template; runtime CSP, shell HTML and shell headers come from compiled API modules. `RUNTIME_REPO_ROOT` can select another development checkout containing the runtime modules. The create/renew/close control responses are explicitly synthetic. This harness cannot establish real authentication or deployment preservation.

Install literal Chrome and Edge binaries separately, then provide their executable paths. Playwright drives those binaries; cached Chromium is not a substitute for a branded-browser acceptance claim. Firefox uses a separately running loopback geckodriver and W3C WebDriver. Example:

```sh
PLAYWRIGHT_MODULE_PATH=/tmp/pcu-browser-e2e/node_modules/playwright \
CHROME_EXECUTABLE=/path/to/google/chrome EDGE_EXECUTABLE=/path/to/msedge \
node scripts/unity-fixtures/check-browser.cjs
WEBDRIVER_URL=http://127.0.0.1:19013 FIREFOX_EXECUTABLE=/path/to/firefox \
python3 scripts/unity-fixtures/check-firefox.py
```

`BROWSER_ENV_FILE` optionally supplies a JSON environment mapping for NixOS browser library paths. Chrome/Edge use headless SwiftShader; hardware GPU acceptance is separate. Both runners write browser version, readiness, canvas dimensions, worker messages, errors and screenshots. They fail the process when a fixture fails. `FIXTURE_CONFIGS` restricts a comma-separated list of published fixture directories, and `RESULT_SUFFIX` preserves separate reports.

For the trusted shell native threaded probe, set `TRUSTED_SHELL=true` and `FIXTURE_CONFIGS=threaded-gltf-root,threaded-gltf-wrapper` on each runner. The probe checks parent and child isolation/SAB, cross-origin parent DOM denial, native worker initialization, a CSP-blocked external GLB request and successful same-origin GLB loading. Inspect screenshots for actual rendering; nonzero canvas dimensions alone are insufficient rendering evidence.

Only the threaded fixture's HTML is adapted: all `parent.globals` references become local no-op/observation callbacks and its unavailable parent-relative SVG becomes a data URL. Instrumentation wraps the loader promise and Worker constructor for observation. Generated loader, framework, WASM, data and worker bytes remain unchanged. The separately pinned Cesium Box GLB is a local test input with its CC-BY-4.0 notice. The threaded export repository has no explicit license; keep that artifact in the local test environment and do not redistribute it based on this harness.

Browser installation used in the 2026-10-01 record: Chrome package from `https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb`; Edge `154.0.4258.48-1` package from the official `packages.microsoft.com/repos/edge` pool; Mozilla geckodriver release `v0.37.1`. Current Chrome's URL is mutable: use the recorded package hash/version when comparing a rerun, and record new versions rather than claiming an identical browser environment.
