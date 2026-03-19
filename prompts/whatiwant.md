## 1. 전체 아키텍처 요약

권장 기본안은 **정적 프론트엔드 + NAS 위 REST API + PostgreSQL + NAS 파일 스토리지**의 4분리 구조입니다.

* **프론트엔드**: React + TypeScript SPA를 정적으로 빌드해서 **GitHub Pages**에 배포
* **백엔드 API**: Synology NAS의 Container Manager(Project/Compose)로 실행되는 Node.js + TypeScript REST API
* **DB**: NAS 내부 Docker/Container Manager로 구동하는 PostgreSQL
* **파일 저장소**: Synology NAS 볼륨에 업로드 파일 저장
* **인증**: 프론트에서 Google Identity로 로그인 → 받은 ID token을 백엔드에 전달 → 백엔드가 Google 토큰 검증 후 세션 발급
* **자산 접근**:

  * 공개 썸네일/대표 이미지: 캐시 가능한 공개 URL 또는 공개 asset endpoint
  * 원본 이미지/게임 파일: 백엔드 통제 하 다운로드/조회
* **운영 핵심 원칙**:

  * 브라우저는 DB에 직접 접근하지 않음
  * 브라우저는 NAS 파일시스템에 직접 쓰지 않음
  * 업로드는 반드시 백엔드 API를 거침
  * 공개 여부는 `Project.status`로 통제

GitHub Pages는 정적 HTML/CSS/JS를 배포하는 정적 호스팅 서비스이고, GitHub Actions 기반 Pages 배포도 지원하므로 프론트 정적 셸 배포에 적합합니다. Synology DSM은 reverse proxy 규칙과 access control profile을 둘 수 있고, Container Manager의 Project로 compose 기반 다중 컨테이너 운영이 가능합니다. ([GitHub Docs][1])

---

## 2. 왜 이 구조가 요구사항에 맞는지 설명

이 구조가 맞는 이유는 요구사항의 충돌을 가장 적게 만들기 때문입니다.

첫째, **프론트 정적 호스팅** 요구와 **서버 데이터 기반 동적 목록/상세** 요구를 동시에 만족합니다.
프론트는 GitHub Pages에 정적으로 올라가되, 실제 작품 목록/상세/로그인 상태는 런타임에 NAS API를 호출해 가져오면 됩니다. 즉 “페이지 셸은 정적”, “콘텐츠 데이터는 API 기반 동적”으로 분리됩니다. GitHub Pages가 정적 호스팅이므로 서버 렌더링 의존 기능을 프론트에 넣지 않는 것이 맞습니다. ([GitHub Docs][1])

둘째, **DB 직접 접근 금지** 요구를 정확히 지킵니다.
브라우저는 오직 `https://api.example.ac.kr/api/...`만 호출하고, API 서버만 PostgreSQL과 NAS 파일 경로를 해석합니다.

셋째, **업로드 자동 생성** 요구를 가장 안전하게 처리합니다.
업로드 폼 제출 한 번으로

1. 파일 검증
2. NAS 저장
3. Project / ProjectMember / Asset 생성
4. poster 연결
5. 상세 조회 가능 상태 반환
   까지 한 흐름으로 처리할 수 있습니다.

넷째, **작품 등록**, **파일 저장**, **공개 여부**를 분리할 수 있습니다.

* **파일 저장**: blob를 NAS에 저장하고 Asset 메타데이터 생성
* **작품 등록**: Project + Member + Asset 연결 생성
* **공개 여부**: `status=DRAFT|PUBLISHED|ARCHIVED` 전환으로 public API 노출 여부 제어

이 분리가 있어야 검수 후 공개와 즉시 공개를 둘 다 지원할 수 있습니다.

다섯째, **학교 도메인 로그인 제한**을 백엔드 책임으로 둘 수 있습니다.
Google 로그인 후 프론트가 받은 토큰을 백엔드가 다시 검증하고, `aud`, `iss`, `exp`, `hd`를 확인해야 안전합니다. Google 문서도 단순 사용자 ID를 신뢰하지 말고, HTTPS로 받은 ID token을 서버에서 검증하라고 명시합니다. 또한 조직/학교 도메인 제한은 이메일 문자열만이 아니라 `hd` claim 검증이 필요합니다. ([Google for Developers][2])

---

## 3. 권장 기술 스택과 선택 이유

### 프론트엔드

* **React 19 + TypeScript**
* **Vite**
* **React Router**
* **TanStack Query**
* **React Hook Form + Zod**
* **GitHub Actions → GitHub Pages**

선택 이유:

* GitHub Pages에 올리기 쉬운 정적 빌드 구조
* API 기반 데이터 fetch/caching에 유리
* 업로드 폼과 동적 멤버 배열 처리에 강함
* Zod로 프론트 입력 스키마를 백엔드와 공유 가능

### 백엔드

* **Node.js 22 LTS + TypeScript**
* **Fastify**
* **@fastify/multipart**
* **Zod**
* **Prisma ORM**
* **google-auth-library**
* **PostgreSQL**
* **Pino logger**

선택 이유:

* REST API와 multipart 업로드 처리에 적합
* Fastify는 스트리밍 업로드 처리에 유리
* Prisma migration/schema 관리가 쉽고 유지보수성이 높음
* `google-auth-library`로 Google ID token 검증 가능 ([Google for Developers][3])

### 인프라

