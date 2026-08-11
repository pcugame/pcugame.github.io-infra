# 016 - 현재 dependency high advisory 해소

상태: `completed` (2026-08-11)

## 목적

ticket 015의 clean `npm ci` 이후 `npm audit --audit-level=high`가 보고한 high advisory를 실제 사용 경로와 호환성 테스트를 기준으로 해소한다. 구조 감사 결과를 dependency 상태와 섞어 종결하지 않으며, `npm audit fix --force`가 제안하는 major downgrade/upgrade를 검증 없이 적용하지 않는다.

## 재현

```bash
npm ci
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm ls prisma @prisma/dev find-my-way valibot pdf-to-img pdfjs-dist sharp react-router-dom react-router brace-expansion fast-uri js-yaml nanoid postcss --all
```

2026-08-10 결과:

- 전체 graph: 14건(High 13, Moderate 1)
- `--omit=dev`: 10건(High 9, Moderate 1)
- API runtime/upload 경로: `fast-uri@3.1.2`, `find-my-way@9.6.0`, `pdfjs-dist@5.6.205` via `pdf-to-img@6.0.0`, `sharp@0.34.5`
- Web 경로: `react-router@7.18.1` via `react-router-dom@7.18.1`
- CLI/build graph: `prisma@7.9.0`/`@prisma/dev@0.24.14`, `brace-expansion`, `js-yaml`, `nanoid`, `postcss`

관련 advisory는 `GHSA-v2hh-gcrm-f6hx`, `GHSA-7p8r-x3mc-p8w7`, `GHSA-4c8g-83qw-93j6`, `GHSA-c96f-x56v-gq3h`, `GHSA-hq66-cqwq-w95j`, `GHSA-f88m-g3jw-g9cj`, `GHSA-qwww-vcr4-c8h2` 등이다.

## 적용

- Prisma CLI/client/adapter를 정확히 `7.9.1`로 맞췄다. CLI가 가져오는 `@prisma/dev@0.24.17`, `find-my-way@9.7.0`, `valibot@1.4.2`도 안전 범위다.
- API route graph는 `fastify@5.11.3`으로 올리고 중복 Fastify 설치를 dedupe했다. URL parser는 사용 경로에 따라 `fast-uri@3.1.5`와 `4.1.2`를 사용한다.
- Web router를 `react-router-dom/react-router@7.18.2`로 올렸다.
- image processor와 Linux runtime binary를 `sharp@0.35.3`, `@img/sharp-linux-x64@0.35.3`, `@img/sharp-libvips-linux-x64@1.3.2`로 함께 맞췄다.
- `pdf-to-img@6.2.0`은 여전히 취약한 `pdfjs-dist~5.6.205`를 고정한다. 기능을 downgrade하지 않고 root override로 `pdfjs-dist@6.2.108`을 사용하며 실제 정상/embedded-JavaScript/손상 PDF raster test로 호환성과 비실행 경계를 검증했다.
- `brace-expansion@1.1.18/5.0.9`, `js-yaml@4.3.1`, `nanoid@3.3.18`, `postcss@8.5.26`으로 lockfile 전이 의존성을 갱신했다. `js-yaml`은 v4 안전 패치가 legacy tag라 root override로 버전 하한을 고정했다.
- `pdf-to-img@6.2.0`의 명시적 document lifecycle에 맞춰 첫 페이지 변환 성공/실패 뒤 `destroy()`를 호출한다.

## 완료 조건

- Prisma CLI/client/adapter의 정확한 버전을 함께 맞추고 generate/validate/migration을 재검증한다.
- 악성/정상 PDF 및 이미지 업로드가 격리된 processor에서 기대대로 성공·거부되는지 확인한다.
- Fastify route/schema/rate-limit, Web router guard와 production build를 재검증한다.
- `npm audit --audit-level=high`와 `npm audit --omit=dev --audit-level=high`가 모두 0으로 종료한다.
- 전체 unit, architecture, build, PostgreSQL/Garage integration과 환경 정리가 통과한다.

## 비범위

- audit 수치만 낮추기 위한 advisory ignore
- 검증 없는 `npm audit fix --force`
- PDF/image 처리 기능 제거 또는 외부 HTTP 계약 변경

## 완료 증거

- clean `npm ci --include-workspace-root`: 0 vulnerabilities
- `npm audit --audit-level=high`: 0 vulnerabilities
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities
- isolated media processor: 정상 PDF, embedded JavaScript action PDF, 손상 PDF, 정상/손상 image 4 tests 통과
- `npm test`: API 671, Web 86, contracts 26 통과; PostgreSQL 조건부 23개 skip
- `npm run lint`, `npm run architecture`, `npm run build` 통과
- Debian API builder clean `npm ci`, Prisma 7.9.1 generate/build/schema validate와 동일 media processor tests 통과
- `npm run test:integration`: Garage smoke/E2E와 PostgreSQL orphan 5, asset 5, year 7, import 2, game/recovery 4 통과
- `npm run testenv:clean`: container, network, volume 제거 및 compose process 0
