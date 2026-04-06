# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PCU Graduation Project Showcase — a monorepo for a university game engineering capstone showcase platform. Frontend is deployed to GitHub Pages; backend runs on a dedicated server via Podman. A NAS provides file storage only.

## Commands

### API (`apps/api`)
```bash
npm run dev              # tsx watch (hot reload) on :4000
npm run build            # tsc compile to dist/
npm run lint             # tsc --noEmit (type-check only)
npm run test             # vitest run (unit tests in src/__tests__/)
npm run db:generate      # regenerate Prisma client after schema changes
npm run db:migrate       # create + apply migration (development)
npm run db:migrate:deploy # apply existing migrations (production)
npm run db:studio        # Prisma Studio GUI
npm run db:seed          # test admin + sample data (from apps/db/seed.ts)
npm run db:seed:import   # import legacy data (from apps/db/legacy-import.json)
```

### Web (`apps/web`)
```bash
npm run dev              # Vite dev server on :5173
npm run build            # tsc + vite build + post-build.mjs (for SPA routing on GitHub Pages)
npm run lint             # ESLint 9
npm run test             # vitest run (unit tests in src/__tests__/)
npm run preview          # preview production build locally
```

### Local dev setup
```bash
# 1. DB (Docker)
cd apps/db && docker compose up -d

# 2. API (separate terminal)
cd apps/api
npm install && npx prisma generate && npx prisma migrate dev
npm run db:seed              # test admin + sample data
npm run dev

# 3. Web (separate terminal)
cd apps/web && npm install && npm run dev
```

### DB tools (`apps/db`)
```bash
docker compose up -d         # start local PostgreSQL on :5432
docker compose down          # stop (data preserved)
docker compose down -v       # stop + delete data
```
API에서 실행하는 seed 스크립트:
```bash
npm run db:seed              # test admin + sample project
npm run db:seed:import       # legacy-import.json으로 전체 임포트
```

## Architecture

### Monorepo structure
```
apps/api/   — Fastify 5 + TypeScript + Prisma + PostgreSQL
apps/db/    — Local PostgreSQL (docker-compose) + seed/migration scripts
apps/web/   — React 19 + Vite + TanStack Query + React Router v7
```

No shared package — types are duplicated in `apps/web/src/contracts/` (enums, Zod schemas, response types).

**Note:** API uses Zod v3 (`zod@^3.24`), Web uses Zod v4 (`zod@^4.3`) — import paths and some APIs differ between the two.

### API (`apps/api/src/`)

- **Entry**: `server.ts` → `buildApp()` in `app.ts`
- **Route prefixes**: `/api/auth`, `/api/public`, `/api/admin`, `/api/assets`
- **Admin routes** (`modules/admin/`): `admin.routes.ts` is an assembly-only entry point that registers sub-route modules. Each module follows a 3-layer pattern (`controller.ts` → `service.ts` → `repository.ts`):
  - `year/` — Exhibition/Year CRUD (3 endpoints)
  - `project/` — Project CRUD + submit + asset add + poster set (7 endpoints)
  - `member/` — Member CRUD (3 endpoints)
  - `game-upload/` — Resumable chunked game-file upload (6 endpoints)
  - `banned-ip/` — Banned IP list + unban (2 endpoints, OPERATOR/ADMIN only)
  - `settings/` — Site settings CRUD
  - `project-access.ts` — `assertWriteAccess()` (pure, testable permission check) + `loadProjectWithAccess()` (DB-backed wrapper)
  - `upload-guard.ts` — `assertUploadAllowed()` enforces exhibition existence + upload lock
- **Auth plugin** (`plugins/auth.ts`): cookie-based session via `AuthSession` table. Decorates request with `requireLogin()` and `requireRole()` helpers.
- **Env config** (`config/env.ts`): Zod-validated singleton; access via `env()`.
- **Shared utilities** (`shared/`): `errors.ts` (AppError), `http.ts` (sendOk/sendCreated), `validation.ts` (Zod schemas + `parseBody` helper), `session.ts`, `storage-path.ts`, `file-signature.ts`, `slug.ts`, `download-rate-limit.ts` (IP-based rate limiter with permanent ban)
- **Upload pipeline** (`modules/assets/upload/`): `UploadPipeline` orchestrates file validation → image processing (sharp) → disk persistence. Types: `CollectedFile` → `ValidatedFile` → `SavedFile`.
- **Tests**: vitest unit tests in `src/__tests__/` — run with `npm run test`.

