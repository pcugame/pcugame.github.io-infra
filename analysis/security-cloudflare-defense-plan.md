# PCU Graduation Project 보안 방어 정리

## Summary

- 현재 프로젝트는 Fastify API + React SPA + PostgreSQL + S3 호환 스토리지 구조입니다.
- 이미 적용된 방어: Helmet 보안 헤더, CORS allowlist, CSRF Origin 검사, HttpOnly 세션 쿠키, Google ID token 검증, 전역/로그인/업로드 rate limit, 파일 magic-byte 검증, 업로드 동시성 제한, API loopback 바인딩/host firewall 문서화.
- Cloudflare로 “쉽게” 좋아지는 영역은 트래픽성 공격, 봇/스크래핑, 원본 서버 은닉, 단순 WAF 차단입니다.
- Cloudflare만으로 해결 안 되는 영역은 계정 탈취, 권한/업무 로직 악용, 악성 업로드 처리, DB/S3/CI 비밀 유출, 백업/복구입니다.

## Cloudflare로 간단히 방어 가능한 것

- DDoS/HTTP flood: API/Web 도메인을 Cloudflare proxied DNS로 두고 HTTP DDoS managed rules + WAF + rate limiting을 적용합니다. Cloudflare 문서상 proxied DNS는 DDoS 보호와 WAF/CDN 적용 대상입니다.
- 로그인/자동화 공격: `/api/auth/google`에 Cloudflare Rate Limiting과 Managed Challenge를 추가합니다. 앱에도 로그인 rate limit이 이미 있습니다: `apps/api/src/plugins/rate-limit.ts`, `apps/api/src/modules/auth/controller.ts`.
- 업로드 남용: `/api/admin/projects/submit`, `/api/admin/projects/:id/assets`, `/api/admin/game-upload-sessions/*`에 Cloudflare rate limit/Challenge를 겁니다. 단, Cloudflare Free/Pro는 요청 업로드 100MB 제한이 있어 5GB 게임 업로드는 현재처럼 10MB chunk 방식 위주로 유지해야 합니다.
- 원본 서버 직접 공격: Cloudflare Tunnel 또는 Authenticated Origin Pulls + 방화벽으로 Cloudflare를 거치지 않는 요청을 차단합니다. 현재 운영 문서도 API `:4000` 외부 직접 접근 차단을 전제로 합니다: `server/SECURITY-HARDENING.md`.
- 정적 파일/공개 이미지 부하: Cloudflare Cache Rules로 공개 정적 자산을 캐싱합니다. 현재 API는 S3 presigned URL로 302 redirect하므로, 캐시 효과를 내려면 공개 S3/asset hostname도 Cloudflare 뒤에 두거나 API가 cacheable response를 직접 내도록 조정해야 합니다.
- 흔한 SQLi/XSS 스캔: Cloudflare Managed Rules/OWASP Core Ruleset으로 commodity exploit probe를 줄입니다. 앱도 Zod validation과 Prisma를 사용하지만, WAF는 보조 방어로만 봐야 합니다.

## Cloudflare만으로 방어 불가능하거나 어려운 것

- Google 계정 탈취/피싱: Cloudflare가 정상 Google ID token을 악성 사용자인지 판단할 수 없습니다. `ALLOWED_GOOGLE_HD`를 운영에서 반드시 설정하고, Google Workspace 2FA/계정 복구 정책/세션 무효화 기능이 필요합니다.
- 권한 있는 사용자의 악용: 학생/운영자/관리자가 정상 로그인 후 프로젝트를 잘못 게시·삭제·수정하는 문제는 WAF가 못 막습니다. 감사 로그, 승인 플로우, 관리자 작업 이력, 복구 기능이 필요합니다.
- 악성 업로드/ZIP bomb/이미지·PDF 처리 취약점: magic-byte와 크기 제한은 있지만, `sharp`, PDF 변환, ZIP 내부 구조까지 안전하다는 뜻은 아닙니다. AV 스캔, ZIP 압축 해제 전 구조 검사, 변환 작업 sandbox, CPU/memory 제한이 필요합니다.
- DB/S3/CI secret 유출: Cloudflare는 서버 내부 비밀 유출을 막지 못합니다. S3 최소 권한 키, GitHub Actions 환경 보호, secret rotation, 백업 암호화가 필요합니다.
- 원본 IP가 노출된 상태의 직접 접속: Cloudflare를 붙여도 공격자가 원본 IP와 포트를 직접 치면 우회됩니다. Tunnel/AOP/firewall 없이 “DNS만 Cloudflare”는 불완전합니다.
- 정상 사용자 다수의 저속 자원 고갈: IP별 threshold 아래로 분산된 업로드/조회는 edge rate limit만으로 어렵습니다. 계정별 quota, 작업 큐, DB connection pool 제한, observability가 필요합니다.

## Recommended Changes

- 1순위: Cloudflare proxied DNS 또는 Tunnel로 Web/API를 붙이고, origin은 Cloudflare/Tunnel/nginx만 접근 가능하게 잠급니다.
- 2순위: `TRUST_PROXY` 운영 설정을 명확히 합니다. 현재 Fastify는 `TRUST_PROXY`를 지원하지만 `deploy.sh`에는 전달 항목이 보이지 않습니다. nginx/Cloudflare 뒤에서 실제 client IP를 신뢰하려면 origin 직접 접근 차단 후 안전하게 설정해야 rate limit이 의미가 있습니다.
- 3순위: Cloudflare rules를 경로별로 나눕니다: login은 낮은 threshold, upload session 생성/완료는 Challenge, chunk upload는 rate limit만, public GET은 캐시 또는 완화 규칙.
- 4순위: Turnstile은 로그인보다 “프로젝트 제출/업로드 세션 생성”에 먼저 붙입니다. 서버 검증은 필수입니다.
- 5순위: Cloudflare 밖 영역으로 백업, 감사 로그, 악성 파일 스캔, dependency/SCA, secret rotation을 별도 과제로 둡니다.

## Test Plan

- Cloudflare 우회 테스트: 원본 IP `:4000` 직접 접근이 실패하고, 도메인 경유만 성공해야 합니다.
- Rate limit 테스트: `/api/auth/google`, 업로드 생성, 보호 asset 다운로드에서 429/Challenge가 예상대로 나오는지 확인합니다.
- 업로드 테스트: 10MB chunk 업로드는 통과, Cloudflare plan별 단일 대용량 POST는 차단/우회 정책대로 동작해야 합니다.
- 캐시 테스트: 공개 정적 자산만 `CF-Cache-Status: HIT`가 나오고, 세션/관리자/API mutation 응답은 캐시되지 않아야 합니다.
- 회귀 테스트: 기존 `apps/api` 보안 테스트와 `apps/web` lint/test를 실행합니다.

## Assumptions & Sources

- Cloudflare Free/Pro 또는 Business 수준을 기본 가정하고, Enterprise 전용 고급 기능은 필수로 두지 않습니다.
- 참고: Cloudflare Rate Limiting, DDoS managed rules, WAF managed rules, Cache behavior/upload limits, Tunnel, Authenticated Origin Pulls, Turnstile server-side validation 공식 문서.
- Sources:
  - https://developers.cloudflare.com/waf/rate-limiting-rules/
  - https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/
  - https://developers.cloudflare.com/waf/managed-rules/
  - https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
  - https://developers.cloudflare.com/tunnel/
  - https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/
  - https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
