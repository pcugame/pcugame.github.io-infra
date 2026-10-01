# Ticket 3: approved external HTTPS / Addressables / WSS connections

Status: implemented and merged through #69. The feature defaults disabled; release and browser evidence are tracked below.

Project owners submit exact secure origin, purpose, connection mode and required CORS configuration. Administrators approve/reject/revoke with actor, reviewer, reason, timestamps and policy version. States PENDING/APPROVED/REJECTED/REVOKED. Reject wildcard, userinfo, insecure schemes, localhost/private/reserved IP and site authentication/administration origins. No server fetch/proxy validation.

Approval belongs to project and survives next deployment. New execution snapshots approved origins/version; new approvals affect next execution. Existing internal gateway auth provides trusted CSP for document and network Worker responses. Only connect-src extends; script/worker origins stay runtime-local plus necessary blob. Fail closed on policy lookup failure. Revocation invalidates affected sessions immediately for future NAS reads and at next shell renewal/return; already connected external WSS is not remotely terminated.

Shared request/review contracts and project/admin APIs must enforce authorization, duplicate/concurrent review transitions and version changes. External CORS must allow the actual NAS game origin; developer configures Addressables catalog/hash/bundles and WSS auth. No OAuth popup/redirect flow or direct external script support. CSP is not a proof that downloaded bytes cannot become code with Unity eval/blob support.

Acceptance: approved API/Addressables/WSS in actual Unity fixtures on Chrome/Edge/Firefox, unapproved/cross-project/Worker/encoded-path/redirect bypass tests, CORS-vs-CSP guidance, HTTP permission/concurrency/version/revocation tests, CI verify/integration. Feature default off. Production enablement uses established release flow and records exact source/image/NAS/browser evidence.

## Rollout and rollback

Apply the additive migrations through Deploy Release with the features disabled. Deploy the matching NAS gateway templates using the existing NAS compose procedure, verify `nginx -t` and the authenticated runtime headers, then enable `WEBGL_PLAY_ENABLED` and `WEBGL_EXTERNAL_CONNECTIONS_ENABLED` through the established API configuration/release procedure. The gateway auth response buffer accommodates the bounded maximum of sixteen approved origins. Keep the release source, image digest, NAS template hashes and browser evidence together.

For rollback, disable external connections first (or disable all new playback with `WEBGL_PLAY_ENABLED=false`) through the same configuration/release flow. While issuance is disabled, revoke existing leases using the CLI bundled in that exact API image:

```sh
# Existing API container, using its configured database; emits counts only.
podman exec gp-api node dist-release/scripts/revoke-webgl-play-sessions.js --external
podman exec gp-api node dist-release/scripts/revoke-webgl-play-sessions.js --external --apply
# For full runtime rollback use --all in place of --external.
```

Default execution is read-only. Record the applied count and feature configuration before re-enabling. Revocation is persistent and cannot be undone by changing the flag back. Runtime requests encountering a disabled external policy also durably revoke that session. This CLI manages leases only; it neither deploys code nor replaces the established CD process. Existing loaded code/external WSS cannot be forcibly erased. The legacy player does not provide a threaded-runtime guarantee.

## Implementation verification

Authenticated PostgreSQL/Fastify network and play tests passed (20 cases), plus existing visibility/file-access integration tests (29 total). Shared origin-validation tests, API test/build/lint/architecture and UI submission/review/unavailable-state tests passed. Independent security review verified snapshot/revocation ordering and addressed reserved IPv6 and flag-off revival edge cases. The real Nginx fixture passed with a policy larger than 4 KiB. CLI tests confirm explicit scope, dry-run default and persistent apply. Actual Unity Addressables/API/WSS, final CI and production evidence remain separate acceptance gates.

`node scripts/webgl-network-browser.mjs` passed on Chrome 154.0.8037.92, Edge 154.0.4258.48 and Firefox 141.0 (Playwright engine). Each browser made fourteen allowed HTTP requests and two real WSS echo exchanges from document and dedicated Worker. Unapproved hosts/WSS, redirected targets, another runtime token, external scripts and external Workers produced zero prohibited traffic. The probe uses actual generated runtime CSP, local self-signed TLS and DNS mapped to loopback without interception. Its catalog/hash/bundle payloads are synthetic transport fixtures, not Unity Addressables. It uses the shell harness Playwright options plus optional WS_MODULE_PATH.