* **Synology DSM Reverse Proxy**
* **Synology Container Manager Project**
* **PostgreSQL container**
* **API container**
* 필요시 **Nginx sidecar** 또는 API 직접 서빙

선택 이유:

* Synology가 reverse proxy와 container project 구성을 지원 ([시놀로지 지식 센터][4])

### 세션

* **HttpOnly Secure Cookie Session**
* 세션 저장소: **PostgreSQL AuthSession 테이블**

선택 이유:

* 장기 민감 토큰을 브라우저 저장소에 둘 필요가 없음
* `/me` 조회가 단순
* 운영 규모상 Redis 없이도 충분
* 단, 프론트와 API가 다른 origin이면 `credentials`, `CORS`, `SameSite`, CSRF 방어를 정확히 설정해야 함

---

## 4. 프론트엔드 구조

### 라우트

필수 라우트는 다음과 같이 잡습니다.

* `/`

  * 전시 소개
  * 연도 목록 진입 버튼
* `/years`

  * 연도 목록 조회
* `/years/:year`

  * 해당 연도 작품 grid
* `/years/:year/:slug`

  * 공개용 상세 라우트
* `/projects/:projectId`

  * 내부 이동/관리자 이동용 상세 라우트
* `/login`

  * Google 로그인
* `/me`

  * 내 정보, 권한, 로그인 상태
* `/admin/projects/new`

  * 작품 등록
* `/admin/projects/:id/edit`

  * 작품 수정
* `/admin/years`

  * 연도 관리
* `/admin/projects`

  * 작품 목록/상태 관리

### 페이지별 동작

#### `/years`

* `GET /api/public/years`
* 연도 내림차순 또는 `sortOrder`
* 빈 상태 처리

#### `/years/:year`

* `GET /api/public/years/:year/projects`
* grid card 표시:

  * 대표 이미지
  * 제목
  * 학생 이름 목록
  * 학번 목록
  * 자세히 보기 버튼
* 정렬:

  * `sortOrder ASC NULLS LAST`
  * `createdAt DESC` 보조 정렬
* 빈 연도 상태:

  * “해당 연도 작품이 아직 등록되지 않았습니다”

#### `/years/:year/:slug`

* 추천 public canonical route
* 프로젝트 상세:

  * 제목
  * 요약/설명
  * 참여 학생 목록
  * YouTube embed
  * 이미지 갤러리
  * 게임 다운로드 섹션
  * 연도 페이지로 돌아가기

#### `/admin/projects/new`

폼 필드:

* year
* title
* summary
* description
* members: `[{ name, studentId, sortOrder }]`
* poster file
* image files[]
* game file
* youtubeUrl

폼 동작:

* 학생 여러 명 추가/삭제
* poster 미리보기 optional
* 제출 후 성공 시

  * `/projects/:id` 또는 `/admin/projects/:id/edit`로 이동
  * query cache invalidate

### 프론트 상태 관리

* 서버 상태: TanStack Query
* 폼 상태: React Hook Form
* 공유 계약: `packages/contracts`

### 캐시 무효화 전략

관리자 수정 후:

* `queryClient.invalidateQueries(['publicYears'])`
* `queryClient.invalidateQueries(['yearProjects', year])`
* `queryClient.invalidateQueries(['project', id])`

공개 썸네일 URL은 asset id + revision 기반으로 캐시 키를 만들면 좋습니다.
예:

* `/api/assets/ast_123?v=20260319T170000`

### GitHub Pages 라우팅 처리

GitHub Pages는 정적 호스팅이므로 SPA deep link 404 대응이 필요합니다.
권장안:

* custom domain 사용
* `404.html`을 `index.html`과 동일하게 두는 SPA fallback
* 또는 hash routing

---

## 5. 백엔드 구조

### 계층 구조

* **route layer**: HTTP, auth guard, multipart parsing
* **controller/service layer**: 비즈니스 로직
* **repository/ORM layer**: Prisma
* **storage layer**: NAS 파일 저장/삭제/stream
* **auth layer**: Google token verify, session create, RBAC
* **contract/validation layer**: Zod schema

### 주요 모듈

* `auth`

  * `POST /api/auth/google`
  * `POST /api/auth/logout`
  * `GET /api/me`

* `public`

  * years/projects 조회

* `admin`

  * year/project CRUD
  * publish toggle
  * member CRUD
  * asset CRUD
  * submit all-in-one

* `storage`

  * saveTemp
  * saveFinal
  * deleteFile
  * streamFile
  * checksum 계산
  * mime sniffing

### 권한 모델

기본 모델:

* **PUBLIC**

  * published year/project 조회
* **USER** (허용 학교 도메인)

  * 로그인
  * 본인 정보 조회
  * 작품 등록
  * 본인 draft 수정 가능
* **OPERATOR / ADMIN**

  * 연도 생성/수정
  * 모든 작품 수정/삭제
  * 공개 여부 전환
  * 자산 삭제/교체

권장 정책:

* 로그인 사용자도 업로드는 가능
* 공개 전환은 `OPERATOR|ADMIN`만 가능
* 일반 업로더는 자기 작품만 수정 가능

### 작품 등록 파이프라인 전체

기본안은 **단일 요청 multipart 처리**입니다.

#### 기본 흐름

1. 관리자/권한 사용자 로그인 확인
2. JSON 필드 validation
3. 파일 validation
4. 파일을 NAS 저장소에 저장
5. DB transaction 시작
6. Year 확인 또는 생성
7. Project 생성 (`status='DRAFT'`)
8. ProjectMember 생성
9. Asset 메타데이터 생성
10. `posterAssetId` 연결
11. commit
12. 응답으로 `projectId`, `slug`, `status`
13. 프론트 이동

