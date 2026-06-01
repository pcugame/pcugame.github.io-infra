# 06 V0.2 Backlog

작성일: 2026-05-28

이 backlog는 현재 repo 상태 기준으로 Codex에게 바로 맡길 수 있는 작업 단위로 쪼갰다. 각 작업은 기능 범위를 좁게 유지하고, unrelated refactor나 대규모 이동을 제외한다.

## 완료됨

### 완료 1. Chunked game upload CORS `PUT` 허용

- 완료일: 2026-05-28 안정화 패치
- 수정 파일: `apps/api/src/plugins/cors.ts`, `apps/api/src/__tests__/cors.test.ts`
- 완료 내용: CORS allowed methods에 `PUT` 추가, cross-origin `OPTIONS` preflight test 추가.
- 검증 결과: `npm test`, `npm run lint`, `npm run build` 통과.
- 제외 범위 준수: game upload service 로직은 변경하지 않았다.

### 완료 2. Web mock route coverage 보강

- 완료일: 2026-05-28 안정화 패치
- 수정 파일: `apps/web/src/lib/api/mock/handler.ts`
- 완료 내용: `/api/public/exhibitions/:id/projects` mock handler 추가, 기존 `MOCK_YEARS`/`MOCK_YEAR_PROJECTS` 기반으로 `PublicExhibitionProjectsResponse` 형태 반환.
- 검증 결과: `npm test`, `npm run lint`, `npm run build` 통과.
- 제외 범위 준수: mock data 대량 추가, production API 변경, UI redesign은 하지 않았다.

### 완료 3. `/admin` index route 처리

- 완료일: 2026-05-28 안정화 패치
- 수정 파일: `apps/web/src/app/router.tsx`
- 완료 내용: `/admin` index child route 추가, `/admin` 직접 접근 시 `/admin/projects`로 redirect.
- 검증 결과: `npm test`, `npm run lint`, `npm run build` 통과.
- 제외 범위 준수: sidebar redesign, 권한 체계 변경, admin page 추가는 하지 않았다.

### 완료 4. Google hosted domain 오류 contract 정렬

- 완료일: 2026-05-28 Google hosted domain 오류 contract 정렬
- 수정 파일: `apps/api/src/modules/auth/service.ts`, `apps/api/src/shared/errors.ts`, `apps/api/src/__tests__/auth-domain.test.ts`, `apps/web/src/lib/api/client.ts`, `apps/web/src/lib/api/index.ts`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/__tests__/LoginPage.test.tsx`
- 완료 내용: invalid Google token은 401 `UNAUTHORIZED` 유지, hosted domain mismatch는 403 `EMAIL_DOMAIN_NOT_ALLOWED`로 변경, LoginPage는 error code/message 기반으로 학교 도메인 안내 표시.
- 검증 결과: `npm test`, `npm run lint`, `npm run build` 통과.
- 제외 범위 준수: OAuth provider, Google client 설정, role 부여 정책, DB schema, session/cookie 구조는 변경하지 않았다.
- 남은 위험: API error code 문자열은 아직 `packages/contracts`에 중앙화되어 있지 않다.

## 다음 우선순위

### 1. API error code 문자열 중앙화

- 목적: backend/frontend/test가 같은 API error code 이름을 쓰도록 `packages/contracts`에 공용 type/constant를 둔다.
- 수정 예상 파일: `packages/contracts/src/index.ts`, `apps/api/src/modules/auth/service.ts`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/lib/api/client.ts`, 관련 tests/docs
- 구현 범위: 현재 쓰는 `EMAIL_DOMAIN_NOT_ALLOWED` 등 error code를 공용 union/constant로 정의하고 import 경로 정리
- 제외 범위: runtime envelope 변경, OAuth/provider 정책 변경, DB schema 변경
- 검증 방법: `npm test`, `npm run lint`, `npm run build`
- rollback 기준: contracts 변경으로 API/Web compile이 깨지거나 runtime error envelope가 달라짐
- 완료 조건: error code 문자열 중복이 제거되고 backend/frontend/test가 공용 contract를 참조함

### 2. Production server `.env.example` 추가

- 목적: `server/deploy.sh`가 요구하는 production env를 신규 참여자/운영자가 누락 없이 준비하게 한다.
- 수정 예상 파일: `server/.env.example` 또는 `docs/03_DEPLOYMENT_AND_ENV.md`, `README.md`
- 구현 범위: `server/deploy.sh`에서 실제로 읽는 변수 목록과 예시 placeholder 작성, secret은 placeholder만 사용
- 제외 범위: 실제 secret 작성, deploy script 동작 변경, 서버 접속
- 검증 방법: `rg -n "^[A-Z0-9_]+=" server/.env.example`, `npm test`는 문서성 변경이면 선택
- rollback 기준: 실제 secret이 포함됨, deploy script와 다른 변수명을 문서화함
- 완료 조건: production deploy에 필요한 `POSTGRES_*`, `DATABASE_URL`, `SESSION_SECRET`, `GOOGLE_CLIENT_IDS`, `CORS_ALLOWED_ORIGINS`, `S3_*`, `STORAGE_HOST_PATH`, `NAS_EXPORT_*`가 example에 포함됨

### 3. API deploy workflow path 정리

- 목적: `.github/workflows/deploy-api.yml`의 stale path trigger를 실제 파일 구조와 맞춘다.
- 수정 예상 파일: `.github/workflows/deploy-api.yml`
- 구현 범위: 존재하지 않는 root `docker-compose.yml` path 제거 또는 `apps/db/docker-compose.yml`로 의도 명확화
- 제외 범위: deploy job 구조 변경, image tag 정책 변경, server deploy 방식 변경
- 검증 방법: YAML syntax 확인, 변경 후 PR에서 workflow trigger 확인
- rollback 기준: API 관련 변경이 deploy workflow를 트리거하지 않음
- 완료 조건: workflow path 목록에 존재하지 않는 파일이 남지 않고 API/deploy 관련 변경에 대한 trigger 의도가 명확함

