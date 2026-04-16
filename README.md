# PCU Graduation Project V2

배재대학교 게임공학과 졸업작품 전시 플랫폼 모노레포입니다.

## Repository Layout

- `apps/api`: Fastify + TypeScript + Prisma API
- `apps/web`: React + Vite + TypeScript SPA
- `apps/db`: 로컬 개발용 DB + 오브젝트 스토리지 (docker-compose)
- `server`: 운영 보조 스크립트
- `.github/workflows`: CI/CD 워크플로

## Tech Stack

- **Frontend**: React 19 · Vite · React Router 7 · TanStack Query
- **Backend**: Fastify 5 · TypeScript · Prisma · PostgreSQL
- **Storage**: S3 호환 오브젝트 스토리지
- **Auth**: Google OAuth 2.0
- **CI/CD**: GitHub Actions (API → GHCR · Web → GitHub Pages)

## Local Development

### 사전 요구사항

- Node.js 22+
- Docker (또는 Docker Desktop)

### 1. DB + 스토리지

```bash
cd apps/db
docker compose up -d
```

### 2. API

```bash
cd apps/api
npm install
npx prisma generate
npx prisma migrate dev
npm run db:seed
npm run dev
```

### 3. Web

```bash
cd apps/web
npm install
npm run dev
```

### Mock 모드 (DB 없이 UI 확인)

```bash
cd apps/web
npm run dev:mock
```

## Quality Checks

```bash
cd apps/api && npm test && npm run lint
cd apps/web && npm test && npm run lint
```

## Contributions

- 변경 사항이 있으면 브랜치를 pull 받은 뒤 수정해서 PR로 보내 주세요.
- PR을 올리면 확인하겠습니다.
- 더 빠른 확인이 필요하면 Instagram `@gluemylifeplease` 로 연락해 주세요.
- 오프라인으로는 `C302호`에 와서 `송지한`을 찾아도 됩니다.