#### 실패 보상 처리

파일시스템과 DB는 한 트랜잭션에 묶을 수 없으므로, 기본안은 **보상 처리(saga-like compensation)** 입니다.

* 4단계 후 DB 실패:

  * 방금 저장한 파일 전부 삭제
* 7~10단계 중 실패:

  * DB rollback
  * 저장 파일 삭제
* commit 이후 응답 실패:

  * DB는 살아 있으므로 idempotent하게 재조회 가능
* 삭제 실패/부분 실패 추적:

  * `UploadJob` 또는 audit log에 실패 기록
  * 주기적 orphan cleanup job 운영

### 작품 등록 / 파일 저장 / 공개 여부 분리

#### 파일 저장

* 파일 blob 저장
* `Asset` 메타데이터 생성
* 아직 public 노출 아님

#### 작품 등록

* `Project`, `ProjectMember`, `Asset` 연결
* 기본 `status='DRAFT'`

#### 공개 여부

* `PATCH /api/admin/projects/:id`
* `status='PUBLISHED'` 시 public API 노출 시작
* `status='ARCHIVED'` 시 public 목록 제외

이 분리가 있어야 검수 후 공개와 즉시 공개를 모두 지원할 수 있습니다.

### 즉시 공개 vs 검수 후 공개

#### 기본 권장안: 검수 후 공개

* 생성 시 `status='DRAFT'`
* 관리자 검토 후 `PUBLISHED`

장점:

* 악성 파일, 잘못된 포스터, 학번 오류, 유튜브 URL 오류를 걸러내기 쉬움
* 운영 안정성 높음

단점:

* 업로드 직후 public 반영 안 됨

#### 선택안: 즉시 공개

* 환경변수 `AUTO_PUBLISH_DEFAULT=true` 또는 폼 정책값으로 즉시 `PUBLISHED`

장점:

* 등록 즉시 public 반영
* 행사 직전 대량 등록에 빠름

단점:

* 잘못된 데이터가 바로 공개될 수 있음
* 관리자 정정 부담 증가

권장 환경변수:

```env
AUTO_PUBLISH_DEFAULT=false
```

---

## 6. DB 스키마 초안

권장 모델은 다음과 같습니다.

```prisma
enum UserRole {
  USER
  OPERATOR
  ADMIN
}

enum ProjectStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

enum AssetKind {
  THUMBNAIL
  IMAGE
  POSTER
  GAME
}

enum AssetStatus {
  READY
  DELETING
  DELETED
  FAILED
}

enum DownloadPolicy {
  NONE
  PUBLIC
  SCHOOL_ONLY
  ADMIN_ONLY
}

model User {
  id             String      @id @default(cuid())
  googleSub      String      @unique
  email          String      @unique
  name           String
  role           UserRole    @default(USER)
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt
  lastLoginAt    DateTime?

  projectsCreated Project[]   @relation("ProjectCreatedBy")
  uploadedAssets  Asset[]     @relation("AssetUploadedBy")
  sessions        AuthSession[]
}

model Year {
  id          String    @id @default(cuid())
  year        Int       @unique
  title       String?
  isPublished Boolean   @default(true)
  sortOrder   Int       @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  projects    Project[]
}

model Project {
  id               String         @id @default(cuid())
  yearId           String
  slug             String
  title            String
  summary          String?
  description      String?
  youtubeUrl       String?
  status           ProjectStatus  @default(DRAFT)
  sortOrder        Int            @default(0)
  downloadPolicy   DownloadPolicy @default(PUBLIC)

  posterAssetId    String?
  createdByUserId  String

  createdAt        DateTime       @default(now())
  updatedAt        DateTime       @updatedAt
  publishedAt      DateTime?

  year             Year           @relation(fields: [yearId], references: [id], onDelete: Restrict)
  createdByUser    User           @relation("ProjectCreatedBy", fields: [createdByUserId], references: [id], onDelete: Restrict)
  posterAsset      Asset?         @relation("ProjectPoster", fields: [posterAssetId], references: [id], onDelete: SetNull)
  members          ProjectMember[]
  assets           Asset[]        @relation("ProjectAssets")

  @@unique([yearId, slug])
  @@index([yearId, status, sortOrder, createdAt])
}

model ProjectMember {
  id         String   @id @default(cuid())
  projectId  String
  name       String
  studentId  String
  role       String?
  sortOrder  Int      @default(0)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  project    Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, sortOrder])
}

model Asset {
  id               String      @id @default(cuid())
  projectId        String?
  kind             AssetKind
  storageKey       String      @unique
  originalName     String
  mimeType         String
  size             BigInt
  checksum         String?
  isPublic         Boolean     @default(false)
  status           AssetStatus @default(READY)
  uploadedByUserId String
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt
  deletedAt        DateTime?

  project          Project?    @relation("ProjectAssets", fields: [projectId], references: [id], onDelete: SetNull)
  uploadedByUser   User        @relation("AssetUploadedBy", fields: [uploadedByUserId], references: [id], onDelete: Restrict)
  posterOfProject  Project[]   @relation("ProjectPoster")

  @@index([projectId, kind, createdAt])
}

model AuthSession {
  id               String   @id @default(cuid())
  userId           String
  sessionTokenHash String   @unique
  expiresAt        DateTime
  revokedAt        DateTime?
  userAgent        String?
  ipAddress        String?
  createdAt        DateTime @default(now())

  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model UploadJob {
  id             String   @id @default(cuid())
  createdByUserId String
  status         String
  payloadJson    Json?
  errorMessage   String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}
```

