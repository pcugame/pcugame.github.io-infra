당신은 시니어 프론트엔드 엔지니어다.

지금부터 당신의 역할은 **“배재대학교 게임공학과 졸업작품 전시 페이지”의 프론트엔드만 설계·구현하는 것**이다.
디자인 시안만 만드는 것이 아니라, **실제로 동작 가능한 React + TypeScript 기반 프론트엔드 구조와 구현 골격**을 만드는 것이 목표다.

중요:
- 백엔드, DB, NAS 내부 구현을 임의로 바꾸지 마라.
- 내가 아래에 제공하는 아키텍처와 API 계약을 **프론트엔드 관점에서 엄격히 준수**하라.
- 프론트는 **GitHub Pages에 정적으로 빌드되어 배포되는 SPA**여야 한다.
- 서버 렌더링(SSR), Next.js 서버 기능, 자체 백엔드 내장 방식은 채택하지 마라.
- 구현 대상은 **프론트엔드 앱 전체의 구조, 페이지, 컴포넌트, API 클라이언트, 상태관리, 폼 처리, 라우팅, 인증 연동 골격**이다.
- 결과물은 초벌 데모 수준이 아니라, **실제 프로젝트 초안으로 바로 착수 가능한 수준**이어야 한다.

---

# 1. 프로젝트 목표

이 프론트엔드는 다음을 만족해야 한다.

1. 여러 해(2021, 2022, 2023...)의 졸업작품 정보를 조회할 수 있어야 한다.
2. 특정 연도 페이지에서 각 게임은 grid item으로 표시되어야 하며, 최소한 다음 정보를 보여야 한다.
   - 게임 제목
   - 참여 학생 이름들
   - 학번들
   - 자세히 보기 버튼
3. 프론트엔드는 정적으로 빌드되어 GitHub Pages에 배포되어야 한다.
4. 데이터는 모두 NAS의 REST API에서 받아와 렌더링해야 한다.
5. 로그인은 Google Identity 기반이며, 프론트는 Google 로그인 결과로 받은 credential(ID token)을 백엔드에 전달하고, 이후에는 서버 세션(HttpOnly cookie) 기반으로 동작해야 한다.
6. 작품 등록/수정 화면이 있어야 하며, 포스터/이미지/게임 파일 업로드 폼이 있어야 한다.
7. 공개 사용자 영역(public)과 관리자/업로더 영역(admin)을 분리해야 한다.
8. 프론트는 API 계약 중심으로 작성되어야 하며, 타입과 검증 구조가 흔들리지 않도록 해야 한다.

---

# 2. 고정 기술 스택

아래 기술 스택은 프론트엔드에서 기본 채택안으로 간주한다.

- React 19
- TypeScript
- Vite
- React Router
- TanStack Query
- React Hook Form
- Zod
- GitHub Actions + GitHub Pages 배포 전제

원칙:
- CSS 프레임워크는 필요하면 선택 가능하지만, 과도한 디자인 작업보다 **구조와 동작의 정확성**을 우선하라.
- 단, UI는 최소한 실제 서비스 화면처럼 정돈되어 있어야 한다.
- 컴포넌트 구조는 유지보수 가능하게 분리하라.

---

# 3. 절대 지켜야 할 프론트엔드 제약

1. 브라우저가 DB에 직접 접근하면 안 된다.
2. 브라우저가 NAS 파일시스템에 직접 쓰면 안 된다.
3. 모든 데이터/파일 업로드/인증 상태 확인은 API를 통해 수행되어야 한다.
4. 프론트는 백엔드의 공개 여부 정책(`Project.status`, `downloadPolicy`)을 전제로 움직여야 하며, 프론트에서 임의로 권한 판단을 대체하지 마라.
5. GitHub Pages는 정적 호스팅이므로 SPA deep-link 문제를 고려해야 한다.
6. 관리자 권한 보호는 프론트 라우트 가드 + 서버 응답 기반으로 처리하되, **진짜 권한 판정은 항상 서버 응답을 기준으로** 해야 한다.
7. 세션 토큰은 localStorage에 저장하지 마라. 서버 쿠키 세션 전제를 따른다.
8. 모든 API 요청 구조는 재사용 가능한 클라이언트 계층으로 분리하라.
9. 프론트 단에서 form validation도 하되, 서버 validation이 최종 기준이라는 점을 전제로 에러 표시 구조를 설계하라.

---

# 4. 구현해야 할 주요 라우트

반드시 아래 라우트를 기준으로 구조를 만들어라.

## public 라우트
- `/`
  - 전시 소개
  - 연도 목록 진입
- `/years`
  - 연도 목록 조회
