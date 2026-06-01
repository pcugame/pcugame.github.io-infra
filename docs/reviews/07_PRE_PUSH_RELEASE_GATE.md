# Pre-Push Release Gate

작성일: 2026-06-01

검증 범위: 현재 dirty worktree를 GitHub에 push해도 되는지 확인했다. 앱 코드, dependency, formatting, 파일 삭제는 수행하지 않았다. 실제 `.env`류 secret 파일은 열거나 출력하지 않았다.

## Verdict

- SAFE_TO_PUSH_FEATURE_BRANCH: no
- SAFE_TO_PUSH_MASTER: no
- SAFE_TO_DEPLOY_PRODUCTION: no

판정 기준: test/lint/build/audit는 통과했지만, 현재 worktree에는 여러 작업의 변경분과 untracked local artifacts가 섞여 있다. 지금 상태를 그대로 stage/push하면 feature branch에도 불필요한 파일이 들어갈 위험이 있다. master push는 web/API deploy workflow를 트리거할 수 있고 Docker image build가 로컬에서 완료 검증되지 않았다.

## Push Blockers

- BLK-001: current worktree is not safe to push as-is
- evidence: `git status --short` shows broad modified/untracked scope across API, web, docs, workflows, integration files, local analysis files, prompt drafts, and images. Suspicious unrelated files include `20-reflective-stonebraker.md`, `analysis/*`, `design_problem.png`, `left-problems.md`, `prompts/*`, and `docs/llm/*`.
- required fix: stage only intentional files by commit group. Do not include local notes, prompt drafts, analysis scripts, generated images, or unrelated untracked files. Re-run `git status --short`, `git diff --cached --stat`, `git diff --cached --name-status`, and the validation commands before pushing.

## Warnings

- WARN-001: Docker API image build was not completed locally
- evidence: `docker build -f apps/api/Dockerfile .` was attempted after sandbox escalation and timed out after about 5 minutes with no successful build result. Follow-up `docker version` and `docker ps` showed Docker client installed but daemon unavailable: `failed to connect to the docker API at npipe:////./pipe/docker_engine`.
- why acceptable or not: not acceptable for production deploy readiness; acceptable only for feature branch review if CI performs Docker build.

- WARN-002: production web build still emits mock handler chunk
- evidence: `npm run build` output includes `dist/assets/handler-*.js`; source still dynamically imports `./mock/handler` behind `import.meta.env.VITE_MOCK === 'true'`.
- why acceptable or not: not a push blocker because build succeeds and mock code is gated, but it remains the `PERF-005` warning from the performance review.

- WARN-003: API Dockerfile still installs global `tsx`
- evidence: `apps/api/Dockerfile` still contains `RUN npm install -g tsx`, while runtime `CMD` is `npx prisma migrate deploy && node dist/server.js`.
- why acceptable or not: not a functional blocker because runtime CMD is normal, but cleanup from `PERF-006`/`DEAD-011` is not complete.

- WARN-004: API deploy workflow still watches absent root `docker-compose.yml`
- evidence: `.github/workflows/deploy-api.yml` path trigger still includes `docker-compose.yml`, while docs state root `docker-compose.yml` is absent.
- why acceptable or not: not introduced by the current API workflow diff, but still stale deploy trigger drift.

- WARN-005: Prisma schema changed without a migration
- evidence: `apps/api/prisma/schema.prisma` diff is a comment-only change: `game files` to `protected assets` for `BannedIp`.
- why acceptable or not: acceptable because there is no database shape change. Any future model/field/index change needs migration plus migrate status/deploy verification.

## Validation Results

- command: `git status --short`
- result: passed
- summary: dirty worktree is broad; modified/staged/untracked files are mixed. No `dist`, `node_modules`, tracked `.env`, local DB, or storage files appeared in status.

- command: `git diff --stat`
- result: passed
- summary: 70 tracked files changed, 3131 insertions and 1997 deletions. Large scope includes API, web, contracts, docs, workflow, root package files, and lockfile.

- command: `git diff --name-status`
- result: passed
- summary: tracked changes are modifications only. No tracked deletions were reported.

- command: `git diff --check`
- result: passed
- summary: no whitespace errors. Git printed CRLF conversion warnings only.

- command: `git log --oneline -5`
- result: passed
- summary: latest commits are `fd579ca fix: harden asset upload validation`, `bc2a4fa feat: add UCM account help link on login page`, `df082b7 fix: improve project search matching`, `bb0a410 feat: truncate members at 2 in project card, add video dot nav in modal`, `911056a feat: remove DRAFT project status, add exhibition posters, upload manager`.

