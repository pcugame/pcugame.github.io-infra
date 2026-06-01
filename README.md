# PCU 졸업작품 전시 플랫폼 운영 문서

배재대학교 게임공학과 졸업작품을 공개 전시하고, 학생과 운영자가 작품 자료를 등록/관리하는 웹 서비스입니다. 이 문서는 비전공자, 신규 운영자, 인수인계 담당자가 서비스 구조와 기본 운영 절차를 한 번에 파악할 수 있도록 작성했습니다.

## 먼저 볼 것

- 공개 웹사이트: `https://pcugame.github.io`
- 공개 API 상태 확인: `https://203.250.133.230/api/health`
- 담당자: `송지한`
- 운영 서버 기준 배포 위치: `/srv/graduationproject_v2`
- 전체 기능을 로컬에서 확인할 때: 루트에서 `npm run testenv:up`
- 화면만 빠르게 볼 때: `cd apps/web` 후 `npm run dev:mock`

문제가 생겼을 때는 먼저 API health를 확인합니다. `health`가 정상이면 웹 배포, 로그인, 권한, 파일 저장소 문제를 차례로 좁혀 봅니다. `health/deep`은 DB뿐 아니라 S3/NAS 계층까지 확인하므로 파일 업로드/이미지 문제를 볼 때 유용합니다.

## 현재 운영 정보

| 항목 | 현재 기준 |
| --- | --- |
| 담당자 | `송지한` |
| Web | `https://pcugame.github.io` |
| API | `https://203.250.133.230` |
| 공개 API health | `https://203.250.133.230/api/health` |
| 서버 내부 health | `http://127.0.0.1:4000/api/health` |
| 서버 내부 deep health | `http://127.0.0.1:4000/api/health/deep` |
| 서버 배포 디렉터리 | `/srv/graduationproject_v2` |
| 운영 런타임 | Podman pod `graduationproject` |
| 주요 컨테이너 | `gp-api`, `gp-postgres` |
| API 이미지 | `ghcr.io/pcugame/pcu-graduationproject-v2-api:latest` |
| 공개 프록시 | nginx HTTPS -> `127.0.0.1:4000` |

운영 서버의 API는 외부에 `:4000` 포트를 직접 열지 않고, nginx가 HTTPS 요청을 받아 내부 `127.0.0.1:4000`으로 전달하는 구조입니다. 서버 내부에서는 `http://127.0.0.1:4000/api/health`를 보고, 외부에서는 `https://203.250.133.230/api/health`를 봅니다.

운영에서 금지할 것:

- `.env`, 토큰, 비밀번호, 개인키, 쿠키 값을 문서나 이슈에 붙여 넣지 않습니다.
- DB 마이그레이션, 복구, 대량 삭제, NAS 권한 변경은 백업과 승인 없이 실행하지 않습니다.
- 루트 `docker-compose.yml`이 있다고 가정하지 않습니다. 현재 저장소 루트에는 없습니다.
- 운영 배포는 `server/deploy.sh` 기준입니다. 서버에 남아 있는 오래된 compose 파일이 있더라도 현재 기준이 아닙니다.
- production에서 `DEV_AUTH_ENABLED` 또는 `VITE_DEV_AUTH_ENABLED`를 켜지 않습니다.

## 서비스 구조

이 서비스는 크게 다섯 부분으로 나뉩니다.

| 구성 | 역할 | 저장소 위치 |
| --- | --- | --- |
| Web | 사용자가 보는 화면입니다. 공개 전시, 로그인, 내 작품, 관리자 화면을 제공합니다. | `apps/web` |
| API | 로그인, 작품 조회/등록/수정, 업로드, 관리자 기능을 처리합니다. | `apps/api` |
| DB | 사용자, 전시, 작품, 멤버, 파일 메타데이터를 저장합니다. PostgreSQL을 사용합니다. | `apps/api/prisma` |
| 파일 저장소 | 이미지, 게임 파일, 영상 파일을 저장하고 내려줍니다. Garage/S3 호환 저장소를 사용합니다. | `apps/db`, API S3 설정 |
| NAS/export | 관리자 export 기능의 대상 경로입니다. 운영 서버에서는 NAS mount가 연동됩니다. | 서버 `/mnt/nas/pcu_storage`, 컨테이너 `/nas` |

