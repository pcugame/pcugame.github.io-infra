# Architecture Decision Records

아래 ADR은 현재 코드와 저장소 정책에 반영된 기존 결정을 소급 기록한다.
작성 시점의 신규 승인이나 production 검증 완료를 의미하지 않는다.

| ADR | 결정 | 상태 |
|---|---|---|
| [0001](./0001-explicit-composition-and-resource-ownership.md) | 명시적 composition root와 자원 소유권 | 기존 결정 기록 |
| [0002](./0002-durable-cleanup-outbox.md) | Durable cleanup과 outbox | 기존 결정 기록 |
| [0003](./0003-forward-only-database-migrations.md) | 후속 migration과 forward recovery | 기존 결정 기록 |
| [0004](./0004-dedicated-workers.md) | Byte 처리·export·publication 전용 worker | 기존 결정 기록 |
| [0005](./0005-object-access-boundary.md) | Object 저장 위치와 접근 권한의 분리 | 기존 결정 기록 |

현재 구성은 [Backend architecture](../architecture/README.md),
감사 수행 과정과 당시 증거는 [감사 이력](../history/2026-backend-audit/README.md)에 명시한다.
[Route contract 소유권 후속안](../architecture/route-contract-ownership.md)은 **PROPOSED** 상태이며 기존 결정 목록에 포함하지 않는다.
