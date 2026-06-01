# 00 Current State

작성일: 2026-05-28

이 문서는 현재 저장소에 실제로 존재하는 파일과 실행 결과만 기준으로 작성했다. 기능 구현, 삭제, 대규모 이동은 하지 않았다.

## 현재 프로젝트의 목적

배재대학교 게임공학과 졸업작품 전시 플랫폼이다. 공개 전시 페이지, 관리자 업로드/편집 화면, Google OAuth 로그인, PostgreSQL 데이터, Garage/S3 호환 파일 저장소를 함께 관리한다.

근거 파일:

- `README.md`
- `apps/api/package.json`
- `apps/web/package.json`
- `apps/api/prisma/schema.prisma`

## Frontend 구성

- 위치: `apps/web`
- 기술: React 19, Vite 8, TypeScript, React Router 7, TanStack Query, Zod v4
- 엔트리: `apps/web/src/main.tsx`
- 라우터: `apps/web/src/app/router.tsx`
- 전역 Provider: TanStack Query, UploadProvider
- API client: `apps/web/src/lib/api/*`
- mock 모드: `npm run dev:mock`, `VITE_MOCK=true`일 때 `apps/web/src/lib/api/mock/handler.ts` 사용
- 정적 asset: `apps/web/public/*`가 Vite 빌드 결과에 복사됨

근거 파일:

- `apps/web/package.json`
- `apps/web/src/main.tsx`
- `apps/web/src/app/router.tsx`
- `apps/web/src/app/providers.tsx`
- `apps/web/src/lib/api/client.ts`
- `apps/web/src/lib/api/mock/handler.ts`
- `apps/web/vite.config.ts`

## Backend 구성

- 위치: `apps/api`
- 기술: Fastify 5, TypeScript, Prisma 6.11, PostgreSQL, Zod v3
- 엔트리: `apps/api/src/server.ts`
- 앱 구성: `apps/api/src/app.ts`
- 설정 검증: `apps/api/src/config/env.ts`
- 주요 모듈: `auth`, `public`, `assets`, `admin`, `orphan`
- DB schema: `apps/api/prisma/schema.prisma`
- migration 위치: `apps/api/prisma/migrations`
- 테스트: Vitest

근거 파일:

- `apps/api/package.json`
- `apps/api/src/server.ts`
- `apps/api/src/app.ts`
- `apps/api/src/config/env.ts`
- `apps/api/prisma/schema.prisma`
- `apps/api/vitest.config.ts`

## Infra 구성

- 로컬 DB/Object storage: `apps/db/docker-compose.yml`
  - PostgreSQL 16
  - Garage v1.1.0
  - Garage init container
- API production image: `apps/api/Dockerfile`
- API deploy workflow: `.github/workflows/deploy-api.yml`
- Web GitHub Pages workflow: `.github/workflows/deploy-web-pages.yml`
- PR 검증 workflow: `.github/workflows/pr-checks.yml`
- 서버 배포 스크립트: `server/deploy.sh`
- 서버 보안/프록시 문서: `server/SECURITY-HARDENING.md`

주의: 루트 `docker-compose.yml`은 현재 저장소에 존재하지 않는다. README와 deploy workflow에는 루트 `docker-compose.yml` 언급이 남아 있다.

근거 파일:

- `apps/db/docker-compose.yml`
- `apps/api/Dockerfile`
- `.github/workflows/deploy-api.yml`
- `.github/workflows/deploy-web-pages.yml`
- `.github/workflows/pr-checks.yml`
- `server/deploy.sh`
- `server/SECURITY-HARDENING.md`
- `rg --files` 실행 결과

## 실제 존재하는 주요 디렉터리

- `apps/api`: Fastify API, Prisma schema/migrations, API tests, migration/backfill scripts
- `apps/web`: React/Vite SPA, pages, components, API client, tests, public assets
- `apps/db`: PostgreSQL/Garage local compose, Garage config, legacy import helper
- `packages/contracts`: API/Web 공유 type-only contract
- `assets`: 배재대학교/학과 관련 원본 이미지 asset
- `server`: production deploy/security helper scripts and legacy sample JSON
- `analysis`: 과거 분석/운영/보안 조사 문서 및 스크립트
- `docs/llm`: LLM 작업용 문서
- `prompts`: 재사용 프롬프트
- `.github/workflows`: CI/CD workflow
- `prisma/migrations`: 루트에 따로 존재하는 migration 한 개. 현재 API Prisma schema 위치와 다르므로 의심 파일로 별도 문서화했다.

근거 파일:

- `rg --files`
- `rg --files -uu -g ".env*" -g ".github/**" -g "!node_modules" -g "!apps/**/node_modules" -g "!apps/web/dist"`