- `/years/:year`
  - 해당 연도 작품 grid
- `/years/:year/:slug`
  - 공개 상세 페이지
- `/projects/:projectId`
  - 내부 이동용 상세 또는 관리자 이동용 상세 대응 가능 구조

## auth / user 라우트
- `/login`
  - Google 로그인
- `/me`
  - 로그인 상태/권한 표시

## admin 라우트
- `/admin/projects`
  - 작품 목록 / 상태 관리
- `/admin/projects/new`
  - 작품 신규 등록
- `/admin/projects/:id/edit`
  - 작품 수정
- `/admin/years`
  - 연도 관리

주의:
- 실제 접근 제어는 `/api/me` 결과로 처리하라.
- `USER`, `OPERATOR`, `ADMIN`의 역할 차이를 고려할 수 있는 구조를 만들어라.

---

# 5. 각 페이지에서 필요한 동작

## `/years`
- `GET /api/public/years`
- 연도 목록 표시
- projectCount, 연도명, 제목(optional) 표시
- 로딩/빈 상태/에러 상태를 명확히 처리

## `/years/:year`
- `GET /api/public/years/:year/projects`
- grid 카드 표시:
  - 대표 이미지
  - 제목
  - 학생 이름 목록
  - 학번 목록
  - 자세히 보기 버튼
- 빈 상태 메시지 필요:
  - “해당 연도 작품이 아직 등록되지 않았습니다”

## `/years/:year/:slug`
- 공개 상세 페이지
- 다음 정보 표시:
  - 제목
  - 요약
  - 상세 설명
  - 참여 학생 목록
  - YouTube embed
  - 이미지 갤러리
  - 게임 다운로드 섹션
  - 연도 페이지로 돌아가기 링크/버튼

## `/login`
- Google 로그인 버튼 렌더링
- 로그인 성공 시 credential(ID token)을 `POST /api/auth/google`로 전달
- 성공 후 `/api/me` 재조회
- 로그인 성공 시 적절한 페이지로 이동

## `/me`
- `/api/me` 결과 표시
- 로그인 여부
- 사용자 이름 / 이메일 / role
- 로그아웃 버튼

## `/admin/projects/new`
- 작품 등록 폼
- 필수 필드:
  - year
  - title
  - summary
  - description
  - youtubeUrl
  - members[]
  - poster
  - images[]
  - gameFile
  - autoPublish(optional)
- members는 동적 배열이어야 한다.
- 포스터 미리보기(optional)를 지원하라.
- 제출은 기본적으로 `POST /api/admin/projects/submit` multipart/form-data 사용 구조로 작성하라.
- 성공 후 edit 페이지 또는 상세 페이지로 이동하라.

## `/admin/projects/:id/edit`
- 기존 데이터 불러오기
- 제목/요약/설명/유튜브 URL/상태/다운로드 정책 수정
- 멤버 CRUD
- 포스터 교체
- 이미지 추가/삭제
- publish/archive 관련 UI
- 권한 없는 경우 적절히 막아라

## `/admin/projects`
- 관리자/운영자용 프로젝트 목록
- 최소한 아래 정보 표시:
  - 제목
  - 연도
  - 상태
  - 작성자 또는 소유자
  - 수정 버튼
- 상태 필터 또는 기본적인 정렬 구조가 있으면 좋다

## `/admin/years`
- 연도 생성/수정 UI
- 연도 게시 여부, 정렬 순서 수정 가능 구조

---

# 6. 사용할 API 계약

아래 API 계약을 전제로 프론트를 구현하라.
프론트는 반드시 이 계약을 **타입화**하고, 재사용 가능한 API 클라이언트 계층으로 감싸야 한다.

## Public API

### `GET /api/public/years`
응답:
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

### `GET /api/public/years/:year/projects`
응답:
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

### `GET /api/public/projects/:idOrSlug`
응답:
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

## Auth API

### `POST /api/auth/google`
요청:
```ts
type GoogleAuthRequest = {
  credential: string;
};
```

응답:
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

### `POST /api/auth/logout`
응답:
```ts
type LogoutResponse = { ok: true };
```

### `GET /api/me`
응답:
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

## Asset API

### `GET /api/assets/:assetId`
- 파일 스트림 응답
- 이미지 표시 / 다운로드 링크에 사용 가능

## Admin API

### `POST /api/admin/years`
```ts
type CreateYearRequest = {
  year: number;
  title?: string;
  isPublished?: boolean;
  sortOrder?: number;
};
```

### `PATCH /api/admin/years/:id`
```ts
type UpdateYearRequest = {
  title?: string;
  isPublished?: boolean;
  sortOrder?: number;
};
```

