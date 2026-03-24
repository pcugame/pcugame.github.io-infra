# Known Problems

2026-03-23 시스템 검증(Adversarial Audit) 결과 발견된 문제 목록.

---

## F-01. [CRITICAL] Prisma 마이그레이션이 git에 미커밋

- **파일**: `apps/api/prisma/migrations/` (전체 디렉토리 untracked)
- **현상**: 마이그레이션 파일이 git에 커밋되지 않아 Docker 이미지에 포함되지 않음. Dockerfile CMD의 `npx prisma migrate deploy`가 no-op.
- **영향**: 신규 환경 배포 시 DB 테이블 미생성으로 모든 API 실패. 기존 NAS에서도 `sort_order` 컬럼 추가 미적용.
- **조치**:
  1. `npx prisma migrate dev --name init`으로 초기 마이그레이션 생성 (기존 DB 있으면 `prisma migrate diff` 사용)
  2. `apps/api/prisma/migrations/` 전체를 git에 커밋
  3. 운영 NAS에서 `prisma migrate deploy` 동작 확인

---

## F-02. [CRITICAL] 공개 연도 API가 isOpen 필터링 안 함

- **파일**: `apps/api/src/modules/public/public.routes.ts:14-28`
- **현상**: `GET /api/public/years`에서 `where: { isOpen: true }` 조건 없이 전체 연도 반환.
- **영향**: 관리자가 비공개 설정한 연도가 공개 페이지에 노출됨.
- **조치**: `findMany`에 `where: { isOpen: true }` 추가

---

## F-03. [HIGH] 인가 검사 불일치 — poster PATCH와 asset DELETE

- **파일**:
  - `apps/api/src/modules/admin/admin.routes.ts:497-514` (PATCH poster)
  - `apps/api/src/modules/assets/assets.routes.ts:89-96` (DELETE asset)
- **현상**: USER 역할일 때 프로젝트 `status !== 'DRAFT'` 검사 누락. 다른 편집 작업(프로젝트 PATCH, 멤버 CRUD, 에셋 추가)은 모두 DRAFT 상태만 허용.
- **영향**: USER가 PUBLISHED 프로젝트의 포스터 변경 또는 에셋 삭제 가능. 공개 전시 중 작품 손상 위험.
- **조치**: 두 엔드포인트에 `canEditProject()` 헬퍼 또는 동등한 status 검사 추가

---

## F-04. [HIGH] ESLint 실패 (Web)

- **파일**: `apps/web/src/app/router.tsx`
- **현상**: `npm run lint` → exit code 1, 11 errors (모두 `react-refresh/only-export-components`)
- **영향**: CI에서 lint gate 사용 시 배포 차단. 현재 deploy 워크플로우는 lint 미실행이라 빌드는 통과.
- **조치**: lazy import를 별도 파일로 분리하거나, 해당 파일에서 ESLint 규칙 비활성화

---

## F-05. [HIGH] docker-compose.yml에 하드코딩된 DB 비밀번호 폴백

- **파일**: `docker-compose.yml:10`
- **현상**: `POSTGRES_PASSWORD`에 64자 hex 문자열이 기본값으로 하드코딩. `.env` 없이 실행 시 이 공개된 비밀번호 사용.
- **영향**: git 히스토리에 비밀번호 영구 기록. `.env` 미설정 시 fail-open.
- **조치**: 폴백 값 제거 → `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}`

---

## F-06. [HIGH] CORS_ALLOWED_ORIGINS 빈 값 기본 → 모든 cross-origin 차단

- **파일**: `docker-compose.yml:38`, `apps/api/src/config/env.ts:21`, `apps/api/src/plugins/cors.ts:7`
- **현상**: `.env` 미설정 시 CORS origins가 빈 배열 → Fastify CORS가 모든 origin 거부.
- **영향**: 프론트엔드→API 통신 전면 차단. 에러 메시지 불명확하여 디버깅 어려움.
- **조치**: env 스키마에서 빈 배열 시 서버 시작 실패 또는 경고 로그 출력

---

## F-07. [HIGH] GOOGLE_CLIENT_IDS 빈 값 시 OAuth 동작 불명확

- **파일**: `docker-compose.yml:36`, `apps/api/src/modules/auth/auth.routes.ts:22`
- **현상**: `.env` 미설정 시 `GOOGLE_CLIENT_IDS`가 빈 배열. `oauthClient.verifyIdToken({ audience: [] })`의 동작이 라이브러리 버전에 따라 audience 검증을 skip할 수 있음.
- **영향**: 아무 Google OAuth 클라이언트에서 발급된 토큰이 수락될 가능성.
- **조치**: env 스키마에서 파싱 결과가 빈 배열이면 서버 시작 거부

---

## F-08. [MEDIUM] Zod 메이저 버전 불일치 (v3 vs v4)

- **파일**: `apps/api/package.json` → `zod@^3.24.1`, `apps/web/package.json` → `zod@^4.3.6`
- **현상**: 프론트/백엔드가 서로 다른 Zod 메이저 버전 사용. 런타임 동작에 미묘한 차이 가능.
- **영향**: 동일한 입력에 대해 프론트 검증은 통과하지만 백엔드에서 실패하거나 그 반대 가능.
- **조치**: 양쪽 Zod 버전 통일 권장

---

## F-09. [MEDIUM] deploy-web-pages.yml의 publish_branch 불일치

- **파일**: `.github/workflows/deploy-web-pages.yml:48`
- **현상**: `publish_branch: master`로 설정. CLAUDE.md에는 `main` 브랜치라고 기술.
- **영향**: pcugame.github.io 기본 브랜치가 `main`이면 배포된 dist가 서빙되지 않음.
- **조치**: pcugame.github.io 레포의 기본 브랜치명 확인 후 워크플로우 또는 CLAUDE.md 정정

---

## F-10. [MEDIUM] CSRF 가능성 — 로그아웃 엔드포인트

- **파일**: `apps/api/src/modules/auth/auth.routes.ts:75-86`
- **현상**: `POST /api/auth/logout`에 요청 본문 검증 없음. 프로덕션 `SameSite=none` 환경에서 cross-site form POST로 쿠키 전송.
- **영향**: 악의적 사이트가 사용자를 강제 로그아웃 가능 (낮은 심각도).
- **조치**: 낮은 우선순위. 필요 시 Referer/Origin 헤더 검증 또는 CSRF 토큰 도입.

---

## F-11. [LOW] 만료 세션 미정리

- **파일**: `apps/api/src/plugins/auth.ts:30-32`
- **현상**: 세션 조회 시 만료 확인 후 삭제하지만, 조회되지 않는 만료 세션은 영구 잔류.
- **영향**: `auth_sessions` 테이블 무한 증가. 장기 운영 시 DB 성능 저하.
- **조치**: cron 또는 scheduled job으로 `DELETE FROM auth_sessions WHERE expires_at < NOW()` 주기적 실행

---

## F-12. [LOW] README 문서 불일치

- **파일**: `README.md`
- **현상**:
  - `pgdata` 볼륨 언급 → 실제 compose: `pg_data`
  - NAS crontab 방식 설명 → 현재 `deploy-api.yml` CI/CD 파이프라인 존재
  - 레포명 `pcugame/pcugame.github.io-infra` → 실제 레포명과 불일치 가능
  - `deploy-web-pages.yml`만 언급 → `deploy-api.yml`도 존재
- **조치**: README를 현재 인프라 구조에 맞게 갱신
