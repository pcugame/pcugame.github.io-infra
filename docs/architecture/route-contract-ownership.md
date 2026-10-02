# Route contract 소유권 후속 제안

상태: 제안. Feature별 runtime contract 분산은 현재 구현으로 간주하지 않는다.

## 현재 경계

[중앙 registry](../../apps/api/src/shared/http-route-schemas.ts)는 route의 input·response schema와 body·response 경계를 정의하고, Fastify route 등록 시 계약 누락을 거부한다. [HTTP contract test](../../apps/api/src/__tests__/http-route-runtime-contracts.test.ts)는 runtime schema 적용과 계약 검증을 담당한다. 현재 구조의 기준은 [backend architecture](README.md)이다.

## 제안과 보존 조건

Storage lifecycle 변경과 계약 소유권 이동은 별도 변경으로 검토한다. 후속 변경에서는 각 feature controller 옆에 runtime contract를 배치하고 typed registration fragment를 export하며, HTTP composition root에서 fragment를 결합하는 방안을 검토한다.

중앙 registry를 제거하기 전에 다음 조건을 보존해야 한다.

- 중복 route 계약과 누락 계약의 검출
- 실제 등록 route의 input·response runtime schema 적용
- JSON·multipart·stream·redirect 경계별 검증 책임
- 실제 인증 HTTP 요청과 response serialization을 포함한 회귀 검증

Route 개수는 구현 inventory에서 확인하며 설계 조건으로 고정하지 않는다. 이 문서는 기존 후속 ticket의 제안을 분리한 기록으로, 코드 변경이나 새로운 구현 완료 판정을 포함하지 않는다.
