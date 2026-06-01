# PCU Web App

React 19 + Vite SPA for the PCU graduation project showcase.

## Responsibilities

- Public exhibition/year/project browsing.
- Google OAuth login entry points and session-aware navigation.
- Student project submission and editing flows.
- Admin screens for exhibitions, projects, settings, banned IPs, import/export,
  and asset management.
- Development mock mode for UI work without the API.

## Commands

```bash
npm run dev       # Vite dev server on :5173
npm run dev:mock  # Vite with VITE_MOCK=true mode
npm test          # Vitest
npm run lint      # ESLint
npm run build     # TypeScript build + Vite build + SPA post-build
npm run preview   # Preview production build
```

## Environment

Copy `.env.example` to `.env.local` for local development.

- `VITE_API_BASE_URL`: API origin, usually `http://localhost:4000`.
- `VITE_GOOGLE_CLIENT_ID`: Google OAuth web client ID.
- `VITE_DEV_AUTH_ENABLED`: shows the integration-only dev login panel when
  `true` and the app is not a production build.
- `VITE_BASE_PATH`: GitHub Pages base path. Use `/` for a custom domain.

## Project Notes

- API calls live under `src/lib/api`.
- TanStack Query keys live in `src/lib/query/keys.ts`.
- Shared API transport types come from `@pcu/contracts` through
  `src/contracts`.
- Web form schemas live in `src/contracts/schemas.ts` and use Zod v4.
- Mock mode is intentionally lightweight for UI-only work. Use the root
  integration test environment for full API/PostgreSQL/Garage coverage.