Web은 GitHub Pages에 정적 파일로 배포됩니다. API는 GitHub Actions가 Docker 이미지를 만들고 GHCR에 올린 뒤, 운영 서버에서 Podman으로 실행합니다. DB는 운영 서버의 Podman volume에 저장됩니다.

## 페이지 사용법

### 방문자

- `/`: 공개 홈 화면입니다.
- `/years`: 전시 연도 목록을 봅니다.
- `/years/:year`: 특정 연도의 작품 목록을 봅니다.
- `/exhibitions/:id`: 특정 전시 기준 작품 목록을 봅니다.
- `/years/:year/:slug`, `/projects/:projectId`: 작품 상세를 봅니다.

방문자는 로그인 없이 공개된 전시와 작품을 볼 수 있습니다. 작품 이미지나 파일이 보이지 않으면 API health보다 `health/deep`을 먼저 확인합니다.

### 로그인 사용자

- `/login`: Google 계정으로 로그인합니다.
- `/me`: 내 계정 정보를 확인합니다.
- `/me/projects`: 내가 만든 작품 또는 멤버로 포함된 작품을 봅니다.
- `/me/projects/new`: 작품을 제출합니다.

로그인은 Google OAuth와 HttpOnly session cookie를 사용합니다. 학교 도메인 제한이 설정된 경우 허용되지 않은 계정은 로그인할 수 없습니다.

### 관리자/운영자

- `/admin`: 관리자 홈 진입점입니다. 현재는 `/admin/projects`로 이동합니다.
- `/admin/projects`: 작품 목록을 관리합니다.
- `/admin/projects/new`: 운영자가 작품을 직접 등록합니다.
- `/admin/projects/:id/edit`: 작품 정보, 멤버, 이미지, 포스터, 게임 파일을 수정합니다.
- `/admin/years`: 전시 연도와 전시 포스터를 관리합니다.
- `/admin/settings`: 업로드 제한 등 사이트 설정을 조정합니다.
- `/admin/banned-ips`: 보호 파일 접근 차단 IP를 확인/해제합니다.
- `/admin/import`: JSON import를 preview/execute 합니다. `ADMIN` 권한만 접근합니다.

권한은 `USER`, `OPERATOR`, `ADMIN`으로 나뉩니다. 일반 사용자는 본인 작품 중심으로 접근하고, 운영자는 전시/작품 운영 화면을 다루며, 관리자는 import와 일부 위험 작업까지 수행합니다.

## 문제 발생 시 확인표

### 사이트 접속이 안 됨

1. 브라우저에서 `https://pcugame.github.io`가 열리는지 확인합니다.
2. API 상태를 확인합니다.

```bash
curl -fsS https://203.250.133.230/api/health
```

3. 운영 서버 안에서는 내부 API도 확인합니다.

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

4. 서버에서 Podman 상태를 확인합니다.

```bash
/srv/graduationproject_v2/deploy.sh status
```

5. API 로그를 봅니다.

```bash
/srv/graduationproject_v2/deploy.sh logs api
```

### 로그인 실패

- Google 계정이 허용 도메인인지 확인합니다.
- 브라우저에서 쿠키가 차단되어 있지 않은지 확인합니다.
- API health가 정상인지 확인합니다.
- 운영 환경에서 dev login 패널이 보이면 설정 오류입니다. `DEV_AUTH_ENABLED`, `VITE_DEV_AUTH_ENABLED`는 production에서 꺼져 있어야 합니다.
- `EMAIL_DOMAIN_NOT_ALLOWED` 오류는 학교 도메인 제한에 걸린 경우입니다.

### 이미지, 포스터, 게임 파일이 안 뜸

1. 일반 health를 확인합니다.

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

2. deep health를 확인합니다.

```bash
curl -fsS http://127.0.0.1:4000/api/health/deep
```

