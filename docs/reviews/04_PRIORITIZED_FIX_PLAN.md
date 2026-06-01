# Prioritized Fix Plan

This plan is intentionally PR-sized. Do not combine unrelated cleanup with security or contract fixes.

## 1. Must Fix First: Real Security / Operational Risk

1. `SEC-001` / `DEAD-006`: lock down `ProjectMember.userId` updates.
   - PR size: Small
   - Scope: remove `userId` from normal member update or move it to an ADMIN/OPERATOR-only endpoint.
   - Validation: USER cannot link/clear `userId`; privileged path works only if explicitly intended.

2. `SEC-002` / `PERF-002`: bound upload memory and temp-disk usage.
   - PR size: Medium
   - Scope: stream chunk uploads or add strict bounded concurrency; enforce kind-specific limits while streaming single-asset uploads.
   - Validation: concurrent chunk, oversized image/video/game, temp cleanup, and memory regression tests.

3. `SEC-004`: update production dependencies flagged by `npm audit`.
   - PR size: Medium
   - Scope: update lockfile/dependencies, especially Fastify and transitive AWS/Google auth vulnerability paths.
   - Validation: `npm audit --audit-level=high --omit=dev`, `npm test`, `npm run lint`, `npm run build`, auth/upload/asset tests.

4. `SEC-003`: apply rate limiting consistently to protected VIDEO downloads.
   - PR size: Small
   - Scope: either remove the broad protected-asset allowlist from the global limiter or apply a protected download limiter to GAME and VIDEO.
   - Validation: repeated protected VIDEO requests should hit a limit; health endpoints remain unblocked.

5. `SEC-006`: switch Podman login to `--password-stdin`.
   - PR size: Small
   - Scope: workflow-only deploy hardening.
   - Validation: manual workflow dispatch or remote command smoke test.

## 2. Contract Drift To Pin With Tests First

1. `DEAD-005`: decide `githubUrl` / `platforms` behavior.
   - First add failing contract/API tests that import data with these fields and fetch admin/public detail.
   - Then either expose fields through contracts/serializers/UI or stop accepting them with a compatibility plan.

2. `DEAD-004`: decide `AUTO_PUBLISH_DEFAULT`.
   - First add a submit behavior test documenting the desired default status.
   - Then remove the env or implement it. Do not reintroduce `DRAFT` without migration/UI review.

3. Error-code centralization follow-up from seed verification.
   - Current Google hosted-domain behavior is fixed, but `EMAIL_DOMAIN_NOT_ALLOWED` is still a string shared by convention.
   - Add contract constants/types for API error codes before adding more auth/client error handling.

4. `DEAD-010`: add mock contract smoke tests.
   - Keep mock mode useful, but make key mock routes fail tests when required response fields drift from contracts.

## 3. Small PRs For Safe Cleanup

1. `DEAD-001`: docs-only stale issue cleanup.
   - Update architecture/deployment docs to stop describing resolved seed issues as current problems.

2. `DEAD-002`: add `server/.env.example` with placeholders only.
   - Cross-check variables used by `server/deploy.sh`.

3. `DEAD-003`: fix deploy workflow path trigger and stale naming.
   - Remove absent root `docker-compose.yml` trigger or replace with the intended actual path.

4. `DEAD-011` / `PERF-006`: remove global `tsx` from the API Docker runner stage.
   - Verify Docker build and container health.

5. `DEAD-009`: remove confirmed source-only unused assets.
   - Limit first cleanup to `apps/web/src/assets/vite.svg` and `apps/web/src/assets/hero.png` after web build and visual smoke.

## 4. Hold Until Operational Confirmation

1. `DEAD-007`: `GameUploadSession.stagingPath`, `UPLOAD_ROOT_PUBLIC`, `UPLOAD_ROOT_PROTECTED`, and `apps/api/scripts/migrate-to-s3.ts`.
   - Hold until an operator confirms S3 migration is complete and rollback/recovery does not need local storage roots.

