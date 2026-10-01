# Ticket 2: dedicated NAS runtime and play sessions

Status: implementation in progress; depends on compatible API + NAS gateway rollout, defaults disabled.

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
