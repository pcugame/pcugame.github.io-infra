# 02 API And Data Contract

작성일: 2026-05-28

## 공통 응답 envelope

Backend 성공 응답은 기본적으로 다음 형태다.

```ts
type ApiSuccess<T> = {
	ok: true;
	data: T;
};
```

Backend 오류 응답은 다음 형태다.

```ts
type ApiError = {
	ok: false;
	error: {
		code: string;
		message: string;
		details?: unknown;
	};
};
```

Frontend API client는 `{ ok: true, data }`를 받으면 `data`만 반환한다. `204 No Content`는 `undefined`로 처리한다.

근거 파일:

- `apps/api/src/shared/http.ts`
- `apps/api/src/app.ts`
- `apps/web/src/lib/api/client.ts`

## 실제 backend route 목록

Prefix 등록 근거:

- `authController`: `/api`
- `publicController`: `/api/public`
- `adminRoutes`: `/api/admin`
- `assetsController`: `/api`

근거 파일:

- `apps/api/src/app.ts`

### Health

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | 없음 | 없음 | `{ ok, state, timestamp, checks: { db } }`, draining/shutting_down 또는 DB 실패 시 503 |
| GET | `/api/health/deep` | 없음 | 없음 | `{ ok, state, timestamp, checks: { db, s3 } }`, DB/S3 실패 시 503 |

근거 파일: `apps/api/src/app.ts`

### Auth

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/google` | 없음 | JSON `{ credential: string }` | `GoogleAuthResponse` = `{ user }`, HttpOnly session cookie 설정 |
| POST | `/api/auth/logout` | 선택 | 없음 | `LogoutResponse` = `{ message: string }`, session cookie clear |
| GET | `/api/me` | 선택 | 없음 | `MeResponse` = `{ authenticated: false }` 또는 `{ authenticated: true, user }` |

Auth 오류 contract:

- 잘못된 Google ID token 또는 payload: 401, `error.code = "UNAUTHORIZED"`
- Google hosted domain mismatch: 403, `error.code = "EMAIL_DOMAIN_NOT_ALLOWED"`
- Frontend LoginPage는 `EMAIL_DOMAIN_NOT_ALLOWED` 또는 `DOMAIN_NOT_ALLOWED` code를 학교 도메인 안내 조건으로 사용하고, 일반 로그인 실패는 backend message를 표시한다.

근거 파일:

- `apps/api/src/modules/auth/controller.ts`
- `apps/api/src/modules/auth/service.ts`
- `apps/api/src/plugins/auth.ts`
- `apps/web/src/pages/LoginPage.tsx`
- `apps/web/src/lib/api/client.ts`
- `packages/contracts/src/index.ts`

### Public

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/api/public/years` | 없음 | 없음 | `PublicYearListResponse` = `{ items: PublicYearItem[] }` |
| GET | `/api/public/exhibition-posters/:storageKey` | 없음 | path `storageKey` | 302 redirect to presigned public S3 URL |
| GET | `/api/public/years/:year/projects` | 없음 | path `year` | `PublicYearProjectsResponse` |
| GET | `/api/public/exhibitions/:id/projects` | 없음 | path `id` | `PublicExhibitionProjectsResponse` |
| GET | `/api/public/projects/:idOrSlug` | 없음 | path `idOrSlug`, query `year?` | `PublicProjectDetailResponse` |

근거 파일:

- `apps/api/src/modules/public/controller.ts`
- `apps/api/src/modules/public/service.ts`
- `packages/contracts/src/index.ts`