### 설계 포인트

* `Year.year`는 숫자 unique
* `Project.slug`는 **연도 기준 unique**
* `posterAssetId`로 목록 카드 대표 이미지 연결
* `ProjectMember`는 배열 기반 입력을 그대로 반영
* `Asset.storageKey`는 UUID/해시 기반
* `AuthSession`은 DB-backed cookie session 용도
* `UploadJob`은 필수는 아니지만 장애 추적에 유용

### slug 규칙

예:

* 제목 `"Takobocchi Wars"` → `takobocchi-wars`
* 충돌 시 → `takobocchi-wars-2`
* 또는 `takobocchi-wars-9f3a`

---

## 7. API 명세 초안

아래는 **필수 API + 권장 추가 API** 기준입니다.

---

### 7-1. Public API

#### `GET /api/public/years`

**목적**

* 공개 가능한 연도 목록 조회

**요청**

* 없음

**응답**

```ts
type PublicYearListResponse = {
  items: {
    id: string;
    year: number;
    title?: string;
    projectCount: number;
    isPublished: boolean;
  }[];
};
```

**인증**

* 불필요

**실패 케이스**

* `500`

**프론트 사용**

* `/years` 목록 렌더링
* 홈에서 연도 진입 버튼 렌더링

---

#### `GET /api/public/years/:year/projects`

**목적**

* 특정 연도 작품 카드 목록 조회

**요청 파라미터**

* path: `year: number`

**응답**

```ts
type PublicYearProjectsResponse = {
  year: number;
  items: {
    id: string;
    slug: string;
    title: string;
    summary?: string;
    posterUrl?: string;
    members: { name: string; studentId: string }[];
  }[];
  empty: boolean;
};
```

**인증**

* 불필요

**실패 케이스**

* `404` 연도 없음
* `500`

**프론트 사용**

* `/years/:year` grid 렌더링

---

#### `GET /api/public/projects/:idOrSlug`

**목적**

* 프로젝트 상세 조회

**요청 파라미터**

* path: `idOrSlug`
* query optional: `year=2026` when slug lookup

**응답**

```ts
type PublicProjectDetailResponse = {
  id: string;
  year: number;
  slug: string;
  title: string;
  summary?: string;
  description?: string;
  youtubeUrl?: string;
  members: { id: string; name: string; studentId: string }[];
  images: { id: string; url: string; kind: 'IMAGE' | 'POSTER' }[];
  posterUrl?: string;
  gameDownloadUrl?: string;
  downloadPolicy: 'NONE' | 'PUBLIC' | 'SCHOOL_ONLY' | 'ADMIN_ONLY';
  status: 'PUBLISHED';
};
```

**인증**

* public 상세는 불필요
* 단, 비공개 프로젝트는 관리자/소유자만 별도 admin API로 조회

**실패 케이스**

* `404`
* `403` 접근 불가 asset policy

**프론트 사용**

* `/projects/:id`, `/years/:year/:slug`

---

### 7-2. Auth API

#### `POST /api/auth/google`

**목적**

* Google ID token 검증 후 서버 세션 생성

**요청**

```ts
type GoogleAuthRequest = {
  credential: string; // Google ID token
};
```

**응답**

```ts
type GoogleAuthResponse = {
  ok: true;
  user: {
    id: string;
    email: string;
    name: string;
    role: 'USER' | 'OPERATOR' | 'ADMIN';
  };
};
```

**인증**

* 없음

**실패 케이스**

* `400` token 없음
* `401` token invalid
* `403` 허용 도메인 아님
* `500`

**프론트 사용**

* `/login`에서 Google 로그인 성공 후 credential 전송
* 성공 시 `/me` 재조회

---

#### `POST /api/auth/logout`

**목적**

* 세션 무효화

**요청**

* 없음

**응답**

```ts
type LogoutResponse = { ok: true };
```

**인증**

* 로그인 필요

**실패 케이스**

* `401`

**프론트 사용**

* 로그아웃 버튼

---

#### `GET /api/me`

**목적**

* 현재 로그인 상태와 권한 확인

**응답**

```ts
type MeResponse =
  | { authenticated: false }
  | {
      authenticated: true;
      user: {
        id: string;
        email: string;
        name: string;
        role: 'USER' | 'OPERATOR' | 'ADMIN';
      };
    };
```

**인증**

* 선택적

**실패 케이스**

* `500`

**프론트 사용**

* 헤더 로그인 상태 표시
* admin 접근 가드

---

### 7-3. Asset API

#### `GET /api/assets/:assetId`

**목적**

* asset 제공
* public thumbnail/poster는 anonymous 허용
* protected image/game는 정책 확인 후 stream

**요청**

* path: `assetId`

**응답**

* 파일 stream
* 적절한 `Content-Type`
* 다운로드 시 `Content-Disposition: attachment`

**인증**

* asset/project policy에 따라 다름

**실패 케이스**

* `404`
* `403`
* `410` deleted

**프론트 사용**

* 카드 대표 이미지
* 상세 이미지 갤러리
* 게임 다운로드

---

### 7-4. Admin Year API

#### `POST /api/admin/years`

**목적**

* 연도 생성

**요청**