3. `deep health`에서 `s3=fail`이면 S3/Garage/NAS 계층을 의심합니다.
4. NAS 작업 직후라면 mount 상태도 확인합니다.

```bash
df -hT /mnt/nas/pcu_storage
mount | grep /mnt/nas/pcu_storage
```

5. 관리자 화면에서 파일 삭제/재업로드를 하기 전, 원본 파일과 저장소 상태를 먼저 확인합니다.

### 업로드 실패

- 파일 크기가 현재 업로드 제한을 넘지 않는지 확인합니다.
- 대용량 게임 파일은 chunked upload 경로를 사용합니다.
- 브라우저 네트워크 탭에서 401/403이면 로그인 또는 권한 문제입니다.
- 413 또는 request size 관련 오류면 nginx `client_max_body_size`, API upload limit, 관리자 설정을 함께 확인합니다.
- `health/deep`이 실패하면 업로드 저장소가 정상이 아닐 수 있습니다.

### 관리자 접근 불가

- `/me`에서 로그인 사용자를 먼저 확인합니다.
- 사용자의 role이 `OPERATOR` 또는 `ADMIN`인지 확인합니다.
- `/admin/import`는 `ADMIN`만 접근 가능합니다.
- `/admin`이 `/admin/projects`로 이동하지 않으면 Web 배포가 최신인지 확인합니다.

### 배포 직후 장애

1. API workflow가 성공했는지 GitHub Actions에서 확인합니다.
2. 서버에서 상태를 봅니다.

```bash
/srv/graduationproject_v2/deploy.sh status
```

3. API 로그를 봅니다.

```bash
/srv/graduationproject_v2/deploy.sh logs api
```

4. health를 순서대로 확인합니다.

```bash
curl -fsS http://127.0.0.1:4000/api/health
curl -fsS http://127.0.0.1:4000/api/health/deep
curl -kfsS https://203.250.133.230/api/health
```

5. DB migration이 포함된 배포라면 백업 존재 여부와 migration 로그를 확인합니다. DB restore는 승인 없이 실행하지 않습니다.

### 인증서 경고

- 현재 공개 API는 IP 주소 `203.250.133.230` 기준입니다. IP 기반 TLS 운영은 일반 도메인보다 갱신/호환성 리스크가 큽니다.
- 서버에서 인증서 만료일과 nginx 설정을 확인합니다.

```bash
openssl x509 -in /etc/ssl/acme/203.250.133.230/fullchain.pem -noout -subject -issuer -enddate
sudo nginx -t
```

- 임의로 인증서 파일을 교체하지 말고, `ops/server-audit/2026-06-01/`의 TLS 기록과 운영 담당자 확인 후 처리합니다.

## 로컬/통합 확인법

사전 조건:

- Node.js 22 이상
- Docker Desktop 또는 Docker daemon
- 루트에서 `npm install` 실행

루트 기본 검증:

```bash
npm install
npm test
npm run lint
npm run build
```

### 통합 테스트 환경

실제 API, PostgreSQL, Garage(S3), Web을 함께 띄우는 기본 확인 방법입니다. Google OAuth 자체만 test/dev 전용 로그인 패널로 대체하고, 이후 session cookie, role guard, API/Web 오류 처리는 실제 경로를 사용합니다.

```bash
npm run testenv:up
```

접속:

- Web: `http://localhost:5173`
- API: `http://localhost:4000`
- PostgreSQL host port: `15432`
- Garage S3 host port: `3900`

상태 초기화와 종료:

```bash
npm run testenv:reset
npm run testenv:down
npm run testenv:clean
```

`testenv:reset`과 `testenv:clean`은 볼륨을 삭제합니다. 로컬 테스트 데이터가 사라져도 되는 상황에서만 사용합니다.

### UI mock 모드

API, DB, S3 없이 화면만 빠르게 확인하는 방법입니다.

```bash
cd apps/web
npm run dev:mock
```

mock 모드는 UI-only 확인용입니다. 로그인, 세션, 실제 업로드, DB 저장, S3 저장까지 보려면 통합 테스트 환경을 사용합니다.