2. `DEAD-008`: root-level `prisma/migrations/*`.
   - Hold until `_prisma_migrations` in production/staging is checked read-only.

3. `DEAD-009`: all `apps/web/public/*` assets.
   - Hold until external URL usage, old docs, and deployment access logs are checked.

4. Shared contract field removals.
   - Hold until API and web contract tests pin the current runtime behavior.

## 5. Learning-Value Refactors

1. `PERF-001`: paginated admin/public list APIs.
   - Good learning value: Prisma query design, server-side filtering/sorting, TanStack Query cache keys, and UI page-state design.

2. `PERF-003`: bounded concurrency for storage deletes.
   - Good learning value: remote I/O backpressure, error isolation, and orphan-retry behavior.

3. `PERF-004`: batched export job.
   - Good learning value: background-job progress, batching, abort handling, and memory-safe streaming.

4. `PERF-005`: production bundle/mock split and asset budgeting.
   - Good learning value: Vite env replacement, lazy chunks, build artifact inspection, and public asset governance.

5. `SEC-005` / `SEC-007` / `SEC-008`: auth hardening polish.
   - Good learning value: structured logging redaction, signed cookies vs opaque bearer sessions, and fail-fast production auth policy.

## Command Log

Secret handling note: actual `.env`, `apps/api/.env`, and `apps/web/.env.local` files were not opened or printed. `db:generate` loaded `.env` internally through Prisma; values were not inspected.

| Command | Result |
| --- | --- |
| `git status --short` | Succeeded. Worktree was already dirty before this audit, with many modified/untracked files outside `docs/reviews`. |
| `rg --files` | Succeeded. Confirmed repository file inventory, including absence of root `docker-compose.yml`. |
| `rg --files -uu -g ".env*" -g ".github/**" -g "!node_modules" -g "!apps/**/node_modules" -g "!apps/web/dist"` | Succeeded. Used only to confirm env-example/secret-file presence by filename. |
| `rg -n "TODO|FIXME|HACK|deprecated|legacy|no longer used|DRAFT|AUTO_PUBLISH_DEFAULT|UPLOAD_ROOT|docker-compose.yml|process.env|console.log|any|as any"` | Succeeded. Used as seed search for stale env/docs/config and type escape hatches. |
| `rg -n "findMany|include:|select:|Promise.all|setInterval|setTimeout|createReadStream|readFile|writeFile|Buffer|arrayBuffer|formData|multipart|presign|redirect"` | Succeeded. Used to locate unbounded queries, upload/download, and async/concurrency hotspots. |
| `rg -n "requireRole|currentUser|projectId|assetId|storageKey|protected|public|csrf|cors|cookie|sameSite|secure|rateLimit|trustProxy"` | Succeeded. Used to locate auth, access-control, and rate-limit boundaries. |
| `npm test` | Succeeded. API: 28 test files / 301 tests passed. Web: 10 test files / 58 tests passed. |
| `npm run lint` | Succeeded. API `tsc --noEmit` and web ESLint passed. |
| `npm run build` | Succeeded. API and web built. Vite output showed main JS/CSS chunks, many Pretendard subset font files, and a mock handler chunk. |
| `npm run db:generate --workspace=apps/api` | Succeeded. Prisma Client generated. Prisma reported loading `.env`; values were not read or printed. |
| `npm audit --audit-level=high --omit=dev` | Initial sandbox attempts failed with `windows sandbox: spawn setup refresh`; rerun with approved escalation succeeded and exited 1 due advisories. Result: 7 vulnerabilities, 4 moderate and 3 high; `npm audit fix` reported available. |

## Certainty Notes

- Confirmed: code-level evidence for `SEC-001`, `SEC-002`, `SEC-003`, `DEAD-004`, `DEAD-005`, and seed issue status.
- Confirmed: test/lint/build/db-generate command results.
- Confirmed by command output, not by secret inspection: env file presence and missing server-level production env example.
- Requires operator confirmation before deletion: migration history, legacy upload storage env, S3 migration script, and public assets.
