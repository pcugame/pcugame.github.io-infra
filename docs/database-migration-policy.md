# Database migration policy

이 문서는 `apps/api/prisma/migrations/`에 추가하거나 변경하는 PostgreSQL migration의 저장소 공통 기준이다. 코딩 에이전트, 유지보수자와 PR reviewer는 기능별 runbook보다 이 정책을 우선하여 적용하고, 기능별 문서에는 해당 배포의 구체적인 순서만 추가한다.

규칙 강도는 다음과 같다.

- **MUST**: 예외 없이 충족하거나, 작업을 중단하고 별도의 복구·설계 결정을 받아야 한다.
- **SHOULD**: 따르지 않는 이유와 동등한 안전 근거를 PR에 명시한다.
- **MAY**: 변경 위험과 배포 조건에 따라 선택한다.

## Migration history

- 보존해야 하는 production, staging 또는 공유 DB에 이미 적용된 migration은 **MUST NOT** 수정한다. 수정이 필요하면 후속 migration을 추가한다.
- origin에 push되었다는 사실만으로 migration을 적용된 것으로 단정하지 않는다. 적용 여부와 보존해야 하는 DB의 migration history를 기준으로 판단한다.
- 적용 여부를 확인할 수 없는 published migration은 **MUST** 적용되었을 가능성이 있는 것으로 판단한다. 안전하게 확인할 수 있을 때만 예외로 한다.
- schema 변경은 `apps/api/prisma/schema.prisma`와 `apps/api/prisma/migrations/`에 함께 반영해야 한다. 최상위 `prisma/migrations/`는 이전 기록이며 신규 migration 위치가 아니다.
- migration 성공을 만들기 위하여 다음 행위를 **MUST NOT** 수행한다.
  - 적용된 migration 또는 기존 migration directory 재작성
  - checksum/history mismatch 무시
  - production DB reset
  - 실패한 migration을 성공한 것으로 표시
- 복구가 필요하면 Prisma의 migration table과 PostgreSQL의 실제 schema·data 상태를 먼저 조사하고, 복구 절차와 근거를 기록한다.

## Risk and rollout

다음 변경은 high-risk migration으로 분류한다.

- `DROP TABLE`, `DROP COLUMN`, `DROP TYPE`
- 기존 data에 영향을 미치는 `CHECK`, `UNIQUE`, `FOREIGN KEY` 등의 constraint 강화
- durable external resource reference 제거
- identity 또는 key semantics 변경
- 기존 row의 의미를 변경하는 destructive rewrite

High-risk migration은 구현 전에 다음 항목을 **MUST** 검토한다.

- 실행 precondition과 legacy conflict 처리 정책
- 중간 실패 후 DB 상태와 partial application 허용 여부
- rollback 또는 forward recovery 가능성
- 기존 data reconciliation과 application compatibility
- 단계적 배포와 old/new writer 공존 가능 여부

필요하면 다음 순서로 rollout을 단계화한다.

1. additive schema
2. old/new application compatibility
3. data backfill 또는 reconciliation
4. invariant verification
5. destructive cleanup

각 단계를 별도 migration으로 분리할지는 lock 시간, 복구 가능성, application 호환성과 배포 순서를 기준으로 결정한다. 단계적 배포가 필요하면 기능별 runbook 또는 release gate에 구체적인 순서를 기록해야 한다.

## Atomicity and failure paths

- migration 작성자는 partial application의 허용 여부를 **MUST** 의식적으로 결정한다.
- 중간 실패 후 partial schema나 data state가 허용되지 않으면 migration은 **MUST** 그 상태를 방지하도록 구성하고 실제 PostgreSQL에서 검증한다.
- PostgreSQL transactional DDL을 사용할 수 있으면 명시적 transaction이 필요한지 **SHOULD** 검토한다. Prisma가 migration 전체를 요구되는 atomicity 수준으로 자동 처리한다고 가정해서는 안 된다.
- transaction 안에서 수행할 수 없는 operation이 있으면 단계를 분리하고, 실패 시 상태·재실행·복구 절차와 분리 이유를 명시한다.
- 모든 migration을 transaction으로 감싸는 것은 요구하지 않는다. partial application이 안전하고 재실행·복구 상태가 명확하면 transaction을 사용하지 않을 수 있다.
- fail-stop precondition을 포함한 migration은 **MUST** 실제 PostgreSQL에서 다음을 검증한다.
  1. precondition 위반 상태 구성
  2. migration 실행과 예상 실패 확인
  3. 실패 전에 실행된 DDL/DML의 rollback 필요 시 실제 미잔존 확인
  4. 보존해야 하는 row와 reference의 잔존 확인