### full-stack local

개발자가 API와 Web을 따로 띄우는 방식입니다. 통합 환경보다 설정을 직접 만져야 합니다.

1. DB와 Garage를 실행합니다.

```bash
cd apps/db
docker compose up -d
```

2. API 환경 파일을 만듭니다.

```bash
cd apps/api
cp .env.example .env
```

3. 로컬 Garage key를 확인해 API `.env`에 넣습니다. 출력값은 문서나 채팅에 공유하지 않습니다.

```bash
docker compose -f ../db/docker-compose.yml exec garage garage -c /etc/garage.toml key info pcu-dev-key
```

4. API를 준비하고 실행합니다.

```bash
cd apps/api
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

5. Web을 실행합니다.

```bash
cd apps/web
npm run dev
```

## 운영/배포 기본

### Web 배포

- workflow: `.github/workflows/deploy-web-pages.yml`
- trigger: `master` push 또는 수동 실행
- 주요 단계: install, test, lint, build, GitHub Pages 배포
- 배포 대상 저장소: `pcugame/pcugame.github.io`
- 공개 URL: `https://pcugame.github.io`

Web 배포 변수는 GitHub Actions variables/secrets에서 관리합니다. README에는 값을 쓰지 않습니다.

### API 배포

- workflow: `.github/workflows/deploy-api.yml`
- trigger: `master` push 또는 수동 실행
- 주요 단계: install, Prisma generate, API test, API build, Docker image build/push, 서버 SSH deploy
- 이미지 registry: GHCR
- 운영 서버 실행 스크립트: `/srv/graduationproject_v2/deploy.sh`

운영 서버의 기본 명령:

```bash
/srv/graduationproject_v2/deploy.sh status
/srv/graduationproject_v2/deploy.sh logs api
/srv/graduationproject_v2/deploy.sh logs pg
/srv/graduationproject_v2/deploy.sh restart
```

`restart`는 API와 DB 컨테이너를 재생성합니다. 배포, DB migration, NAS 작업 전후에는 backup과 smoke check를 먼저 확인합니다.

### 배포 전후 smoke check

배포 전:

- 최신 백업이 있는지 확인합니다.
- `.env` 파일 권한이 제한되어 있는지 확인합니다.
- `/`, `/srv`, NAS 여유 공간을 확인합니다.
- API가 외부 `:4000`으로 직접 노출되지 않는지 확인합니다.
- `http://127.0.0.1:4000/api/health`와 `/api/health/deep`을 확인합니다.

배포 후:

- Podman pod와 컨테이너가 실행 중인지 확인합니다.
- 내부 health와 공개 HTTPS health를 확인합니다.
- nginx가 `127.0.0.1:4000`으로 proxy하는지 확인합니다.
- API 로그에 env validation 실패, migration 실패, 반복 재시작이 없는지 확인합니다.

자세한 체크리스트는 `ops/server-audit/2026-06-01/05_smoke_checklist.md`를 봅니다.

## 기술 스택

- Frontend: React 19, Vite 8, TypeScript, React Router 7, TanStack Query, Zod v4
- Backend: Fastify 5, TypeScript, Prisma 6, PostgreSQL, Zod v3
- Storage: Garage 또는 S3 호환 오브젝트 스토리지
- Auth: Google OAuth 2.0, HttpOnly cookie session
- Local/Integration: Docker Compose, PostgreSQL 16, Garage v1.1.0
- Production runtime: Podman, nginx, systemd user service
- CI/CD: GitHub Actions, GHCR, GitHub Pages
- Shared contracts: `packages/contracts`

## Known pitfalls

### 현재 남은 문제