### Assets

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/api/assets/public/:storageKey` | 없음 | path `storageKey` | 302 redirect to presigned public S3 URL |
| GET | `/api/assets/protected/:storageKey` | 선택/조건부 | path `storageKey` | 302 redirect to presigned protected S3 URL, protected access/rate limit 적용 |
| DELETE | `/api/admin/assets/:assetId` | login | path `assetId` | 204 |

근거 파일:

- `apps/api/src/modules/assets/controller.ts`
- `apps/api/src/modules/assets/service.ts`
- `apps/api/src/modules/admin/project-access.ts`

### Admin: exhibitions

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/exhibitions` | login | 없음 | `{ items: AdminExhibitionItem[] }` |
| POST | `/api/admin/exhibitions` | `ADMIN`/`OPERATOR` | `CreateExhibitionRequest` | `{ id: number; year: number }` |
| PATCH | `/api/admin/exhibitions/:id` | `ADMIN`/`OPERATOR` | `UpdateExhibitionRequest` | `AdminExhibitionItem` |
| DELETE | `/api/admin/exhibitions/:id` | `ADMIN`/`OPERATOR` | path `id` | 204 |
| POST | `/api/admin/exhibitions/:id/poster` | `ADMIN`/`OPERATOR` | multipart field `poster` exactly one file | `AdminExhibitionItem` |
| DELETE | `/api/admin/exhibitions/:id/poster` | `ADMIN`/`OPERATOR` | path `id` | 204 |

근거 파일:

- `apps/api/src/modules/admin/year/controller.ts`
- `apps/api/src/modules/admin/year/service.ts`
- `packages/contracts/src/index.ts`

### Admin: projects

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/projects` | login | 없음 | `{ items: AdminProjectItem[] }`; USER는 본인/멤버 작품, OPERATOR/ADMIN은 전체 |
| GET | `/api/admin/projects/:id` | login | path `id` | `AdminProjectDetail` |
| PATCH | `/api/admin/projects/:id` | login | `UpdateProjectRequest` | `AdminProjectDetail` |
| DELETE | `/api/admin/projects/:id` | login | path `id` | 204 |
| PATCH | `/api/admin/projects/bulk/status` | `ADMIN`/`OPERATOR` | `{ ids: number[]; status: ProjectStatus }` | `{ updated: number }` |
| POST | `/api/admin/projects/bulk/delete` | `ADMIN` | `{ ids: number[] }` | `{ deleted: number; assetsRemoved: number }` |
| POST | `/api/admin/projects/submit` | login | multipart: field `payload` JSON, optional files `poster`, `images[]`, `gameFile`, `videoFile` | `SubmitProjectResponse` |
| POST | `/api/admin/projects/:id/assets` | login | multipart: field `kind`, file field `file` | `{ assetId: number; url: string }` |
| PATCH | `/api/admin/projects/:id/poster` | login | `{ assetId: number }` | `{ posterAssetId: number }` |

근거 파일:

- `apps/api/src/modules/admin/project/controller.ts`
- `apps/api/src/modules/admin/project/service.ts`
- `apps/api/src/shared/validation.ts`
- `packages/contracts/src/index.ts`

### Admin: members

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/api/admin/projects/:id/members` | login | `AddMemberRequest` | `{ id: number }` |
| PATCH | `/api/admin/projects/:id/members/:memberId` | login | `UpdateMemberRequest` | 204 |
| DELETE | `/api/admin/projects/:id/members/:memberId` | login | path `id`, `memberId` | 204 |
| PATCH | `/api/admin/projects/:id/members/swap` | login | `{ memberIdA: number; memberIdB: number }` | 204 |

근거 파일:

- `apps/api/src/modules/admin/member/controller.ts`
- `apps/api/src/shared/validation.ts`
- `packages/contracts/src/index.ts`

### Admin: chunked game upload

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/api/admin/projects/:id/game-upload-sessions` | login | JSON `{ originalName?: string; totalBytes?: number }` | `GameUploadSession` |
| PUT | `/api/admin/game-upload-sessions/:sessionId/chunks/:index` | login | `application/octet-stream` body | `GameUploadChunkResponse` |
| GET | `/api/admin/game-upload-sessions/:sessionId` | login | path `sessionId` | `GameUploadStatus` |
| POST | `/api/admin/game-upload-sessions/:sessionId/complete` | login | 없음 | `GameUploadCompleteResponse` |
| DELETE | `/api/admin/game-upload-sessions/:sessionId` | login | path `sessionId` | 204 |
| GET | `/api/admin/projects/:id/game-upload-sessions` | login | path `id` | `GameUploadSessionListResponse` |

근거 파일:

- `apps/api/src/modules/admin/game-upload/controller.ts`
- `apps/api/src/modules/admin/game-upload/service.ts`
- `apps/web/src/lib/api/game-upload.ts`
- `packages/contracts/src/index.ts`

### Admin: settings

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/settings` | `ADMIN`/`OPERATOR` | 없음 | `SiteSettingsData` |
| PATCH | `/api/admin/settings` | `ADMIN`/`OPERATOR` | `UpdateSiteSettingsRequest` | `SiteSettingsData` |

