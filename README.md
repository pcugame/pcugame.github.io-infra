# 배재대학교 게임공학과 졸업작품 전시 시스템

배재대학교 게임공학과의 연도별 졸업작품을 공개하고, 재학생과 운영자가 작품 자료를 등록·관리하는 웹 시스템이다. 공개 전시 화면, 작품 제출 및 운영 화면, API, 관계형 데이터베이스, 객체 저장소와 배포 자동화를 하나의 npm workspace에서 관리한다.

## 주요 기능

### 공개 전시

- 연도와 전시회별 작품 목록 조회
- 작품 설명, 참여 학생, 지원 플랫폼, 이미지·영상 조회
- 게임 배포 파일 다운로드
- 업로드된 Unity WebGL 빌드의 브라우저 실행
- 전시회 포스터와 공개 자산 제공

### 작품 제출 및 운영

- Google 계정 기반 로그인과 `USER`·`OPERATOR`·`ADMIN` 권한 구분
- 재학생의 작품 제출 및 본인 참여 작품 조회
- 작품 기본 정보, 참여 학생, 공개 상태와 정렬 순서 관리
- 이미지·PDF·영상·게임 ZIP·Unity WebGL ZIP 업로드
- 대용량 게임 파일의 S3 multipart 분할 업로드와 재개
- 전시회 개설, 업로드 허용 여부와 포스터 관리
- 작품 일괄 상태 변경·삭제, 차단 IP와 사이트 설정 관리
- 기존 JSON 자료의 검증·가져오기와 NAS 내보내기

## 시스템 구성

```mermaid
flowchart LR
    B[브라우저] --> W[React Web\nGitHub Pages]
    W -->|JSON API·session cookie| A[Fastify API]
    B -->|WebGL·다운로드 요청| A
    A --> P[(PostgreSQL)]
    A --> S[(S3 호환 객체 저장소\nGarage)]
    A --> N[NAS 내보내기 경로\n선택 사항]
```

| 구성 요소 | 구현 | 역할 |
|---|---|---|
| `apps/web` | React 19, Vite 8, React Router, TanStack Query | 공개 전시, 작품 제출, 운영 화면 |
| `apps/api` | Node.js 22, Fastify 5, Prisma 7 | 인증, 작품·전시 관리, 파일 처리, 공개 자산 제공 |
| `packages/contracts` | TypeScript, Zod | Web과 API가 공유하는 요청·응답 schema와 enum |
| PostgreSQL | PostgreSQL 16 | 사용자, 전시회, 작품, 자산 metadata, session, 업로드 상태 저장 |
| Garage | S3 호환 객체 저장소 | 공개·보호 자산과 multipart 업로드 객체 저장 |

Web은 정적 SPA로 빌드된다. API는 공개·인증·운영 route를 제공하고, PostgreSQL과 객체 저장소 사이의 자산 상태를 관리한다. 게임과 WebGL 대용량 파일은 브라우저에서 S3 multipart 단위로 전송하며, API는 업로드 session, 완료 claim, 정리 작업과 orphan object를 데이터베이스에 기록한다.

## 저장소 구조

```text
.
├── apps/
│   ├── api/                 # Fastify API, Prisma schema·migration, 단위·통합 테스트
│   ├── db/                  # 로컬 PostgreSQL·Garage 구성과 초기화 script
│   └── web/                 # React SPA와 화면 테스트
├── packages/contracts/      # Web/API 공용 Zod 계약
├── prisma/migrations/       # 이전 최상위 migration 기록
├── scripts/                 # 통합 환경 기동과 smoke test
├── server/                  # 운영 API용 Podman 배포 script와 이전 자료 예시
├── docs/                    # 운영 runbook과 backend 검토 기록
└── .github/workflows/       # PR 검증, API 배포, Web 배포
```

현재 Prisma schema와 신규 migration의 기준 위치는 `apps/api/prisma`이다. 최상위 `prisma/migrations`는 이전 migration 기록이며, 개발 명령은 `apps/api` workspace의 Prisma 설정을 사용한다.

## 요구 환경

- Node.js 22
- npm과 저장소의 `package-lock.json`
- Docker Engine 및 Docker Compose v2
- 로컬 개발 포트 `4000`, `5173`, `5432`, `3900`, `3902`

운영 배포에는 별도로 Podman, systemd user service, reverse proxy, PostgreSQL 백업 공간과 S3 호환 저장소 접속 정보가 필요하다.

## 통합 환경 실행

저장소의 전체 경로를 가장 짧게 확인하는 방법이다. PostgreSQL, Garage, API와 Web을 컨테이너로 기동하고 integration seed와 smoke test를 실행한다.

```bash
npm ci
npm run testenv:up
```

기동 이후 접속 위치는 다음과 같다.

| 대상 | 주소 |
|---|---|
| Web | <http://localhost:5173> |
| API | <http://localhost:4000> |
| API 상태 | <http://localhost:4000/api/health> |
| Garage S3 API | <http://localhost:3900> |