#### Database schema (Prisma)
Key models: `User` (roles: USER/OPERATOR/ADMIN), `Exhibition` (year + title, isUploadEnabled), `Project` (status: DRAFT/PUBLISHED/ARCHIVED), `ProjectMember`, `Asset` (kind: THUMBNAIL/IMAGE/POSTER/GAME), `AuthSession`, `GameUploadSession` (resumable chunked game uploads), `BannedIp` (auto-banned IPs from excessive game downloads), `SiteSetting` (runtime-configurable limits).
Note: `UploadJob` model exists in schema but is unused (dead code, pending removal).

### Web (`apps/web/src/`)

- **Router** (`app/router.tsx`): lazy-loaded pages, guarded by `RequireAuth` and `RequireRole` components.
- **API client** (`lib/api/`): thin fetch wrappers — `client.ts` (base), then `auth.ts`, `public.ts`, `admin.ts`.
- **Query keys** (`lib/query/keys.ts`): centralized TanStack Query key factory.
- **Auth** (`features/auth/`): `useMe`, `useLogin`, `useLogout` hooks + route guards.
- **Contracts** (`contracts/`): Zod schemas and inferred TypeScript types for all API responses — update these when the API changes.
- **Mock** (`lib/api/mock/`): development-only fake data, activated by `VITE_MOCK=true`. **Intentionally does NOT import from `contracts/`** — uses local types and `any` to avoid breaking production builds when contracts change. Mock data is excluded from production bundles by Vite dead-code elimination.
- **Tests**: vitest unit tests in `src/__tests__/` — run with `npm run test`.

## Upload lock policy (`isUploadEnabled`)

Each `Exhibition` has an `isUploadEnabled` flag controlled by operators/admins.

- **Server enforcement** (`upload-guard.ts`): The submit route (`POST /projects/submit`) requires the target exhibition to **already exist** (no auto-creation). If `isUploadEnabled` is `false`, only `ADMIN` and `OPERATOR` roles may submit; `USER` receives 403.
- **Frontend hint**: The new-project form shows an exhibition dropdown with lock status and disables the submit button for locked exhibitions (non-privileged users only). This is a UX convenience — the server is the source of truth.
- Exhibitions must be created explicitly by operators via `POST /admin/years`.

## Read vs write permissions

This is a **public showcase site** — read access is open, write access is restricted.

### Read (public, no login required)
- `GET /api/assets/public/:storageKey` — images, posters, thumbnails. No auth.
- `GET /api/assets/protected/:storageKey` — game files are **always publicly downloadable** (no login required). An IP-based rate limiter permanently bans IPs that exceed 30 downloads/15min. Admins can unban via `GET/DELETE /api/admin/banned-ips`.
- `GET /api/public/*` — project listings, year listings. No auth.

### Write (login required, role-enforced)
All write routes go through `assertWriteAccess()` (via `loadProjectWithAccess()`):
- **ADMIN / OPERATOR**: can modify any project in any status.
- **USER**: can only modify projects they created, and only while in `DRAFT` status (when `requireDraft` is set, which is all write routes except submit).

| Route | Guard |
|-------|-------|
| `POST /projects/submit` | `requireLogin` + `assertUploadAllowed` (year lock) |
| `PATCH /projects/:id` | `loadProjectWithAccess(requireDraft)` |
| `DELETE /projects/:id` | `loadProjectWithAccess(requireDraft)` |
| `POST /projects/:id/assets` | `loadProjectWithAccess(requireDraft)` |
| `PATCH /projects/:id/poster` | `loadProjectWithAccess(requireDraft)` |
| `DELETE /admin/assets/:assetId` | `loadProjectWithAccess(requireDraft)` |
| `POST /projects/:id/members` | `loadProjectWithAccess(requireDraft)` |
| `PATCH /projects/:id/members/:memberId` | `loadProjectWithAccess(requireDraft)` |
| `DELETE /projects/:id/members/:memberId` | `loadProjectWithAccess(requireDraft)` |

## CSRF protection

Because the frontend (GitHub Pages) and API are cross-origin with `SameSite=None` cookies, a CSRF defense is required. The API uses **Origin header validation** (`plugins/csrf.ts`):

- All state-changing methods (POST, PATCH, DELETE, PUT) must include an `Origin` header matching one of `CORS_ALLOWED_ORIGINS`.
- Falls back to `Referer` header origin if `Origin` is absent.
- If neither header is present, the request is rejected (403). Legitimate browser cross-origin requests always send `Origin`.
- GET / HEAD / OPTIONS are exempt (read-only).
- No client-side changes needed — browsers automatically send `Origin` on `fetch` with `credentials: 'include'`.