근거 파일:

- `apps/api/src/modules/admin/settings/controller.ts`
- `apps/api/src/modules/admin/settings/service.ts`
- `packages/contracts/src/index.ts`

### Admin: banned IPs

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/banned-ips` | `ADMIN`/`OPERATOR` | 없음 | `BannedIpListResponse` |
| DELETE | `/api/admin/banned-ips/:id` | `ADMIN`/`OPERATOR` | path `id` | 204 |

근거 파일:

- `apps/api/src/modules/admin/banned-ip/controller.ts`
- `apps/api/src/modules/admin/banned-ip/service.ts`
- `packages/contracts/src/index.ts`

### Admin: import/export

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/api/admin/import/preview` | `ADMIN` | multipart JSON file, max 10 MB | `ImportPreviewResult` |
| POST | `/api/admin/import/execute` | `ADMIN` | multipart JSON file, max 10 MB | `ImportExecuteResult` |
| POST | `/api/admin/export` | `ADMIN` | JSON `{ year?: number; dryRun?: boolean }`; requires `NAS_EXPORT_PATH` | `ExportResult` |
| GET | `/api/admin/export/status` | `ADMIN` | 없음 | `ExportStatusResponse` |

Import JSON schema:

```ts
type ImportData = {
	years?: {
		year: number;
		title?: string;
		isUploadEnabled?: boolean;
	}[];
	projects?: {
		year: number;
		title: string;
		slug?: string;
		summary?: string;
		description?: string;
		isIncomplete?: boolean;
		status?: 'PUBLISHED' | 'ARCHIVED';
		githubUrl?: string;
		platforms?: ('PC' | 'MOBILE' | 'WEB')[];
		members?: { name: string; studentId?: string; sortOrder?: number }[];
	}[];
};
```

근거 파일:

- `apps/api/src/modules/admin/import/controller.ts`
- `apps/api/src/modules/admin/import/service.ts`
- `apps/api/src/modules/admin/export/controller.ts`
- `apps/api/src/modules/admin/export/service.ts`
- `packages/contracts/src/index.ts`

## Frontend가 기대하는 API 형태

공통:

- `env.API_BASE_URL + path`로 호출한다.
- `credentials: 'include'`를 사용한다.
- JSON body는 `Content-Type: application/json`으로 보낸다.
- `FormData`는 browser가 boundary를 설정하도록 Content-Type을 직접 지정하지 않는다.
- XHR 기반 upload는 progress UI를 갱신한다.
- `VITE_MOCK=true`면 실제 네트워크 대신 `handleMockRequest()`를 호출한다.

근거 파일:

- `apps/web/src/lib/api/client.ts`
- `apps/web/src/lib/api/game-upload.ts`

Frontend client별 expected route:

- `publicApi`: `/api/public/years`, `/api/public/years/:year/projects`, `/api/public/exhibitions/:id/projects`, `/api/public/projects/:idOrSlug`
- `authApi`: `/api/auth/google`, `/api/auth/logout`, `/api/me`
- `adminExhibitionApi`: `/api/admin/exhibitions`, `/api/admin/exhibitions/:id`, `/api/admin/exhibitions/:id/poster`
- `adminProjectApi`: `/api/admin/projects`, `/api/admin/projects/:id`, `/api/admin/projects/submit`, `/api/admin/projects/:id/assets`, `/api/admin/projects/:id/poster`, bulk routes
- `adminMemberApi`: member CRUD/swap routes
- `adminAssetApi`: `/api/admin/assets/:assetId`
- `adminSettingsApi`: `/api/admin/settings`
- `adminBannedIpApi`: `/api/admin/banned-ips`
- `adminExportApi`: `/api/admin/export`, `/api/admin/export/status`
- `adminImportApi`: `/api/admin/import/preview`, `/api/admin/import/execute`
- game upload API: chunked upload session/chunk/status/complete/cancel/list routes