- 루트 `docker-compose.yml`은 현재 저장소에 없습니다. 일부 workflow path나 오래된 문서/서버 파일에 이름이 남아 있을 수 있지만 현재 local DB compose는 `apps/db/docker-compose.yml`, 통합 compose는 `docker-compose.integration.yml`, 운영 배포는 `server/deploy.sh`가 기준입니다.
- production 서버용 `.env.example`은 아직 없습니다. 운영 서버 `.env`는 `/srv/graduationproject_v2/.env`에 있으나 값은 문서화하지 않습니다.
- `AUTO_PUBLISH_DEFAULT` 설정은 env/schema/deploy에 남아 있지만 현재 작품 제출 로직은 `PUBLISHED`로 고정되어 있습니다. 값을 바꿔도 등록 상태가 바뀐다고 가정하면 안 됩니다.
- API error code 문자열은 아직 `packages/contracts`에 중앙화되어 있지 않습니다. 현재 `EMAIL_DOMAIN_NOT_ALLOWED`는 테스트로 고정되어 있지만, 새 오류 코드가 늘면 backend/frontend drift 가능성이 있습니다.
- API `health/deep`과 파일 접근은 S3/NAS 계층에 영향을 받습니다. NAS 점검이나 mount 장애 중에는 일반 health가 정상이더라도 이미지/업로드/export가 실패할 수 있습니다.
- 공개 API가 IP 주소 기반 TLS를 사용합니다. 실제 DNS 이름으로 이전하기 전까지 인증서 갱신과 브라우저 호환성 리스크를 계속 확인해야 합니다.
- 백업과 복구 자동화가 아직 충분하지 않습니다. 수동 DB/NAS 백업 기록은 있으나, 자동 백업, off-host 보관, 복구 rehearsal, restore runbook이 추가로 필요합니다.
- 서버 `.env`에는 과거 session 관련 key가 남아 있을 수 있습니다. 현재 API schema는 `SESSION_IDLE_MS`, `SESSION_ABSOLUTE_MS`, `SESSION_TOUCH_MIN_INTERVAL_MS` 기준입니다.
- DB/import schema에는 `githubUrl`, `platforms`가 있지만 현재 public/admin 응답 serializer에서 사용자 화면으로 노출되는 경로는 확인되지 않았습니다.

### 이미 해결된 과거 함정

- CORS allowed methods에 `PUT`이 포함되어 chunked game upload preflight 문제가 해결됐습니다.
- mock API에 `/api/public/exhibitions/:id/projects` route가 추가됐습니다.
- `/admin` 직접 접근 시 `/admin/projects`로 이동하도록 index route가 추가됐습니다.
- Google hosted domain mismatch는 403 `EMAIL_DOMAIN_NOT_ALLOWED`로 정리됐고, invalid token은 401 `UNAUTHORIZED`를 유지합니다.

## 참고 문서

- 현재 상태 요약: `docs/00_CURRENT_STATE.md`
- API와 데이터 contract: `docs/02_API_AND_DATA_CONTRACT.md`
- 검증 기록: `docs/05_VALIDATION_REPORT.md`
- 서버 감사 기록: `ops/server-audit/2026-06-01/`
- 서버 smoke checklist: `ops/server-audit/2026-06-01/05_smoke_checklist.md`
- 서버 보안/프록시 문서: `server/SECURITY-HARDENING.md`
- API deploy workflow: `.github/workflows/deploy-api.yml`
- Web deploy workflow: `.github/workflows/deploy-web-pages.yml`
- API Prisma schema: `apps/api/prisma/schema.prisma`
- 공유 contract: `packages/contracts/src/index.ts`
- LLM/신규 작업 기준: `docs/llm/`

## 안전수칙

- 운영 값은 “키 이름”까지만 공유하고 값은 공유하지 않습니다.
- 로그를 공유할 때도 토큰, 쿠키, 개인키, DB 접속 문자열, S3 access key가 포함되지 않았는지 먼저 확인합니다.
- 배포 전에는 백업과 health를 확인합니다.
- 배포 후에는 내부 health, deep health, 공개 HTTPS health를 모두 확인합니다.
- NAS 이동/재부팅/네트워크 작업 전에는 업로드 중단 안내와 사후 smoke check를 준비합니다.
- DB restore, volume 삭제, NAS 권한 변경, 대량 삭제는 승인 없이는 실행하지 않습니다.
