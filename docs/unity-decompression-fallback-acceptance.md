# Unity Decompression Fallback acceptance

## Scope and required behavior

A Unity WebGL ZIP contains exactly one `index.html`, at ZIP root or inside one wrapper directory. All files must be inside that wrapper when present; keep the `Build` directory relative to `index.html`.

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

## Real export and browser acceptance (pending)

Export the same playable Unity scene, retaining its actual generated loader, HTML and build artifacts, with these five Player publishing configurations:

| Compression Format | Decompression Fallback | Root ZIP | Single wrapper ZIP |
| --- | --- | --- | --- |
| Disabled | Off | Pending | Pending |
| Gzip | Off | Pending | Pending |
| Brotli | Off | Pending | Pending |
| Gzip | On | Pending | Pending |
| Brotli | On | Pending | Pending |

For each of the ten archives, upload through the authenticated application flow, await READY/publication, and open the actual player in current Chrome, Edge and Firefox. Confirm initialization, scene rendering, and basic input/gameplay. Inspect the loader/framework/WASM/data HTTP statuses and headers; compare fallback response bytes to the exported bytes and confirm no fallback `Content-Encoding`. Confirm gzip/Brotli response encoding remains correct. Record Unity version, browser/OS versions, ZIP checksums, deployment ID, source commit, observed headers, and console/network failures.

After one known-good deployment, submit missing-artifact, corrupt, unsafe-path and over-limit archives through the same authenticated flow. Confirm their failed status/error identifies the issue, the current deployment ID is unchanged, and the previous game remains playable in all three browsers. Synthetic unit assertions do not replace this check.

Local fixture inventory on 2026-10-01: searching Desktop and Downloads found no generated `.loader.js`, `.unityweb`, or WASM build files. `/home/song/Desktop/26_2_capstone.zip` contains 14 entries and no Unity build artifacts; the other discovered ZIP is a homepage maintenance package. Real Unity five-configuration fixtures and Chrome/Edge/Firefox acceptance are unavailable and remain pending. This document records no browser execution or production verification claim.

## Local verification record

On 2026-10-01, branch `feat/unity-fallback` based on `origin/master` `f4174cb`, Linux/NixOS, Node `v22.23.1`, npm `10.9.8`, and independently installed lockfile dependencies:

- `npm ci`: passed.
- `PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x npm run db:generate -w apps/api`: passed. The default NixOS engine target returned a checksum 404; specifying the CLI binary target generated the client without changing the schema or dependencies.
- `npm exec -w apps/api -- vitest run src/modules/webgl/processing.test.ts src/__tests__/bounded-zip-validator.test.ts src/__tests__/object-storage-head.test.ts src/__tests__/visibility-gateway.garage.postgres.test.ts`: 62 passed, 3 live gateway tests skipped because the integration flags/environment were not enabled.
- `npm exec -w apps/web -- vitest run src/__tests__/SubmissionWebglFiles.test.tsx`: 1 passed.
- `npm run build`: passed (contracts, API TypeScript/release build, web TypeScript/Vite build).
- `npm run lint`: passed (API lint/type checks and web lint).

Required GitHub CI/integration, real authenticated upload replacement checks, browser acceptance, and production verification are not established by these local results.