```ts
type CreateYearRequest = {
  year: number;
  title?: string;
  isPublished?: boolean;
  sortOrder?: number;
};
```

**응답**

```ts
type CreateYearResponse = {
  id: string;
  year: number;
};
```

**인증**

* `OPERATOR | ADMIN`

**실패**

* `400` validation
* `409` duplicate year
* `403`

**프론트 사용**

* 연도 관리 화면

---

#### `PATCH /api/admin/years/:id`

**목적**

* 연도 수정

**요청**

```ts
type UpdateYearRequest = {
  title?: string;
  isPublished?: boolean;
  sortOrder?: number;
};
```

**응답**

* 수정된 year

**인증**

* `OPERATOR | ADMIN`

---

### 7-5. Admin Project API

#### `POST /api/admin/projects`

**목적**

* 메타데이터만 프로젝트 생성
* staged upload 방식 또는 분리형 생성용

**요청**

```ts
type CreateProjectRequest = {
  year: number;
  title: string;
  summary?: string;
  description?: string;
  youtubeUrl?: string;
  members: { name: string; studentId: string; sortOrder?: number }[];
  status?: 'DRAFT' | 'PUBLISHED';
  posterAssetId?: string;
  imageAssetIds?: string[];
  gameAssetId?: string;
};
```

**응답**

```ts
type CreateProjectResponse = {
  id: string;
  slug: string;
  status: 'DRAFT' | 'PUBLISHED';
};
```

**인증**

* 로그인 필요
* publish 지정은 `OPERATOR|ADMIN`

**실패**

* `400`, `403`, `409`

**프론트 사용**

* staged upload 또는 수정형 생성

---

#### `PATCH /api/admin/projects/:id`

**목적**

* 기존 작품 수정
* 공개 여부 전환

**요청**

```ts
type UpdateProjectRequest = {
  title?: string;
  summary?: string;
  description?: string;
  youtubeUrl?: string | null;
  status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  sortOrder?: number;
  downloadPolicy?: 'NONE' | 'PUBLIC' | 'SCHOOL_ONLY' | 'ADMIN_ONLY';
};
```

**응답**

* 수정된 project

**인증**

* 소유자 draft 수정 가능
* publish/archive/delete는 `OPERATOR|ADMIN`

---

#### `DELETE /api/admin/projects/:id`

**목적**

* 프로젝트 soft delete 또는 archive

**권장**

* 실제 hard delete보다 `ARCHIVED` 우선

**인증**

* `ADMIN`

---

#### `POST /api/admin/projects/:id/assets`

**목적**

* 기존 작품에 자산 추가
* 수정 화면에서 이미지 추가/게임 파일 추가

**요청**

* `multipart/form-data`
* fields:

  * `kind`
  * `file`

**응답**

* `assetId`, `url`

**인증**

* 로그인 필요, 소유권/권한 검사

---

### 7-6. 업로드/작품 자동 생성 API

#### `POST /api/admin/projects/submit`

**목적**

* 작품 메타데이터 + 멤버 목록 + 파일 업로드를 한 번에 처리하는 기본 API

**채택 방식**

* **기본안: 단일 요청 `multipart/form-data`**
* 이유:

  * 작품 등록을 한 번에 끝낼 수 있음
  * 운영 복잡도 낮음
  * 요구사항 17, 18에 직접 부합

**요청 형식**

* Content-Type: `multipart/form-data`
* field 예시:

  * `payload`: JSON string
  * `poster`: file
  * `images[]`: files
  * `gameFile`: file

`payload` 예시:

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

**응답**

```ts
type SubmitProjectResponse = {
  id: string;
  slug: string;
  year: number;
  status: 'DRAFT' | 'PUBLISHED';
  adminEditUrl: string;
  publicUrl?: string;
};
```

**인증**

* 학교 도메인 로그인 필요

**실패 케이스**

* `400` payload schema invalid
* `400` members empty / poster missing
* `400` invalid youtube url
* `413` file too large
* `415` invalid mime/ext
* `401` not logged in
* `403` role insufficient
* `409` duplicate slug
* `500`

**프론트 사용**

* `/admin/projects/new` 저장 버튼의 기본 제출 API

**롤백/정리 방식**

* 저장된 파일 목록을 메모리/`UploadJob`로 추적
* DB 트랜잭션 실패 시 저장 파일 삭제
* 파일 삭제 실패 시 cleanup queue 기록

**최대 파일 크기 예시**

* poster: 10MB
* image(each): 15MB
* game: 1024MB
* total multipart: 1200MB

**허용 확장자 / MIME**

* poster/image:

  * ext: `.jpg .jpeg .png .webp`
  * mime: `image/jpeg`, `image/png`, `image/webp`
* game:

  * ext: `.zip`
  * mime: `application/zip`, `application/x-zip-compressed`
* SVG 금지
* EXE 직접 업로드 금지
* 게임 파일은 압축본만 허용

**검증 규칙**

* 확장자만 보지 말고 magic number로 MIME sniffing
* 원본 파일명은 저장 경로에 사용하지 않음

---

#### `POST /api/admin/uploads`

**목적**

* 대용량 파일을 분리 업로드해야 할 경우의 선택 API

**채택 방식**

* **선택안: 단계별 처리**
* 업로드 자체는 여전히 **multipart/form-data**
* presigned-like 직접 NAS 업로드는 **기본안으로 채택하지 않음**

**왜 presigned-like를 기본안으로 안 쓰는가**