- command: `git diff --name-only`
- result: passed
- summary: tracked diff list does not include generated web `dist`, `node_modules`, real `.env`, local DB, or storage files.

- command: `git ls-files -o --exclude-standard`
- result: passed
- summary: many untracked files are present, including intended-looking tests/docs and suspicious local artifacts.

- command: `rg` secret pattern scan
- result: passed
- summary: findings are env variable names, test fixtures, documented placeholders, local-dev Garage config, and integration placeholders. No live-looking GitHub token, AWS key, private key, or real secret was confirmed.

- command: `rg` deploy/local host scan
- result: passed
- summary: expected localhost, GitHub Pages repo, API URL env names, S3 endpoint env names, NAS path defaults, and server deploy paths were found.

- command: `npm test`
- result: passed
- summary: API 37 test files / 357 tests passed. Web 11 test files / 63 tests passed.

- command: `npm run lint`
- result: passed
- summary: API `tsc --noEmit` and Web ESLint passed.

- command: `npm run build`
- result: passed
- summary: API TypeScript build passed. Web Vite build passed and created `404.html` SPA fallback. Build still emitted `handler-*.js` mock handler chunk.

- command: `npm run db:generate --workspace=apps/api`
- result: passed
- summary: Prisma Client v6.11.0 generated. Prisma loaded `.env` internally; values were not inspected.

- command: `npm audit --audit-level=high --omit=dev`
- result: passed
- summary: found 0 vulnerabilities. This indicates prior `SEC-004` audit blocker is resolved in the current lockfile/dependency state.

- command: `docker build -f apps/api/Dockerfile .`
- result: warning
- summary: command timed out after about 5 minutes. Docker daemon was unavailable on follow-up checks, so API image build remains unverified locally.

## Diff Scope

- intended files
- API security/performance/contract cleanup: `apps/api/src/**`, `apps/api/prisma/seed.ts`, `apps/api/src/__tests__/**`, `apps/api/vitest.config.ts`
- Web contract/auth/admin pagination/user submission cleanup: `apps/web/src/**`, `apps/web/.env.example`, `apps/web/README.md`
- Shared contract and validation: `packages/contracts/src/index.ts`
- Dependency audit cleanup: `apps/api/package.json`, `package-lock.json`
- CI/deploy/integration support: `.github/workflows/deploy-api.yml`, `.github/workflows/pr-checks.yml`, `docker-compose.integration.yml`, `scripts/smoke-integration.mjs`, `apps/db/garage-init-integration.sh`
- Documentation/review output: `README.md`, `docs/**`, `AGENTS.md.example`, `CLAUDE.md.example`

- suspicious unrelated files
- `20-reflective-stonebraker.md`
- `analysis/remote-backfill-video-playback.mjs`
- `analysis/start-remote-video-backfill.sh`
- `design_problem.png`
- `left-problems.md`
- `prompts/*`
- `docs/llm/*`

- generated files
- no tracked `apps/web/dist`, `node_modules`, Prisma generated client, local DB, or storage output appeared in `git status --short`.
- `package-lock.json` is generated by npm but expected for dependency audit cleanup; it aligns with `google-auth-library` update and `npm audit` returning 0 vulnerabilities.

- deleted files
- none from `git diff --name-status --diff-filter=D`.
- no `apps/web/public/*` deletion was detected.
- no migration file deletion was detected.
- no deploy script or shared contract deletion was detected.

## Secret Scan Result

- confirmed safe placeholders
- `apps/db/garage.toml`: local-dev admin token and zeroed Garage secret.
- `apps/db/GARAGE-NAS-SETUP.md`: placeholder examples and instructions to replace with random values.
- `docker-compose.integration.yml`: integration-only placeholder values such as `pcu-integration-secret-key-change-me-000000` and `integration-session-secret-change-me-32chars`.
- `apps/api/src/__tests__/helpers/app-mocks.ts`: test-only DB URL, session secret, Google client ID, and S3 secret fixtures.
- docs and scripts: env variable names such as `DATABASE_URL`, `SESSION_SECRET`, `S3_SECRET_ACCESS_KEY`, `GOOGLE_CLIENT_IDS`, and deploy pass-through references.

