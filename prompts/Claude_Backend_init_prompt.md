당신은 시니어 백엔드 엔지니어이자 DevOps 엔지니어다.

지금부터 “배재대학교 게임공학과 졸업작품 전시 페이지”의 **백엔드 API 서버만** 구현한다.
프론트엔드는 만들지 말고, **Synology NAS의 Container Manager(Project/Compose)** 에서 실제로 띄울 수 있는 **Docker 기반 Node.js + TypeScript + Fastify + Prisma + PostgreSQL 백엔드**를 작성하라.

중요:
- 설명 위주로 끝내지 말고, **실제 실행 가능한 파일들**을 생성하라.
- pseudo code 금지.
- TODO 남발 금지.
- 핵심 기능은 반드시 동작 가능한 수준으로 구현하라.
- 결과물은 “초벌 스캐폴딩”이 아니라 **MVP 동작 가능한 백엔드**여야 한다.
- 기존 프론트 요구사항은 참고만 하고, 이번 작업 범위는 **백엔드 + DB + Docker + NAS 파일 저장 + 인증/세션 + 업로드/다운로드 API**다.

---

# 0. 최종 목표

다음 구조를 만족하는 백엔드를 구현하라.

- 프론트엔드는 GitHub Pages의 정적 SPA가 호출하는 외부 클라이언트다.
- 백엔드는 Synology NAS에서 Docker 컨테이너로 실행된다.
- DB는 PostgreSQL 컨테이너다.
- 파일은 NAS 볼륨에 저장된다.
- 브라우저는 DB에 직접 접근하지 않는다.
- 브라우저는 NAS 파일시스템에 직접 쓰지 않는다.
- 모든 업로드는 백엔드 API를 거친다.
- 공개 여부는 `Project.status` 로 통제한다.
- Google Identity 로그인 후 프론트가 넘긴 ID token을 서버가 검증하고 세션 쿠키를 발급한다.
- 공개 썸네일/대표 이미지는 public access 가능해야 하고, 원본 이미지/게임 파일은 정책에 따라 백엔드가 통제해야 한다.

---

# 1. 기술 스택 고정

반드시 아래 스택으로 구현하라.

- Node.js 22
- TypeScript
- Fastify
- @fastify/multipart
- @fastify/cookie
- @fastify/cors
- Zod
- Prisma ORM
- PostgreSQL 16
- google-auth-library
- Pino logger
- Docker / Docker Compose
- package manager는 npm 사용

테스트 라이브러리는 선택 사항이지만, 최소한 구조상 추가 가능하게 설계하라.

---

# 2. 반드시 생성해야 하는 산출물

다음 파일/구조를 실제로 작성하라.

