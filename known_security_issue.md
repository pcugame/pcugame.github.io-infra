# Manual Verification Needed

| # | 항목 | 확인 방법 |
|---|------|-----------|
| M-01 | 운영 `.env`에서 `POSTGRES_PASSWORD`가 docker-compose.yml 기본값과 다른지 | NAS에서 `.env` 파일 직접 확인 |
| M-02 | 운영 `SESSION_SECRET`이 충분한 엔트로피를 가진 값인지 | NAS `.env` 확인 (`openssl rand -hex 32` 출력값 여부) |
| M-03 | `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=none` 이 운영에 설정되어 있는지 | NAS `.env` 확인 |
| M-04 | `ALLOWED_GOOGLE_HD`가 의도적으로 빈 값인지 (모든 Google 계정 허용 의도 여부) | 관리자에게 확인 |
| M-05 | PostgreSQL 포트(5432)가 NAS 외부에서 접근 불가능한지 | `docker-compose.yml`에 ports 미노출이지만, NAS 방화벽/네트워크 확인 필요 |
| M-06 | GHCR 토큰의 권한 범위가 `read:packages`로 최소화되어 있는지 | GitHub Settings → Personal Access Tokens 확인 |
| M-07 | NAS SSH 키가 해당 배포 작업에만 제한된 키인지 | NAS authorized_keys 및 GitHub Secrets 확인 |
| M-08 | F-03 (USER 자가 게시) 가 의도된 동작인지 | 프로젝트 요구사항 확인 |
