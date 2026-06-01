# Dead Code, Stale Docs, And Drift Review

This pass treats "dead" broadly: unreferenced code/assets, stale documentation, stale env/workflow config, and API/contract drift. Public assets, migrations, deploy scripts, and shared contracts are not marked safe-to-delete without external dependency checks.

## Findings

### DEAD-001

- ID: DEAD-001
- Severity: P2
- Category: Stale documentation contradicts current implementation
- Evidence: `docs/01_ARCHITECTURE.md:78-80`, `docs/01_ARCHITECTURE.md:223`, `docs/01_ARCHITECTURE.md:273-275`, `docs/03_DEPLOYMENT_AND_ENV.md:35`, `apps/web/src/app/router.tsx:129-139`, `apps/api/src/plugins/cors.ts:6-10`, `apps/api/src/modules/auth/service.ts:75-77`, `apps/web/src/lib/api/mock/handler.ts:109-134`
- Affected flow: 개발
- Why it matters: docs still describe resolved issues as current risks: missing `/admin` redirect, missing CORS `PUT`, Google hosted-domain 401/403 mismatch, and missing mock exhibition projects handler. Future maintainers may spend time fixing already-fixed behavior or reintroduce old assumptions.
- Reproduction or verification steps: compare the cited docs against the cited code paths.
- Recommended fix: docs-only PR that updates stale sections and labels historical issues as resolved.
- Test plan: no runtime test required; run `rg` checks for the stale phrases after doc edit.
- Suggested PR size: Small
- Do-not-do: Do not change router/auth/CORS/mock behavior in the docs cleanup PR.

### DEAD-002

- ID: DEAD-002
- Severity: P2
- Category: Missing production server env example
- Evidence: `server/deploy.sh:163-193`, `docs/03_DEPLOYMENT_AND_ENV.md:194-245`
- Affected flow: 배포
- Why it matters: production deployment requires server-side variables, but the repo does not provide a server-level `.env.example`. The existing examples are app-local and do not fully document the production deploy surface, increasing the chance of missing auth, storage, cookie, or domain policy variables.
- Reproduction or verification steps: run `rg --files -uu -g ".env*" -g "!node_modules" -g "!apps/**/node_modules" -g "!apps/web/dist"` and compare the result with variables consumed by `server/deploy.sh`.
- Recommended fix: add a `server/.env.example` or equivalent production env template with placeholder values and comments for required/optional settings.
- Test plan: docs/config review plus a script or checklist that every `server/deploy.sh` env read is represented in the example.
- Suggested PR size: Small
- Do-not-do: Do not copy values from real `.env` files into the example.

### DEAD-003

- ID: DEAD-003
- Severity: P3
- Category: Stale deploy workflow trigger and secret naming
- Evidence: `.github/workflows/deploy-api.yml:6-13`, `.github/workflows/deploy-api.yml:80`, `.github/workflows/deploy-api.yml:100-102`, `docs/00_CURRENT_STATE.md:73`, `docs/03_DEPLOYMENT_AND_ENV.md:318-323`
- Affected flow: 배포
- Why it matters: the API deploy workflow watches root `docker-compose.yml`, but that file is absent. The workflow also uses `DEPLOY_COMPOSE_PATH` naming while current deploy is `server/deploy.sh` plus Podman. This is operational drift and makes CI/deploy triggers harder to reason about.
- Reproduction or verification steps: run `rg --files | rg "(^docker-compose.yml$|docker-compose)"` and inspect workflow path filters.
- Recommended fix: remove the absent root compose trigger or replace it with the actual relevant files, and rename deploy secret/env labels when safe.
- Test plan: GitHub Actions path-filter review, manual workflow dispatch, and confirmation that changes to `server/deploy.sh` and API Dockerfile still trigger deploy.
- Suggested PR size: Small
- Do-not-do: Do not rewrite the deployment topology in this cleanup PR.

### DEAD-004

- ID: DEAD-004
- Severity: P2
- Category: Stale env variable / behavior drift
- Evidence: `apps/api/src/config/env.ts:41-47`, `apps/api/.env.example:35`, `server/deploy.sh:179-181`, `apps/api/src/modules/admin/project/service.ts:257-305`, `docs/06_V0_2_BACKLOG.md:74-84`
- Affected flow: 관리자, 배포, 개발
- Why it matters: `AUTO_PUBLISH_DEFAULT` remains in schema/example/deploy, but `submitProject()` always creates `PUBLISHED` projects. Operators may believe they can toggle default publication behavior, while the runtime ignores the setting.
- Reproduction or verification steps: set `AUTO_PUBLISH_DEFAULT=false`, submit a project, and inspect created status. Code currently assigns `const status: ProjectStatus = 'PUBLISHED'`.
- Recommended fix: decide policy. Either remove the env everywhere and document always-publish behavior, or implement the env with contract/tests around draft/publication rules.
- Test plan: API submit tests for chosen status policy and env schema/example consistency checks.
- Suggested PR size: Small
- Do-not-do: Do not reintroduce `DRAFT` status without checking the migration that removed it and all UI assumptions.

