# 04 Obsolete Or Suspicious Files

작성일: 2026-05-28

이 문서는 삭제 후보를 확정하지 않는다. 실제 삭제는 하지 않았다. 각 항목은 현재 repo 파일 참조, import 검색, route/schema 검색 결과를 기준으로 분류했다.

위험도 기준:

- 낮음: 삭제 전 확인은 필요하지만 runtime 영향 가능성이 낮아 보임
- 중간: 문서/운영/외부 링크/배포에 영향을 줄 수 있음
- 높음: 현재 코드나 DB compatibility에 연결되어 있어 삭제하면 위험함

## 의심 또는 stale 가능성이 있는 파일

### `prisma/migrations/20260416000000_remove_unused_upload_job_model/migration.sql`

- 근거: 현재 Prisma schema와 migrations는 `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations` 아래에 있다. 루트에는 `prisma/schema.prisma`가 없고 root `package.json`에도 Prisma script가 없다.
- 위험도: 중간
- 추천 조치: 바로 삭제하지 말고, 이 migration이 과거 DB 이력 추적용인지 확인한다. 필요하면 `analysis/` 또는 migration archive 문서로 이동하는 별도 작업을 만든다.

근거 파일:

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/*`
- `package.json`
- `apps/api/package.json`
- `rg --files`

### `upload_admin_add.md`

- 근거: 문서 안에 `DRAFT`, `/api/legacy-assets/public/:id`, `/api/legacy-assets/protected/:id` 같은 현재 contract에 없는 개념/route가 남아 있다. 현재 `ProjectStatus`는 `PUBLISHED | ARCHIVED`만 허용한다.
- 위험도: 낮음
- 추천 조치: 현재 설계 문서로 쓰지 말고 과거 제안/초안으로 표시한다. 필요한 내용만 `docs/06_V0_2_BACKLOG.md` 작업 단위로 재정리한다.

근거 파일:

- `upload_admin_add.md`
- `packages/contracts/src/index.ts`
- `apps/api/src/shared/validation.ts`
- `apps/api/prisma/schema.prisma`
- `rg -n "legacy-assets|DRAFT"`

### `server/how-to-add-project-manually.md`

- 근거: 문서가 `DRAFT/PUBLISHED/ARCHIVED`를 안내하지만 현재 schema/contract는 `DRAFT`를 제거했다. 또한 현재 primary asset 저장은 S3/Garage이고, 수동 문서의 일부 NAS/영상 URL 흐름은 현재 API upload 흐름과 다를 수 있다.
- 위험도: 중간
- 추천 조치: 운영자가 실제로 쓰는 문서라면 먼저 최신 schema 기준으로 갱신한다. 삭제는 위험하다. 잘못된 운영 절차를 막기 위해 상단에 stale 경고를 추가하는 작업을 분리한다.

근거 파일:

- `server/how-to-add-project-manually.md`
- `apps/api/prisma/schema.prisma`
- `apps/api/src/modules/admin/project/service.ts`
- `apps/api/src/modules/assets/upload/upload.service.ts`

### `.github/workflows/deploy-api.yml`

- 근거: path trigger에 `docker-compose.yml`이 포함되어 있지만 현재 루트 `docker-compose.yml`은 없다. 실제 production deploy는 `server/deploy.sh`와 podman 기반이다.
- 위험도: 낮음
- 추천 조치: workflow path trigger를 실제 파일 구조에 맞춘다. 루트 compose가 다시 생길 계획이 없다면 `docker-compose.yml` path를 제거하거나 `apps/db/docker-compose.yml`로 의도를 명확히 한다.

근거 파일:

- `.github/workflows/deploy-api.yml`
- `server/deploy.sh`
- `apps/db/docker-compose.yml`
- `rg --files`

### `apps/web/src/assets/vite.svg`

- 근거: `apps/web/src`와 `apps/web/index.html` 검색에서 import/reference가 확인되지 않았다.
- 위험도: 낮음
- 추천 조치: Vite 기본 잔재로 보인다. 화면 확인 후 삭제 후보로 분리한다.

근거 파일:

- `apps/web/src/assets/vite.svg`
- `rg -n "vite\\.svg" apps/web/src apps/web/index.html`

### `apps/web/src/assets/hero.png`

- 근거: `apps/web/src`와 `apps/web/index.html` 검색에서 import/reference가 확인되지 않았다.
- 위험도: 낮음
- 추천 조치: 현재 UI에서 쓰는 asset인지 디자이너/기획 문맥 확인 후 삭제 후보로 분리한다.

근거 파일:

- `apps/web/src/assets/hero.png`
- `rg -n "hero\\.png" apps/web/src apps/web/index.html`

### `apps/web/public/pcu_game_character_*.png`, `apps/web/public/pcu_game_character_*.webp`

- 근거: `apps/web/src`, `apps/web/public`, `apps/web/index.html` 검색에서 현재 코드 참조가 확인되지 않았다.
- 위험도: 중간
- 추천 조치: public asset은 코드 import가 없어도 외부 URL로 직접 참조될 수 있으므로 바로 삭제하지 않는다. GitHub Pages 공개 URL 사용 여부를 확인한 뒤 정리한다.

근거 파일:

- `apps/web/public/pcu_game_character_male.png`
- `apps/web/public/pcu_game_character_male.webp`
- `apps/web/public/pcu_game_character_female.png`
- `apps/web/public/pcu_game_character_female.webp`
- `rg -n "pcu_game_character" apps/web/src apps/web/public apps/web/index.html`

### `apps/web/public/2022_pcu_poster.png`, `apps/web/public/2023_pcu_poster.png`, `apps/web/public/2024_pcu_poster.png`

- 근거: 현재 mock data는 poster에 `placehold.co` URL을 사용하고, source 검색에서 이 파일명 참조가 확인되지 않았다.
- 위험도: 중간
- 추천 조치: public URL로 외부 참조되는지 확인한다. 실제 전시 포스터로 다시 쓸 계획이 있으면 DB/seed/import 흐름에 연결하고, 아니면 asset archive로 분리한다.

근거 파일:

- `apps/web/public/2022_pcu_poster.png`
- `apps/web/public/2023_pcu_poster.png`
- `apps/web/public/2024_pcu_poster.png`
- `apps/web/src/lib/api/mock/data.ts`
- `rg -n "202[234]_pcu_poster" apps/web/src apps/web/public apps/web/index.html`

### `apps/web/public/icons.svg`

- 근거: source 검색에서 `/icons.svg` 참조가 확인되지 않았다.
- 위험도: 중간
- 추천 조치: favicon/icon sprite로 외부 참조될 수 있으므로 바로 삭제하지 않는다. HTML, CSS, production Pages output 사용 여부를 확인한다.

근거 파일:

- `apps/web/public/icons.svg`
- `rg -n "icons\\.svg" apps/web/src apps/web/public apps/web/index.html`

### `apps/web/public/pcu_signature_dark.svg`, `apps/web/public/pcu_signature.png`

- 근거: 현재 코드에서는 `/pcu_signature.svg`만 확인된다. dark variant와 PNG variant 참조는 확인되지 않았다.
- 위험도: 중간
- 추천 조치: theme 전환이나 외부 참조 계획이 있는지 확인한다. 필요 없다면 asset 정리 작업으로 분리한다.

근거 파일:

- `apps/web/public/pcu_signature_dark.svg`
- `apps/web/public/pcu_signature.png`
- `apps/web/src/pages/HomePage.tsx`
- `apps/web/src/components/layout/Header.tsx`
- `apps/web/src/components/layout/MobileTopBar.tsx`
- `rg -n "pcu_signature" apps/web/src apps/web/public apps/web/index.html`

### `analysis/remote-backfill-video-playback.mjs`

- 근거: `analysis/start-remote-video-backfill.sh`에서 원격 container 내부 `remote-backfill-video-playback.mjs` 실행을 시도한다. repo 안의 파일이 실제 서버 container에 어떻게 배치되는지는 현재 repo만으로 확인되지 않았다.
- 위험도: 중간
- 추천 조치: 운영에 사용 중인지 확인한다. 사용 중이면 `apps/api/scripts/backfill-video-playback.ts`와 관계를 문서화하고, 아니면 analysis archive로 표시한다.

근거 파일:

- `analysis/remote-backfill-video-playback.mjs`
- `analysis/start-remote-video-backfill.sh`
- `apps/api/scripts/backfill-video-playback.ts`

### `20-reflective-stonebraker.md`, `left-problems.md`, `analysis/*`

- 근거: 현재 runtime/build/test path에는 포함되지 않는다. `left-problems.md`는 `20-reflective-stonebraker.md` 감사 보고서의 미해결 항목을 정리한다고 설명한다.
- 위험도: 낮음
- 추천 조치: 앱 코드와 분리된 분석/감사 기록으로 유지하거나, 현행 문서와 중복되는 내용은 `docs/`로 승격한다. 삭제는 기록 보존 정책을 정한 뒤 진행한다.

근거 파일:

- `20-reflective-stonebraker.md`
- `left-problems.md`
- `analysis/*`
- `rg -n "20-reflective|left-problems"`

## 해결된 의심/위험

### 완료됨: Mock public exhibition projects route 누락

- 기존 근거: frontend `publicApi.getExhibitionProjects()`와 backend route는 존재하지만 mock handler에는 `/api/public/exhibitions/:id/projects` pattern이 없었다.
- 처리 결과: 2026-05-28 안정화 패치에서 mock handler에 route를 추가했고, 기존 mock data를 재사용해 `PublicExhibitionProjectsResponse` 형태를 반환한다.
- 위험도: 해결됨
- 남은 선택 작업: 별도 `ExhibitionProjectsPage` mock smoke test는 아직 없다.

근거 파일:

- `apps/web/src/lib/api/public.ts`
- `apps/web/src/pages/ExhibitionProjectsPage.tsx`
- `apps/api/src/modules/public/controller.ts`
- `apps/web/src/lib/api/mock/handler.ts`

### 완료됨: CORS method drift

- 기존 근거: game upload route와 frontend client는 `PUT`을 사용하지만 CORS allowed methods에는 `PUT`이 없었다.
- 처리 결과: 2026-05-28 안정화 패치에서 CORS allowed methods에 `PUT`을 추가했고, cross-origin preflight API test를 추가했다.
- 위험도: 해결됨

근거 파일:

- `apps/api/src/plugins/cors.ts`
- `apps/api/src/__tests__/cors.test.ts`
- `apps/api/src/modules/admin/game-upload/controller.ts`
- `apps/web/src/lib/api/game-upload.ts`

### 완료됨: Auth domain error status drift

- 기존 근거: backend hosted domain mismatch는 401인데 frontend는 403일 때 전용 안내를 표시했다.
- 처리 결과: 2026-05-28 Google hosted domain 오류 contract 정렬에서 invalid Google token은 401 `UNAUTHORIZED` 유지, hosted domain mismatch는 403 `EMAIL_DOMAIN_NOT_ALLOWED`로 변경했다. LoginPage는 error code/message 기반으로 학교 도메인 안내를 표시한다.
- 위험도: 해결됨
- 남은 선택 작업: error code 문자열은 아직 `packages/contracts`에 중앙화되어 있지 않다.

근거 파일:

- `apps/api/src/modules/auth/service.ts`
- `apps/api/src/shared/errors.ts`
- `apps/api/src/__tests__/auth-domain.test.ts`
- `apps/web/src/lib/api/client.ts`
- `apps/web/src/pages/LoginPage.tsx`
- `apps/web/src/__tests__/LoginPage.test.tsx`

## 중복 구현 또는 contract drift 의심

### API error code 문자열 중앙화 누락

- 근거: `EMAIL_DOMAIN_NOT_ALLOWED`는 backend/frontend/test에서 문자열로 맞춰 쓰지만, 아직 `packages/contracts`의 공용 error code 상수나 union type이 아니다.
- 위험도: 낮음
- 추천 조치: API error code를 `packages/contracts`에 중앙화하고 backend/frontend가 같은 type/constant를 import하게 한다.

근거 파일:

- `apps/api/src/modules/auth/service.ts`
- `apps/web/src/pages/LoginPage.tsx`
- `apps/web/src/lib/api/client.ts`
- `packages/contracts/src/index.ts`

## Deprecated로 보이는 파일/필드

### `GameUploadSession.stagingPath`

- 근거: Prisma schema에 `legacy, no longer used` 주석이 있다.
- 위험도: 높음
- 추천 조치: 현재 DB compatibility 때문에 바로 삭제하지 않는다. migration 작성, data 확인, service/repo 영향 확인이 끝난 뒤 별도 DB cleanup 작업으로 처리한다.

근거 파일:

- `apps/api/prisma/schema.prisma`
- `apps/api/src/modules/admin/game-upload/service.ts`

### `UPLOAD_ROOT_PROTECTED`, `UPLOAD_ROOT_PUBLIC`

- 근거: env schema와 example에 남아 있지만 주석상 legacy local storage path이고, 현재 upload path는 S3/Garage 중심이다. migration script `migrate-to-s3.ts`에서는 여전히 사용한다.
- 위험도: 높음
- 추천 조치: S3 migration script를 더 이상 사용하지 않는다는 결정 전까지 삭제하지 않는다. env 문서에서 "migration-only"로 명확히 표시한다.

근거 파일:

- `apps/api/src/config/env.ts`
- `apps/api/.env.example`
- `apps/api/scripts/migrate-to-s3.ts`
- `apps/api/src/shared/storage-path.ts`

### `AUTO_PUBLISH_DEFAULT`

- 근거: env schema/example/deploy에는 있지만 현재 `submitProject()`는 항상 `PUBLISHED`를 사용한다.
- 위험도: 중간
- 추천 조치: v0.2에서 제거할지, 실제 상태 결정 로직으로 되살릴지 선택한다. 현재 동작을 기준으로는 "설정해도 영향 없음"을 문서화해야 한다.

근거 파일:

- `apps/api/src/config/env.ts`
- `apps/api/.env.example`
- `server/deploy.sh`
- `apps/api/src/modules/admin/project/service.ts`

## 삭제하면 위험한 파일

### `packages/contracts/src/index.ts`

- 근거: API와 Web 양쪽이 type-only contract로 import한다.
- 위험도: 높음
- 추천 조치: 삭제 금지. transport shape 변경 전 반드시 먼저 수정하고 양쪽 build/test를 실행한다.

근거 파일:

- `packages/contracts/src/index.ts`
- `apps/api/package.json`
- `apps/web/package.json`
- `apps/web/src/lib/api/*.ts`
- `apps/api/src/modules/**/*.ts`

### `apps/api/prisma/migrations/*`

- 근거: production Dockerfile은 container start에서 `npx prisma migrate deploy`를 실행한다.
- 위험도: 높음
- 추천 조치: migration history 삭제 금지. 잘못된 migration 정리는 별도 DB 이력 감사 후 진행한다.

근거 파일:

- `apps/api/Dockerfile`
- `apps/api/prisma/migrations/*`

### `apps/web/public/pcu_logo.png`, `apps/web/public/pcu_signature.svg`

- 근거: favicon과 header/home/mobile top bar에서 직접 참조한다.
- 위험도: 높음
- 추천 조치: 삭제 금지. 교체 시 파일명/경로 호환을 유지하거나 모든 참조를 함께 수정한다.

근거 파일:

- `apps/web/index.html`
- `apps/web/src/pages/HomePage.tsx`
- `apps/web/src/components/layout/Header.tsx`
- `apps/web/src/components/layout/MobileTopBar.tsx`

### `server/deploy.sh`

- 근거: API deploy workflow가 이 파일을 서버에 복사하고 원격에서 실행한다.
- 위험도: 높음
- 추천 조치: 삭제 금지. production 배포 방식 교체 전까지 유지한다.

근거 파일:

- `.github/workflows/deploy-api.yml`
- `server/deploy.sh`

### `apps/api/src/shared/storage-path.ts`

- 근거: deprecated 주석이 있는 함수도 있지만, `generateStorageKey`는 현재 upload/game-upload/import/backfill script에서 사용한다.
- 위험도: 높음
- 추천 조치: 파일 단위 삭제 금지. deprecated 함수만 정리하려면 참조 검색 후 함수 단위 migration을 만든다.

근거 파일:

- `apps/api/src/shared/storage-path.ts`
- `apps/api/src/modules/assets/upload/upload.service.ts`
- `apps/api/src/modules/admin/game-upload/service.ts`
- `apps/api/scripts/*.ts`