## 루트 구조
- `apps/api/`
- `apps/api/src/`
- `apps/api/prisma/schema.prisma`
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/Dockerfile`
- `apps/api/.dockerignore`
- `docker-compose.yml`
- `.env.example`
- `README.md`

## src 내부 권장 구조
- `src/server.ts`
- `src/app.ts`
- `src/config/env.ts`
- `src/plugins/cors.ts`
- `src/plugins/cookie.ts`
- `src/plugins/multipart.ts`
- `src/plugins/auth.ts`
- `src/lib/prisma.ts`
- `src/lib/logger.ts`
- `src/shared/errors.ts`
- `src/shared/http.ts`
- `src/shared/slug.ts`
- `src/shared/session.ts`
- `src/shared/file-signature.ts`
- `src/shared/storage-path.ts`

## modules
- `src/modules/auth/auth.routes.ts`
- `src/modules/auth/auth.service.ts`
- `src/modules/public/public.routes.ts`
- `src/modules/public/public.service.ts`
- `src/modules/admin/admin.routes.ts`
- `src/modules/admin/admin.project.service.ts`
- `src/modules/admin/admin.year.service.ts`
- `src/modules/admin/admin.asset.service.ts`
- `src/modules/assets/assets.routes.ts`
- `src/modules/assets/assets.service.ts`
- `src/modules/storage/storage.service.ts`

또한 다음을 포함하라.
- Prisma schema
- Prisma client generation 설정
- migration 적용 가능한 상태
- health check endpoint
- 실행 방법 README
- Synology Container Manager에서 곧바로 쓸 수 있는 `docker-compose.yml`

---

# 3. 구현 범위

이번 단계에서 반드시 구현할 MVP 범위는 아래와 같다.

## Public API
1. `GET /api/health`
2. `GET /api/public/years`
3. `GET /api/public/years/:year/projects`
4. `GET /api/public/projects/:idOrSlug`
5. `GET /api/assets/:assetId`

## Auth API
6. `POST /api/auth/google`
7. `POST /api/auth/logout`
8. `GET /api/me`

## Admin API
9. `POST /api/admin/years`
10. `PATCH /api/admin/years/:id`
11. `POST /api/admin/projects`
12. `PATCH /api/admin/projects/:id`
13. `DELETE /api/admin/projects/:id`
14. `POST /api/admin/projects/:id/assets`
15. `POST /api/admin/projects/submit`
16. `PATCH /api/admin/projects/:id/poster`
17. `POST /api/admin/projects/:id/members`
18. `PATCH /api/admin/projects/:id/members/:memberId`
19. `DELETE /api/admin/projects/:id/members/:memberId`
20. `DELETE /api/admin/assets/:assetId`

---

# 4. 데이터 모델 요구사항

Prisma schema는 아래 모델을 기준으로 구현하라.

## enum
- `UserRole = USER | OPERATOR | ADMIN`
- `ProjectStatus = DRAFT | PUBLISHED | ARCHIVED`
- `AssetKind = THUMBNAIL | IMAGE | POSTER | GAME`
- `AssetStatus = READY | DELETING | DELETED | FAILED`
- `DownloadPolicy = NONE | PUBLIC | SCHOOL_ONLY | ADMIN_ONLY`

## model
- `User`
- `Year`
- `Project`
- `ProjectMember`
- `Asset`
- `AuthSession`
- `UploadJob`

다음 조건을 반드시 반영하라.
- `Year.year` 는 unique
- `Project.slug` 는 year 기준 unique
- `Project.posterAssetId` 지원
- `ProjectMember` 는 정렬 가능해야 함
- `Asset.storageKey` unique
- `AuthSession` 은 DB-backed session 용도
- `UploadJob` 은 업로드 실패 추적 용도로 유지

Prisma schema는 아래 요구를 충족해야 한다.
- relation 이름 명확히 지정
- 삭제 정책(onDelete) 적절히 지정
- `createdAt`, `updatedAt` 자동 처리
- public 목록 조회와 year/project 조회에 필요한 index 반영

---

# 5. 인증/인가 요구사항

반드시 아래 정책대로 구현하라.

## Google 로그인
- 프론트가 `credential`(Google ID token)을 `POST /api/auth/google` 으로 보낸다.
- 서버는 `google-auth-library` 로 토큰을 검증한다.
- 다음을 확인해야 한다:
  - `aud`
  - `iss`
  - `exp`
  - `email_verified`
  - `hd`
  - `sub`
- 허용 학교 도메인은 환경변수 `ALLOWED_GOOGLE_HD`
- 허용 클라이언트 ID 목록은 `GOOGLE_CLIENT_IDS`
- 사용자 식별자는 `sub`
- 로그인 성공 시 `User` upsert
- `AuthSession` row 생성
- `sid` 쿠키 발급

## 세션
- DB-backed 세션
- 쿠키는 `HttpOnly`, `Secure`
- `SameSite` 는 cross-site 환경 고려 가능하게 환경변수/설정으로 제어 가능하게 설계
- `GET /api/me` 는 로그인 여부와 사용자 role 반환
- `POST /api/auth/logout` 은 세션 revoke

## 권한
- PUBLIC:
  - published 데이터만 조회 가능
- USER:
  - 로그인
  - `/api/me`
  - 작품 등록
  - 본인이 생성한 draft 수정 가능
- OPERATOR / ADMIN:
  - 연도 생성/수정
  - 모든 작품 수정 가능
  - publish/archive 전환 가능
- `DELETE /api/admin/projects/:id` 는 우선 archive 기반으로 처리해도 된다.
- `status=PUBLISHED` 전환은 `OPERATOR|ADMIN` 만 가능하게 구현하라.

---

# 6. 파일 저장 및 보안 요구사항

반드시 NAS 볼륨 마운트를 전제로 구현하라.

## 스토리지 원칙
- public/static 루트와 protected 루트를 분리
- 사용자 원본 파일명으로 저장하지 말 것
- 내부 저장 키는 UUID 또는 안전한 랜덤 키 기반
- path traversal 방지
- MIME/type spoofing 방지
- 확장자만 보지 말고 magic number 검사
- asset URL은 내부 storageKey를 직접 노출하지 말 것

## 볼륨 경로
환경변수:
- `UPLOAD_ROOT_PROTECTED`
- `UPLOAD_ROOT_PUBLIC`

예상 예시:
- `/app/storage/protected`
- `/app/storage/public`

## 허용 파일
### 이미지
- jpg
- jpeg
- png
- webp

### 게임 파일
- zip 만 허용

## 금지 파일
- svg
- exe
- msi
- bat
- sh
- apk 직접 업로드
- heic
- bmp
- gif

## 크기 제한
- poster: 10MB
- image(each): 15MB
- game: 1024MB
- total multipart: 1200MB

## 공개 정책
- published 프로젝트의 대표 poster/thumbnails 는 public access 허용 가능
- game file 은 항상 attachment 다운로드
- image/game 접근 시 `Project.downloadPolicy` 와 `Project.status` 를 검사하라

---

# 7. 업로드/작품 자동 생성 요구사항

가장 중요한 기능은 아래다.

## `POST /api/admin/projects/submit`
multipart/form-data 한 번으로 아래를 처리하라.
- `payload` JSON string
- `poster` file
- `images[]` files optional
- `gameFile` file optional

payload 예시:
```json
{
  "year": 2026,
  "title": "Takobocchi Wars",
  "summary": "한 줄 소개",
  "description": "상세 설명",
  "youtubeUrl": "https://www.youtube.com/watch?v=xxxx",
  "members": [
    { "name": "홍길동", "studentId": "20201234", "sortOrder": 0 },
    { "name": "김철수", "studentId": "20205678", "sortOrder": 1 }
  ],
  "autoPublish": false
}
```

서버 동작 요구:
1. 로그인 확인
2. payload Zod validation
3. 파일 validation
4. 파일 저장
5. DB transaction 시작
6. Year 확인 또는 생성
7. Project 생성
8. ProjectMember 생성
9. Asset 생성
10. poster 연결
11. 성공 응답 반환

## 실패 보상 처리
파일시스템과 DB는 한 트랜잭션이 아니므로 반드시 보상 처리를 구현하라.
- DB 실패 시 저장한 파일 삭제 시도
- 삭제 실패 시 로그 남기기
- 필요하면 `UploadJob` 에 실패 상태 기록
- 최소한 “파일만 남고 DB 실패” 상황을 무시하지 말 것

---

# 8. public 조회 로직 요구사항

## `GET /api/public/years`
반환:
- published 가능한 연도 목록
- 연도별 published 프로젝트 수 포함

## `GET /api/public/years/:year/projects`
반환:
- 해당 연도의 published 프로젝트 목록
- 각 카드:
  - id
  - slug
  - title
  - summary
  - posterUrl
  - members
- 정렬:
  - `sortOrder ASC`
  - 보조 `createdAt DESC`

## `GET /api/public/projects/:idOrSlug`
반환:
- id 또는 slug 조회 지원
- slug 조회 시 query의 `year` 활용 가능
- published 프로젝트 상세
- members
- images
- poster
- game download url
- downloadPolicy
- status

---

# 9. admin 수정 로직 요구사항

아래를 구현하라.

## `POST /api/admin/projects`
- 메타데이터만 프로젝트 생성 가능

## `PATCH /api/admin/projects/:id`
- title
- summary
- description
- youtubeUrl
- status
- sortOrder
- downloadPolicy
수정 가능

## `POST /api/admin/projects/:id/assets`
- kind + file 업로드로 자산 추가

## `PATCH /api/admin/projects/:id/poster`
- 대표 포스터 교체

## member CRUD
- 추가
- 수정
- 삭제

## asset delete
- 참조 해제
- 상태 변경
- storage delete
- soft delete 반영

---

# 10. API 응답 형식 요구사항

- JSON 응답 구조를 일관되게 유지하라.
- 성공/실패 응답을 너무 난잡하게 만들지 말고, 실서비스에서 프론트가 쓰기 좋은 구조로 정리하라.
- 적절한 HTTP status code 사용:
  - 200
  - 201
  - 400
  - 401
  - 403
  - 404
  - 409
  - 413
  - 415
  - 500
- validation 오류는 사람이 읽을 수 있는 메시지 포함
- Fastify error handler 정리

---

# 11. 환경변수 요구사항

`.env.example` 에 최소한 아래를 포함하라.

- `NODE_ENV`
- `PORT`
- `DATABASE_URL`
- `SESSION_SECRET`
- `SESSION_COOKIE_NAME`
- `SESSION_TTL_DAYS`
- `COOKIE_SECURE`
- `COOKIE_SAME_SITE`
- `GOOGLE_CLIENT_IDS`
- `ALLOWED_GOOGLE_HD`
- `CORS_ALLOWED_ORIGINS`
- `PUBLIC_BASE_URL`
- `UPLOAD_ROOT_PROTECTED`
- `UPLOAD_ROOT_PUBLIC`
- `AUTO_PUBLISH_DEFAULT`
- `LOG_LEVEL`

---

# 12. Docker / Synology 요구사항

반드시 Synology NAS의 Container Manager(Project/Compose) 를 고려해서 작성하라.

## `docker-compose.yml`
아래 서비스를 포함하라.
- `postgres`
- `api`

요구:
- postgres data volume mount
- protected/public storage volume mount
- `restart: unless-stopped`
- API가 postgres 의존
- production 환경 기준

## `apps/api/Dockerfile`
- multi-stage build
- production image 최적화
- Prisma client 동작 고려
- `npm ci` 기반
- TypeScript build 후 dist 실행
- health check 추가 가능하면 반영

주의:
- Synology에서 너무 복잡한 쿠버네티스식 구성 금지
- compose 한 파일로 충분히 띄울 수 있게 하라

---

# 13. README 요구사항

`README.md` 에 반드시 아래를 써라.

- 프로젝트 개요
- 폴더 구조
- 로컬 실행 방법
- `.env` 설정 방법
- Prisma migration 방법
- Docker Compose 실행 방법
- Synology Container Manager에 올리는 방법
- NAS 볼륨 경로 준비 방법
- Reverse Proxy 연결 포인트
- Google 로그인 준비물
- 운영시 주의사항

README는 실제 운영자가 따라할 수 있을 정도로 구체적으로 작성하라.

---

# 14. 코드 품질 요구사항

- TypeScript strict 기준으로 작성
- any 남발 금지
- 함수/변수 이름 명확하게
- 비즈니스 로직은 route 파일에 몰아넣지 말고 service로 분리
- env parsing은 중앙화
- Zod validation 적극 사용
- Prisma 접근은 service/lib 계층에서 정리
- 파일 저장 로직과 DB 로직을 적절히 분리
- 에러 핸들링 통일
- 로깅 포함
- 최소한 이후 프론트가 붙기 쉬운 구조로 유지

---

# 15. 구현 우선순위

반드시 아래 우선순위대로 작업하라.

1. 프로젝트 구조 및 package 설정
2. env/config
3. Prisma schema
4. Dockerfile / compose
5. Fastify app / plugins / health
6. auth/session
7. public API
8. storage / assets API
9. admin year/project/member/asset API
10. multipart submit 전체 흐름
11. README 정리

---

# 16. 작업 방식 지시

중요:
- 한꺼번에 장황한 설명만 하지 말고, 실제 파일 생성 중심으로 진행하라.
- 먼저 전체 파일 구조를 잡고,
- 그 다음 핵심 파일 내용을 작성하고,
- 마지막에 실행 방법을 정리하라.
- 생성한 파일은 가능한 한 내용까지 완성도 있게 작성하라.
- “여기서 끝”이 아니라, 실제로 `docker compose up --build` 후 이어서 세팅할 수 있는 상태를 목표로 하라.

---

# 17. 출력 형식

다음 순서로 답하라.

1. 먼저 생성할 파일 목록을 간단히 제시
2. 그 다음 각 파일의 실제 내용을 제시
3. 마지막에 실행 순서를 제시

설명은 최소화하고, **코드와 파일 내용 위주**로 출력하라.

이제 위 요구사항을 만족하는 **실행 가능한 백엔드 MVP 코드베이스**를 작성하라.