근거 파일:

- `apps/web/src/lib/api/public.ts`
- `apps/web/src/lib/api/auth.ts`
- `apps/web/src/lib/api/admin.ts`
- `apps/web/src/lib/api/game-upload.ts`

## DB schema 기준 데이터 모델

### User

- 식별자: `id`
- Google identity: `googleSub`
- profile: `email`, `studentId`, `name`, `picture`
- authorization: `role`
- relation: sessions, created projects, project memberships, game upload sessions

근거 파일: `apps/api/prisma/schema.prisma`

### Exhibition

- 연도와 전시 제목: `year`, `title`
- upload control: `isUploadEnabled`
- sorting: `sortOrder`
- poster object metadata: `posterStorageKey`, `posterOriginalName`, `posterMimeType`, `posterSizeBytes`
- unique: `[year, title]`
- relation: projects

근거 파일: `apps/api/prisma/schema.prisma`

### Project

- belongs to exhibition and creator
- public identity: `slug`, unique per exhibition
- content: `title`, `summary`, `description`
- lifecycle/status: `isIncomplete`, `status`
- optional metadata: `githubUrl`, `platforms`, `sortOrder`
- poster relation: `posterAssetId`
- relation: members, assets, game upload sessions

근거 파일: `apps/api/prisma/schema.prisma`

### ProjectMember

- belongs to project
- optional linked user
- public member fields: `name`, `studentId`
- `sortOrder`

근거 파일: `apps/api/prisma/schema.prisma`

### Asset

- belongs to project
- `kind`: `THUMBNAIL`, `IMAGE`, `POSTER`, `GAME`, `VIDEO`
- deletion status: `READY`, `DELETING`, `DELETED`, `FAILED`
- object keys: `storageKey`, optional `playbackStorageKey`
- file metadata: `originalName`, `mimeType`, `playbackMimeType`, `sizeBytes`, `playbackSizeBytes`
- playback metadata for video: `playbackStatus`, `playbackError`
- `isPublic`
- optional poster relation

근거 파일: `apps/api/prisma/schema.prisma`

### AuthSession

- `id` is session cookie value
- belongs to user
- `expiresAt`, `lastSeenAt`, `createdAt`

근거 파일: `apps/api/prisma/schema.prisma`

### GameUploadSession

- tracks S3 multipart upload
- fields: `projectId`, `userId`, `originalName`, `totalBytes`, `chunkSizeBytes`, `totalChunks`, `uploadedChunks`, `status`, `storageKey`, `s3UploadId`, `s3Key`, `s3PartEtags`, `expiresAt`
- `stagingPath` remains as legacy field and is commented as no longer used

근거 파일: `apps/api/prisma/schema.prisma`

### BannedIp, OrphanObject, SiteSetting

- `BannedIp`: protected asset download abuse ban list
- `OrphanObject`: failed S3 delete retry queue
- `SiteSetting`: upload size settings exposed to admin

근거 파일: `apps/api/prisma/schema.prisma`

## contract 불일치와 해결된 drift

### 해결됨: CORS와 game upload PUT 불일치

- Backend route: `PUT /api/admin/game-upload-sessions/:sessionId/chunks/:index`
- Frontend client: `method: 'PUT'`
- CORS plugin allowed methods: `['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']`
- 해결 내용: 2026-05-28 안정화 패치에서 `PUT`을 추가하고 `apps/api/src/__tests__/cors.test.ts`로 cross-origin `OPTIONS` preflight 응답을 검증했다.

근거 파일:

- `apps/api/src/modules/admin/game-upload/controller.ts`
- `apps/web/src/lib/api/game-upload.ts`
- `apps/api/src/plugins/cors.ts`
- `apps/api/src/__tests__/cors.test.ts`

### 해결됨: Mock API coverage 불일치