## 실행 가능한 명령어

루트:

```bash
npm install
npm test
npm run lint
npm run build
```

API:

```bash
cd apps/api
npm run dev
npm run build
npm start
npm run db:generate
npm run db:migrate
npm run db:migrate:deploy
npm run db:studio
npm run db:seed
npm run db:seed:import
npm run lint
npm test
```

Web:

```bash
cd apps/web
npm run dev
npm run dev:mock
npm run build
npm run lint
npm run preview
npm test
```

Local DB/Object storage:

```bash
cd apps/db
docker compose up -d
```

Production helper:

```bash
server/deploy.sh up
server/deploy.sh down
server/deploy.sh restart
server/deploy.sh logs api
server/deploy.sh logs pg
server/deploy.sh status
```

근거 파일:

- `package.json`
- `apps/api/package.json`
- `apps/web/package.json`
- `apps/db/docker-compose.yml`
- `server/deploy.sh`

## 현재 구현된 기능

Frontend:

- 공개 홈/연도 목록/연도별 작품 목록/전시별 작품 목록/작품 상세 페이지
- 작품 목록 검색 및 정렬 유틸
- Google Identity Services 기반 로그인 화면
- 현재 사용자 확인, 로그아웃, 인증/역할 기반 route guard
- 내 작품 페이지
- 관리자 작품 목록, 작품 등록, 작품 편집
- 관리자 전시회 관리, 전시 포스터 업로드/삭제
- 관리자 사이트 설정
- 관리자 IP 차단 목록/해제
- 관리자 JSON import
- 관리자 NAS export 실행 및 진행상태 모달
- 작품/asset upload progress UI
- chunked game upload UI
- mock API 모드와 mock role switcher

근거 파일:

- `apps/web/src/app/router.tsx`
- `apps/web/src/pages/*Page.tsx`
- `apps/web/src/pages/admin/*Page.tsx`
- `apps/web/src/lib/api/*.ts`
- `apps/web/src/components/GameUploadWidget.tsx`
- `apps/web/src/components/common/MockRoleSwitcher.tsx`

Backend:

- health/deep health
- Google ID token 검증, user upsert, HttpOnly cookie session
- Google hosted domain 제한: invalid token은 401, hosted domain mismatch는 403 `EMAIL_DOMAIN_NOT_ALLOWED`
- session idle/absolute 만료와 sliding touch
- 공개 연도/전시/작품 목록 및 상세 조회
- public/protected asset redirect
- protected asset 접근 제어, 다운로드 rate limit, IP ban
- 관리자 전시 CRUD 및 전시 포스터 관리
- 관리자 작품 CRUD, 상태 변경, bulk status, bulk delete
- multipart 작품 등록
- 기존 작품 asset 추가, 포스터 지정, asset 삭제
- 멤버 추가/수정/삭제/sort swap
- chunked game upload: S3 multipart 기반 세션 생성/청크 업로드/완료/취소/조회
- 사이트 설정 조회/수정
- IP ban 목록 조회/해제
- JSON import preview/execute
- S3 asset을 NAS filesystem으로 export
- orphan object retry/reaper
- request id, structured logging, graceful shutdown
- Helmet, CORS, CSRF origin check, rate limit

근거 파일:

- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/api/src/modules/auth/*`
- `apps/api/src/modules/public/*`
- `apps/api/src/modules/assets/*`
- `apps/api/src/modules/admin/**/*`
- `apps/api/src/modules/orphan/*`
- `apps/api/src/plugins/*`

DB/Storage:

- PostgreSQL schema와 Prisma migrations 존재
- Garage/S3 호환 object storage 사용
- public bucket과 protected bucket 분리
- web static asset은 Vite public asset으로 배포
- 운영 export는 NAS mount path로 파일 복사

근거 파일:

- `apps/api/prisma/schema.prisma`
- `apps/api/src/lib/s3.ts`
- `apps/api/src/lib/storage.ts`
- `apps/db/docker-compose.yml`
- `server/deploy.sh`
- `apps/api/src/modules/admin/export/service.ts`

## 아직 구현되지 않은 기능

- 추정: Google OAuth 없이 full-stack local login을 하는 별도 dev-auth route는 없다. `README.md`도 local full-stack development가 별도 dev-auth task 없이는 Google OAuth를 따른다고 설명한다. 근거 파일: `README.md`, `apps/api/src/modules/auth/controller.ts`, `apps/web/src/pages/LoginPage.tsx`.
- 추정: DRAFT 상태 기반 검수 workflow는 현재 구현되어 있지 않다. 현재 contract/schema/validation은 `PUBLISHED`, `ARCHIVED`만 허용하고, migration에 DRAFT 제거 이력이 있다. 근거 파일: `packages/contracts/src/index.ts`, `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260523_remove_draft_project_status/migration.sql`, `apps/api/src/shared/validation.ts`.
- 추정: production 서버용 `.env.example`은 없다. `server/deploy.sh`는 `/srv/graduationproject_v2/.env`를 요구하지만 해당 변수 세트를 설명하는 server-level example 파일은 현재 확인되지 않았다. 근거 파일: `server/deploy.sh`, `rg --files -uu -g ".env*" ...`.
- 추정: 루트 Docker Compose 기반 full-stack 실행은 현재 파일 기준으로 제공되지 않는다. 루트 `docker-compose.yml`이 없고, 실제 compose 파일은 `apps/db/docker-compose.yml`뿐이다. 근거 파일: `README.md`, `apps/db/docker-compose.yml`, `rg --files`.

## 해결된 안정화 항목

- 해결됨: CORS allowed methods에 `PUT`이 추가되어 `PUT /api/admin/game-upload-sessions/:sessionId/chunks/:index` cross-origin preflight가 허용된다. API test `apps/api/src/__tests__/cors.test.ts`로 고정했다. 근거 파일: `apps/api/src/plugins/cors.ts`, `apps/api/src/__tests__/cors.test.ts`, `apps/api/src/modules/admin/game-upload/controller.ts`, `apps/web/src/lib/api/game-upload.ts`.
- 해결됨: Mock API에 `/api/public/exhibitions/:id/projects` handler가 추가되어 `PublicExhibitionProjectsResponse` 형태를 반환한다. 기존 mock year/project data를 재사용한다. 근거 파일: `apps/web/src/lib/api/public.ts`, `apps/web/src/pages/ExhibitionProjectsPage.tsx`, `apps/web/src/lib/api/mock/handler.ts`.
- 해결됨: `/admin` route에 index child redirect가 추가되어 직접 접근 시 `/admin/projects`로 이동한다. 기존 child route의 `RequireAuth`/`RequireRole` 구조는 유지된다. 근거 파일: `apps/web/src/app/router.tsx`, `apps/web/src/components/layout/AdminLayout.tsx`.
- 해결됨: Google hosted domain mismatch는 403 `EMAIL_DOMAIN_NOT_ALLOWED`로 반환되고, LoginPage는 error code/message 기반으로 학교 도메인 안내를 표시한다. invalid Google token은 401 `UNAUTHORIZED`를 유지한다. 근거 파일: `apps/api/src/modules/auth/service.ts`, `apps/api/src/shared/errors.ts`, `apps/web/src/lib/api/client.ts`, `apps/web/src/pages/LoginPage.tsx`, `apps/api/src/__tests__/auth-domain.test.ts`, `apps/web/src/__tests__/LoginPage.test.tsx`.

## 깨진 부분 또는 미확인 부분

- API error code 문자열은 아직 `packages/contracts`에 중앙화되어 있지 않다. 현재 `EMAIL_DOMAIN_NOT_ALLOWED`는 backend/frontend에서 문자열로 맞춰 쓰므로, 향후 error code 추가 시 drift 가능성이 남아 있다. 근거 파일: `apps/api/src/modules/auth/service.ts`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/lib/api/client.ts`, `packages/contracts/src/index.ts`.
- `.github/workflows/deploy-api.yml`의 path trigger에 `docker-compose.yml`이 포함되어 있지만 루트 `docker-compose.yml`은 없다. 배포에는 `server/deploy.sh`와 API Dockerfile이 쓰인다. 근거 파일: `.github/workflows/deploy-api.yml`, `server/deploy.sh`, `rg --files`.
- `AUTO_PUBLISH_DEFAULT` env는 schema/example/deploy에 남아 있지만 현재 `submitProject()`는 항상 `PUBLISHED`를 사용한다. 근거 파일: `apps/api/src/config/env.ts`, `apps/api/.env.example`, `server/deploy.sh`, `apps/api/src/modules/admin/project/service.ts`.
- DB/import schema에는 `githubUrl`, `platforms`가 있지만 현재 공유 contract의 public/admin project 응답과 serializer에는 노출되지 않는다. 해당 데이터의 사용자-facing 사용 여부는 미확인이다. 근거 파일: `apps/api/prisma/schema.prisma`, `apps/api/src/modules/admin/import/service.ts`, `packages/contracts/src/index.ts`, `apps/api/src/modules/admin/project/serializer.ts`, `apps/api/src/modules/public/service.ts`.
- 실제 production Google OAuth, production S3/Garage, NAS mount, reverse proxy 상태는 로컬 repo만으로는 확인하지 않았다. 근거 파일: `server/deploy.sh`, `server/SECURITY-HARDENING.md`, `apps/db/GARAGE-NAS-SETUP.md`.