- SQL 문자열 검사는 migration 구조의 regression을 탐지하는 보조 수단으로 **MAY** 사용한다. 실제 PostgreSQL migration semantics 검증을 대체해서는 안 된다.

> Migration에 fail-stop precondition을 포함하면 그 실패가 의도한 DB 상태를 보존하는지도 검증한다.

## Durable external resource references

S3/Garage object key, filesystem path, upload intent, deletion/outbox target, external resource generation identity를 보존하는 row나 column은 일반 schema field로 취급해서는 안 된다.

이러한 table 또는 column을 제거하기 전에 다음 중 하나를 **MUST** 증명한다.

- reference row가 존재하지 않는다.
- reference가 새 모델로 안전하게 이전되었다.
- 기존 reconciliation 또는 deletion mechanism이 resource를 안전하게 처리하였다.

application code가 더 이상 조회하지 않는다는 이유만으로 durable reference를 제거해서는 안 된다. database reference가 사라진 뒤에도 외부 resource가 남을 수 있으면 inventory, ownership과 cleanup 책임을 먼저 확정한다.

## Schema migration and data migration

- 대규모 backfill 또는 rewrite를 deploy-time schema migration에 무리하게 포함해서는 안 된다.
- object storage, filesystem, network 등의 외부 system I/O를 Prisma migration SQL에 포함해서는 안 된다. 필요한 작업은 application-level backfill 또는 reconciliation command로 분리한다.
- schema와 data migration의 분리 여부는 data 규모, lock 시간, rollback 가능성, application 호환성, 외부 resource 존재 여부와 배포 순서를 기준으로 결정한다.
- schema migration과 별도 command의 선후 관계, 재시작 가능성, 완료 invariant는 **SHOULD** runbook 또는 command help에 기록한다.

## Constraint rollout

신규 또는 강화된 `CHECK`, `UNIQUE`, `FOREIGN KEY`가 legacy row와 충돌할 가능성이 있으면 처리 정책을 구현 전에 **MUST** 선택한다. 가능한 전략은 다음과 같다.

- 위반 row가 있으면 deployment를 fail-stop한다.
- 신규 write부터 제약하고 legacy row는 단계적으로 정리한다.
- reconciliation 완료 후 constraint를 validate한다.

`NOT VALID` 등의 staged mechanism은 필요에 따라 **MAY** 사용하며 기본값으로 강제하지 않는다. 위반 data를 조용히 삭제하거나 무시하여 migration을 통과시켜서는 안 된다.

## Safety invariants

schema 단순화나 migration 편의를 이유로 다음 invariant를 약화해서는 안 된다.

- durable deletion과 reference inventory
- concurrency safety와 ownership invariant
- public/private authorization
- immutable object semantics
- 기존 database integrity constraint

기존 safety mechanism을 제거하려면 대체 mechanism과 동등한 실패 경로 증거를 먼저 제시해야 한다.

## Verification and review

Migration PR은 위험도에 비례하여 다음 증거를 **MUST** 제공한다.

- migration 적용 전후의 기대 schema와 application compatibility
- high-risk 변경의 precondition, reconciliation 및 recovery 판단
- fail-stop 조건이 있으면 실제 PostgreSQL failure-path 결과
- durable reference 제거가 있으면 inventory 이전 또는 cleanup 증거
- schema/data migration을 분리하였다면 배포 순서와 완료 invariant

Reviewer는 다음 항목을 확인한다.

- 적용 가능성이 있는 기존 migration을 수정하지 않았는가?
- partial application 판단과 검증이 명시되었는가?
- destructive 변경이 additive·compatibility·reconciliation 단계를 건너뛰지 않았는가?
- legacy constraint conflict 정책이 의도적으로 선택되었는가?
- durable reference와 기존 safety invariant가 보존되는가?
- 문자열 검사만으로 rollback 또는 PostgreSQL semantics를 주장하지 않는가?

CI와 architecture guard는 위험 신호를 알리는 보조 장치이다. destructive SQL 탐지나 migration history 비교 같은 heuristic은 reviewer의 검토를 돕기 위하여 **MAY** 추가하지만, 모든 `DROP`을 금지하거나 모든 migration에 transaction을 강제하거나 semantic correctness의 증거로 취급해서는 안 된다.