- Frontend calls `GET /api/public/exhibitions/:id/projects`.
- Backend route exists.
- Mock handler에도 `/api/public/exhibitions/:id/projects` route pattern이 있다.
- 해결 내용: 기존 `MOCK_YEARS`와 `MOCK_YEAR_PROJECTS`를 재사용해 `PublicExhibitionProjectsResponse` 형태인 `{ exhibition, items, empty }`를 반환한다.

근거 파일:

- `apps/web/src/lib/api/public.ts`
- `apps/api/src/modules/public/controller.ts`
- `apps/web/src/lib/api/mock/handler.ts`

### 해결됨: 로그인 도메인 오류 status 불일치

- 기존 문제: Backend Google hosted domain mismatch는 401이었고 LoginPage는 403일 때만 학교 도메인 안내 문구를 표시했다.
- 해결 내용: 2026-05-28 Google hosted domain 오류 contract 정렬에서 invalid token은 401 `UNAUTHORIZED`를 유지하고, hosted domain mismatch는 403 `EMAIL_DOMAIN_NOT_ALLOWED`로 반환하도록 변경했다.
- Frontend는 status number만 보지 않고 backend error code/message를 사용해 학교 도메인 안내를 표시한다.
- Backend/frontend test로 invalid token과 domain mismatch 구분, LoginPage 전용 안내 표시, 일반 로그인 실패 메시지 유지를 고정했다.

근거 파일:

- `apps/api/src/modules/auth/service.ts`
- `apps/api/src/shared/errors.ts`
- `apps/api/src/__tests__/auth-domain.test.ts`
- `apps/web/src/lib/api/client.ts`
- `apps/web/src/pages/LoginPage.tsx`
- `apps/web/src/__tests__/LoginPage.test.tsx`

### API error code 문자열 중앙화 누락

- `EMAIL_DOMAIN_NOT_ALLOWED`는 backend/frontend/test에서 사용되지만 아직 `packages/contracts`의 공용 상수나 union type으로 중앙화되어 있지 않다.
- 결론: 현재 동작은 test로 고정됐지만, 향후 error code 추가/이름 변경 시 문자열 drift 가능성이 남아 있다.

근거 파일:

- `apps/api/src/modules/auth/service.ts`
- `apps/web/src/pages/LoginPage.tsx`
- `apps/web/src/lib/api/client.ts`
- `packages/contracts/src/index.ts`

### `AUTO_PUBLISH_DEFAULT` 설정과 실제 생성 상태 불일치

- Env schema/example/deploy에는 `AUTO_PUBLISH_DEFAULT`가 남아 있다.
- `submitProject()`는 `const status: ProjectStatus = 'PUBLISHED';`로 고정한다.
- 결론: env를 변경해도 작품 등록 상태에는 영향이 없다.

근거 파일:

- `apps/api/src/config/env.ts`
- `apps/api/.env.example`
- `server/deploy.sh`
- `apps/api/src/modules/admin/project/service.ts`

### Deploy workflow path와 실제 파일 불일치

- `.github/workflows/deploy-api.yml` path trigger에 `docker-compose.yml`이 있다.
- 현재 루트에는 `docker-compose.yml`이 없다.
- 실제 local compose 파일은 `apps/db/docker-compose.yml`이고 production deploy는 `server/deploy.sh` 기반이다.

근거 파일:

- `.github/workflows/deploy-api.yml`
- `apps/db/docker-compose.yml`
- `server/deploy.sh`
- `rg --files`

### DB/import field와 API 응답 field gap

- DB `Project` 모델에는 `githubUrl`, `platforms`가 있다.
- JSON import schema도 `githubUrl`, `platforms`를 받는다.
- 현재 `PublicProjectDetailResponse`, `AdminProjectDetail`, serializer 응답에는 해당 field가 없다.
- 결론: import로 저장한 `githubUrl`, `platforms`를 frontend에서 볼 수 있는 route는 현재 확인되지 않는다.

근거 파일:

- `apps/api/prisma/schema.prisma`
- `apps/api/src/modules/admin/import/service.ts`
- `packages/contracts/src/index.ts`
- `apps/api/src/modules/admin/project/serializer.ts`
- `apps/api/src/modules/public/service.ts`
