# Code Review Index

Date: 2026-06-01

Scope: first-pass repository audit for performance, security, dead code, stale docs/config/workflows, and contract drift. No app code was changed in this pass.

## Reports

- `docs/reviews/01_PERFORMANCE_REVIEW.md`
- `docs/reviews/02_SECURITY_REVIEW.md`
- `docs/reviews/03_DEAD_CODE_REVIEW.md`
- `docs/reviews/04_PRIORITIZED_FIX_PLAN.md`

## Highest Priority Findings

1. `SEC-001`: project members can update `ProjectMember.userId` through a non-admin route, which can grant another account project write/protected-asset access.
2. `SEC-002` / `PERF-002`: upload paths can place large request bodies into memory or temp storage before the tightest kind-specific limit is enforced.
3. `SEC-004`: `npm audit --omit=dev` reports high severity production dependency advisories, including Fastify.
4. `PERF-001`: admin/public list APIs return unbounded project lists and the web UI filters/sorts/renders the full result client-side.
5. `DEAD-005`: `githubUrl` and `platforms` exist in DB/import paths but are absent from API serializers/contracts.

## Seed Issue Verification

| Seed issue | Result | Evidence |
| --- | --- | --- |
| Chunked game upload uses `PUT`, but CORS may omit `PUT` | Resolved in current code. CORS includes `PUT`. | `apps/web/src/lib/api/game-upload.ts:187-193`, `apps/api/src/modules/admin/game-upload/controller.ts:44-49`, `apps/api/src/plugins/cors.ts:6-10` |
| Mock mode may lack `/api/public/exhibitions/:id/projects` | Resolved in current code. Handler exists. | `apps/web/src/lib/api/mock/handler.ts:109-134` |
| Google hosted-domain mismatch may be backend 401 while frontend handles only 403 | Resolved in current code, but error-code centralization is still missing. | `apps/api/src/modules/auth/service.ts:75-77`, `apps/web/src/pages/LoginPage.tsx:28-35`, `packages/contracts/src/index.ts:1-3` |
| `/admin` route may lack index redirect | Resolved in current code. | `apps/web/src/app/router.tsx:129-139` |
| Production server-level `.env.example` may be missing | Confirmed. Only root/app example files exist; `server/deploy.sh` still requires production variables. | `server/deploy.sh:163-193`, `docs/03_DEPLOYMENT_AND_ENV.md:194-245` |
| Root `docker-compose.yml` may be referenced but absent | Confirmed. Root compose file is absent; workflow/docs still mention it. | `.github/workflows/deploy-api.yml:6-13`, `docs/00_CURRENT_STATE.md:73`, `docs/03_DEPLOYMENT_AND_ENV.md:318-323` |
| `AUTO_PUBLISH_DEFAULT` may not affect submit behavior | Confirmed. Env/example/deploy keep it, but submit status is hardcoded. | `apps/api/src/config/env.ts:44-47`, `apps/api/.env.example:35`, `server/deploy.sh:181`, `apps/api/src/modules/admin/project/service.ts:301` |
| DB/import may include `githubUrl`/`platforms` while API response omits them | Confirmed. | `apps/api/prisma/schema.prisma:102-103`, `apps/api/src/modules/admin/import/service.ts:23-24`, `apps/api/src/modules/admin/import/repository.ts:48-49`, `packages/contracts/src/index.ts:124-139`, `packages/contracts/src/index.ts:192-218`, `apps/api/src/modules/public/service.ts:156-177`, `apps/api/src/modules/admin/project/serializer.ts:67-101` |
| `GameUploadSession.stagingPath` and `UPLOAD_ROOT_*` may be legacy | Confirmed as migration-only / compatibility-risk, not immediate deletion candidates. | `apps/api/prisma/schema.prisma:184-211`, `apps/api/src/config/env.ts:41-47`, `apps/api/scripts/migrate-to-s3.ts:16-22`, `server/deploy.sh:179-181` |

## Deletion Policy From This Pass

Deletion candidates are limited to items with no runtime/migration/deploy/external URL dependency. Anything under migrations, deploy scripts, shared contracts, or `public/` assets should be treated as deletion-risk until an external dependency check is done.

Likely safe cleanup candidates after a small verification PR:

- `apps/web/src/assets/vite.svg`
- `apps/web/src/assets/hero.png`
- unused runtime package/install steps such as global `tsx` in the API Docker runner image

Deletion-hold items:

- Prisma migrations and root-level migration history
- `GameUploadSession.stagingPath`
- `UPLOAD_ROOT_PUBLIC` / `UPLOAD_ROOT_PROTECTED`
- `apps/api/scripts/migrate-to-s3.ts`
- public assets that may be referenced by external URLs
- shared contract fields/types unless runtime contract tests are added first

## Notes

The worktree was already dirty before this audit. Findings were verified against the current filesystem, not against docs alone. Actual secret files such as `.env`, `apps/api/.env`, and `apps/web/.env.local` were not opened or printed.