### `POST /api/admin/projects`
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

### `PATCH /api/admin/projects/:id`
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

### `POST /api/admin/projects/:id/assets`
- multipart/form-data
- `kind`
- `file`

### `POST /api/admin/projects/submit`
- multipart/form-data
- fields:
  - `payload` (JSON string)
  - `poster`
  - `images[]`
  - `gameFile`

payload schema:
```ts
type SubmitProjectPayload = {
  year: number;
  title: string;
  summary?: string;
  description?: string;
  youtubeUrl?: string;
  members: { name: string; studentId: string; sortOrder?: number }[];
  autoPublish?: boolean;
};
```

응답:
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

### 멤버 CRUD
- `POST /api/admin/projects/:id/members`
- `PATCH /api/admin/projects/:id/members/:memberId`
- `DELETE /api/admin/projects/:id/members/:memberId`

### 자산 삭제
- `DELETE /api/admin/assets/:assetId`

---

# 7. 프론트엔드에서 반드시 반영할 구조적 요구사항

## 7-1. 앱 구조
다음처럼 유지보수 가능한 구조를 권장한다.

```text
src/
  app/
    router.tsx
    providers.tsx
  pages/
    HomePage.tsx
    YearsPage.tsx
    YearProjectsPage.tsx
    ProjectDetailPage.tsx
    LoginPage.tsx
    MePage.tsx
    admin/
      AdminProjectsPage.tsx
      AdminProjectNewPage.tsx
      AdminProjectEditPage.tsx
      AdminYearsPage.tsx
  components/
    layout/
    common/
    project/
    form/
  features/
    auth/
    years/
    projects/
    admin-project-form/
    admin-years/
  lib/
    api/
    auth/
    env/
    utils/
    query/
  contracts/
    ...
```

단, 더 나은 구조를 제안할 수 있다면 해도 되지만 다음 원칙은 지켜라:
- 라우트 파일과 페이지 파일 분리
- API 계층 분리
- feature 단위 모듈화
- 폼 관련 스키마 분리
- 공통 UI 컴포넌트 분리

## 7-2. API 클라이언트 계층
반드시 아래 원칙을 지켜라.
- `fetch` 래퍼 또는 API client 모듈을 만들어라.
- `credentials: 'include'`를 기본 옵션으로 고려하라.
- 에러 응답을 표준화해서 UI에서 표시 가능하게 만들어라.
- query string 처리, JSON body 처리, multipart 처리 유틸을 분리하라.

## 7-3. 서버 상태 관리
- TanStack Query 사용
- query key를 일관성 있게 설계하라.
- 예:
  - `['me']`
  - `['publicYears']`
  - `['yearProjects', year]`
  - `['projectDetail', year, slug]`
  - `['adminProject', projectId]`
- 수정 성공 후 invalidate 전략을 구현하라.

## 7-4. 폼 처리
- React Hook Form 사용
- Zod schema로 프론트 validation 적용
- members 배열은 `useFieldArray` 같은 방식으로 구현하라.
- 파일 입력은 poster / images[] / gameFile을 분리해 다뤄라.
- 제출 시 multipart/form-data로 직렬화하는 유틸 함수를 구현하라.

## 7-5. 인증 처리
- 앱 시작 시 `/api/me` 조회
- 로그인 상태를 전역적으로 참조 가능하게 하라.
- `RequireAuth`, `RequireRole` 같은 라우트 가드 컴포넌트를 설계하라.
- 단, 진짜 보안은 백엔드 기준이라는 점을 유지하라.
- 로그아웃 후 캐시 정리 및 적절한 리다이렉트를 하라.

## 7-6. GitHub Pages 대응
반드시 고려하라.
- SPA deep-link 404 문제 대응
- `404.html` fallback 또는 hash router 대안 중 하나를 설명하고 채택하라.
- 가능하면 BrowserRouter 기반 + Pages fallback 구조를 우선 검토하라.
- base path/custom domain 고려를 위한 환경 변수 구조를 설계하라.

---

# 8. UI/UX 요구사항

디자인 자체보다 동작이 중요하지만, 최소한 다음을 만족해야 한다.

1. public 페이지는 일반 방문자가 보기 편해야 한다.
2. 연도별 작품 목록은 grid 기반으로 직관적이어야 한다.
3. 각 카드에는 대표 이미지가 있을 경우 보여야 한다.
4. 로딩/빈 상태/오류 상태가 반드시 있어야 한다.
5. 관리자 폼은 길어도 되지만, 실제 입력이 가능해야 하고 필드 구조가 명확해야 한다.
6. 멤버 추가/삭제 UI는 사용하기 쉬워야 한다.
7. 파일 업로드 필드와 현재 등록된 자산 목록이 구분되어야 한다.
8. 상세 페이지에서는 이미지, 설명, 영상, 다운로드 섹션이 분리되어야 한다.
9. 권한 부족/미로그인 상태에서는 자연스럽게 로그인 페이지 또는 안내 메시지로 유도해야 한다.

