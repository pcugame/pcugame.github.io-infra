# PCU Graduation Project V2

배재대학교 게임공학과 졸업작품 전시 플랫폼 모노레포입니다.

> [!CAUTION]
> **이 프로젝트는 현재 개발 중이며, 아직 완성된 상태가 아닙니다.**
> 알려진 이슈는 [Issues](../../issues) 탭에서 확인할 수 있습니다.

## Repository Layout

- `apps/api`: Fastify + TypeScript + Prisma API
- `apps/web`: React + Vite + TypeScript SPA
- `apps/db`: 로컬 개발용 DB + 오브젝트 스토리지 (docker-compose)
- `server`: 운영 보조 스크립트
- `.github/workflows`: CI/CD 워크플로

운영 서버 SSH/password 제한, fail2ban, nftables, API loopback 바인딩 적용 절차는 [`server/SECURITY-HARDENING.md`](server/SECURITY-HARDENING.md)를 참고하세요.

## Tech Stack

- **Frontend**: React 19 · Vite · React Router 7 · TanStack Query
- **Backend**: Fastify 5 · TypeScript · Prisma · PostgreSQL
- **Storage**: S3 호환 오브젝트 스토리지 (Garage)
- **Auth**: Google OAuth 2.0
- **CI/CD**: GitHub Actions (API → GHCR · Web → GitHub Pages)

## Local Development

### 사전 요구사항

- Node.js 22+
- Docker (또는 Docker Desktop)

### 경로 A: UI만 수정 (DB/API 불필요)

서버를 띄우지 않고 프론트엔드 UI만 확인할 수 있습니다.

```bash
cd apps/web
npm install
npm run dev:mock
```

mock 모드에서는 가짜 데이터로 대부분의 화면을 둘러볼 수 있습니다.
다만 일부 관리자 API는 아직 mock이 없습니다 — [#8](../../issues/8) 참고.

### 경로 B: 풀스택 개발

#### 1. DB + 스토리지

```bash
cd apps/db
docker compose up -d
```

Garage(S3 호환 스토리지)가 함께 올라갑니다. 초기 버킷은 `garage-init.sh`가 자동 생성합니다.

#### 2. API

```bash
cd apps/api
npm install
npx prisma generate
npx prisma migrate dev
npm run db:seed          # 테스트 관리자 + 샘플 프로젝트
npm run dev
```

> **참고**: API 실행에는 환경변수 설정이 필요합니다. 아직 `.env.example`이 없어서 `src/config/env.ts`를 보고 직접 작성해야 합니다 — [#6](../../issues/6)에서 개선 예정.

#### 3. Web

```bash
cd apps/web
npm install
npm run dev
```

### 로그인

현재 로그인은 Google OAuth를 거쳐야 합니다. 로컬 개발 시에는 seed가 출력하는 세션 쿠키를 브라우저에 수동 주입하는 방식을 씁니다.
개발용 간편 로그인은 [#7](../../issues/7)에서 추가 예정입니다.

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
