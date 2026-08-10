# 016 - 현재 dependency high advisory 해소

상태: `open` (2026-08-10 ticket 015 독립 재검증에서 발견)

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

## 현재 registry에서 확인한 후보

- Prisma CLI/client/adapter `7.9.1`과 `@prisma/dev@0.24.17`
- `react-router-dom@7.18.2`
- `sharp@0.35.3` (major 호환성 검증 필요)
- `fastify@5.11.3`, `find-my-way@9.7.0`, `@fastify/ajv-compiler@4.0.6`, `fast-uri@4.1.2`
- `pdf-to-img@6.2.0`도 아직 취약 범위의 `pdfjs-dist~5.6.205`를 사용한다. audit의 `pdf-to-img@5.0.0` 제안은 downgrade이며 PDF 변환 회귀 검증 없이는 적용하지 않는다.

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
