# 개발·검증 환경

[운영 가이드](README.md) · [개요](../../README.md)

개발용 source mount와 seed는 운영 컨테이너의 실행 계약에 포함하지 않는다. 다음 명령은 저장소 루트에서 실행한다.

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

### 6. Mock 개발 환경

API·DB 없이 현재 Web의 조회·수정·제출·검토 흐름을 확인하려면 다음 명령을 실행한다.

```bash
npm run dev:mock --workspace=apps/web
```

화면 하단의 **Mock 개발 패널**에서 익명, 소유 학생, 공동 참여자, 다른 학생, `OPERATOR`, `ADMIN`을 선택한다. 최초 실행은 기존 `mock-role`을 반영하며, 설정이 없으면 `ADMIN`을 사용한다. 사용자 전환은 작품과 작업을 보존하고 조회 캐시를 갱신한다. 로그아웃·세션 만료 이후에는 보호된 요청의 인증 결과도 변경된다.

| 제어 | 재현 범위 |
|---|---|
| 기본 전시 | 같은 연도 복수 전시, 20개 초과 목록, 상태·공개 범위·수정 허용 조합 |
| 빈 데이터 | 전시·작품 목록의 빈 상태 |
| 권한·수정 종료 | 소유·참여 관계별 capability, 직접 수정 제한 |
| 미디어 처리 | 영상 처리 상태와 작업 일시 정지 |
| 변경 요청 검토 | 수정 종료 작품의 `PENDING` 요청과 관리자 검토 |
| 실패·재시도 | 일회성 요청 실패, 작업 실패와 재시도 |
| 지연·다음 요청 429 | 지정 경로의 지연, `Retry-After`를 통한 직접 업로드 재시도 |
| 전체 초기화 | 저장 데이터·작업의 삭제와 기본 fixture 복원 |

브라우저 기능 검증은 **기본 전시**를 선택한 뒤 다음 경로에서 시작한다. 개발 패널에는 예시 작품 링크를 제공한다. 로그인 화면은 Mock 모드에서 역할 로그인과 로그인 실패 버튼을 표시하므로 Google 계정 연결 없이 확인할 수 있다.

| 화면 기능 | 시작 경로·조작 |
|---|---|
| 게임 ZIP·영상·문서 다운로드 | `/projects/1`의 다운로드와 재생 버튼 |
| 고정 크기·반응형 WebGL | `/projects/2`, `/projects/1` → 게임 실행. 편집 화면에서 표시 크기 저장 후 다시 실행 |
| 첨부자료·긴 설명·다수 참여자·포스터 누락 | `/projects/3`, `/projects/4` |
| 로그인·실패 안내·로그아웃 | 익명 선택 → `/login`의 역할·실패 버튼. 로그인 후 사용자 메뉴의 로그아웃 |
| 소유자·참여자·다른 학생의 권한 | 사용자 전환 → `/me/projects`와 작품 편집 화면 |
| 제출·초안·업로드 재개·취소 | `/me/projects/new` 또는 관리자 작품 등록. 파일 선택·ZIP 용도 선택 → 제출. 처리 중 새로고침 후 원본 파일 재선택 |
| 영상 대기·성공·실패 | **미디어 처리** → `/projects/1` → 작업 결과 변경. 새로고침 후에도 처리 상태 유지 |
| 변경 요청 작성·반려·승인·실패 재시도 | **권한·수정 종료** → 학생 내 작품의 변경 요청. 관리자 변경 요청에서 검토. **변경 요청 검토**는 대기 요청을 바로 제공 |
| 외부 연결 신청·승인·철회 | 학생 `/me/projects/1/network` → 관리자 `/admin/webgl-network` |
| 전시·포스터 수정, 작품 검색·일괄 처리 | `/admin/years`, `/admin/projects` |
| 설정·IP 차단·JSON import·export | 관리자 메뉴의 각 화면. Export는 전시 목록의 **NAS 내보내기** |

영상 순서 변경과 기존 이미지의 포스터 지정은 변경 요청 화면의 **현재 파일 관리**에서 승인 요청으로 조작할 수 있다. 관리자 직접 편집 화면에는 해당 버튼이 없으며, 직접 변경 API는 client 테스트로 확인한다. 정적 fixture는 실제 파일 서버의 토큰 강제 검증이나 외부 서버의 CSP·CORS 적용을 재현하지 않으며, 신청·검토·파일 접근 및 갱신 API의 화면 상태와 오류를 확인하는 용도로 사용한다.

