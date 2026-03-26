# Repository Guidelines

## Project Structure & Module Organization

- Monorepo under `apps/`:
  - `apps/api` — Fastify + TypeScript API. Routes in `src/modules/<area>/*.routes.ts`, plugins in `src/plugins/*.ts`, shared utils in `src/{shared,lib}`. Prisma schema at `prisma/schema.prisma`.
  - `apps/web` — React + Vite + TypeScript. Pages in `src/pages/*Page.tsx`, components in `src/components/**`, features in `src/features/**`.
- Root: `docker-compose.yml` (Postgres + API), `.env.example`, `assets/`, `prompts/`.

## Build, Test, and Development Commands

- API (`cd apps/api`):
  - `npm run dev` — Start Fastify with `tsx` on `:4000`.
  - `npm run build` / `npm start` — Compile to `dist/` and run.
  - DB: `npm run db:generate`, `npm run db:migrate`, `npm run db:studio`.
- Web (`cd apps/web`):
  - `npm run dev` — Vite dev server (`:5173`).
  - `npm run build` / `npm run preview`.
  - `npm run lint` — ESLint.
- Docker (API + Postgres): `docker compose up --build -d`.

## Coding Style & Naming Conventions

- TypeScript throughout; 1-tab indent; prefer explicit types at module boundaries.
- Web: Components/pages PascalCase (e.g., `HomePage.tsx`), hooks `useX.ts`, re‑exports via `index.ts`.
- API: Route files end with `.routes.ts`; plugins lowercase (`cookie.ts`); keep handlers small and typed.
- Linting: Web uses ESLint (`apps/web/eslint.config.js`); API uses `tsc --noEmit` for type checks.

## Testing Guidelines

- No test suite yet. If adding:
  - Web: Vitest + React Testing Library; files `*.test.tsx` colocated or under `__tests__/`.
  - API: Vitest/Jest + Supertest; files `*.test.ts`.
  - Aim for >80% on critical paths (auth, routing, data transforms).

## Commit & Pull Request Guidelines

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`) as used in history.
- PRs: clear description, link issues, screenshots for UI changes (`apps/web`), note DB migrations and run `db:migrate` locally.

## Security & Configuration

- Do not commit secrets. Copy `.env.example` → `.env`. Web env keys must start with `VITE_` (see `apps/web/.env.example`).
- For production, rotate `SESSION_SECRET`, set `POSTGRES_PASSWORD`, and follow reverse‑proxy guidance in `README.md`.