## Upload limits (role-based)

Upload size, file count, and concurrency are enforced at the server level with role-based policies (`shared/upload-limits.ts`).

| Limit | USER default | OPERATOR/ADMIN default | Env var |
|-------|-------------|----------------------|---------|
| Image/poster per file | 10 MB | 15 MB | `UPLOAD_USER_IMAGE_MAX_MB` / `UPLOAD_PRIVILEGED_IMAGE_MAX_MB` |
| Game (ZIP) per file | 200 MB | 1024 MB | `UPLOAD_USER_GAME_MAX_MB` / `UPLOAD_PRIVILEGED_GAME_MAX_MB` |
| Total per request | 250 MB | 1200 MB | `UPLOAD_USER_REQUEST_MAX_MB` / `UPLOAD_PRIVILEGED_REQUEST_MAX_MB` |
| Files per request | 10 | 20 | `UPLOAD_USER_MAX_FILES` / `UPLOAD_PRIVILEGED_MAX_FILES` |
| Concurrent uploads (global) | — | — | `UPLOAD_MAX_CONCURRENT` (default 5) |

**Enforcement layers (defense in depth):**
1. **Streaming byte limiter** (`createByteLimiter`) — aborts write to tmp disk as soon as per-file limit is exceeded, before the full file lands on disk.
2. **Per-request total** — tracked by accumulating file sizes during multipart collection.
3. **File count** — checked before each file part is written.
4. **Concurrent upload semaphore** — 429 when server is at capacity.
5. **Fastify multipart global ceiling** — set to privileged game max (absolute cap).
6. **`file-validator.ts`** — secondary per-kind check after write (absolute ceilings, role-independent).

## Chunked game upload (5GB resumable)

Large game ZIP files (up to 5GB) use a separate resumable chunked upload flow, independent of the existing multipart submit. The existing `POST /projects/submit` is preserved for small files (images, posters, small games).

**Flow**: Create session → Upload chunks (PUT, one per request) → Complete (concatenate + create GAME asset)

**API endpoints** (all under `/api/admin/`):
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/projects/:id/game-upload-sessions` | Create session |
| PUT | `/game-upload-sessions/:sid/chunks/:index` | Upload one chunk (octet-stream) |
| GET | `/game-upload-sessions/:sid` | Session status + uploaded chunks |
| POST | `/game-upload-sessions/:sid/complete` | Finalize → GAME asset |
| DELETE | `/game-upload-sessions/:sid` | Cancel + cleanup staging |
| GET | `/projects/:id/game-upload-sessions` | List active sessions |

**Env vars**:
| Var | Default | Description |
|-----|---------|-------------|
| `UPLOAD_CHUNKED_GAME_MAX_MB` | 5120 | Max game file size (chunked) |
| `UPLOAD_CHUNK_SIZE_MB` | 10 | Chunk size in MB |
| `UPLOAD_STAGING_ROOT` | (configurable) | Staging directory for chunks |
| `UPLOAD_SESSION_TTL_MINUTES` | 1440 | Session expiry (24h) |

**Key design decisions**:
- Chunks are streamed directly to disk (no memory buffering)
- On complete, chunks are concatenated directly to permanent storage (no intermediate copy)
- Existing GAME asset is replaced on complete via safe rename-then-update (old file backed up, restored on DB failure)
- ZIP magic-byte validation on finalize (rejects non-ZIP files)
- Role-based size limit enforced on session creation (`min(globalMax, roleGameMax)`)
- Exhibition upload lock (`assertUploadAllowed`) checked on session creation
- Expired/cancelled sessions have their staging dirs cleaned up
- Frontend widget supports pause, resume, retry, and new-tab recovery via session API

## Known pitfalls

### Fastify 5: route-level hooks must be async
Fastify 5 hangs when a route-level `preHandler` is a sync function that returns `undefined` on success (i.e., doesn't throw). The request lifecycle stalls silently — no error, no timeout, just infinite pending. Always declare `preHandler` / `onRequest` / `preSerialization` etc. as `async` functions returning `Promise<void>`, even if the body is synchronous. This applies to `requireLogin()`, `requireRole()`, and any future route guards in `plugins/auth.ts`.

## Coding conventions

- 1-tab indentation throughout.
- API route files named `*.routes.ts`; Fastify plugins are lowercase.
- Web components PascalCase (`HomePage.tsx`); hooks camelCase (`useMe.ts`).
- Explicit TypeScript types at module boundaries; Zod for runtime validation on both sides.
- Conventional Commits (`feat:`, `fix:`, `chore:`, etc.).
