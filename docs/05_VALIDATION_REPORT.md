# 05 Validation Report

작성일: 2026-05-28

## 실행 환경

- OS/shell: Windows PowerShell
- Working directory: `C:\Users\song\Desktop\pcu_graduationproject_v2`
- Node/npm: 로컬 설치본 사용. 별도 버전 명령은 실행하지 않았다.

## 2026-05-28 안정화 패치 검증 결과

대상 변경 파일:

- `apps/api/src/plugins/cors.ts`
- `apps/api/src/__tests__/cors.test.ts`
- `apps/web/src/lib/api/mock/handler.ts`
- `apps/web/src/app/router.tsx`

완료된 검증:

- `npm test`: 성공
  - API: 25 test files, 283 tests passed
  - Web: 7 test files, 48 tests passed
- `npm run lint`: 성공
  - API: `tsc --noEmit`
  - Web: `eslint .`
- `npm run build`: 성공
  - API: `tsc -p tsconfig.json`
  - Web: `tsc -b && vite build && node scripts/post-build.mjs`

완료 처리:

- CORS allowed methods에 `PUT` 추가.
- chunked game upload cross-origin `PUT` preflight test 추가.
- mock handler에 `/api/public/exhibitions/:id/projects` 추가.
- `/admin` index child route 추가, 직접 접근 시 `/admin/projects` redirect.

새로 발견된 위험:

- 없음. 다만 mock route는 기존 year/project mock data를 재사용하므로, 향후 한 연도에 여러 전시 mock을 표현해야 하면 mock data 구조 확장이 필요하다.

## 2026-05-28 Google hosted domain 오류 contract 검증 결과

대상 변경 파일:

- `apps/api/src/modules/auth/service.ts`
- `apps/api/src/shared/errors.ts`
- `apps/api/src/__tests__/auth-domain.test.ts`
- `apps/web/src/lib/api/client.ts`
- `apps/web/src/lib/api/index.ts`
- `apps/web/src/pages/LoginPage.tsx`
- `apps/web/src/__tests__/LoginPage.test.tsx`

완료된 검증:

- `npm test`: 성공
  - API: 26 test files, 285 tests passed
  - Web: 9 test files, 53 tests passed
- `npm run lint`: 성공
  - API: `tsc --noEmit`
  - Web: `eslint .`
- `npm run build`: 성공
  - API: `tsc -p tsconfig.json`
  - Web: `tsc -b && vite build && node scripts/post-build.mjs`

완료 처리:

- invalid Google token은 401 `UNAUTHORIZED` 유지.
- hosted domain mismatch는 403 `EMAIL_DOMAIN_NOT_ALLOWED`로 정렬.
- LoginPage는 backend error code/message 기반으로 학교 도메인 안내 표시.
- backend auth service test와 frontend LoginPage test 추가.

새로 발견된 위험:

- API error code 문자열이 아직 `packages/contracts`에 중앙화되어 있지 않다.

## 실행한 검증 명령어

### 1. `git status --short`

결과: 성공

요약:

- 문서 작성 전부터 modified/untracked 파일이 다수 있었다.
- 이번 작업에서는 기존 modified 파일을 되돌리거나 삭제하지 않았다.
- 이번 작업에서 `docs/00_CURRENT_STATE.md`부터 `docs/HANDOFF_SUMMARY.md`까지 새 문서를 추가했다.

문서 작성 전 주요 dirty state:

```text
M AGENTS.md.example
M CLAUDE.md.example
M README.md
M apps/api/src/modules/admin/banned-ip/controller.ts
M apps/api/src/modules/admin/banned-ip/service.ts
M apps/api/src/modules/admin/export/controller.ts
M apps/api/src/modules/admin/export/service.ts
M apps/api/src/modules/admin/game-upload/controller.ts
M apps/api/src/modules/admin/game-upload/service.ts
M apps/api/src/modules/admin/import/controller.ts
M apps/api/src/modules/admin/import/service.ts
M apps/api/src/modules/admin/settings/controller.ts
M apps/api/src/modules/admin/settings/service.ts
M apps/api/src/shared/site-settings.ts
M apps/web/README.md
M apps/web/src/lib/api/admin.ts
M apps/web/src/lib/api/game-upload.ts
M apps/web/src/lib/api/index.ts
M apps/web/src/lib/api/mock/handler.ts
M packages/contracts/src/index.ts
?? .github/workflows/pr-checks.yml
?? 20-reflective-stonebraker.md
?? analysis/remote-backfill-video-playback.mjs
?? analysis/start-remote-video-backfill.sh
?? apps/api/.env.example
?? apps/api/vitest.config.ts
?? design_problem.png
?? docs/
?? left-problems.md
?? prompts/
```