데이터와 예정된 작업 상태는 IndexedDB `pcu-development-mock-v1`에 저장한다. 성공 응답은 저장 완료 후 반환한다. 새로고침·사용자 전환·처리 중 재접속 이후에도 상태가 유지된다. 탭 간 변경은 revision 검사와 변경 알림으로 반영하며, 충돌 시 요청을 다시 실행한다. 시나리오 변경과 전체 초기화에는 데이터 삭제 확인이 표시되며, 폐기된 제출·업로드의 브라우저 복원 정보를 제거하고 화면을 다시 연다. 저장을 사용할 수 없거나 저장에 실패하면 오류를 표시하며 성공으로 처리하지 않는다. 이전 저장 형식은 migration을 적용하고, 지원하지 않는 버전은 전체 초기화로 복구한다.

직접 업로드 재개 시 원본 파일을 다시 선택한다. 파일의 source identity, part 크기·checksum·ETag와 generation을 검증한다. `UPLOADING` 이후 검증·처리·`READY` 상태를 거치며, 작업 일시 정지·실패·취소도 재현한다. 초기 제출과 변경 요청은 프로젝트별로 구분하고, 제출의 `Idempotency-Key`를 보존한다. 발행 실패의 **Mock 발행 다시 시도**는 개발용 상태 재현 버튼이며 Mock 모드에서만 표시한다. 운영 API는 이미 `FINALIZING`인 발행을 finalize 재호출로 재시작하지 않는다. 일시적인 상태 조회 오류에는 **제출 상태 다시 확인**으로 조회를 재개한다. 변경 요청의 파일은 임시 프로젝트에 저장하며 승인 완료 시 원본에 반영한다.

미디어는 `apps/web/public/mock`의 합성 이미지, 짧은 영상, 첨부파일, 고정 크기·반응형 WebGL 미리보기를 사용한다. Mock 기본 동작에는 운영 API·스토리지와 외부 이미지 서비스가 필요하지 않다. 대용량 파일은 메타데이터와 처리 상태를 재현한다. 실제 압축 해제·영상 변환·Unity 실행은 통합 환경에서 검증한다. Export는 서버 작업 상태와 결과 경로를 재현하며 브라우저 다운로드 기능은 추가하지 않는다.

API 대응표는 [Mock API inventory](../../apps/web/src/lib/api/mock/inventory.json)에 기록한다. 일반 요청과 직접 업로드는 운영 모드와 동일한 응답 해석·`ApiError`·재시도 경로를 사용한다. 미등록 method/path는 오류와 개발 진단을 반환한다. production build에는 Mock transport·handler 코드가 포함되지 않는다.

```bash
npm test --workspace=apps/web -- mock
npm run lint --workspace=apps/web
npm run build --workspace=apps/web
```

응답 계약·실제 client·IndexedDB 저장/충돌/실패와 인증된 격리 API의 controller·service·serializer 비교는 자동 테스트로 확인한다. 격리 API 비교에는 테스트용 저장소를 사용하며, 운영의 인증된 응답을 검증한 것으로 간주하지 않는다. 서버·DB·공용 계약·release workflow는 이번 Mock 구현의 변경 범위에 포함하지 않는다.

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

[PR Checks](../../.github/workflows/pr-checks.yml)의 기본 npm 검증 순서는 다음과 같다. 전체 CI는 아래 명령 외에 migration 정책·배포 경계 검사와 별도 integration job을 포함한다.

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


## 쓰기 주체

호스트 실행에서는 호스트 npm·Prisma·TypeScript만 의존성·생성 코드·dist를 갱신한다. Docker source mount 실행에서는 해당 컨테이너만 이를 갱신한다. 같은 checkout에서 두 방식을 동시에 실행하지 않는다. 전환 시 실행 중인 watcher를 종료하고 별도 checkout과 독립 node_modules volume을 사용한다. 운영에는 source·node_modules·generated·dist mount를 사용하지 않는다.