### 4. `AUTO_PUBLISH_DEFAULT` 처리 결정

- 목적: 설정은 남아 있지만 실제 등록 상태에는 영향이 없는 drift를 해소한다.
- 수정 예상 파일: `apps/api/src/config/env.ts`, `apps/api/.env.example`, `server/deploy.sh`, `apps/api/src/modules/admin/project/service.ts`, tests, docs
- 구현 범위: 둘 중 하나 선택
  - 설정 제거: env schema/example/deploy에서 제거하고 현재 항상 `PUBLISHED` 동작을 명시
  - 설정 구현: `submitProject()`가 env 값을 사용하도록 하고 contract/test 갱신
- 제외 범위: DRAFT 상태 재도입, moderation workflow 구현
- 검증 방법: `npm test --workspace=apps/api`, `npm run lint --workspace=apps/api`, `npm run build --workspace=apps/api`
- rollback 기준: env validation이 production에서 깨짐, submit response status가 contract와 불일치
- 완료 조건: env와 실제 submit behavior가 일치하고 test로 고정됨

### 5. Stale 운영/기획 문서 분류

- 목적: `DRAFT`, legacy asset route, old NAS URL 등 현재 contract와 다른 문서가 신규 작업자를 오도하지 않게 한다.
- 수정 예상 파일: `upload_admin_add.md`, `server/how-to-add-project-manually.md`, `20-reflective-stonebraker.md`, `left-problems.md`, `analysis/*`, 필요 시 `docs/04_OBSOLETE_OR_SUSPICIOUS_FILES.md`
- 구현 범위: stale 경고 추가, 현재 대체 문서 링크 추가, 삭제 후보/보존 후보 분류
- 제외 범위: 실제 파일 삭제, 운영 절차 대규모 재작성
- 검증 방법: `rg -n "DRAFT|legacy-assets"`, 문서 링크 확인
- rollback 기준: 중요한 운영 절차가 근거 없이 제거됨
- 완료 조건: 현재 contract와 다른 문서가 명확히 stale 또는 archive로 표시됨

### 6. Public asset 사용 여부 감사

- 목적: public에 남은 미참조 asset을 삭제하기 전에 외부 URL 사용 가능성까지 확인한다.
- 수정 예상 파일: `docs/04_OBSOLETE_OR_SUSPICIOUS_FILES.md`, 필요 시 asset inventory 문서
- 구현 범위: `apps/web/public/*`, `apps/web/src/assets/*`, `assets/*`의 참조 여부 표 작성
- 제외 범위: 실제 asset 삭제, 이미지 최적화, 디자인 변경
- 검증 방법: `rg -n "<filename>" apps/web/src apps/web/index.html docs README.md`, GitHub Pages 공개 URL 확인은 별도 수동 항목으로 표시
- rollback 기준: 외부에서 쓰는 public URL을 삭제 후보로 단정
- 완료 조건: 삭제 가능/보류/필수 asset이 근거와 함께 분류됨

### 7. API contract 문서와 공유 type gap 정리

- 목적: 현재 API route 중 공유 contract type이 느슨하거나 inline으로만 쓰이는 response를 정리해 다음 변경의 회귀 위험을 줄인다.
- 수정 예상 파일: `packages/contracts/src/index.ts`, `apps/api/src/modules/**/*.ts`, `apps/web/src/lib/api/*.ts`, `apps/api/src/__tests__/*`, `apps/web/src/__tests__/*`
- 구현 범위: 이미 존재하는 route의 request/response type 이름 보강, API/Web generic type 일치, docs update
- 제외 범위: route 추가, DB schema 변경, runtime validation framework 통합
- 검증 방법: `npm test`, `npm run lint`, `npm run build`
- rollback 기준: contracts 변경으로 API/Web 중 하나가 깨지거나 runtime shape와 type이 달라짐
- 완료 조건: 주요 admin list/create/update/delete response가 named contract로 정리되고 양쪽 compile 통과

### 8. Browser upload smoke test 추가

- 목적: multipart upload와 chunked upload가 브라우저 API 관점에서 깨지지 않게 최소 회귀 검증을 만든다.
- 수정 예상 파일: `apps/web/src/__tests__/*`, `apps/api/src/__tests__/*`, 필요 시 test helper
- 구현 범위: FormData field 이름, XHR/fetch method/header, CORS preflight 관련 단위 테스트
- 제외 범위: 실제 S3/Garage integration, Playwright E2E, 대용량 파일 업로드
- 검증 방법: `npm test --workspace=apps/web`, `npm test --workspace=apps/api`
- rollback 기준: test가 implementation detail에 과하게 묶여 정상 refactor를 막음
- 완료 조건: `poster`, `images[]`, `gameFile`, `videoFile`, `file`, chunk `PUT` 경로가 테스트로 고정됨

### 9. Production deploy smoke checklist 자동화

- 목적: 배포 후 API/DB/reverse proxy/NAS export readiness를 한 번에 확인할 수 있게 한다.
- 수정 예상 파일: `server/deploy.sh`, 신규 `server/smoke.sh` 또는 `docs/03_DEPLOYMENT_AND_ENV.md`
- 구현 범위: read-only health check, container status, loopback/public health command 정리
- 제외 범위: 실제 deploy 실행, DB migration 변경, nginx config 변경
- 검증 방법: shellcheck 가능하면 실행, 문서 command review
- rollback 기준: destructive command 포함, secret 출력 가능성 발생
- 완료 조건: 운영자가 배포 직후 실행할 read-only checklist가 생김
