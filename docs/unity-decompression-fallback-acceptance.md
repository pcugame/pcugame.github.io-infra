# Unity Decompression Fallback acceptance

## Scope and required behavior

A Unity WebGL ZIP has one explicit entry page: `index.html` at ZIP root, or `index.html` directly inside one wrapper directory. Nested player/help pages may also contain `index.html`. All files must stay inside the wrapper when present. At least one Unity player must contain the loader, framework, WASM and data artifacts together in the same `Build` directory; incomplete directories cannot be combined into a valid player. Original parent/child files and payloads are preserved.

Required artifacts in `Build`:

| Artifact | Supported filenames |
| --- | --- |
| Loader | `*.loader.js`, `*.loader.js.gz`, `*.loader.js.br` |
| Framework | `*.framework.js`, `*.framework.js.gz`, `*.framework.js.br`, `*.framework.js.unityweb` |
| WASM | `*.wasm`, `*.wasm.gz`, `*.wasm.br`, `*.wasm.unityweb` |
| Data | `*.data`, `*.data.gz`, `*.data.br`, `*.data.unityweb` |

Fallback files are served as `application/octet-stream`, byte-for-byte as stored in the ZIP, without `Content-Encoding`. Unity's JavaScript loader performs their decompression. Existing `.gz` and `.br` objects retain their decoded MIME type and `gzip` / `br` encoding. A `*.loader.js.unityweb` file cannot satisfy the loader requirement.

No database or public API changes are required. The bounded ZIP validator remains authoritative for unsafe paths, duplicate normalized paths, encrypted entries, CRC/size validation, entry count, expanded size and compression-ratio limits. Validation still completes before deployment reservation or any output PUT. Failed validation must preserve the existing deployment.

## Automated evidence

`apps/api/src/modules/webgl/processing.test.ts` uses synthetic ZIPs, real gzip/Brotli payload bytes, and the canonical processing pipeline with mocked repository/object storage ports. The matrix covers all five configurations below at ZIP root and inside one wrapper directory. It checks uploaded bytes, MIME types, absent/present encoding, and persisted manifest encoding. Missing artifacts, unsupported fallback loader, CRC corruption and a ZIP compression bomb do not commit a new deployment; missing/invalid archives do not reserve or upload output objects. These checks verify processing boundaries; they do **not** prove Unity executes in a browser or that a production deployment remains playable.

The gateway integration test extends the existing authenticated file-access fixture to assert binary fallback response bytes and absence of `Content-Encoding`. It requires the existing loopback PostgreSQL/Garage/API/Nginx integration environment. It does not execute a Unity player.

## Real public export and browser evidence

On 2026-10-01, the five actual configurations below passed initialization and scene-render inspection in literal Google Chrome `154.0.8037.92`, Microsoft Edge `154.0.4258.48`, and system Firefox `152.0.4`, on Linux/NixOS with headless software rendering. Each export passed ZIP-root and one-wrapper layouts: 30 primary browser cases. Input was dispatched, but complete gameplay was not assessed.

| Configuration | Source | Unity version | Root / wrapper, three browsers |
| --- | --- | --- | --- |
| Uncompressed | synboxdev/AspNetCore-Unity-WebGL | 6000.0.25f1 | Passed |
| Gzip, fallback on | same repository | 6000.0.25f1 | Passed |
| Brotli, fallback on | same repository | 6000.0.25f1 | Passed |
| Gzip, fallback off | kc3hack/2022_e | 2020.3.5f1 | Passed |
| Brotli, fallback off | eldNach/docker-nginx-unity | 2021.3.16f1 (WASM version string) | Passed |