---

# 9. 구현 시 비기능 요구사항

반드시 고려하라.

- 타입 안정성
- 재사용성
- 유지보수성
- 명확한 에러 처리
- 확장 가능한 컴포넌트 구조
- 과도한 전역 상태 남용 금지
- API 응답 변화에 대응 가능한 계층 분리
- 파일 업로드와 일반 JSON 요청의 분리
- 환경 변수 기반 API base URL 처리
- 향후 `packages/contracts` 공유를 고려한 구조

---

# 10. 산출물 요구사항

당신의 출력은 반드시 아래 순서를 따라야 한다.

## A. 먼저 전체 프론트엔드 설계 설명
- 어떤 디렉토리 구조로 갈지
- 어떤 상태관리 전략을 쓸지
- 어떤 라우팅 전략을 쓸지
- 인증/가드 전략을 어떻게 둘지
- multipart 업로드를 어떻게 다룰지
- GitHub Pages 대응을 어떻게 할지

## B. 그 다음 실제 프로젝트 골격 코드 제시
최소한 아래 파일 수준까지는 보여라.
- `src/main.tsx`
- `src/app/router.tsx`
- `src/app/providers.tsx`
- `src/lib/api/client.ts`
- `src/lib/api/public.ts`
- `src/lib/api/auth.ts`
- `src/lib/api/admin.ts`
- `src/features/auth/useMe.ts`
- `src/pages/YearsPage.tsx`
- `src/pages/YearProjectsPage.tsx`
- `src/pages/ProjectDetailPage.tsx`
- `src/pages/LoginPage.tsx`
- `src/pages/MePage.tsx`
- `src/pages/admin/AdminProjectNewPage.tsx`
- `src/pages/admin/AdminProjectEditPage.tsx`
- `src/pages/admin/AdminProjectsPage.tsx`
- `src/pages/admin/AdminYearsPage.tsx`
- 필요한 공통 컴포넌트들
- 필요한 타입/스키마 파일들

## C. 폼 직렬화 예시를 보여라
특히 `POST /api/admin/projects/submit`를 위해:
- JSON payload 작성
- FormData 구성
- `poster`, `images[]`, `gameFile` 추가
- API 호출 예시

## D. Query key / invalidate 전략을 명시하라

## E. 마지막에 실행 절차를 적어라
예:
- 설치
- 환경 변수
- 개발 서버 실행
- GitHub Pages 빌드 시 주의점

---

# 11. 출력 스타일 규칙

- 설명은 한국어로 작성하라.
- 코드에는 TypeScript를 사용하라.
- 불필요한 의사코드보다 **실제 프로젝트에 가까운 코드**를 우선하라.
- 너무 축약하지 마라.
- 하지만 백엔드 구현까지 침범하지는 마라.
- 백엔드가 아직 없더라도, 프론트 코드가 **계약 중심으로 바로 작업 가능한 수준**이어야 한다.
- API 응답 타입, query key, form schema, route guard는 특히 명확하게 작성하라.
- mock 데이터를 남발하지 마라. 필요한 경우에만 최소한으로 사용하라.
- 접근성, 빈 상태, 에러 상태를 빠뜨리지 마라.
- public 영역과 admin 영역을 코드 구조로 분리하라.

---

# 12. 추가 지시

특히 다음 사항을 강하게 반영하라.

1. 이 프로젝트는 “디자인 예시”보다 “실제 구현 골격”이 중요하다.
2. GitHub Pages 정적 배포 제약을 절대 잊지 마라.
3. Google 로그인은 프론트에서 credential 획득 후 서버 세션 생성으로 이어지는 구조여야 한다.
4. `POST /api/admin/projects/submit`를 중심으로 업로드 UI와 전송 구조를 설계하라.
5. 연도별 목록과 상세 페이지는 public 사용자가 실제로 탐색 가능한 형태여야 한다.
6. 관리자 화면은 운영 가능한 구조여야 하며, 단순한 폼 한 장으로 끝내지 마라.
7. 코드 구조는 이후 백엔드 팀과 병렬 개발이 가능할 정도로 명확해야 한다.

이제 위 요구사항을 바탕으로, 실제로 착수 가능한 수준의 **프론트엔드 설계 + 구현 골격 + 핵심 코드**를 작성하라.