### DEAD-005

- ID: DEAD-005
- Severity: P2
- Category: DB/import/API contract drift
- Evidence: `apps/api/prisma/schema.prisma:92-120`, `apps/api/src/modules/admin/import/service.ts:15-24`, `apps/api/src/modules/admin/import/service.ts:193-194`, `apps/api/src/modules/admin/import/repository.ts:48-49`, `packages/contracts/src/index.ts:124-139`, `packages/contracts/src/index.ts:192-218`, `apps/api/src/modules/admin/project/serializer.ts:67-101`, `apps/api/src/modules/public/service.ts:156-177`
- Affected flow: 관리자, 사용자, 배포
- Why it matters: `githubUrl` and `platforms` are part of the database and import schema, but public/admin detail contracts and serializers do not expose them. Imported data can be silently stored but become invisible to the UI/API.
- Reproduction or verification steps: import a project JSON with `githubUrl` and `platforms`, then fetch public/admin project detail and inspect the response.
- Recommended fix: decide whether these fields are product features. If yes, add them to contracts, serializers, API tests, and UI. If no, stop accepting/importing them after a DB/data compatibility review.
- Test plan: contract tests for import-to-detail round trip, public/admin serializer tests, and UI display/edit tests if fields remain.
- Suggested PR size: Medium
- Do-not-do: Do not drop DB columns before checking existing production data and import compatibility.

### DEAD-006

- ID: DEAD-006
- Severity: P2
- Category: Runtime contract drift around member account linking
- Evidence: `packages/contracts/src/index.ts:247-251`, `apps/api/src/shared/validation.ts:61-66`, `apps/api/src/modules/admin/member/controller.ts:23-34`, `apps/api/src/modules/admin/member/service.ts:14-27`
- Affected flow: 관리자, 사용자
- Why it matters: the shared `UpdateMemberRequest` contract has no `userId`, while runtime validation accepts and applies `userId`. This drift hides an authorization-sensitive field from consumers and tests, and it overlaps with `SEC-001`.
- Reproduction or verification steps: compile a client against `UpdateMemberRequest`, then call the API manually with `userId` and observe that runtime accepts it.
- Recommended fix: after fixing `SEC-001`, align the contract with the chosen policy: either remove runtime support from normal member updates or expose an admin-only contract type.
- Test plan: contract compile test plus API tests for allowed/disallowed member patch fields.
- Suggested PR size: Small
- Do-not-do: Do not simply add `userId` to the general user-facing contract without first fixing the authorization boundary.

### DEAD-007

- ID: DEAD-007
- Severity: P3
- Category: Legacy upload fields/env are compatibility-risk, not immediate delete candidates
- Evidence: `apps/api/prisma/schema.prisma:184-211`, `apps/api/prisma/migrations/0_init/migration.sql:107-127`, `apps/api/src/config/env.ts:41-47`, `apps/api/scripts/migrate-to-s3.ts:16-22`, `server/deploy.sh:179-181`, `docs/04_OBSOLETE_OR_SUSPICIOUS_FILES.md:232-247`
- Affected flow: 배포, 개발
- Why it matters: `GameUploadSession.stagingPath` is marked legacy and `UPLOAD_ROOT_PUBLIC/PROTECTED` are no longer part of the active S3-first upload path. However, migrations and migration scripts still reference the old storage model, so deleting fields/env/scripts prematurely can break historical DB compatibility or one-time migration/recovery work.
- Reproduction or verification steps: inspect schema/migration/script references, then verify whether production has already completed S3 migration and whether any rollback/recovery process still needs local storage roots.
- Recommended fix: document these as migration-only; later, create a dedicated decommission PR with DB migration, deploy cleanup, and an operator sign-off checklist.
- Test plan: Prisma migration deploy on a production-like DB snapshot, migration-script smoke test or explicit deprecation decision, and deploy script validation.
- Suggested PR size: Medium
- Do-not-do: Do not delete `stagingPath`, `UPLOAD_ROOT_*`, or `migrate-to-s3.ts` in a generic cleanup PR.

### DEAD-008

