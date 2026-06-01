# Security Review

This pass focused on authentication, authorization, upload/download abuse, dependency exposure, deploy hardening, and logging. Actual secret files were not opened or printed.

## Findings

### SEC-001

- ID: SEC-001
- Severity: P1
- Category: Authorization / IDOR / project membership mutation
- Evidence: `apps/api/src/modules/admin/member/controller.ts:23-34`, `apps/api/src/shared/validation.ts:61-66`, `apps/api/src/modules/admin/member/service.ts:14-27`, `apps/api/src/modules/admin/project-access.ts:45-52`, `apps/api/src/modules/admin/project/serializer.ts:83-89`
- Affected flow: 사용자, 관리자
- Why it matters: `PATCH /projects/:id/members/:memberId` only requires login plus project write access, but the accepted patch includes `userId`. Since linked `ProjectMember.userId` is later used to grant project write/protected-asset access, a normal project writer can link arbitrary user IDs to member rows. This is a real authorization boundary, not just metadata editing.
- Reproduction or verification steps: as a `USER` who owns or is a linked member of a project, call `PATCH /api/admin/projects/:id/members/:memberId` with `{ "userId": <another user id> }`. Then authenticate as that other user and verify `loadProjectWithAccess` accepts the project because `ProjectMember.userId` matches.
- Recommended fix: split member profile editing from account-link management. Remove `userId` from the normal `UpdateMemberBody`, or allow it only through an ADMIN/OPERATOR-only endpoint with explicit audit tests.
- Test plan: API tests that USER can edit member name/studentId/sortOrder but cannot set or clear `userId`; ADMIN/OPERATOR behavior should be tested according to the chosen policy. Add a regression test that account linking changes project access only through the privileged path.
- Suggested PR size: Small
- Do-not-do: Do not remove member self-service editing entirely; isolate the `userId` permission boundary.

### SEC-002

- ID: SEC-002
- Severity: P1
- Category: Authenticated resource exhaustion through upload paths
- Evidence: `apps/api/src/modules/admin/game-upload/controller.ts:44-49`, `apps/api/src/modules/admin/game-upload/service.ts:184-210`, `apps/api/src/modules/admin/project/controller.ts:108-118`, `apps/api/src/modules/admin/project/service.ts:404-435`
- Affected flow: 사용자, 관리자, 배포
- Why it matters: chunk upload accumulates request chunks in memory and then calls `Buffer.concat`; single-asset upload allows the privileged body limit before exact image/video/game limits are enforced. A logged-in user with project write access can consume API memory or temp disk repeatedly, and protected download/global rate-limit controls do not mitigate uploads.
- Reproduction or verification steps: send several concurrent near-limit chunk PUT requests and observe RSS. Then send an over-limit image file to the single-asset endpoint and observe temp storage growth before the 413 response.
- Recommended fix: stream chunk uploads directly to object storage or introduce a strict per-process upload concurrency limiter and lower per-route body limits. Enforce asset-kind limits while streaming, not after writing the full temp file.
- Test plan: concurrency test around chunk uploads, oversized image/video/game rejection tests, temp cleanup assertions, and process memory checks in integration smoke tests.
- Suggested PR size: Medium
- Do-not-do: Do not weaken ZIP magic-byte, central-directory, or expansion-ratio validation while changing the upload pipeline.

### SEC-003

- ID: SEC-003
- Severity: P2
- Category: Download abuse/rate-limit gap
- Evidence: `apps/api/src/plugins/rate-limit.ts:26-35`, `apps/api/src/shared/download-rate-limit.ts:18-20`, `apps/api/src/modules/assets/service.ts:63-89`
- Affected flow: 사용자, 배포
- Why it matters: the global rate limiter allowlists every `/api/assets/protected/*` request because a domain-specific download limiter is expected. The domain limiter is only applied when `asset.kind === 'GAME'`; protected VIDEO assets still receive presigned redirects without the global limiter or the game-download limiter. This creates an unbounded redirect/download-abuse path for video assets.
- Reproduction or verification steps: request a published project's protected video URL repeatedly from the same IP and compare behavior with a GAME download URL. The GAME path should ban/limit after the threshold; VIDEO should continue returning redirects.
- Recommended fix: either stop allowlisting all protected assets globally, or apply a protected-asset download limiter to both GAME and VIDEO with configurable thresholds.
- Test plan: API tests for GAME and VIDEO protected download rate limiting, including banned-IP persistence and allowlist behavior for health endpoints.
- Suggested PR size: Small
- Do-not-do: Do not make private, unpublished protected assets public while changing limiter behavior.

### SEC-004

- ID: SEC-004
- Severity: P1
- Category: Dependency / supply-chain vulnerabilities
- Evidence: `apps/api/package.json:20-31`, `package-lock.json:18-29`, `package-lock.json:809`, `package-lock.json:2182`, `package-lock.json:2196`, `package-lock.json:2209`, `package-lock.json:2227`, `package-lock.json:2293`, `package-lock.json:3101`
- Affected flow: 배포
- Why it matters: `npm audit --audit-level=high --omit=dev` reports high severity production advisories for Fastify and transitive URI/XML packages, plus moderate advisories through AWS/Google auth dependencies. Fastify advisories are particularly relevant because this API relies on Fastify request parsing, `trustProxy`, CORS, and credentialed cookies.
- Reproduction or verification steps: run `npm audit --audit-level=high --omit=dev`. On 2026-06-01 it reported 7 vulnerabilities, including 3 high severity findings, and stated `npm audit fix` is available.
- Recommended fix: open a dependency-update PR that updates lockfile and production dependencies, then rerun the full API/web test/build suite. Review Fastify release notes for behavior changes around schema validation, request host/protocol, and plugins.
- Test plan: `npm audit --audit-level=high --omit=dev`, `npm test`, `npm run lint`, `npm run build`, auth/login tests, upload tests, and protected asset redirect tests.
- Suggested PR size: Medium
- Do-not-do: Do not run a blind `npm audit fix --force` or combine dependency upgrades with app refactors.