통합 환경은 `DEV_AUTH_ENABLED=true`로 실행된다. 로그인 화면의 개발용 인증 기능에서 `USER`, `OPERATOR`, `ADMIN` 동작을 확인할 수 있다. 이 route는 `NODE_ENV=production`에서 등록되지 않는다.

```bash
# 컨테이너 종료 — volume 유지
npm run testenv:down

# 컨테이너와 통합 테스트 volume 제거
npm run testenv:clean

# volume 제거 후 재구성
npm run testenv:reset
```

`testenv:clean`과 `testenv:reset`은 `pcu-integration` Compose project의 PostgreSQL·Garage volume을 제거한다.

## 개발 환경 구성

API와 Web의 hot reload가 필요한 경우 PostgreSQL과 Garage만 Docker로 실행한다.

### 1. 의존성 설치

```bash
npm ci
```

### 2. PostgreSQL·Garage 기동

```bash
docker compose -f apps/db/docker-compose.yml up -d --build
docker compose -f apps/db/docker-compose.yml logs garage-init
```

`garage-init`는 `pcu-public`, `pcu-protected` bucket과 `pcu-dev-key`를 구성한다. 출력된 access key ID와 secret key를 API 환경 변수에 반영한다. 저장소의 기본 PostgreSQL 접속 정보는 개발용이며 운영 환경에 사용하지 않는다.

### 3. 환경 변수 구성

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

`apps/api/.env`에서 최소한 다음 항목을 로컬 환경에 정합한다.

- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: `garage-init`에서 생성한 값
- `GOOGLE_CLIENT_IDS`, `VITE_GOOGLE_CLIENT_ID`: 실제 Google OAuth를 확인할 때 사용하는 같은 Web client ID
- `DEV_AUTH_ENABLED=true`, `VITE_DEV_AUTH_ENABLED=true`: 로컬 역할별 동작을 OAuth 없이 확인할 때만 설정

