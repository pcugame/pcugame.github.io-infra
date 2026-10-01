# Ticket 2: dedicated NAS runtime and play sessions

Status: implemented and deployed through #67. The feature defaults disabled; release and follow-up browser evidence are recorded below.

## Scope and interfaces

Trusted API-origin GET /play/projects/:projectId renders no private project data. API-origin-only POST /api/webgl-play/sessions, /:id/renew, /:id/close create/control a play lease. Public project detail adds stable webglPlayUrl; webglUrl remains compatible. New tab uses noopener. Runtime files remain NAS/Garage under /runtime/<assetToken>/...; API never relays uploaded executable bytes.

Control secrets remain in shell memory and are hashed in persistence; file capabilities cannot renew/control sessions. Manifest-only GET/HEAD checks bind live project visibility, active deployment and login session. Lease: 15m idle, visible tab renews every 60s, maximum 8h and login absolute cutoff. Renewal preserves iframe URL. Hidden tabs do not count as login activity; expired background sessions require restart. Revocation stops future reads; loaded code cannot be erased remotely.

COOP/COEP/CSP/Permissions-Policy and sandbox allow-scripts allow-pointer-lock allow-same-origin with credentialless preserve the isolation boundary. Only selected runtime path and required blobs execute. New Service Workers denied, general Workers supported. No blanket Firefox denial for missing credentialless. Storage separation/persistence are not guaranteed; Safari/mobile excluded from guaranteed scope.

## Required acceptance evidence

- Authenticated HTTP create/renew/close and file responses for anonymous public, private, owner, staff; logout, permission change, replacement, deletion, expiry, concurrency.
- Additive migration and PostgreSQL/Garage integration; normal 60s token compatibility; CI verify/integration.
- Actual threaded Unity fixture: child + Worker crossOriginIsolated, SharedArrayBuffer and running threads in Chrome/Edge/Firefox; record Unity version/settings/hash.
- Exhibition-tab closure, loading >60s, delayed assets, background return and expiry; malicious parent/session/control/cross-game/path/Worker fixtures.
- Existing Service Worker scope audit and browser storage differences; API image/NAS settings compatibility before enabling.
- Exact master commit, immutable image digest, NAS config revision and production authenticated success recorded after approved release.

Synthetic archives and local unit tests do not complete real Unity/browser or production acceptance.

## Local acceptance evidence (2026-10-01)

Source a0a8cb6 plus the reproducible `scripts/webgl-shell-browser.mjs` harness:
Chrome 154.0.8037.92 and Edge 154.0.4258.48 (official binaries), Firefox 141.0 (Playwright engine), and Chromium 150.0.7871.46 passed shell checks. Parent, separate-origin iframe and dedicated Worker reported crossOriginIsolated and SharedArrayBuffer; project HTML-looking strings remained text. The selected-token CSP blocked another runtime path, a visible renewal preserved iframe URL, simulated hidden state suppressed renewal, and denied renewal removed the iframe.

Chrome/Edge credentialless requests omitted fixture cookies. Firefox reported credentialless unsupported and sent two fixture cookies to the NAS origin; isolation still passed. This is a storage/credential behavior difference, not a reason to reject Firefox threads. API-origin credentials were never forwarded to the game.

These shell checks use mock control responses, a synthetic Worker, loopback origins and simulated visibility. They supplement seven authenticated PostgreSQL/Fastify cases and real Nginx gateway tests; they do not substitute for real threaded Unity or production tests. Set PLAYWRIGHT_MODULE_PATH, PLAYWRIGHT_BROWSER, BROWSER_EXECUTABLE and optional BROWSER_ENV_FILE to reproduce after building API. Actual Unity artifacts are tracked separately in ticket 1 fixture evidence.

Follow-up: renewal now locks the authentication session before the play session, matching logout's foreign-key cascade order. A real PostgreSQL concurrent logout/renewal test reproduced HTTP 500 with the former order and returns 403 with the corrected order; the expanded play suite passes eight tests. This prevents logout and renewal from deadlocking while preserving atomic lease/login updates.

Issuance uses the same parent-first rule before expired-lease cleanup and insertion. Its separate real PostgreSQL logout/issuance regression also reproduced HTTP 500 before the fix and passes with 403 afterward. The final play suite has nine passing cases; API lint/build pass on this follow-up.

## Native Firefox Worker follow-up (2026-10-01)

The original Unity6000.0.0b12 glTFast build runs in Firefox152.0.4 with16 native worker realms and renders the pinned Box model. Firefox BiDi enumerates those realms but cannot evaluate their globals (`no such frame`); this is an observation limitation, not a failed Unity runtime.

A separate diagnostic variant prepends [native-worker-observer.js](../../scripts/unity-fixtures/native-worker-observer.js) to the original worker response. The observer reads values inside the actual DedicatedWorkerGlobalScope and inspects the original native `load`/`run` messages. All16 startup/load reports and14 run reports had crossOriginIsolated, SharedArrayBuffer and secure context; the actual native memory buffer was shared (32MiB or38.4375MiB). The original worker body, WebAssembly, framework and data are preserved; the modified-worker result is explicitly separate from the original baseline. It does not claim that an unmodified production worker was inspected through BiDi.

The final local matrix uses the exact `554b57e` player shell, sandbox, COOP/COEP/CSP and a CA trusted only in isolated test profiles; certificate validation stays enabled. Chrome/Edge use software rendering for repeatability and the normal graphics-warning continue button. Firefox did not show that warning in the worker runs. Session controls in this local harness are synthetic. [The follow-up evidence](../../scripts/unity-fixtures/verification-2026-10-01-external.json) separates these results from authenticated production verification.

## Production acceptance (2026-10-01)

All nine actual Unity cases passed on Chrome154.0.8037.92, Edge154.0.4258.48 and Firefox152.0.4 over strict public HTTPS: native text/binary WSS echo, HTTPS binary model loading with shared native Worker memory, and Addressables hash/catalog/13 bundles with rendered models. The Worker diagnostic prefix remains explicit; no unmodified Firefox BiDi-global claim is made.

The tested API source is `fca80666767f4fc17bc95fbc154660c6230b147f`, immutable image `sha256:06274c32d5ba8d338c921bcbe7fc078e8d086010f208a7a5b2604682e6f0a84f`, built by [Build API Release Image 36849244804](https://github.com/pcugame/pcugame.github.io-infra/actions/runs/36849244804) and deployed by [Deploy Release 36849862293](https://github.com/pcugame/pcugame.github.io-infra/actions/runs/36849862293). Both playback and approved external connections are enabled. NAS gateway configuration remains at `cf00f44`; exact template hashes are in the evidence JSON.

Private fixture sessions exercised authenticated public player creation and NAS downloads. Approval/revocation used real HTTP handlers through container loopback with exact Origin; public HTTPS policy reads also passed. Sessions were provisioned for verification, so this does not claim OAuth-login coverage. All three policies were revoked after fresh successful NAS reads: subsequent reads and renewal were denied. An actual visible player removed its iframe on the next check (60.34 seconds).

All three private projects, two fixture users, play sessions, uploaded objects and temporary server artifacts were removed through the canonical deletion/outbox flow. Three policy requests and six append-only audit events remain intentionally. The evidence-only follow-up does not replace the tested production image.