* S3가 아니라 NAS 로컬 스토리지
* 브라우저가 NAS 파일시스템에 직접 쓰면 안 됨
* 백엔드 검증, 권한, 감사 추적을 중앙화하는 것이 더 안전

**권장 동작**

1. `/api/admin/uploads`로 파일 1개 업로드
2. 서버가 temp storage에 저장
3. `uploadToken` 반환
4. `/api/admin/projects` 또는 `/api/admin/projects/submit`에서 token 참조

**응답**

```ts
type UploadResponse = {
  uploadToken: string;
  originalName: string;
  size: number;
  mimeType: string;
  expiresAt: string;
};
```

**실패 정리**

* 미사용 temp upload는 24시간 후 정리

---

#### `PATCH /api/admin/projects/:id/poster`

**목적**

* 대표 포스터 교체

**요청**

* `multipart/form-data`
* `poster` file 1개
* 또는 JSON `{ uploadToken }`

**응답**

* 새 `posterAssetId`, `posterUrl`

**인증**

* 소유자 또는 관리자

**정리**

* 기존 poster asset은 즉시 hard delete보다 soft delete 후 참조 해제
* 백그라운드 cleanup 가능

---

#### `POST /api/admin/projects/:id/members`

**목적**

* 참여 학생 추가

**요청**

```ts
type AddMemberRequest = {
  name: string;
  studentId: string;
  sortOrder?: number;
};
```

---

#### `PATCH /api/admin/projects/:id/members/:memberId`

**목적**

* 참여 학생 수정

**요청**

```ts
type UpdateMemberRequest = {
  name?: string;
  studentId?: string;
  sortOrder?: number;
};
```

---

#### `DELETE /api/admin/projects/:id/members/:memberId`

**목적**

* 참여 학생 삭제

---

#### `DELETE /api/admin/assets/:assetId`

**목적**

* 업로드 자산 삭제

**동작**

1. 참조 여부 검사
2. 필요하면 poster 연결 해제
3. DB row `DELETING`
4. storage delete
5. 성공 시 `DELETED`/soft delete
6. 실패 시 재시도 대상 기록

---

## 8. 인증 흐름

### 선택안

**HttpOnly Secure Cookie Session**을 권장합니다.

### 이유

* 장기 refresh token을 브라우저 localStorage에 저장하지 않아도 됨
* XSS 노출면이 줄어듦
* `/me` 확인 구조가 단순
* 관리 화면 보호가 쉬움

### 로그인 흐름

1. 프론트 `/login`에서 Google Identity 버튼 표시
2. Google 로그인 성공
3. 프론트가 `credential`(ID token) 획득
4. `POST /api/auth/google`로 HTTPS 전송
5. 백엔드가 Google ID token 검증

   * signature
   * `aud`
   * `iss`
   * `exp`
   * `hd`
6. `email_verified=true`, `hd===ALLOWED_GOOGLE_HD` 확인
7. User upsert
8. AuthSession row 생성
9. `Set-Cookie: sid=...; HttpOnly; Secure`
10. 프론트는 `GET /api/me`로 로그인 상태 갱신

Google 문서는 서버에서 ID token의 무결성을 검증해야 하며, plain user ID를 백엔드에서 신뢰하면 안 된다고 명시합니다. 또한 조직/학교 계정 제한은 `hd` claim으로 확인해야 하며, 단순 email domain 문자열만으로는 충분하지 않다고 설명합니다. `sub`를 사용자 식별자로 저장하는 것도 권장됩니다. ([Google for Developers][2])

### 학교 도메인 제한

환경변수 예:

```env
ALLOWED_GOOGLE_HD=pcu.ac.kr
GOOGLE_CLIENT_IDS=web-client-id.apps.googleusercontent.com
```

검증 로직:

* `payload.hd === ALLOWED_GOOGLE_HD`
* `payload.email_verified === true`
* `payload.aud` in allowed client IDs
* `payload.sub`를 `User.googleSub`에 저장

### 세션 보안

* cookie:

  * `HttpOnly`
  * `Secure`
  * `SameSite=None` 또는 same-site custom domain이면 정책 재검토
* CORS:

  * `Access-Control-Allow-Origin`은 allowlist만
  * `Access-Control-Allow-Credentials: true`
* state-changing 요청:

  * CSRF token 또는 Origin 검증
* session rotation:

  * 로그인 시 새 세션 발급
  * 로그아웃 시 revoke

### `/me`

* 프론트는 앱 시작 시 `/api/me` 호출
* 로그인 여부, 권한, 본인 이메일 확인

---

## 9. 파일 저장/다운로드 보안 전략

### 저장 원칙

* 업로드 디렉터리는 public static 루트와 분리
* 원본 파일명 사용 금지
* `storageKey = UUID + checksum prefix` 같은 내부 키 사용
* MIME/type spoofing 방지 위해 magic number 검사
* path traversal 방지 위해 사용자 입력 경로 결합 금지

### 디렉터리 구조 예시

```text
/volume1/gradshow/
  db-backups/
  file-storage/
    protected/
      projects/
        2026/
          prj_cx82a/
            poster/
              3fa85f64-5717-4562-aeaa-1.webp
            images/
              84aa1d3e-d2e1-4b3b-a1e2-1.webp
              84aa1d3e-d2e1-4b3b-a1e2-2.webp
            game/
              9ea20f3c-79ad-4f89-a1f2-1.zip
    public/
      thumbnails/
        2026/
          prj_cx82a/
            3fa85f64-5717-4562-aeaa-thumb.webp
```