### SEC-005

- ID: SEC-005
- Severity: P2
- Category: Logging / PII and auth configuration leakage
- Evidence: `apps/api/src/modules/auth/service.ts:61-68`, `apps/api/src/modules/auth/service.ts:73-77`
- Affected flow: 사용자, 배포
- Why it matters: Google token verification failure logs include the configured audience list, and every Google login attempt logs the user's email and hosted-domain data. Email/student identifiers are PII in this project context; auth configuration in logs also increases blast radius if logs are broadly accessible.
- Reproduction or verification steps: submit an invalid Google credential and inspect API logs; then submit a valid credential with disallowed hosted domain and inspect logged fields.
- Recommended fix: redact or hash user email, log only domain-level metadata where necessary, and remove configured OAuth audience values from error logs. Keep structured error codes for debugging.
- Test plan: logger-unit test or integration logger spy proving invalid-token/domain-rejected paths do not emit raw email, token, cookie, or OAuth audience values.
- Suggested PR size: Small
- Do-not-do: Do not remove all auth logging; keep enough non-PII fields for operations.

### SEC-006

- ID: SEC-006
- Severity: P2
- Category: Deploy secret handling
- Evidence: `.github/workflows/deploy-api.yml:91-102`
- Affected flow: 배포
- Why it matters: the remote deploy step runs `podman login ghcr.io -u "${GHCR_USERNAME}" -p "${GHCR_TOKEN}"`. Passing a token as a command-line argument can expose it through process inspection on the remote host during execution.
- Reproduction or verification steps: inspect the workflow command at `.github/workflows/deploy-api.yml:95`; compare with Podman's `--password-stdin` pattern.
- Recommended fix: change the remote login command to pipe the token through stdin, for example `printf '%s' "$GHCR_TOKEN" | podman login ghcr.io -u "$GHCR_USERNAME" --password-stdin`.
- Test plan: dry-run the workflow or test the remote command with a scoped token; verify no token appears in shell history, logs, or process arguments.
- Suggested PR size: Small
- Do-not-do: Do not rename or rotate secrets in the same PR unless an actual exposure has been confirmed.

### SEC-007

- ID: SEC-007
- Severity: P3
- Category: Session cookie hardening
- Evidence: `apps/api/src/plugins/cookie.ts:5-9`, `apps/api/src/modules/auth/controller.ts:24-30`, `apps/api/src/plugins/auth.ts:23-31`, `apps/api/src/plugins/auth.ts:52-58`, `apps/api/src/shared/session.ts:4-10`
- Affected flow: 사용자
- Why it matters: the cookie plugin is configured with `SESSION_SECRET`, but session cookies are not set with `signed: true` and are read directly from `request.cookies`. The current session ID is a 32-byte random opaque database key and cookies are HttpOnly/Secure/SameSite-configured, so this is not an immediate auth bypass. It is still a hardening gap relative to the configured secret and review checklist.
- Reproduction or verification steps: log in and inspect the cookie value format; it is the raw session ID rather than Fastify's signed cookie format.
- Recommended fix: either sign the session cookie and verify with `request.unsignCookie`, or document that the cookie is intentionally unsigned because the value is an opaque random bearer token and the DB is the source of truth.
- Test plan: auth tests for login, sliding refresh, logout, tampered signed cookie, idle expiration, and absolute expiration.
- Suggested PR size: Small
- Do-not-do: Do not change cookie name/domain/SameSite policy without browser regression testing.

### SEC-008

- ID: SEC-008
- Severity: P3
- Category: Production auth policy drift
- Evidence: `apps/api/src/config/env.ts:24-33`, `apps/api/src/config/env.ts:155-158`, `server/deploy.sh:175`
- Affected flow: 배포
- Why it matters: `ALLOWED_GOOGLE_HD` defaults to an empty string and production deploy permits an empty value. The API warns that any Google account can sign up when it is empty. If the intended production policy is school-domain-only access, a missing env var silently opens registration.
- Reproduction or verification steps: start API with production-like env and no `ALLOWED_GOOGLE_HD`; observe the warning and successful config load.
- Recommended fix: decide the production policy. If school-domain-only is required, fail fast in production when `ALLOWED_GOOGLE_HD` is empty unless an explicit `ALLOW_ANY_GOOGLE_DOMAIN=true` escape hatch is set.
- Test plan: env-loading tests for production with empty/non-empty hosted domain settings and login tests for allowed/disallowed domains.
- Suggested PR size: Small
- Do-not-do: Do not hardcode the domain in application code; keep policy env-driven and documented.

## Verified Controls

- Google ID token audience verification uses `GOOGLE_CLIENT_IDS`: `apps/api/src/modules/auth/service.ts:61-64`.
- CSRF origin checks run for non-GET/HEAD/OPTIONS requests: `apps/api/src/plugins/csrf.ts:16-41`.
- CORS currently allows `PUT`, so chunked upload preflight is covered: `apps/api/src/plugins/cors.ts:6-10`.
- Dev-auth routes are disabled in production by both `DEV_AUTH_ENABLED` and `NODE_ENV`: `apps/api/src/app.ts:34-36`.
