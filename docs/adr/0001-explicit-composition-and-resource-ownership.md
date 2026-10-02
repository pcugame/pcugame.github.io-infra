# ADR 0001 — 명시적 composition root와 자원 소유권

상태: **기존 결정 기록** — 현재 구현의 소급 기록이며 신규 승인 기록이 아니다.

## 배경

HTTP app, DB·S3 adapter와 background maintenance는 서로 다른 수명을 가진다.
Import 시 자원 생성·작업 실행이 발생하면 테스트 대체와 startup 실패의 정리가 어려워진다.
외부 주입 자원의 종료 책임도 명확히 구분할 필요가 있다.

## 결정

`createProductionBackendContext(config)`를 production graph의 composition root로 사용한다.
구성과 실행을 분리하고 `start()`에서 소유 자원의 startup을 수행한다.
Factory 생성 자원은 context가 소유하며 주입 자원은 `owned` 또는 `borrowed`를 명시한다.
`close()`는 소유 자원을 역순으로 종료하고 반복 호출을 동일한 promise로 통합한다.
Borrowed 자원은 context가 시작하거나 종료하지 않는다.

`buildApp({ context })`는 HTTP 구성을 담당한다.
Server runtime은 signal·listen·drain을 담당하고 자원 종료는 context로 통합한다.
Helper 분리는 infrastructure, persistence, routes, maintenance와 resource owner의 책임에 따른다.

## 대안과 절충

- Module singleton은 호출부를 단순화하지만 import side effect와 공유 수명의 결합이 증가한다.
- Controller별 자원 생성은 독립성을 제공하지만 중복 client와 종료 경로를 관리해야 한다.
- 명시적 context는 wiring 코드와 주입 인터페이스가 필요하지만 자원 소유권과 실패 정리를 검증할 수 있다.

## 결과

구성 실패·startup 실패·HTTP 종료가 context 종료 경로로 수렴한다.
자원 추가 시 등록 순서와 역순 종료의 의존 관계를 검토한다.
Context 분리는 모든 service에 동일한 port 구조가 적용되었다는 의미가 아니다.

## 근거와 검증 위치

- [Backend context](../../apps/api/src/backend-context.ts), [helper 구성](../../apps/api/src/backend-context/)
- [Resource owner](../../apps/api/src/backend-context/resource-owner.ts)
- [HTTP app](../../apps/api/src/app.ts), [server runtime](../../apps/api/src/server.ts)
- [Composition·ownership tests](../../apps/api/src/__tests__/backend-context.test.ts)
- [Startup·shutdown tests](../../apps/api/src/__tests__/server-runtime.test.ts)
