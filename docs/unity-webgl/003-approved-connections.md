# Approved external HTTPS / Addressables / WSS connections

## Current contract

This section describes the PR source, not a production rollout. The dated records below remain evidence for their recorded revisions only.

| Rule | Host scope | Transport | Ports |
| --- | --- | --- | --- |
| `https://assets.example.com` | Exact host | HTTPS | 443 (unchanged legacy meaning) |
| `wss://game.example.com:8443` | Exact host | WSS | 8443 |
| `https://assets.example.com:*` | Exact host | HTTPS | All ports |
| `wss://*.example.com:*` | Subdomains only, excluding `example.com` | WSS | All ports |

New request forms default to a hostname, selected HTTPS/WSS transport and all ports. Specific ports are selected explicitly. Host wildcard `*.` and port wildcard `:*` are independent. HTTPS and WSS require separate rules. The host field accepts hostnames only; URLs, pasted ports, wildcard syntax, credentials, paths, queries and fragments are rejected. A selected specific port of 443 serializes without a port suffix.

Owners and linked participants can compose one to sixteen connections and submit them atomically through `POST /api/me/projects/:id/webgl-network-requests/batch`. Purpose and CORS/authentication plans are written once for the list and copied into each independently reviewable request. Empty rows must be completed or removed. In-batch duplicates/overlap, protected hosts, active exact duplicates, permission/closure failures and storage errors leave no partial batch; item errors identify the array index and field. Existing approved overlaps remain warnings until approval. A batch consumes one of ten allowed HTTP requests per minute. The legacy single-create route remains compatible.

Administrators and operators can also select a game under Project Management → External Connections and grant one to sixteen connections without a student request. The project-scoped admin endpoint `POST /api/admin/projects/:id/webgl-network-requests/allow` requires `{ items, reason }` and atomically writes approved requests, one review event per address and policy versions. Staff can manage closed exhibitions, while staged change-request projects remain excluded. Active exact duplicates, approved overlaps, protected hosts and the sixteen-approved-rule total reject the whole operation. Ordinary users cannot use the admin read or grant endpoints. Existing pending requests are reviewed through the existing approve action. Direct grants apply to new executions and remain independently revocable.

Editable Photon/Relay/Mirror/HTTPS examples add drafts to this same list, skip duplicates and enforce the sixteen-item limit. They do not submit separately or retry automatically. Failed submissions retain inputs; uncertain outcomes refresh history for confirmation. History appears above the full-width editor; per-connection previews and examples are collapsible. Examples are guidance rather than integration guarantees; Unity/example.com placeholders must be replaced with actual SDK destinations.

Request preview and administrator review show the host scope, transport and port policy, plus overlapping approved requests. Same-project overlapping approvals are rejected; the 16-rule approval limit remains. Public/private suffix, IP and protected-host checks apply at request, approval and runtime. No proxy or service-specific policy expansion is introduced. Approvals extend only the project's `connect-src`; runtime-local executable sources, project isolation and diagnostic authorization remain unchanged.

Persisted requests, append-only history and issued session snapshots are not rewritten. New approvals apply only to new executions. Revocation denies subsequent runtime document/Worker reads, renewal and diagnostics for affected old sessions; reapproval does not revive them. Already loaded documents or connected WSS are not remotely terminated.

## Manual transition from a specific port to all ports

1. Record current approved rules, host scopes, transports and policy version. Confirm the actual remote service's destinations, CORS/Origin checks and authentication with its operator.
2. Submit the required `:*` rules through the owner's/linked participant's network page. Request the root and subdomains separately when both are required; do not edit stored rows or old session snapshots.
3. Review the displayed overlap targets. An operator/administrator records a reason and revokes every overlapping approval, then approves the new request. This creates an approval gap and interrupts subsequent reads/renewal for existing plays using the revoked policy.
4. Close old game tabs and start a new execution. Verify the new session snapshot and document/Worker response CSP; then test the actual required remote ports. Old sessions remain invalid even after reapproval.
5. Use opt-in connection diagnostics to investigate blocked origins. Reports contain only bounded origin/directive/count/time data, use session-scoped HMAC capabilities and do not prove success or auto-approve rules. Gateway and outer-proxy logs must not retain report capabilities.
6. Reverting to specific ports also requires revocation, a new approval and a new execution. Retain the review history.

## Submission notes and public acceptance

