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