API는 시작 시 환경 변수를 검증한다. `SESSION_SECRET`은 32자 이상이어야 하며, `DATABASE_URL`, `CORS_ALLOWED_ORIGINS`, `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, S3 접속 정보는 필수이다. `.env`와 `.env.local`은 commit하지 않는다.

### 4. database 초기화

```bash
npm run db:generate --workspace=apps/api
npm run db:migrate --workspace=apps/api
npm run db:seed --workspace=apps/api
```

`db:seed`는 개발용 관리자, session, 전시회와 예시 작품을 생성한다. `NODE_ENV=production`에서는 실행을 거부한다. 기존 자료를 가져오려면 `apps/db/legacy-import.json`을 검토한 뒤 다음 명령을 사용한다.

```bash
npm run db:seed:import --workspace=apps/api
```

### 5. 개발 server 실행

두 terminal에서 각각 실행한다.

```bash
npm run dev --workspace=apps/api
```

```bash
npm run dev --workspace=apps/web
```

Web은 <http://localhost:5173>, API는 <http://localhost:4000>에서 실행된다. API의 `/api/health`는 process lifecycle과 database를 확인하고, `/api/health/deep`은 객체 저장소까지 추가로 확인한다.

## 주요 명령

| 명령 | 검증 범위 |
|---|---|
| `npm test` | 모든 workspace의 Vitest test |
| `npm run lint` | API·Web lint와 TypeScript 검사 |
| `npm run architecture` | API 계층 경계, 자체 test, dependency-cruiser 규칙 |
| `npm run build` | 공용 계약, API, Web 순차 build |
| `npm run test:integration` | PostgreSQL·Garage 기반 concurrency·transaction·upload·복구 test와 E2E smoke test |
| `npm run test:integration:suite -- <name>` | 지정한 통합 test suite 실행 |
| `npm run test:integration:list` | 통합 test suite 목록 조회 |

[PR Checks](.github/workflows/pr-checks.yml)의 기본 npm 검증 순서는 다음과 같다. 전체 CI는 아래 명령 외에 migration 정책·배포 경계 검사와 별도 integration job을 포함한다.

```bash
npm ci --include-workspace-root
npm run db:generate --workspace=apps/api
npm test
npm run lint
npm run architecture
npm audit --audit-level=high
npm run build
```

전체 통합 test는 Docker image build와 서비스 기동을 포함한다. 고정 포트 `15432`, `3900`, `3902`, `3903`, `4000`, `5173`을 사용하므로 기존 process와의 충돌 여부를 먼저 확인한다.

단일 suite 실행 전에는 `npm run testenv:up`으로 통합 test 환경을 준비한다. 단일 suite는 서비스를 기동하거나 종료하지 않으므로 반복 실행할 수 있다.

```bash
npm run testenv:up
npm run test:integration:suite -- visibility
npm run test:integration:suite -- lease-clock
npm run testenv:down
```

기존 `test:integration:<name>` 명령은 `test:integration:suite -- <name>`으로 대체한다. Suite별 파일 목록, PostgreSQL·Garage 환경 설정, 실행 순서는 `scripts/run-integration.mjs`에서 관리한다. `lease-clock`, `phase2-transition`, `year-change-approval`은 기존 `--no-file-parallelism` 설정을 유지하며, 다른 suite는 기존 Vitest 병렬 실행 설정을 사용한다.

## 데이터와 자산 경계

- PostgreSQL은 자산의 `storageKey`, 공개 여부, 크기, MIME type, 처리 상태를 저장한다.
- Garage의 `pcu-public` bucket은 공개 자산, `pcu-protected` bucket은 보호 자산을 저장한다.
- API는 현재 공개 참조로 확인된 이미지를 불변 cache header와 함께 직접 stream한다. GAME·VIDEO 등 보호 자산은 권한을 검사한 뒤 기존처럼 짧은 유효 기간의 presigned URL로 redirect한다.
- 영상 업로드는 재생용 자산 처리 상태를 별도로 기록한다.
- Unity WebGL ZIP은 archive 경로와 content encoding을 검증한 뒤 공개 실행 경로로 제공한다.
- multipart 업로드의 중단·만료·완료 실패는 background maintenance와 durable task table로 복구한다.

schema 변경과 운영 배포는 [database migration policy](docs/database-migration-policy.md)와 [production 배포 절차](docs/operations/deployment.md)를 따른다.

## 배포 구조

운영 배포는 `master` 기준의 수동 release이다. master의 API 관련 대상 경로 변경 시 이미지를 자동 빌드하지만, push나 이미지 빌드 성공만으로 운영 서비스를 갱신하지 않는다.

| Workflow | 역할 |
| --- | --- |
| [PR Checks](.github/workflows/pr-checks.yml) | PR의 기본 검사와 PostgreSQL·Garage 통합 검증 |
| [Build API Release Image](.github/workflows/deploy-api.yml) | API 이미지 빌드·GHCR 게시, source SHA·artifact 검증, 불변 digest 기록 |
| [Deploy Release](.github/workflows/release-api-cutover.yml) | 수동 실행으로 같은 master SHA의 Web·API와 필요한 DB migration 적용 |
| [Deploy Web to GitHub Pages](.github/workflows/deploy-web-pages.yml) | Web만 수동 검증·빌드·게시 |

일반 배포는 `Deploy Release`에서 `master`와 `phase=release`를 선택한다. 해당 SHA의 검증된 이미지를 재사용하며, 보관된 결과가 없으면 build workflow를 호출한다. 배포 입력은 `@sha256` 불변 digest이고, GHCR의 `latest` tag는 운영 이미지 선택에 사용하지 않는다.

배포는 DB 백업·격리 복원 검증, API·worker 중지, 추가 DB 백업, Web 게시·SHA 확인, migration, API·worker 기동 순서로 진행한다. 컨테이너 시작 자체는 migration을 실행하지 않는다. 완료 시 API health check, 공개 파일 smoke test, 실제 image source SHA·digest를 확인한다. migration 시도 이후에는 이전 이미지로 자동 rollback하지 않는다.

Web은 `apps/web/dist`를 `pcugame/pcugame.github.io`의 `master`에 게시하며, build에서 생성한 `404.html`로 SPA deep link를 처리한다. API·PostgreSQL·worker는 운영 호스트의 Podman pod에서 실행한다. API port는 기본 `127.0.0.1:4000`에 bind하고 외부 요청은 reverse proxy를 통과한다.

사전 조건, 실행 순서, Web 단독 게시와 실패 복구는 [production 배포 절차](docs/operations/deployment.md)를 따른다.

## 변경 기준

- API 요청·응답을 변경할 때 `packages/contracts`의 schema와 관련 계약 test를 함께 개정한다.
- database 구조를 변경할 때 `apps/api/prisma/schema.prisma`와 migration을 함께 commit하고 [database migration policy](docs/database-migration-policy.md)를 따른다.
- 새 API module은 application·infrastructure 경계를 유지하고 `npm run architecture`를 통과해야 한다.
- 업로드 변경은 파일 signature, 권한, 용량 제한, idempotency, orphan 정리와 동시성 test를 함께 검토한다.
- 배포 관련 변경은 불변 이미지 검증, Web/API 호환성, DB 백업과 migration 시도 전후의 복구 경계를 유지한다.

## 관련 문서

- [production 배포 절차](docs/operations/deployment.md)
- [production release 구조 조사와 정리 기준](docs/history/2026-backend-audit/production-release-audit.md)
- [database migration policy](docs/database-migration-policy.md)
- [업로드 lifecycle 전환 기록과 runbook](docs/upload-lifecycle-runbook.md)
- [backend architecture](docs/architecture/README.md)
- [architecture decision records](docs/adr/README.md)
- [backend 감사·수정 이력](docs/history/2026-backend-audit/README.md)
- [route 계약 소유권 후속 제안](docs/architecture/route-contract-ownership.md)
- [추가 test 기록](docs/new_tests/README.md)