Use the existing purpose and server-configuration fields or accompanying project notes; no new mandatory fields are required. Record SDK and version, Unity version and game mode; each HTTPS/WSS destination and purpose; authentication method without secrets; the remote-service operator/contact; and the planned two-player acceptance procedure. The developer/operator owns remote CORS, WebSocket Origin checks, accounts, certificates and service availability.

Before public multiplayer use, two independent clients/accounts must join the same intended region/room through the published build, complete authentication and matchmaking/allocation, exchange bidirectional game state, and exercise disconnect/rejoin and failure reporting. Record browser/SDK/build versions and results. Repeat after relevant build or service changes. Actual Photon authentication/matchmaking/two-player play, Relay allocations/two-player play and the current project's Addressables build remain unverified by the synthetic transport fixture.

Current limitations, unchanged in this PR:

- Submission remains subject to the existing exhibition modification/closure policy. Owners can still read history after closure; post-deadline submission authority is a follow-up policy decision.
- Any failed API renewal stops the player and removes its iframe, including transient network/server failures. Revisit bounded retry and the distinction between transient failure and authorization denial separately; this PR preserves fail-closed behavior.

## Current verification boundary

The repeatable checks are `npm run test:integration:suite -- visibility`, `npm run test:file-gateway`, `sh scripts/run-webgl-network-browser.sh chromium firefox webkit`, and the optional real-form PostgreSQL browser case below. The transport runner uses an isolated container trust store and keeps certificate verification enabled. It opens two real TLS listeners for one approved hostname; documents and dedicated Workers must both fetch HTTPS bodies and receive WSS echoes on both ports for `:*`, and must send no traffic to the second port for a fixed-port rule. It also checks unapproved hosts, wildcard root exclusion, redirect targets, external executable sources, other runtime paths, CORS failures and Origin/auth failures.

```sh
npm run build
RUN_WEBGL_FORM_BROWSER=true \
  PLAYWRIGHT_MODULE_PATH=/absolute/path/node_modules/playwright/index.mjs \
  BROWSER_EXECUTABLE=/absolute/path/to/chromium \
  npm run test:integration:suite -- visibility
npm run test:file-gateway
sh scripts/run-webgl-network-browser.sh chromium firefox webkit
```

The real-form case uses actual React forms, HTTP, authentication cookies, CSRF checks, production controllers/serializers and migrated isolated PostgreSQL. It checks owner submission, administrator approval, unchanged old sessions and new-session document/Worker response CSP. Local fixture identities replace OAuth sign-in, and tiny object responses replace Garage bytes; the separate real nginx fixtures verify gateway behavior. This does not claim production OAuth, DNS, proxy topology, live service accounts or actual multiplayer acceptance. Default unit/CI runs without the optional browser flag report this case as skipped, not passed.

### Local results for the current PR revision

- Real-form PostgreSQL visibility suite: 44 passed, including actual Chromium 150.0.7871.46 form submission and admin review, approved snapshots and document/Worker response CSP. Isolated migrated schemas were removed after the run. OAuth was not exercised.
- Strict-TLS transport fixture: Chromium 145.0.7632.6, Firefox 146.0.1 and WebKit 26.0 each passed fixed-port, exact-host/all-port and subdomain/all-port policies in both document and dedicated Worker. TLS uses a test CA and signed leaf in a disposable trust store, with no certificate-error bypass. Initial self-signed-leaf Firefox trust failure was resolved by using this CA/leaf chain. WebKit Worker violation-event omissions are separate from verified traffic blocking and report-uri receipt.
- Both nginx gateway templates passed live auth-CSP propagation, missing-policy denial, executable isolation and report constraints; trusted upstream TLS passed and wrong hostname/untrusted certificates failed closed.
- `npm test`: API 1,208, API script Vitest 75, release-artifact Node tests 31, Web 820 and contracts 153 passed. The default run skipped 248 environment-dependent API cases; these are not counted as passed. The separately enabled PostgreSQL/browser suite is reported above.
- `npm run lint`, `npm run architecture`, `npm run build`, release-control tests, CI classifier/workflow/integration-runner tests, migration-history guard and diff whitespace checks passed. The existing diagnostic migration's unique-index review signal remains; no migration was added in this follow-up. Audit passed the high-severity threshold with seven moderate findings; Web retains its existing large-chunk warning.
- The full Docker/Garage integration baseline is delegated to the PR's required `integration` CI job. Final PR CI status is recorded on the PR rather than presumed by this local evidence. No real project approvals, operational data or deployment were changed.

## Historical implementation baseline — PR #69

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