### 저장 키 예시

```text
storageKey = 2026/prj_cx82a/poster/3fa85f64-5717-4562-aeaa.webp
storageKey = 2026/prj_cx82a/game/9ea20f3c-79ad-4f89-a1f2.zip
```

### 공개 자산 전략

#### 1) 공개 썸네일/대표 이미지

* published 프로젝트의 카드 이미지 용도
* `isPublic=true`
* 긴 캐시 허용
* reverse proxy 또는 `/api/assets/:assetId`에서 `Cache-Control: public`

#### 2) 갤러리 원본 이미지

* 기본은 `isPublic=false`
* 단, published 프로젝트에 한해 백엔드가 허용 여부 판정 후 전달
* URL 자체는 내부 storageKey를 노출하지 않음

#### 3) 게임 파일

* 항상 백엔드 통제 하 다운로드
* `Content-Disposition: attachment`
* 브라우저 inline 실행 금지
* 서버에서 실행 절대 금지

### 다운로드 제어

기본은 `Project.downloadPolicy` 기반:

* `NONE`
* `PUBLIC`
* `SCHOOL_ONLY`
* `ADMIN_ONLY`

예:

* 공개 전시용이면 `PUBLIC`
* 내부 테스트 빌드는 `SCHOOL_ONLY`

### 파일 검증

#### 이미지

* 허용: jpg, jpeg, png, webp
* 금지: svg, gif, bmp, heic
* 이유: SVG 스크립트/렌더링 리스크, 운영 단순화

#### 게임

* 허용: zip
* 금지: exe, msi, bat, sh, apk 직접 업로드
* Windows 빌드는 zip 압축본만 허용

### 추가 보안 권장

* rate limit
* 업로드 사용자/프로젝트 감사 로그
* 필요시 ClamAV 스캔 컨테이너 추가
* directory listing 금지
* public 볼륨 read-only mount 권장

---

## 10. Synology + GitHub Pages 배포 구조

### 전체 배포 그림

```text
[User Browser]
   ├─ https://gradshow.example.ac.kr      -> GitHub Pages (static frontend)
   └─ https://api.gradshow.example.ac.kr  -> Synology Reverse Proxy -> API Container

[Synology NAS]
   ├─ Reverse Proxy
   ├─ API Container (Node.js/Fastify)
   ├─ PostgreSQL Container
   └─ Volume Mount (/volume1/gradshow/file-storage)
```

GitHub Pages는 정적 파일을 배포하고 custom workflow로 GitHub Actions 기반 배포가 가능합니다. Synology는 Login Portal/Reverse Proxy 설정과 Container Manager Project 구성이 가능하므로 이 구조가 자연스럽습니다. ([GitHub Docs][5])

### 권장 도메인

* 프론트: `gradshow.example.ac.kr`
* API: `api.gradshow.example.ac.kr`

이렇게 하면 custom domain을 GitHub Pages에 연결하면서도 API를 NAS에 둘 수 있습니다. GitHub Pages는 custom domain 설정을 지원합니다. ([GitHub Docs][1])

### Synology reverse proxy 예시

* source:

  * protocol: HTTPS
  * hostname: `api.gradshow.example.ac.kr`
  * port: 443
* destination:

  * protocol: HTTP
  * hostname: `api-container`
  * port: 3000

### Synology Container Manager project 예시

```yaml
services:
  postgres:
    image: postgres:16
    container_name: gradshow-postgres
    environment:
      POSTGRES_DB: gradshow
      POSTGRES_USER: gradshow
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - /volume1/gradshow/postgres:/var/lib/postgresql/data
    restart: unless-stopped

  api:
    image: ghcr.io/your-org/gradshow-api:latest
    container_name: gradshow-api
    depends_on:
      - postgres
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgresql://gradshow:${POSTGRES_PASSWORD}@postgres:5432/gradshow
      SESSION_SECRET: ${SESSION_SECRET}
      GOOGLE_CLIENT_IDS: ${GOOGLE_CLIENT_IDS}
      ALLOWED_GOOGLE_HD: ${ALLOWED_GOOGLE_HD}
      CORS_ALLOWED_ORIGINS: https://gradshow.example.ac.kr
      PUBLIC_BASE_URL: https://api.gradshow.example.ac.kr
      UPLOAD_ROOT_PROTECTED: /app/storage/protected
      UPLOAD_ROOT_PUBLIC: /app/storage/public
      AUTO_PUBLISH_DEFAULT: "false"
    volumes:
      - /volume1/gradshow/file-storage/protected:/app/storage/protected
      - /volume1/gradshow/file-storage/public:/app/storage/public
    restart: unless-stopped
```

### 환경 분리

* local
* staging
* production

예:

```env
NODE_ENV=production
APP_ENV=production
```

### CORS 예시

```env
CORS_ALLOWED_ORIGINS=https://gradshow.example.ac.kr,https://yourname.github.io
```

### 운영 절차

* 배포 전:

  * `prisma migrate deploy`
* 배포 후:

  * health check
* DB backup:

  * daily `pg_dump`
* 파일 backup:

  * Synology Hyper Backup / snapshot
* 관리자 변경 로그:

  * 최소 `AuditLog` 또는 app log 남김

---

## 11. 폴더 구조 예시

### monorepo 권장