재현 명령어:

```bash
git status --short
```

## Test 결과

### `npm test`

결과: 성공

요약:

- root script: `npm test --workspaces --if-present`
- API: 24 test files, 282 tests passed
- Web: 7 test files, 48 tests passed

주요 출력:

```text
@pcu-graduationproject-v2/api test
Test Files 24 passed (24)
Tests 282 passed (282)

@pcu-graduationproject-v2/web test
Test Files 7 passed (7)
Tests 48 passed (48)
```

재현 명령어:

```bash
npm test
```

## Lint/typecheck 결과

### `npm run lint`

결과: 성공

요약:

- root script: `npm run lint --workspaces --if-present`
- API: `tsc --noEmit`
- Web: `eslint .`

주요 출력:

```text
@pcu-graduationproject-v2/api lint
tsc --noEmit

@pcu-graduationproject-v2/web lint
eslint .
```

재현 명령어:

```bash
npm run lint
```

## Build 결과

### `npm run build`

결과: 성공

요약:

- root script: `npm run build --workspaces --if-present`
- API: `tsc -p tsconfig.json`
- Web: `tsc -b && vite build && node scripts/post-build.mjs`
- Web build output에서 `404.html` SPA fallback 생성 확인

주요 출력:

```text
@pcu-graduationproject-v2/api build
tsc -p tsconfig.json

@pcu-graduationproject-v2/web build
tsc -b && vite build && node scripts/post-build.mjs
vite v8.0.1 building client environment for production...
✓ built
✓ 404.html created (SPA fallback for GitHub Pages)
```

재현 명령어:

```bash
npm run build
```

## Prisma generate 결과

### `npm run db:generate --workspace=apps/api`

결과: 성공

요약:

- Prisma schema: `apps/api/prisma/schema.prisma`
- Prisma Client v6.11.0 생성 성공
- Prisma가 7.8.0 major update 가능 알림을 출력했지만 실패는 아니다.

주요 출력:

```text
Environment variables loaded from .env
Prisma schema loaded from prisma\schema.prisma
Generated Prisma Client (v6.11.0)
Update available 6.11.0 -> 7.8.0
```

재현 명령어:

```bash
npm run db:generate --workspace=apps/api
```

주의:

- 명령 출력이 `.env` 로드를 표시했지만 `.env` 내용은 읽거나 문서화하지 않았다.

## 실행하지 않은 검증

아래는 repo 상태 문서화를 위해 필요하지 않거나 외부 상태/DB 변동이 생길 수 있어 실행하지 않았다.

- `npm run db:migrate`
- `npm run db:seed`
- `docker compose up -d`
- API dev server 실행
- Web dev server 실행
- production deploy workflow 실행
- 실제 Google OAuth login
- 실제 S3/Garage upload/download
- 실제 NAS export
- browser E2E/manual UI 확인

## 실패 결과

검증 명령 기준 실패 없음.

## 실패 시 원인 추정

이번 검증에서는 실패가 없었다. 이전 repo inspection에서 확인된 CORS `PUT` 누락, mock exhibition projects route 누락, `/admin` index route 누락은 2026-05-28 안정화 패치에서 해결됐다. Google hosted domain 오류 contract 불일치도 2026-05-28 추가 안정화에서 해결됐다. 아직 남은 위험은 다음과 같다.

- 추정: API error code 문자열이 아직 `packages/contracts`에 중앙화되어 있지 않아 향후 error code 추가/변경 시 backend/frontend drift 가능성이 있다. 근거 파일: `apps/api/src/modules/auth/service.ts`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/lib/api/client.ts`, `packages/contracts/src/index.ts`.

## 현재 검증 결론

- Unit/API/Web tests: 통과. 최신 Google hosted domain 오류 contract 정렬 기준 API 26 files / 285 tests, Web 9 files / 53 tests 통과.
- Typecheck/lint: 통과
- Production build: 통과
- Prisma client generate: 통과
- 외부 의존 runtime 검증: 미실행
