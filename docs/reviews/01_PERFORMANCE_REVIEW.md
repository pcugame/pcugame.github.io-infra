# Performance Review

This pass focused on user-visible latency, resource exhaustion risk, unnecessary runtime cost, and places where simpler bounded logic would be safer.

## Findings

### PERF-001

- ID: PERF-001
- Severity: P2
- Category: Unbounded list APIs, client-side search/sort/render pressure
- Evidence: `apps/api/src/modules/admin/project/repository.ts:16-38`, `apps/api/src/modules/admin/project/controller.ts:13-18`, `apps/api/src/modules/public/repository.ts:22-30`, `apps/api/src/modules/public/service.ts:46-77`, `apps/api/src/modules/public/service.ts:81-109`, `apps/web/src/pages/admin/AdminProjectsPage.tsx:40-43`, `apps/web/src/pages/admin/AdminProjectsPage.tsx:81-112`, `apps/web/src/pages/admin/AdminProjectsPage.tsx:319-354`, `apps/web/src/pages/admin/AdminProjectsPage.tsx:372-414`, `apps/web/src/pages/YearProjectsPage.tsx:47-63`, `apps/web/src/pages/YearProjectsPage.tsx:165-168`, `apps/web/src/pages/ExhibitionProjectsPage.tsx:37-49`
- Affected flow: 사용자, 관리자
- Why it matters: admin and public project lists fetch all matching projects with included members/poster metadata, then filter, count, sort, and render all rows/cards in the browser. This is fine for a small graduation dataset, but it has no hard bound and will degrade predictably as years/assets/members grow.
- Reproduction or verification steps: seed a few thousand projects with members and posters, open `/admin/projects` and `/years/:year`, then measure API payload size, render time, and input latency while searching/sorting.
- Recommended fix: add pagination and server-side filtering/sorting for admin list endpoints first. For public year/exhibition pages, add `limit`, `cursor` or `page`, and optional search query support; keep poster/member fields selected narrowly. Consider virtualized rendering only after the API is bounded.
- Test plan: API tests for default limit, explicit limit cap, cursor/page behavior, role-filtered admin list, and public list ordering. Web integration tests for search/page transitions and bulk selection across pages.
- Suggested PR size: Medium
- Do-not-do: Do not combine with visual redesign, route renaming, or project detail serializer changes.

### PERF-002

- ID: PERF-002
- Severity: P1
- Category: Upload memory/temp-disk pressure and missing bounded concurrency
- Evidence: `apps/api/src/modules/admin/game-upload/controller.ts:44-49`, `apps/api/src/modules/admin/game-upload/service.ts:184-210`, `apps/web/src/lib/api/game-upload.ts:174-209`, `apps/api/src/modules/admin/project/controller.ts:108-118`, `apps/api/src/modules/admin/project/service.ts:404-435`
- Affected flow: 사용자, 관리자
- Why it matters: chunked game upload accepts up to a large body limit per chunk and then concatenates chunk buffers before S3 upload. The single-asset upload route uses the privileged request body limit for all asset kinds and only applies the exact kind-specific limit after the file has been streamed to temp storage. A logged-in user with project write access can consume memory or temp disk well before the final validation rejects the payload.
- Reproduction or verification steps: upload multiple concurrent near-limit chunks to `PUT /api/admin/game-upload-sessions/:id/chunks/:index`; separately, upload a very large file with `kind=IMAGE` to `POST /api/admin/projects/:id/assets` and watch process RSS/temp disk before rejection.
- Recommended fix: stream chunk bodies to S3 multipart without `Buffer.concat`, or add a small per-process upload semaphore and a lower per-chunk body limit. For single-asset upload, require/validate the asset kind before accepting a large file stream, then enforce the exact kind limit during streaming rather than after temp write.
- Test plan: API tests for oversized image/video/game files, concurrent chunk uploads, temp cleanup after rejection, and memory regression checks around chunk upload. Add a test that USER upload cannot exceed non-game image limits before temp file growth.
- Suggested PR size: Medium
- Do-not-do: Do not change S3 object key format or ZIP validation behavior in the same PR.

### PERF-003