## Actual Unity external-connectivity follow-up (2026-10-01)

The earlier synthetic transport test is supplemented by actual Unity builds on Chrome154.0.8037.92, Edge154.0.4258.48 and Firefox152.0.4. The final local tests use the `554b57e` trusted player shell, exact runtime CSP, sandbox/credentialless attributes and separate TLS origins. Test certificates are trusted only in isolated browser profiles; TLS validation is not disabled. Session-control responses are mocked locally and do not substitute for the separate production approval/NAS checks.

| Actual compiled Unity fixture | Approved origin | Denied origin / failure case |
| --- | --- | --- |
| UnityWebSocket2.8.0, Unity6000.0.15f1c1 | Native game UI sends text and binary messages; server and game confirm both echoes | `connect-src` violation; no server connection |
| glTFast, Unity6000.0.0b12 | UnityWebRequest reads a binary HTTPS API response, decodes the GLB and renders the model | CSP denial sends no request; incorrect CORS sends a request but Unity cannot read it |
| Addressables2.2.2, Unity6000.0.33f1 | Real external hash, catalog and13 UnityFS bundles return200 and decoded models render |27 genuine native fetch failures/connection-policy violations; no successful external responses |

Each row passed in all three browsers. The HTTPS fixture verifies a binary GET endpoint, not JSON REST serialization, OAuth or all possible application protocols. Firefox's expected external MP4 `media-src` violation in the Addressables demo is separate: an approved connection origin does not authorize external media, scripts or Workers.

The Addressables fixture replaces only the local catalog hash with32 ASCII zeros to exercise an actual remote catalog refresh. Remote URLs and all15 remote resources are unchanged and match the pinned Git blobs. The JavaScript readiness hook observes the real game and does not synthesize fetches. The WSS test uses native canvas keyboard/mouse input, not an injected WebSocket.

[external-catalog.json](../../scripts/unity-fixtures/external-catalog.json) pins upstream commits, Unity/package versions, artifact hashes and adaptations. Builds without an identified redistribution license remain private evaluation assets: this repository contains no compiled games, screenshots of those games, credentials or browser profiles. [verification-2026-10-01-external.json](../../scripts/unity-fixtures/verification-2026-10-01-external.json) records the local and production boundaries separately.

## Production acceptance (2026-10-01)

All nine actual Unity cases passed on Chrome154.0.8037.92, Edge154.0.4258.48 and Firefox152.0.4 over strict public HTTPS: native text/binary WSS echo, HTTPS binary model loading with shared native Worker memory, and Addressables hash/catalog/13 bundles with rendered models. The Worker diagnostic prefix remains explicit; no unmodified Firefox BiDi-global claim is made.

The tested API source is `fca80666767f4fc17bc95fbc154660c6230b147f`, immutable image `sha256:06274c32d5ba8d338c921bcbe7fc078e8d086010f208a7a5b2604682e6f0a84f`, built by [Build API Release Image 36849244804](https://github.com/pcugame/pcugame.github.io-infra/actions/runs/36849244804) and deployed by [Deploy Release 36849862293](https://github.com/pcugame/pcugame.github.io-infra/actions/runs/36849862293). Both playback and approved external connections are enabled. NAS gateway configuration remains at `cf00f44`; exact template hashes are in the evidence JSON.

Private fixture sessions exercised authenticated public player creation and NAS downloads. Approval/revocation used real HTTP handlers through container loopback with exact Origin; public HTTPS policy reads also passed. Sessions were provisioned for verification, so this does not claim OAuth-login coverage. All three policies were revoked after fresh successful NAS reads: subsequent reads and renewal were denied. An actual visible player removed its iframe on the next check (60.34 seconds).

All three private projects, two fixture users, play sessions, uploaded objects and temporary server artifacts were removed through the canonical deletion/outbox flow. Three policy requests and six append-only audit events remain intentionally. The evidence-only follow-up does not replace the tested production image.