- suspicious findings
- none confirmed as real live secret material.
- `server/deploy.sh` passes secret env vars to containers, but it contains variable references, not literal secret values.
- `server/how-to-add-project-manually.md` contains `test-session-token`; it is a documented test token string, not a real secret candidate.

- files not opened because they are real secret files
- `.env`
- `apps/api/.env`
- `apps/web/.env.local`

Tracked env-like files:

- `apps/api/.env.example` is untracked and should be reviewed as placeholder-only before staging.
- `apps/web/.env.example` and `apps/web/.env.mock` are tracked.

## Deployment Impact

- web workflow impact
- `.github/workflows/deploy-web-pages.yml` was not modified in the tracked diff.
- `master` push with web/package/contracts changes will trigger GitHub Pages deployment.
- `npm run build` confirms `404.html` SPA fallback is generated.
- Production web artifact still includes a mock handler chunk, which is a warning, not a blocker.

- api workflow impact
- `.github/workflows/deploy-api.yml` changed remote `podman login` from `-p "${GHCR_TOKEN}"` to `--password-stdin`, resolving the deploy secret handling issue from `SEC-006`.
- API workflow still triggers on `master` and paths including `apps/api/**`, `packages/contracts/**`, root package files, absent root `docker-compose.yml`, `server/deploy.sh`, and the workflow itself.
- Because current changes touch API, contracts, root package files, and the deploy workflow, a master push would trigger API build/deploy.

- server/deploy.sh impact
- `server/deploy.sh` is not modified in the tracked diff.
- Existing script uses `API_BIND_HOST` default `127.0.0.1`, rewrites `DATABASE_URL` host from `postgres` to `127.0.0.1` inside the pod, passes S3/NAS env vars, and performs API health polling.
- Workflow and script now align on copying `server/deploy.sh` and running `deploy.sh up`, but local Docker image build was not verified.

- env/example impact
- `apps/web/.env.example` changed.
- `apps/api/.env.example` is untracked and needs placeholder-only review before staging.
- Real `.env`, `apps/api/.env`, and `apps/web/.env.local` were not opened and are not tracked by `git ls-files`.

## DB/Migration Safety

- `apps/api/prisma/schema.prisma` changed only documentation text for `BannedIp`; no migration required for this diff.
- Existing migrations remain present under `apps/api/prisma/migrations`.
- `npm run db:generate --workspace=apps/api` passed.
- `migrate status/deploy` was not run. It is still required before production deploy if any non-comment Prisma schema change is staged later.
- No root-level `prisma/migrations` deletion or modification was detected.

## Manual Checks Still Needed

- Google OAuth
- S3/Garage upload/download
- protected asset download
- NAS export
- production reverse proxy health
- browser smoke
- GitHub Actions deploy dry run or feature branch CI
- Docker API image build in an environment with Docker daemon running

## Recommended Git Action

3. do not push yet

Reason: current worktree should be curated into explicit commits before any push. After excluding suspicious local artifacts and staging only intended files, a feature branch push is reasonable. Do not push directly to `master` from the current state.

## Suggested commit grouping

1. `fix(api): harden auth and protected asset access`
   - member `userId` update guard, protected download limiter, rate-limit and security tests.

2. `fix(api): bound uploads and validate asset resources`
   - upload limit/concurrency/resource guard changes, upload tests, S3/asset handling fixes.

3. `feat(api): add admin project list pagination contract`
   - API project list query validation/repository/service/controller, contracts, API tests.

4. `feat(web): consume paginated admin project list`
   - `AdminProjectsPage`, admin API client/query keys, page tests, minimal CSS.

5. `feat(web): add dev auth and user project submission flow`
   - dev-auth UI/API wiring, user submit page/form/API, route guards and tests.

6. `chore(deps): resolve production audit advisories`
   - `apps/api/package.json`, `package-lock.json`; keep this isolated from app behavior where possible.

7. `ci: add PR checks and integration test environment`
   - `.github/workflows/pr-checks.yml`, `docker-compose.integration.yml`, `scripts/smoke-integration.mjs`, Garage integration init.

8. `ci(deploy): harden API deploy login`
   - `.github/workflows/deploy-api.yml` `--password-stdin` change.

9. `docs: update deployment, validation, and review reports`
   - `docs/**`, `README.md`, `AGENTS.md.example`, `CLAUDE.md.example`.

Exclude from commits unless explicitly intended:

- `20-reflective-stonebraker.md`
- `analysis/*`
- `design_problem.png`
- `left-problems.md`
- `prompts/*`
- local/generated files and real secret files