- ID: PERF-003
- Severity: P2
- Category: Unbounded `Promise.all` for object storage deletes
- Evidence: `apps/api/src/modules/admin/project/service.ts:98-105`, `apps/api/src/modules/admin/project/service.ts:508-518`
- Affected flow: 관리자, 배포
- Why it matters: deleting one project or bulk deleting up to 500 projects can issue object-storage deletes for every related asset at once. That can overload Garage/S3, increase tail latency, and make a user-facing delete operation depend on a burst of remote calls.
- Reproduction or verification steps: seed projects with many images/videos, run bulk delete for the maximum allowed project count, and observe concurrent S3 delete calls plus API latency.
- Recommended fix: use bounded concurrency for `deleteAssetObjects` calls, for example 3-5 in flight per request, while keeping `safeDeleteObject` and orphan-queue fallback semantics.
- Test plan: unit test that failures still enqueue orphan cleanup, integration test that bulk delete succeeds with many assets, and a small fake-storage test proving concurrency never exceeds the configured bound.
- Suggested PR size: Small
- Do-not-do: Do not remove the orphan reaper or make DB deletion depend on perfect storage deletion.

### PERF-004

- ID: PERF-004
- Severity: P2
- Category: Export job loads all project/asset metadata at once
- Evidence: `apps/api/src/modules/admin/export/repository.ts:18-41`, `apps/api/src/modules/admin/export/service.ts:145-172`
- Affected flow: 관리자, 배포
- Why it matters: export fetches every matching project with all READY assets before starting downloads, then computes totals from the full in-memory array. For large cohorts this can increase API memory and delay progress feedback before the first file is written.
- Reproduction or verification steps: seed many projects/assets and run admin export without a year filter. Measure memory before and after `findProjectsWithAssets`, and measure time before progress moves from `preparing` to `downloading`.
- Recommended fix: batch projects by year/id cursor and compute progress incrementally. If exact total counts are required, run a cheap count query first rather than materializing all metadata.
- Test plan: export integration test with multiple batches, abort handling between batches, and dry-run output parity with current small dataset behavior.
- Suggested PR size: Medium
- Do-not-do: Do not change NAS folder layout or overwrite/skip semantics in this PR.

### PERF-005

- ID: PERF-005
- Severity: P3
- Category: Web bundle/static asset weight
- Evidence: `apps/web/src/lib/api/client.ts:30-36`, `apps/web/src/styles/index.css:5`, `apps/web/src/pages/HomePage.tsx:34`, `apps/web/src/components/layout/Header.tsx:13`, `apps/web/src/components/layout/MobileTopBar.tsx:8`, `docs/04_OBSOLETE_OR_SUSPICIOUS_FILES.md:91-143`
- Affected flow: 사용자, 개발, mock
- Why it matters: production build emitted a mock-handler chunk even though mock mode should be development-only, and the Pretendard dynamic subset import produced many font assets. Public assets are copied by Vite even when source references are absent, so large poster/PNG/WebP variants can increase deploy size and cache churn.
- Reproduction or verification steps: run `npm run build`, inspect `apps/web/dist/assets`, and compare emitted chunks/assets with source references. The 2026-06-01 build emitted `handler-*.js`, `index-*.css`, and many `PretendardVariable.subset.*.woff2` files.
- Recommended fix: make mock code dev-only with a static build-time guard that Vite can eliminate, or move mock handler behind a separate dev entry. Review whether dynamic font subsetting is worth the emitted asset count; if not, use a narrower font loading strategy. Inventory public assets before removal.
- Test plan: build test or CI artifact check that production build excludes mock handler chunks; visual smoke test after font strategy change; asset inventory checklist before deleting public files.
- Suggested PR size: Small
- Do-not-do: Do not delete `apps/web/public/*` assets only because `rg` finds no source import; public URLs may be external contracts.

### PERF-006

- ID: PERF-006
- Severity: P3
- Category: API Docker runtime image carries avoidable install/runtime weight
- Evidence: `apps/api/Dockerfile:20-24`, `apps/api/Dockerfile:59-67`, `apps/api/Dockerfile:77-80`
- Affected flow: 배포
- Why it matters: the API image installs workspace dependencies at the root, copies root and API `node_modules` into the runner, then globally installs `tsx` even though the runtime command is `node dist/server.js`. This increases image size and supply-chain surface without serving the production start path.
- Reproduction or verification steps: build the API image and inspect layer sizes/package list. Confirm `tsx` is not used by `CMD`.
- Recommended fix: remove unused global `tsx` from the runner stage and evaluate `npm prune --omit=dev` or a production-only workspace install that still keeps Prisma, sharp, and native PDF/image dependencies working.
- Test plan: Docker build, container healthcheck, Prisma migration start, upload/image-processing smoke tests, and deploy workflow build.
- Suggested PR size: Small
- Do-not-do: Do not remove `ffmpeg`, `wget`, OpenSSL, Prisma generation, or sharp native-package workarounds without a container smoke test.