Sources are pinned in [catalog.json](../scripts/unity-fixtures/catalog.json): [synboxdev export](https://github.com/synboxdev/AspNetCore-Unity-WebGL/tree/b0fada0780244878b9b7e174408ffc89baa0233f), [kc3hack export](https://github.com/kc3hack/2022_e/tree/9fdaf08a062de70c96c92377488053f8d6cacd99), and [eldNach export](https://github.com/eldnach/docker-nginx-unity/tree/260d314bebb14aac060dd83b7f47e85ab6336b70). Repository MIT declarations are recorded; Unity Microgame asset rights are not independently audited. These exports reproduce artifact downloads, not necessarily editor rebuilds. The five configurations use different scenes/Unity versions; a same-scene five-export comparison remains outstanding.

All twelve primary/threaded root/wrapper ZIPs passed the actual bounded validator, archive analyzer and publisher against an isolated disk storage port; published bytes matched source checksums. A fresh pinned download reproduced all 113 source files and all twelve publications. Original downloaded exports remain untouched. Raw HTTP checks verified 64 Build payloads byte-for-byte with exact MIME/encoding metadata in the initial fixture set. Browser responses independently show native gzip/br encoding and no fallback encoding. A supplementary older JohannesDeml Unity 2021.3.0f1 Brotli release initialized but produced shader errors; it is excluded from the primary five-format rendering result.

The actual [atteneder/glTFastWebDemo](https://github.com/atteneder/glTFastWebDemo/tree/32e62b0cffc465d65f113c436b2262491853e199) Unity `6000.0.0b12` native threaded export also passed both layouts in all three browsers through the actual compiled trusted shell and runtime CSP (six cases). WASM imports shared memory (flags 3, minimum 512 and maximum 32767 pages); its generated worker initializes native Emscripten threads against that unchanged WASM. Each case observed 16 workers with `loaded` messages, isolated parent/child and SharedArrayBuffer, denied child access to the cross-origin parent DOM, and a rendered red cube after same-origin model loading. The actual viewer's external model request was blocked by runtime `connect-src`; no network allowlist was relaxed. A separately pinned [Cesium Box model](https://github.com/KhronosGroupArchives/glTF-Sample-Models/tree/d7a3cc8e51d7c573771ae77a57f16b0662a905c6/2.0/Box) carries a CC-BY-4.0 notice.

The threaded HTML requires its source demo's `parent.globals` callbacks and parent SVG. The harness substitutes local callbacks/SVG only; compiled loader/framework/WASM/worker/data bytes remain unchanged. That export has no explicit repository license and stays in temporary local storage. The shell's session-control responses are synthetic; these tests do not establish authenticated API behavior. Cookie/control-header absence was audited on the actual fixture asset requests. Reproduction instructions and exact observation limitations are in [the harness README](../scripts/unity-fixtures/README.md).

Authenticated upload/READY/publication acceptance is still required. After one known-good deployment, submit missing-artifact, corrupt, unsafe-path and over-limit archives through that flow; verify the current deployment ID remains unchanged and the previous game still opens. Record deployment IDs, commit/digest, browser observations and console/network failures. Local publisher tests and mock controls do not replace this check or production verification.

## Local verification record

On 2026-10-01, branch `feat/unity-fallback` based on `origin/master` `f4174cb`, Linux/NixOS, Node `v22.23.1`, npm `10.9.8`, and independently installed lockfile dependencies:

- `npm ci`: passed.
- `PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x npm run db:generate -w apps/api`: passed. The default NixOS engine target returned a checksum 404; specifying the CLI binary target generated the client without changing the schema or dependencies.
- `npm exec -w apps/api -- vitest run src/modules/webgl/processing.test.ts src/__tests__/bounded-zip-validator.test.ts src/__tests__/object-storage-head.test.ts src/__tests__/visibility-gateway.garage.postgres.test.ts`: 62 passed, 3 live gateway tests skipped because the integration flags/environment were not enabled.
- `npm exec -w apps/web -- vitest run src/__tests__/SubmissionWebglFiles.test.tsx`: 1 passed.
- `npm run build`: passed (contracts, API TypeScript/release build, web TypeScript/Vite build).
- `npm run lint`: passed (API lint/type checks and web lint).

Required GitHub CI/integration, real authenticated upload replacement checks, hardware-GPU/full-gameplay acceptance, and production verification remain separate gates.

The unused `webglContentSecurityPolicy` helper was removed: it had no production callers and duplicated a stale policy. Fixture serving reads the active Nginx policy, which already permits blob scripts; no production CSP relaxation was made.
