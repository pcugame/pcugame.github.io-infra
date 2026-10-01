# Ticket 3: approved external HTTPS / Addressables / WSS connections

Status: pending ticket 2. Separate PR required.

Project owners submit exact secure origin, purpose, connection mode and required CORS configuration. Administrators approve/reject/revoke with actor, reviewer, reason, timestamps and policy version. States PENDING/APPROVED/REJECTED/REVOKED. Reject wildcard, userinfo, insecure schemes, localhost/private/reserved IP and site authentication/administration origins. No server fetch/proxy validation.

Approval belongs to project and survives next deployment. New execution snapshots approved origins/version; new approvals affect next execution. Existing internal gateway auth provides trusted CSP for document and network Worker responses. Only connect-src extends; script/worker origins stay runtime-local plus necessary blob. Fail closed on policy lookup failure. Revocation invalidates affected sessions immediately for future NAS reads and at next shell renewal/return; already connected external WSS is not remotely terminated.

Shared request/review contracts and project/admin APIs must enforce authorization, duplicate/concurrent review transitions and version changes. External CORS must allow the actual NAS game origin; developer configures Addressables catalog/hash/bundles and WSS auth. No OAuth popup/redirect flow or direct external script support. CSP is not a proof that downloaded bytes cannot become code with Unity eval/blob support.

Acceptance: approved API/Addressables/WSS in actual Unity fixtures on Chrome/Edge/Firefox, unapproved/cross-project/Worker/encoded-path/redirect bypass tests, CORS-vs-CSP guidance, HTTP permission/concurrency/version/revocation tests, CI verify/integration. Feature default off. Production enablement uses established release flow and records exact source/image/NAS/browser evidence.
