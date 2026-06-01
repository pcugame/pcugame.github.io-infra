# 01 Architecture

작성일: 2026-05-28

## 전체 구조도 설명

```text
사용자 브라우저
  |
  | HTTPS
  v
GitHub Pages 또는 Vite dev server
  - React SPA
  - 정적 asset 제공
  - API 호출 시 credentials: include
  |
  | HTTPS 또는 localhost API 호출
  v
Fastify API server
  - auth/session
  - public/admin API
  - upload validation/processing
  - S3 presigned redirect
  - NAS export
  |
  +--> PostgreSQL
  |     - Prisma ORM
  |     - users, sessions, exhibitions, projects, assets 등 metadata
  |
  +--> Garage/S3 compatible object storage
  |     - public bucket: poster/image 등 공개 asset
  |     - protected bucket: game/video 등 보호 asset
  |
  +--> NAS filesystem mount
        - admin export 결과 저장
```

근거 파일:

- `apps/web/src/lib/api/client.ts`
- `apps/api/src/app.ts`
- `apps/api/prisma/schema.prisma`
- `apps/api/src/lib/s3.ts`
- `apps/api/src/lib/storage.ts`
- `apps/api/src/modules/admin/export/service.ts`
- `server/deploy.sh`

## Frontend 라우팅 구조

라우터는 `createBrowserRouter`를 사용하며 `basename`은 `import.meta.env.BASE_URL`이다.

Public:

- `/`: `HomePage`
- `/years`: `YearsPage`
- `/years/:year`: `YearProjectsPage`
- `/exhibitions/:id`: `ExhibitionProjectsPage`
- `/years/:year/:slug`: `ProjectDetailPage`
- `/projects/:projectId`: `ProjectDetailPage`

Auth:

- `/login`: `LoginPage`
- `/me`: `RequireAuth` + `MePage`
- `/me/projects`: `RequireAuth` + `MyProjectsPage`

Admin:

- `/admin`: `RequireAuth` + `AdminLayout`
- `/admin/projects`: `RequireRole(['OPERATOR', 'ADMIN'])` + `AdminProjectsPage`
- `/admin/projects/new`: `RequireRole(['USER', 'OPERATOR', 'ADMIN'])` + `AdminProjectNewPage`
- `/admin/projects/:id/edit`: `RequireRole(['USER', 'OPERATOR', 'ADMIN'])` + `AdminProjectEditPage`
- `/admin/years`: `RequireRole(['OPERATOR', 'ADMIN'])` + `AdminYearsPage`
- `/admin/settings`: `RequireRole(['OPERATOR', 'ADMIN'])` + `AdminSettingsPage`
- `/admin/banned-ips`: `RequireRole(['OPERATOR', 'ADMIN'])` + `AdminBannedIpsPage`
- `/admin/import`: `RequireRole(['ADMIN'])` + `AdminImportPage`

미확인/주의:

- `/admin`에는 index route 또는 redirect가 없다. `AdminLayout`의 `<Outlet />`만 렌더링되므로 직접 접근 시 본문이 비어 있을 수 있다.

근거 파일:

- `apps/web/src/app/router.tsx`
- `apps/web/src/components/layout/AdminLayout.tsx`
- `apps/web/src/features/auth/RequireAuth.tsx`
- `apps/web/src/features/auth/RequireRole.tsx`

## Backend 모듈 구조

Fastify app 구성:

- `apps/api/src/app.ts`
  - request id 생성
  - lifecycle in-flight counter
  - request context logger
  - plugins 등록
  - health route 등록
  - feature controllers 등록
  - global error handler
- `apps/api/src/server.ts`
  - env load
  - app listen
  - stale game upload session sweep
  - expired auth session purge
  - orphan object reaper
  - graceful shutdown

Plugins:

- `helmet.ts`: security headers
- `rate-limit.ts`: global/request route rate limit
- `cors.ts`: allowed origins and credentials
- `cookie.ts`: signed cookie parser
- `multipart.ts`: multipart body support
- `auth.ts`: session cookie -> `request.currentUser`
- `csrf.ts`: state-changing request origin validation

Feature modules:

- `modules/auth`: Google OAuth login/logout/me
- `modules/public`: public years/projects/project detail
- `modules/assets`: public/protected asset redirect, asset delete
- `modules/admin/year`: exhibition CRUD and poster
- `modules/admin/project`: project CRUD, upload, asset, poster, bulk operations
- `modules/admin/member`: project member CRUD and ordering
- `modules/admin/game-upload`: S3 multipart chunked game upload
- `modules/admin/settings`: site upload settings
- `modules/admin/banned-ip`: banned IP list/unban
- `modules/admin/import`: JSON import preview/execute
- `modules/admin/export`: S3 to NAS export
- `modules/orphan`: failed S3 delete retry queue

근거 파일:

- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/api/src/plugins/*`
- `apps/api/src/modules/**/*`

## DB/ORM 사용 여부

DB는 PostgreSQL이고 ORM은 Prisma를 사용한다.

Prisma 설정:

- generator: `prisma-client-js`
- binary targets: `native`, `debian-openssl-3.0.x`
- datasource provider: `postgresql`
- datasource URL: `env("DATABASE_URL")`

주요 모델:

- `User`
- `Exhibition`
- `Project`
- `ProjectMember`
- `Asset`
- `AuthSession`
- `GameUploadSession`
- `BannedIp`
- `OrphanObject`
- `SiteSetting`

주요 enum:

- `UserRole`: `USER`, `OPERATOR`, `ADMIN`
- `ProjectStatus`: `PUBLISHED`, `ARCHIVED`
- `AssetKind`: `THUMBNAIL`, `IMAGE`, `POSTER`, `GAME`, `VIDEO`
- `AssetStatus`: `READY`, `DELETING`, `DELETED`, `FAILED`
- `AssetPlaybackStatus`: `PENDING`, `READY`, `FAILED`
- `Platform`: `PC`, `MOBILE`, `WEB`

근거 파일:

- `apps/api/prisma/schema.prisma`
- `apps/api/package.json`
- `apps/api/src/lib/prisma.ts`

## 파일 업로드/정적 asset 흐름

Web static asset:

- `apps/web/public/*`는 Vite public asset으로 취급된다.
- `npm run build` 후 `apps/web/dist`에 복사된다.
- GitHub Pages workflow는 `apps/web/dist`를 `pcugame/pcugame.github.io`의 `master` branch로 배포한다.

근거 파일:

- `apps/web/vite.config.ts`
- `apps/web/public/*`
- `.github/workflows/deploy-web-pages.yml`
- `apps/web/scripts/post-build.mjs`

일반 작품/asset upload:

1. Web이 API로 multipart 요청을 보낸다.
2. API가 multipart part를 temp file로 수집하고 size/file count를 검증한다.
3. `UploadPipeline`이 이미지/PDF/동영상/게임 파일을 처리한다.
4. API가 S3/Garage bucket에 저장한다.
5. DB `Asset` row에 `storageKey`, `kind`, `mimeType`, `sizeBytes`, playback 정보 등을 저장한다.
6. public API/admin API는 `API_PUBLIC_URL` 기반 asset route URL을 응답한다.
7. 브라우저가 `/api/assets/public/:storageKey` 또는 `/api/assets/protected/:storageKey`를 열면 API가 presigned S3 URL로 redirect한다.

근거 파일:

- `apps/web/src/lib/api/client.ts`
- `apps/api/src/modules/admin/project/service.ts`
- `apps/api/src/modules/admin/year/service.ts`
- `apps/api/src/modules/assets/upload/upload.service.ts`
- `apps/api/src/modules/assets/service.ts`
- `apps/api/src/modules/admin/project/serializer.ts`
- `apps/api/src/modules/public/service.ts`

Chunked game upload:

1. Web이 `/api/admin/projects/:id/game-upload-sessions`로 upload session을 만든다.
2. API가 protected bucket에 S3 multipart upload를 만든다.
3. Web이 파일을 chunk로 나누어 `/api/admin/game-upload-sessions/:sessionId/chunks/:index`에 `PUT`한다.
4. Web이 `/api/admin/game-upload-sessions/:sessionId/complete`를 호출한다.
5. API가 multipart upload를 완료하고 ZIP 검증 후 `GAME` asset을 만든다.

주의: CORS allowed methods에 `PUT`이 빠져 있어 cross-origin browser upload가 깨질 수 있다.

근거 파일:

- `apps/web/src/lib/api/game-upload.ts`
- `apps/api/src/modules/admin/game-upload/controller.ts`
- `apps/api/src/modules/admin/game-upload/service.ts`
- `apps/api/src/plugins/cors.ts`

NAS export:

- 관리자 export API가 DB metadata와 S3 object를 읽어 NAS mount path로 파일을 저장한다.
- production deploy script는 host NAS path를 container path에 mount한다.

근거 파일:

- `apps/api/src/modules/admin/export/controller.ts`
- `apps/api/src/modules/admin/export/service.ts`
- `server/deploy.sh`

## 인증 흐름

1. `LoginPage`가 Google Identity Services script를 로드한다.
2. 브라우저가 Google credential ID token을 받는다.
3. Web이 `POST /api/auth/google`에 `{ credential }`을 보낸다.
4. API가 `google-auth-library`로 ID token을 검증한다.
5. API가 `ALLOWED_GOOGLE_HD`가 설정된 경우 hosted domain을 검증한다.
6. API가 user를 upsert하고 `AuthSession`을 생성한다.
7. API가 HttpOnly cookie에 session id를 설정한다.
8. 이후 API request에서 auth plugin이 cookie session을 읽어 `request.currentUser`를 채운다.
9. `RequireAuth`는 `/api/me` 결과로 로그인 여부를 판단한다.
10. `RequireRole`은 `USER`, `OPERATOR`, `ADMIN` role에 따라 화면 접근을 제한한다.

Session:

- idle timeout과 absolute timeout이 있다.
- lastSeenAt 기반 sliding touch를 한다.
- expired session은 background timer에서 주기적으로 purge한다.

근거 파일:

- `apps/web/src/pages/LoginPage.tsx`
- `apps/web/src/lib/auth/google.ts`
- `apps/web/src/features/auth/*`
- `apps/api/src/modules/auth/controller.ts`
- `apps/api/src/modules/auth/service.ts`
- `apps/api/src/plugins/auth.ts`
- `apps/api/src/shared/session.ts`
- `apps/api/prisma/schema.prisma`

미확인/주의:

- 도메인 mismatch 시 API는 401을 반환하지만 LoginPage는 403일 때만 학교 도메인 전용 문구를 표시한다. 근거 파일: `apps/api/src/modules/auth/service.ts`, `apps/api/src/shared/errors.ts`, `apps/web/src/pages/LoginPage.tsx`.

## GitHub Pages, NAS, API 서버, DB 책임

GitHub Pages:

- `apps/web/dist` 정적 파일 제공
- React SPA shell 제공
- API data를 직접 저장하지 않음
- Google OAuth client id와 API base URL을 build env로 주입

근거 파일:

- `.github/workflows/deploy-web-pages.yml`
- `apps/web/vite.config.ts`
- `apps/web/src/lib/env/index.ts`

API 서버:

- Fastify route 처리
- auth/session/cookie 처리
- admin/public API 제공
- upload 검증 및 S3 저장
- S3 object presigned redirect
- NAS export 실행
- Prisma를 통한 DB 읽기/쓰기

근거 파일:

- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/api/src/modules/**/*`

DB:

- PostgreSQL
- users, auth sessions, exhibitions, projects, members, assets, upload sessions, banned IP, orphan queue, site settings 저장
- 실제 binary 파일은 DB가 아니라 S3/Garage에 저장

근거 파일:

- `apps/api/prisma/schema.prisma`

Garage/S3:

- object storage
- public bucket과 protected bucket 분리
- API가 presigned URL redirect로 접근을 중개

근거 파일:

- `apps/api/src/lib/s3.ts`
- `apps/api/src/lib/storage.ts`
- `apps/api/src/modules/assets/service.ts`
- `apps/db/docker-compose.yml`

NAS:

- 현재 코드 기준 primary upload store가 아니라 export target이다.
- production deploy script는 `NAS_EXPORT_HOST_PATH`를 `NAS_EXPORT_PATH`로 mount한다.
- Garage 자체를 NAS에서 운영하는 방법은 별도 문서에 있다.

근거 파일:

- `server/deploy.sh`
- `apps/api/src/modules/admin/export/controller.ts`
- `apps/api/src/modules/admin/export/service.ts`
- `apps/db/GARAGE-NAS-SETUP.md`