```text
gradshow/
  apps/
    web/
      src/
        app/
        pages/
          HomePage.tsx
          YearsPage.tsx
          YearProjectsPage.tsx
          ProjectDetailPage.tsx
          LoginPage.tsx
          MePage.tsx
          admin/
            AdminProjectNewPage.tsx
            AdminProjectEditPage.tsx
        components/
        features/
          auth/
          years/
          projects/
          admin-project-form/
        lib/
          api.ts
          queryClient.ts
          env.ts
      public/
      vite.config.ts
      package.json

    api/
      src/
        app.ts
        server.ts
        config/
        plugins/
          cors.ts
          cookies.ts
          multipart.ts
          auth.ts
        modules/
          auth/
            auth.routes.ts
            auth.service.ts
            auth.repository.ts
          public/
            public.routes.ts
            public.service.ts
          admin/
            admin.routes.ts
            admin.project.service.ts
            admin.year.service.ts
            admin.asset.service.ts
          storage/
            storage.service.ts
            storage.types.ts
          project-members/
          assets/
        shared/
          errors/
          guards/
          utils/
      prisma/
        schema.prisma
        migrations/
      package.json

  packages/
    contracts/
      src/
        auth.ts
        public.ts
        admin.ts
        upload.ts
        index.ts
    config/
      eslint/
      typescript/

  .github/
    workflows/
      deploy-web-pages.yml
      build-api-image.yml

  docs/
    architecture.md
```

### 계약 우선 구조

핵심은 `packages/contracts`입니다.

예:

```ts
// packages/contracts/src/admin.ts
import { z } from 'zod';

export const ProjectMemberInputSchema = z.object({
  name: z.string().min(1).max(50),
  studentId: z.string().min(1).max(20),
  sortOrder: z.number().int().nonnegative().optional(),
});

export const SubmitProjectPayloadSchema = z.object({
  year: z.number().int().min(2021).max(2100),
  title: z.string().min(1).max(120),
  summary: z.string().max(300).optional(),
  description: z.string().max(5000).optional(),
  youtubeUrl: z.string().url().optional(),
  autoPublish: z.boolean().optional(),
  members: z.array(ProjectMemberInputSchema).min(1),
});
```

프론트와 백엔드 모두 이 스키마를 사용하면 계약이 흔들리지 않습니다.

---

## 12. 구현 우선순위

### 1단계

* DB schema
* Prisma migration
* public years/projects/detail API
* React public pages

### 2단계

* Google 로그인
* `/api/auth/google`
* `/api/me`
* cookie session
* role/ownership guard

### 3단계

* `/admin/projects/new`
* `POST /api/admin/projects/submit`
* poster + members + year create
* draft 생성

### 4단계

* `/admin/projects/:id/edit`
* 이미지 추가/삭제
* member CRUD
* poster 교체
* publish toggle

### 5단계

* game file upload/download policy
* audit log
* orphan cleanup
* backup automation
* staged upload API

---

## 13. 최소 동작 MVP 범위

MVP는 아래까지만 있어도 요구사항 핵심을 충족합니다.

### public

* `/`
* `/years`
* `/years/:year`
* `/projects/:id`

### auth

* Google 로그인
* 학교 도메인 제한
* `/me`

### admin

* `/admin/projects/new`
* `POST /api/admin/projects/submit`
* draft 생성
* `/admin/projects/:id/edit`
* publish 전환

### asset

* poster 업로드
* 추가 이미지 업로드
* game zip 업로드
* `GET /api/assets/:assetId`

### storage

* NAS protected/public 분리
* UUID storageKey
* MIME/type validation
* size limit
* compensation cleanup

MVP에서 생략 가능한 것:

* resumable upload
* ClamAV
* signed URL
* 상세 audit dashboard
* multi-tenant 권한

---

## 14. 이후 확장 포인트

1. **resumable/chunk upload**

* 대형 게임 파일 안정성 향상

2. **UploadJob 고도화**

* 진행률, 실패 재시도, orphan recovery

3. **썸네일 자동 생성**

* poster 원본 → webp thumbnail 파생 생성

4. **signed download URL**

* 대용량 게임 파일 다운로드 최적화

5. **AuditLog 테이블**

* 누가 언제 공개/수정/삭제했는지 추적

6. **검색/필터**

* 연도 내 검색
* 학생 이름/학번 검색

7. **downloadPolicy 고도화**

* 학교 로그인 사용자만 다운로드
* 행사 기간에만 공개

8. **관리 승인 워크플로우**

* USER 업로더 제출
* OPERATOR 승인
* ADMIN 최종 게시

9. **CI/CD 분리**

* web는 Pages
* api는 GHCR 이미지 빌드 후 NAS pull

10. **관측성**

* health endpoint
* structured log
* storage usage dashboard

---

### 최종 권장 결론

이 프로젝트의 기본안은 아래 한 줄로 정리됩니다.

**GitHub Pages에는 React 정적 셸만 배포하고, 실제 작품 데이터/로그인/업로드/파일 다운로드는 Synology NAS의 TypeScript REST API가 전담하며, PostgreSQL은 API 뒤에 두고, 파일은 NAS 볼륨에 저장하되 공개 썸네일과 보호 자산을 분리해 운영한다.**

이 구조가 요구사항을 가장 직접적으로 만족합니다.
특히 핵심은 다음 세 가지입니다.

* **계약 우선**: `packages/contracts`로 프론트/백 타입과 검증 공유
* **업로드 우선**: `POST /api/admin/projects/submit`로 작품 생성 자동화
* **공개 분리**: `status=DRAFT/PUBLISHED/ARCHIVED`로 안정적 운영