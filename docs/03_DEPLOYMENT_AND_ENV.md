# 03 Deployment And Env

작성일: 2026-05-28

## 로컬 개발 실행법

### 의존성 설치

```bash
npm install
```

근거 파일:

- `package.json`
- `README.md`

### Web mock mode

API와 DB 없이 UI를 확인하는 경로다.

```bash
cd apps/web
npm run dev:mock
```

동작:

- Vite dev server 실행
- `VITE_MOCK=true` mode
- API client가 `apps/web/src/lib/api/mock/handler.ts`를 사용

주의:

- 현재 mock handler에는 `/api/public/exhibitions/:id/projects`가 없다.

근거 파일:

- `apps/web/package.json`
- `apps/web/.env.mock`
- `apps/web/src/lib/api/client.ts`
- `apps/web/src/lib/api/mock/handler.ts`

### Full-stack local

1. DB와 Garage 실행

```bash
cd apps/db
docker compose up -d
```

2. API env 준비

```bash
cd apps/api
cp .env.example .env
```

3. Prisma 준비와 API 실행

```bash
cd apps/api
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

4. Web 실행

```bash
cd apps/web
npm run dev
```

근거 파일:

- `README.md`
- `apps/db/docker-compose.yml`
- `apps/api/package.json`
- `apps/web/package.json`
- `apps/api/.env.example`
- `apps/web/.env.example`

## 필요한 `.env` 목록

현재 repo에서 확인되는 env 파일:

- `.env`: 존재하지만 gitignore 대상. 내용은 읽지 않았다.
- `apps/api/.env`: 존재하지만 gitignore 대상. 내용은 읽지 않았다.
- `apps/api/.env.example`: API local development example
- `apps/web/.env.example`: Web local example
- `apps/web/.env.mock`: Web mock mode env
- `apps/web/.env.local`: 존재하지만 gitignore 대상. 내용은 읽지 않았다.

근거 파일:

- `.gitignore`
- `apps/api/.gitignore`
- `apps/web/.gitignore`
- `rg --files -uu -g ".env*" -g ".github/**" -g "!node_modules" -g "!apps/**/node_modules" -g "!apps/web/dist"`

## `apps/api/.env.example`에 있는 변수

현재 `apps/api/.env.example`에는 다음 변수가 있다.

Runtime:

- `NODE_ENV`
- `PORT`
- `LOG_LEVEL`
- `TRUST_PROXY`
- `SHUTDOWN_DRAIN_MS`

Database:

- `DATABASE_URL`

Session/cookie:

- `SESSION_SECRET`
- `SESSION_COOKIE_NAME`
- `SESSION_IDLE_MS`
- `SESSION_ABSOLUTE_MS`
- `SESSION_TOUCH_MIN_INTERVAL_MS`
- `COOKIE_SECURE`
- `COOKIE_SAME_SITE`

OAuth/origin:

- `GOOGLE_CLIENT_IDS`
- `ALLOWED_GOOGLE_HD`
- `CORS_ALLOWED_ORIGINS`
- `API_PUBLIC_URL`
- `WEB_PUBLIC_URL`

Upload/rate limit:

- `AUTO_PUBLISH_DEFAULT`
- `UPLOAD_ROOT_PROTECTED`
- `UPLOAD_ROOT_PUBLIC`
- `RATE_LIMIT_GLOBAL_MAX`
- `RATE_LIMIT_GLOBAL_WINDOW_MS`
- `RATE_LIMIT_LOGIN_MAX`
- `RATE_LIMIT_LOGIN_WINDOW_MS`
- `RATE_LIMIT_SUBMIT_MAX`
- `RATE_LIMIT_SUBMIT_WINDOW_MS`
- `UPLOAD_USER_IMAGE_MAX_MB`
- `UPLOAD_USER_GAME_MAX_MB`
- `UPLOAD_USER_REQUEST_MAX_MB`
- `UPLOAD_USER_MAX_FILES`
- `UPLOAD_PRIVILEGED_IMAGE_MAX_MB`
- `UPLOAD_PRIVILEGED_GAME_MAX_MB`
- `UPLOAD_PRIVILEGED_REQUEST_MAX_MB`
- `UPLOAD_PRIVILEGED_MAX_FILES`
- `UPLOAD_MAX_CONCURRENT`
- `UPLOAD_CHUNKED_GAME_MAX_MB`
- `UPLOAD_CHUNK_SIZE_MB`
- `UPLOAD_SESSION_TTL_MINUTES`

S3/Garage:

- `S3_ENDPOINT`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_BUCKET_PUBLIC`
- `S3_BUCKET_PROTECTED`
- `S3_FORCE_PATH_STYLE`
- `S3_PRESIGN_TTL_SEC`

