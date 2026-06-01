# PCU Graduation Project V2

배재대학교 게임공학과 졸업작품 전시 플랫폼 모노레포입니다. 공개 전시 페이지, 관리자 업로드/편집 화면, Google OAuth 로그인, PostgreSQL 데이터, Garage/S3 기반 파일 저장소를 함께 관리합니다.

> [!CAUTION]
> 이 프로젝트는 개발 중입니다. LLM이나 신규 참여자가 작업할 때는 먼저 `README.md`, `docs/llm/*`, `packages/contracts/src/index.ts`, `apps/api/prisma/schema.prisma`를 읽고 현재 구조를 확인하세요.

## Repository Layout

- `apps/api`: Fastify 5 + TypeScript + Prisma API.
- `apps/web`: React 19 + Vite + TypeScript SPA.
- `apps/db`: 로컬 PostgreSQL + Garage(S3 호환 스토리지) 개발 환경.
- `packages/contracts`: API/Web 공유 type-only contract 패키지.
- `docs/llm`: LLM 작업 기준 문서와 템플릿.
- `analysis`: 과거 분석, 장애 조사, 의사결정 기록.
- `prompts`: 재사용 가능한 LLM 작업 프롬프트.
- `server`: 운영 서버 배포/보안 보조 스크립트.
- `.github/workflows`: PR 검증과 배포 워크플로.

운영 서버 SSH 제한, fail2ban, nftables, API loopback 바인딩 절차는 [`server/SECURITY-HARDENING.md`](server/SECURITY-HARDENING.md)를 참고하세요.

## Shared LLM Harness

개인별 `AGENTS.md`, `CLAUDE.md`, `.env`, `.env.local`은 로컬 파일입니다. GitHub 기준 원본은 다음 파일들입니다.

- [`docs/llm/project-context.md`](docs/llm/project-context.md)
- [`docs/llm/engineering-rules.md`](docs/llm/engineering-rules.md)
- [`docs/llm/task-template.md`](docs/llm/task-template.md)
- [`docs/llm/verification.md`](docs/llm/verification.md)
- [`docs/llm/mock-coverage.md`](docs/llm/mock-coverage.md)
- [`docs/llm/chatgpt-project-initial-prompt.md`](docs/llm/chatgpt-project-initial-prompt.md)
- [`AGENTS.md.example`](AGENTS.md.example)
- [`CLAUDE.md.example`](CLAUDE.md.example)

ChatGPT Project 같은 LLM 작업 공간에는 개인 로컬 파일이 아니라 위 문서들과 `package.json`, `apps/*/package.json`, `packages/contracts/src/index.ts`, `apps/api/prisma/schema.prisma`, 주요 API/Web client 파일을 넣어 사용하세요.

## Tech Stack

- Frontend: React 19, Vite, React Router 7, TanStack Query, Zod v4.
- Backend: Fastify 5, TypeScript, Prisma, PostgreSQL, Zod v3.
- Storage: Garage 또는 S3 호환 오브젝트 스토리지.
- Auth: Google OAuth 2.0 + HttpOnly cookie session.
- CI/CD: GitHub Actions, GHCR API image, GitHub Pages web deploy.

## Setup

사전 요구사항:

- Node.js 22+
- Docker 또는 Docker Desktop

루트에서 의존성을 설치합니다.

```bash
npm install
```

## Development Paths

### UI Only Mock

API와 DB 없이 프론트엔드 화면을 확인합니다.

```bash
cd apps/web
npm run dev:mock
```

mock 모드는 주요 공개/관리자 화면을 열 수 있도록 유지합니다. 누락된 mock route를 발견하면 [`docs/llm/mock-coverage.md`](docs/llm/mock-coverage.md)를 확인하고 보강하세요.

### Full Integration Test Environment

실제 API, PostgreSQL, Garage(S3), Web을 함께 띄워 전체 기능 흐름을 확인합니다. Google OAuth만 테스트 전용 dev-auth 경로로 대체하고, 이후 세션/cookie/API 오류 처리는 실제 경로를 사용합니다.

```bash
npm run testenv:up
```

- Web: `http://localhost:5173`
- API: `http://localhost:4000`
- PostgreSQL host port: `15432`
- Garage S3 host port: `3900`

상태를 초기화하려면 `npm run testenv:reset`, 종료는 `npm run testenv:down`, 볼륨까지 삭제하려면 `npm run testenv:clean`을 사용합니다. UI-only mock은 빠른 화면 작업용으로 남겨두고, 전체 기능 검증은 이 통합 환경을 기본으로 사용하세요.

### Full-Stack Local

1. DB + Garage 실행:

```bash
cd apps/db
docker compose up -d
```

2. API 환경 파일 작성:

```bash
cd apps/api
cp .env.example .env
```

Garage access key는 다음 명령으로 확인해 `.env`의 `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`에 넣습니다.

```bash
docker compose -f ../db/docker-compose.yml exec garage garage -c /etc/garage.toml key info pcu-dev-key
```

3. API 실행:

```bash
cd apps/api
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

4. Web 실행:

```bash
cd apps/web
npm run dev
```

### Production / Server

- API container build and deploy flow is in [`.github/workflows/deploy-api.yml`](.github/workflows/deploy-api.yml) and [`server/deploy.sh`](server/deploy.sh).
- Web deploy flow is in [`.github/workflows/deploy-web-pages.yml`](.github/workflows/deploy-web-pages.yml).
- Server hardening is in [`server/SECURITY-HARDENING.md`](server/SECURITY-HARDENING.md).

Do not simplify Dockerfile or workflow comments around Prisma, OpenSSL, sharp, or workspace installs without reproducing the production build path.

## Login

Production login uses Google OAuth. The integration environment enables `/api/dev/auth/*` only when `DEV_AUTH_ENABLED=true` and `NODE_ENV` is not `production`; the web login page shows its dev-auth panel only when `VITE_DEV_AUTH_ENABLED=true` and the app is not a production build.

## Contracts

`@pcu/contracts` is the source of truth for API/Web request and response shapes.

- Update [`packages/contracts/src/index.ts`](packages/contracts/src/index.ts) before changing transport shapes.
- API handlers should use `sendOk<T>` or `sendCreated<T>` with contract types.
- Web API clients should use the same contract type as their generic.
- Runtime validation stays app-local: API Zod v3, Web Zod v4.

## Quality Checks

Root baseline:

```bash
npm test
npm run lint
npm run build
```

Focused checks:

```bash
npm test --workspace=apps/api
npm run lint --workspace=apps/api
npm run build --workspace=apps/api

npm test --workspace=apps/web
npm run lint --workspace=apps/web
npm run build --workspace=apps/web
```

See [`docs/llm/verification.md`](docs/llm/verification.md) for change-specific verification.

## Contributions

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Before committing from a dirty worktree, stage only files directly related to the current task.
- PRs should include a clear description, linked issues, screenshots for UI changes, migration notes for DB changes, and verification results.
