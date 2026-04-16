# Collaboration Readiness Findings

Date: 2026-04-17
Repository: `C:\Users\song\Desktop\pcu_graduationproject_v2`

## 목적

이 문서는 다음 질문에 답하기 위해 작성했다.

- 실제 서버 접근권한이 없는 사람도 개발에 참여할 수 있는가
- `.env` 내용을 직접 수정하지 않고도 개발에 참여할 수 있는가
- 여러 명이 병렬로 개발할 때 어떤 부분이 병목이 되는가

코드 패치는 하지 않았고, 현재 저장소 상태를 기준으로 "무엇을 바꿔야 하는지"와 "왜 바꿔야 하는지"만 정리했다.

## 현재 상태 요약

### 가능한 것

- 프론트엔드 UI 일부는 서버 없이 개발 가능
  - [README.md](C:/Users/song/Desktop/pcu_graduationproject_v2/README.md#L58)
  - [apps/web/.env.mock](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/.env.mock#L1)
  - [apps/web/src/lib/api/client.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/src/lib/api/client.ts#L28)
- 로컬 DB와 로컬 오브젝트 스토리지 구성 자체는 이미 존재
  - [apps/db/docker-compose.yml](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/db/docker-compose.yml#L1)

### 아직 부족한 것

- API 로컬 실행을 위한 공유 가능한 샘플 env가 없음
  - [apps/api/src/config/env.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/api/src/config/env.ts#L3)
- 개발용 로그인 우회 경로가 없어 Google 로그인/쿠키 수동 주입에 의존
  - [apps/api/src/modules/auth/service.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/api/src/modules/auth/service.ts#L23)
  - [apps/api/prisma/seed.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/api/prisma/seed.ts#L243)
- 프론트 mock 모드가 전체 화면/기능을 덮지 못함
  - [apps/web/src/lib/api/mock/handler.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/src/lib/api/mock/handler.ts#L30)
- PR 단계 자동 검증 워크플로가 없음
  - [\.github/workflows/deploy-api.yml](C:/Users/song/Desktop/pcu_graduationproject_v2/.github/workflows/deploy-api.yml#L1)
  - [\.github/workflows/deploy-web-pages.yml](C:/Users/song/Desktop/pcu_graduationproject_v2/.github/workflows/deploy-web-pages.yml#L1)

## 결론

현재 저장소는 "실서버 권한이 없어도 일부 작업은 가능한 상태"다.

- 가능 범위: 프론트 UI 수정, 일부 계약/타입 작업, 테스트/린트 기반 리팩터링
- 어려운 범위: API 실행, 인증 포함 E2E 확인, 관리자 기능 전체 확인, 파일 업로드/다운로드 검증

즉, "여러 명이 함께 참여 가능한 기본 방향"은 이미 있지만, 아직은 "신규 참여자가 저장소만 받아 바로 붙을 수 있는 상태"는 아니다.

## 바꿔야 하는 것

### 1. `apps/api/.env.example`를 추가해야 함

관련 코드:

- [apps/api/src/config/env.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/api/src/config/env.ts#L7)
- [apps/api/src/server.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/api/src/server.ts#L1)

이유:

- API는 `DATABASE_URL`, `SESSION_SECRET`, `GOOGLE_CLIENT_IDS`, `CORS_ALLOWED_ORIGINS`, `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `S3_*`를 사실상 필수로 요구한다.
- 그런데 현재 저장소에는 `apps/api/.env.example`이 없어서 신규 참여자가 어떤 값을 넣어야 하는지 코드까지 읽어야 한다.
- 이 상태에서는 "실제 서버 접근권한이 없는 개발자"가 로컬 구성만으로 참여하기 어렵다.

권장 방향:

- 로컬 기준 기본값을 문서화한 `apps/api/.env.example` 제공
- 예:
  - `DATABASE_URL=postgresql://pcu_admin:localdev@localhost:5432/pcu_graduationproject_v2?schema=public`
  - `CORS_ALLOWED_ORIGINS=http://localhost:5173`
  - `API_PUBLIC_URL=http://localhost:4000`
  - `WEB_PUBLIC_URL=http://localhost:5173`
  - `S3_ENDPOINT=http://localhost:3900`

### 2. API 로컬 부트스트랩 절차를 자동화해야 함

관련 파일:

- [apps/db/docker-compose.yml](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/db/docker-compose.yml#L1)
- [apps/db/garage-init.sh](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/db/garage-init.sh#L17)
- [README.md](C:/Users/song/Desktop/pcu_graduationproject_v2/README.md#L32)

이유:

- Postgres와 Garage는 로컬에서 띄울 수 있지만, Garage access key를 다시 조회해서 API env에 수동으로 옮겨 적어야 한다.
- 이 과정은 "한 번 구성한 사람"에게는 문제 없지만, 신규 참여자에게는 실패 지점이 많다.
- 특히 팀 개발에서는 README를 보며 그대로 실행했을 때 한 번에 붙는 것이 중요하다.

권장 방향:

- 로컬 개발용 초기화 스크립트 하나로 묶기
- 예:
  - DB/스토리지 기동
  - Garage key 조회
  - API용 local env 생성
  - Prisma migrate / seed 안내

### 3. 개발용 로그인 경로가 필요함

관련 코드:

- [apps/api/src/modules/auth/service.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/api/src/modules/auth/service.ts#L23)
- [apps/web/src/pages/LoginPage.tsx](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/src/pages/LoginPage.tsx#L29)
- [apps/api/prisma/seed.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/api/prisma/seed.ts#L259)

이유:

- 현재 로그인은 Google ID token 검증을 전제로 한다.
- 개발 우회 수단은 seed가 출력하는 세션 쿠키를 브라우저 콘솔에 수동으로 넣는 방식뿐이다.
- 이 방식은 협업 온보딩용 기본 흐름으로 보기 어렵고, 관리자 페이지 확인도 번거롭다.

권장 방향:

- 개발 모드에서만 동작하는 `dev login` 엔드포인트 또는 명시적인 테스트 로그인 플로우 추가
- 역할 선택 가능:
  - `ADMIN`
  - `OPERATOR`
  - `USER`
- 프로덕션에서는 반드시 비활성화

### 4. 프론트 mock 모드의 커버리지를 넓혀야 함

관련 코드:

- [apps/web/src/lib/api/mock/handler.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/src/lib/api/mock/handler.ts#L30)
- [apps/web/src/lib/api/public.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/src/lib/api/public.ts#L11)
- [apps/web/src/lib/api/admin.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/src/lib/api/admin.ts#L18)

이유:

- 현재 mock은 기본 공개 목록, 일부 관리자 목록, 로그인 상태 흉내는 가능하다.
- 하지만 실제 프론트에서 사용하는 API 중 일부는 mock 구현이 없다.
- 이 때문에 "서버 없이도 프론트 작업 가능"이 페이지마다 달라지고, 병렬 개발 시 누군가는 결국 API를 직접 띄워야 한다.

현재 보강 필요성이 큰 항목:

- `GET /api/public/exhibitions/:id/projects`
- `GET/PATCH /api/admin/settings`
- `GET/DELETE /api/admin/banned-ips`
- `POST /api/admin/import/preview`
- `POST /api/admin/import/execute`
- `POST /api/admin/export`
- bulk status / bulk delete
- chunked game upload 관련 API

권장 방향:

- "프론트만 하는 사람"이 관리자 화면 전체를 mock 상태에서 둘러볼 수 있도록 최소 응답 세트 확보
- mock 응답 shape를 실제 contract와 더 가깝게 유지

### 5. `.env`를 꼭 직접 수정하지 않아도 되는 개발 경로를 분리해야 함

관련 파일:

- [apps/web/.env.example](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/.env.example#L1)
- [apps/web/.env.mock](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/.env.mock#L1)
- [apps/web/src/lib/env/index.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/src/lib/env/index.ts#L4)

이유:

- 웹은 기본값과 mock 모드 덕분에 비교적 진입장벽이 낮다.
- 반면 API는 env가 직접 준비되지 않으면 사실상 실행이 안 된다.
- 협업용 저장소라면 "env를 수정할 수 있는 사람"과 "그렇지 않은 사람"이 모두 참여 가능한 경로가 있어야 한다.

권장 방향:

- 아래 두 경로를 명확히 분리

경로 A. UI 전용 참여

- `apps/web`
- `npm run dev:mock`
- env 수정 없이 참여 가능

경로 B. 풀스택 참여

- `apps/db` + `apps/api` + `apps/web`
- 로컬 샘플 env 또는 자동 생성 스크립트 필요

### 6. README를 "협업 온보딩 문서" 기준으로 다시 써야 함

관련 파일:

- [README.md](C:/Users/song/Desktop/pcu_graduationproject_v2/README.md#L25)

이유:

- 현재 README는 로컬 개발 흐름을 대략 보여주지만, 신규 참여자가 어디까지 가능한지 구분해서 안내하지 않는다.
- 특히 다음 질문에 대한 답이 없다.
  - 프론트만 개발하려면 무엇을 하면 되는가
  - 실서버 권한이 없으면 어디까지 가능한가
  - API env는 어디서 복사하는가
  - 관리자 화면 확인은 어떻게 하는가

권장 방향:

- README 상단에 역할별 시작 경로를 분리
- 예:
  - "UI만 수정"
  - "풀스택 개발"
  - "운영/배포 담당"

### 7. PR 검증용 GitHub Actions를 추가해야 함

관련 파일:

- [\.github/workflows/deploy-api.yml](C:/Users/song/Desktop/pcu_graduationproject_v2/.github/workflows/deploy-api.yml#L1)
- [\.github/workflows/deploy-web-pages.yml](C:/Users/song/Desktop/pcu_graduationproject_v2/.github/workflows/deploy-web-pages.yml#L1)

이유:

- 현재 워크플로는 배포 중심이다.
- 팀 개발에서는 "배포 전에 깨지는지"보다 "PR 단계에서 깨지는지"를 자동으로 잡는 것이 더 중요하다.
- 사람이 늘어날수록 로컬 환경 차이로 인해 "내 컴퓨터에서는 됨" 문제가 늘어난다.

권장 방향:

- PR 대상 자동 검증 추가
- 최소한 아래는 분리해서 돌려야 함
  - `apps/api`: `npm test`, `npm run lint`
  - `apps/web`: `npm test`, `npm run lint`

### 8. 로컬 개발에서 필요한 민감정보와 필요 없는 민감정보를 분리해야 함

관련 코드:

- [apps/api/src/config/env.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/api/src/config/env.ts#L16)
- [apps/web/src/lib/auth/google.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/web/src/lib/auth/google.ts#L14)

이유:

- 현재 구조에서는 Google 로그인 관련 값이 있으면 좋고, 없으면 로그인 경험이 제한된다.
- 하지만 UI 개발, 라우팅, 관리자 페이지 레이아웃, 목록/상세 화면 작업에는 실제 Google 로그인 값이 없어도 된다.
- 민감정보가 없어도 가능한 작업과, 실제 인증값이 있어야 가능한 작업을 분리해야 협업이 쉬워진다.

권장 방향:

- "실제 OAuth 없음" 상태에서 동작 가능한 개발 플로우 보장
- 실 OAuth는 인증 기능 개발자만 필요하게 분리

### 9. seed 기반 개발 흐름을 공식화해야 함

관련 파일:

- [apps/api/prisma/seed.ts](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/api/prisma/seed.ts#L45)
- [apps/db/legacy-import.json](C:/Users/song/Desktop/pcu_graduationproject_v2/apps/db/legacy-import.json#L1)

이유:

- 이미 테스트 관리자 생성과 샘플 데이터 시드 기능이 있다.
- 그런데 이 흐름이 협업 온보딩의 공식 경로로 정리되어 있지 않다.
- 좋은 재료는 이미 있는데, 신규 참여자가 발견하기 어렵다.

권장 방향:

- README에 seed 기반 시작 경로 명시
- 예:
  1. DB/스토리지 실행
  2. migrate
  3. seed
  4. 개발용 로그인

## 우선순위 제안

### 1차

- `apps/api/.env.example` 추가
- README 온보딩 보강
- 로컬 부트스트랩 절차 자동화

이유:

- 신규 참여자가 실제로 "실행"에 들어갈 수 있어야 협업이 시작된다.

### 2차

- 개발용 로그인 추가
- mock 커버리지 확대

이유:

- 프론트/백엔드 병렬 작업 효율이 크게 좋아진다.

### 3차

- PR 검증 워크플로 추가

이유:

- 팀 인원이 늘어날수록 회귀 방지 비용을 자동화해야 한다.

## 최종 판단

현재 저장소는 다음과 같이 보는 것이 맞다.

- "실제 서버 접근권한이 없는 사람도 개발에 참여할 수 있는가"
  - 부분적으로는 가능
  - 프론트 mock 중심으로는 가능
  - 풀스택 기준으로는 아직 온보딩이 부족

- "`.env` 파일의 내용을 건드리지 않고도 개발에 참여할 수 있는가"
  - 프론트 mock 한정으로는 가능
  - API/인증/업로드/관리자 전체 기능 확인까지 포함하면 어려움

따라서 협업 친화적인 저장소로 바꾸려면, 핵심은 "실서버 의존성 제거" 자체보다 "로컬 개발 경로를 공식 경로로 만들고 자동화하는 것"이다.
