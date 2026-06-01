# Handoff Summary

작성일: 2026-05-28

## 이번 구조 정리에서 바뀐 핵심

- 현재 repo 상태를 기준으로 `docs/00_CURRENT_STATE.md`부터 `docs/06_V0_2_BACKLOG.md`까지 문서화했다.
- 실제 backend routes, frontend API client, Prisma schema, env, deploy workflow, validation 결과를 근거 파일과 함께 정리했다.
- 기능 구현, 삭제, 대규모 이동은 하지 않았다.
- 2026-05-28 안정화 패치로 CORS `PUT`, mock exhibition projects route, `/admin` index redirect가 완료됐다.
- 2026-05-28 Google hosted domain 오류 contract 정렬로 backend/frontend/test 기준이 일치했다.

## 완료된 안정화 항목

- Chunked game upload cross-origin preflight: CORS allowed methods에 `PUT` 추가 및 API preflight test 추가 완료.
- Web mock route coverage: `/api/public/exhibitions/:id/projects` handler 추가 완료.
- `/admin` 직접 접근: index child route에서 `/admin/projects`로 redirect 처리 완료.
- Google hosted domain 오류 contract: invalid token은 401 유지, hosted domain mismatch는 403 `EMAIL_DOMAIN_NOT_ALLOWED`로 정렬하고 LoginPage 전용 안내 조건 및 테스트 추가 완료.

## 아직 위험한 부분

- API error code 문자열이 아직 `packages/contracts`에 중앙화되어 있지 않다.
- production deploy용 server-level `.env.example`이 없다.
- root `docker-compose.yml` 언급이 남아 있지만 실제 파일은 없다.

## ChatGPT Project에 업로드하면 좋은 문서 목록

- `README.md`
- `docs/00_CURRENT_STATE.md`
- `docs/01_ARCHITECTURE.md`
- `docs/02_API_AND_DATA_CONTRACT.md`
- `docs/03_DEPLOYMENT_AND_ENV.md`
- `docs/04_OBSOLETE_OR_SUSPICIOUS_FILES.md`
- `docs/05_VALIDATION_REPORT.md`
- `docs/06_V0_2_BACKLOG.md`
- `packages/contracts/src/index.ts`
- `apps/api/prisma/schema.prisma`
- `apps/api/src/app.ts`
- `apps/web/src/app/router.tsx`
- `apps/web/src/lib/api/*.ts`

## 다음에 Codex에게 맡길 1순위 작업 3개

1. API error code 문자열을 `packages/contracts`에 중앙화
2. Production server `.env.example` 추가
3. API deploy workflow path 정리