NAS:

- `NAS_EXPORT_PATH` is documented as optional and commented out.

근거 파일:

- `apps/api/.env.example`
- `apps/api/src/config/env.ts`

## `apps/web/.env.example`에 있는 변수

- `VITE_API_BASE_URL`
- `VITE_GOOGLE_CLIENT_ID`
- `VITE_BASE_PATH` is documented as optional/commented.

근거 파일:

- `apps/web/.env.example`
- `apps/web/src/lib/env/index.ts`
- `apps/web/vite.config.ts`

## `.env.example`에 있어야 할 변수와 현재 gap

API local example은 `apps/api/src/config/env.ts`의 주요 runtime schema와 대체로 맞는다.

다만 production deploy script가 요구하는 server-level `.env` 변수는 별도 example이 현재 없다. `server/deploy.sh` 기준 production deploy `.env`에는 최소 다음 변수가 필요하다.

PostgreSQL container:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `DATABASE_URL`

API/session/OAuth/origin:

- `SESSION_SECRET`
- `SESSION_COOKIE_NAME`
- `SESSION_IDLE_MS`
- `SESSION_ABSOLUTE_MS`
- `SESSION_TOUCH_MIN_INTERVAL_MS`
- `COOKIE_SECURE`
- `COOKIE_SAME_SITE`
- `GOOGLE_CLIENT_IDS`
- `ALLOWED_GOOGLE_HD`
- `CORS_ALLOWED_ORIGINS`
- `API_PUBLIC_URL`
- `WEB_PUBLIC_URL`
- `LOG_LEVEL`

Storage:

- `S3_ENDPOINT`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_BUCKET_PUBLIC`
- `S3_BUCKET_PROTECTED`
- `S3_FORCE_PATH_STYLE`
- `STORAGE_HOST_PATH`

NAS/export:

- `NAS_EXPORT_HOST_PATH`
- `NAS_EXPORT_PATH`

Optional deploy controls:

- `DEPLOY_DIR`
- `API_BIND_HOST`
- `API_PORT`

추정: `server/.env.example` 또는 root-level production env example이 필요하다. 현재 repo에는 server-level deploy `.env.example`이 확인되지 않는다. 근거 파일: `server/deploy.sh`, `rg --files -uu -g ".env*" ...`.

## Docker/Compose 사용 여부

Local:

- `apps/db/docker-compose.yml`이 PostgreSQL, Garage, Garage init을 실행한다.
- root `docker-compose.yml`은 현재 없다.

API image:

- `apps/api/Dockerfile`은 repo root를 build context로 가정한다.
- Node 22 bookworm slim 기반 multi-stage build다.
- Prisma generate와 API build를 수행한다.
- runtime image는 `ffmpeg`, `wget`, `openssl`을 설치한다.
- container start 시 `npx prisma migrate deploy && node dist/server.js`를 실행한다.

Production:

- `server/deploy.sh`는 docker-compose를 쓰지 않고 podman pod/container를 직접 관리한다.
- PostgreSQL container와 API container를 같은 pod에 띄운다.
- API port는 기본적으로 `127.0.0.1:4000`에 bind한다.

근거 파일:

- `apps/db/docker-compose.yml`
- `apps/api/Dockerfile`
- `server/deploy.sh`
- `README.md`
- `rg --files`

## GitHub Pages 배포 흐름

트리거:

- `master` branch push
- path: `apps/web/**`, `packages/contracts/**`, root package files, web deploy workflow
- manual `workflow_dispatch`

빌드:

```bash
npm ci --workspace=apps/web --include-workspace-root
cd apps/web
npm test
npm run lint
npm run build
```

환경 변수:

- `VITE_API_BASE_URL`: GitHub Actions variable
- `VITE_GOOGLE_CLIENT_ID`: GitHub Actions variable
- `VITE_BASE_PATH`: GitHub Actions variable, default `/`

배포:

- `peaceiris/actions-gh-pages@v4`
- external repository: `pcugame/pcugame.github.io`
- branch: `master`
- publish dir: `apps/web/dist`

근거 파일:

- `.github/workflows/deploy-web-pages.yml`
- `apps/web/package.json`
- `apps/web/scripts/post-build.mjs`

## API 배포 흐름

트리거:

- `master` branch push
- path: `apps/api/**`, `packages/contracts/**`, root package files, `docker-compose.yml`, `server/deploy.sh`, API deploy workflow
- manual `workflow_dispatch`

주의:

- root `docker-compose.yml`은 현재 존재하지 않는다. 이 path trigger는 stale일 가능성이 있다.

빌드:

```bash
npm ci --include-workspace-root
npm run db:generate --workspace=apps/api
npm test --workspace=apps/api
npm run build --workspace=apps/api
docker buildx build -f apps/api/Dockerfile .
```

배포:

- GHCR image push
- `server/deploy.sh`를 server로 복사
- SSH로 server에서 `deploy.sh up`
- server에서 podman login 후 latest API image pull/run

근거 파일:

- `.github/workflows/deploy-api.yml`
- `apps/api/Dockerfile`
- `server/deploy.sh`

## NAS/Reverse Proxy/API 배포 관련 현재 상태

NAS:

- API export 기능은 `NAS_EXPORT_PATH`가 설정되어야 실행된다.
- `server/deploy.sh`는 host `NAS_EXPORT_HOST_PATH`를 container `NAS_EXPORT_PATH`로 mount한다.
- 기본 host path는 `/mnt/nas/pcu_storage/GraduationGame`
- 기본 container path는 `/nas`

근거 파일:

- `apps/api/src/modules/admin/export/controller.ts`
- `apps/api/src/modules/admin/export/service.ts`
- `server/deploy.sh`

Reverse proxy:

- `server/deploy.sh`는 API를 기본적으로 loopback에만 bind한다.
- `server/SECURITY-HARDENING.md`는 public API traffic이 nginx를 통해 들어와야 한다고 설명한다.
- direct external `:4000` 접근은 실패해야 하고 public HTTPS reverse proxy health는 동작해야 한다고 설명한다.

근거 파일:

- `server/deploy.sh`
- `server/SECURITY-HARDENING.md`

API server:

- Fastify app은 `0.0.0.0:${PORT}`로 listen한다.
- container/pod port publishing에서 외부 bind 범위를 제한한다.
- healthcheck는 `/api/health`를 사용한다.

근거 파일:

- `apps/api/src/server.ts`
- `apps/api/Dockerfile`
- `server/deploy.sh`

DB:

- Local DB는 `apps/db/docker-compose.yml`의 PostgreSQL service다.
- Production DB는 `server/deploy.sh`가 podman으로 `postgres:16-alpine` container를 띄운다.

근거 파일:

- `apps/db/docker-compose.yml`
- `server/deploy.sh`

## 배포 전 검증 명령어

루트 baseline:

```bash
npm test
npm run lint
npm run build
```

API focused:

```bash
npm run db:generate --workspace=apps/api
npm test --workspace=apps/api
npm run lint --workspace=apps/api
npm run build --workspace=apps/api
```

Web focused:

```bash
npm test --workspace=apps/web
npm run lint --workspace=apps/web
npm run build --workspace=apps/web
```

Local infra smoke:

```bash
cd apps/db
docker compose up -d
cd ../api
npm run db:migrate
npm run db:seed
npm run dev
```

Production API post-deploy smoke:

```bash
curl -fsS http://127.0.0.1:4000/api/health
curl -fsS https://<public-api-host>/api/health
```

주의:

- 이 문서 작성 중에는 Docker compose, DB migrate, production deploy, curl smoke를 실행하지 않았다.
- 실제 production secret/env 값은 문서화하지 않았고 읽지 않았다.

근거 파일:

- `README.md`
- `package.json`
- `apps/api/package.json`
- `apps/web/package.json`
- `.github/workflows/pr-checks.yml`
- `.github/workflows/deploy-api.yml`
- `.github/workflows/deploy-web-pages.yml`