- ID: DEAD-008
- Severity: P3
- Category: Migration tree drift
- Evidence: `prisma/migrations/20260416000000_remove_unused_upload_job_model/migration.sql:1-2`, `apps/api/prisma/migrations/migration_lock.toml:1-3`, `apps/api/prisma/migrations/0_init/migration.sql:1-16`, `docs/04_OBSOLETE_OR_SUSPICIOUS_FILES.md:15-19`
- Affected flow: 배포, 개발
- Why it matters: the repo has a root-level Prisma migration outside `apps/api/prisma/migrations`. It may be stale, but migration history is stateful and can be tied to existing databases. Deleting it without checking `_prisma_migrations` risks breaking deploy or recovery documentation.
- Reproduction or verification steps: compare `prisma/migrations` and `apps/api/prisma/migrations`, then inspect production/staging `_prisma_migrations` records for the root migration name before deleting anything.
- Recommended fix: create an operational audit PR that documents which migration directory is authoritative and whether the root migration has ever been applied.
- Test plan: `prisma migrate status` against dev/test DB and read-only production migration-table check by an operator.
- Suggested PR size: Small
- Do-not-do: Do not delete migration files only because they are not in the active app migration directory.

### DEAD-009

- ID: DEAD-009
- Severity: P3
- Category: Source/public asset inventory
- Evidence: `docs/04_OBSOLETE_OR_SUSPICIOUS_FILES.md:69-143`, `apps/web/src/pages/HomePage.tsx:34`, `apps/web/src/components/layout/Header.tsx:13`, `apps/web/src/components/layout/MobileTopBar.tsx:8`
- Affected flow: 사용자, 배포
- Why it matters: source search confirms the app currently uses `/pcu_signature.svg`, while several source/public assets are listed as unreferenced or uncertain. Source-only assets are likely cleanup candidates; public assets are deletion-risk because external URLs, bookmarks, docs, or old deployments can depend on them.
- Reproduction or verification steps: run `rg -n "pcu_signature|pcu_logo|vite\\.svg|hero\\.png|pcu_game_character|icons\\.svg" apps/web/src apps/web/public apps/web/index.html` and compare with Vite `dist` output after build.
- Recommended fix: split into two PRs: first remove confirmed source-only unused assets after a build/UI smoke test; second create an external URL/public asset retention decision.
- Test plan: web build, visual smoke test, and deployment artifact diff. For public assets, check access logs or public docs before deletion.
- Suggested PR size: Small
- Do-not-do: Do not delete public assets in the same PR as source-only asset cleanup.

### DEAD-010

- ID: DEAD-010
- Severity: P3
- Category: Mock coverage and contract drift can be hidden
- Evidence: `apps/web/src/lib/api/mock/data.ts:3-5`, `apps/web/src/lib/api/mock/handler.ts:404-422`
- Affected flow: mock, 개발, test
- Why it matters: mock data intentionally avoids importing contracts so contract changes do not break the mock build, and unhandled mock routes return `undefined as T`. That keeps mock mode flexible, but it can hide backend/client drift and make UI-only validation pass with responses real APIs would not return.
- Reproduction or verification steps: change a contract response field used by real API but not mock data, then run web mock mode and observe whether TypeScript/tests catch it.
- Recommended fix: add narrow contract smoke tests for mock handlers or use `satisfies` on selected response builders without importing production runtime code into the app bundle.
- Test plan: web tests that exercise key mock routes and fail on missing required fields; build check ensuring mock code remains excluded from production bundle after `PERF-005`.
- Suggested PR size: Small
- Do-not-do: Do not make mock data a source of truth for backend behavior.

### DEAD-011

- ID: DEAD-011
- Severity: P3
- Category: Stale runtime package/install step
- Evidence: `apps/api/Dockerfile:20-24`, `apps/api/Dockerfile:59-67`, `apps/api/Dockerfile:77-80`, `apps/api/package.json:6-17`
- Affected flow: 배포
- Why it matters: the API runtime image globally installs `tsx`, but production starts with `node dist/server.js`. `tsx` is a dev/runtime script tool in `apps/api/package.json`, not part of the production `CMD`.
- Reproduction or verification steps: build the API container and run `which tsx` inside the runner image; compare with `CMD`.
- Recommended fix: remove the global `tsx` install from the runner stage after confirming no deploy/start path invokes it.
- Test plan: Docker build and container healthcheck.
- Suggested PR size: Small
- Do-not-do: Do not remove workspace/package dependencies that are needed for Prisma, sharp, pdf/image processing, or migrations.

## Deletion Classification

Likely deletion candidates after verification:

- `apps/web/src/assets/vite.svg`
- `apps/web/src/assets/hero.png`
- global `tsx` install in the API Docker runner stage

Deletion-hold / operator-check required:

- all Prisma migration files
- root-level `prisma/migrations/*`
- `GameUploadSession.stagingPath`
- `UPLOAD_ROOT_PUBLIC` / `UPLOAD_ROOT_PROTECTED`
- `apps/api/scripts/migrate-to-s3.ts`
- all files under `apps/web/public/*` until external URL usage is checked
- shared contract fields/types until runtime contract tests exist
