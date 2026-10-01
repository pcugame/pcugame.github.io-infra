# Ticket 3: approved external HTTPS / Addressables / WSS connections

Status: implemented on feat/webgl-network-policy, based on ticket 2; runtime/browser and release evidence tracked below.

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

Authenticated PostgreSQL/Fastify network and play tests passed (17 cases), plus existing visibility/file-access integration tests (27 total). Shared origin-validation tests, API test/build/lint/architecture and UI submission/review/unavailable-state tests passed. Independent security review verified snapshot/revocation ordering and addressed reserved IPv6 and flag-off revival edge cases. The real Nginx fixture passed with a policy larger than 4 KiB. CLI tests confirm explicit scope, dry-run default and persistent apply. Actual Unity Addressables/API/WSS, final CI and production evidence remain separate acceptance gates.
