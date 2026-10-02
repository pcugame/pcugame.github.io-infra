# ADR 0003 — 후속 migration과 forward recovery

상태: **기존 결정 기록** — 저장소 정책과 release 구현의 소급 기록이며 신규 승인 기록이 아니다.

## 배경

공유 DB의 적용된 migration 수정은 실제 schema·data와 migration history의 불일치를 유발한다.
Schema 변경 이후 이전 binary 실행은 compatibility 조건을 충족하지 못할 수 있다.
외부 object reference 제거에는 DB 외부 자원의 inventory와 cleanup 증거가 필요하다.

## 결정

적용된 migration은 수정하지 않고 후속 migration으로 변경한다.
적용 여부가 불명확한 published migration도 적용 가능성을 고려한다.
High-risk 변경은 precondition, partial application, compatibility와 recovery를 검토한다.
필요한 경우 additive schema, 호환 application, reconciliation, invariant 검증과 destructive cleanup을 단계화한다.

Schema SQL과 storage·filesystem·network I/O는 분리한다.
Migration의 atomicity는 개별 operation과 실패 상태를 기준으로 결정한다.
모든 migration에 transaction을 일괄 강제하지 않는다.

Release는 merged `master` source와 immutable image를 기준으로 수행한다.
Migration 시도를 SQL 실행 전에 영속 기록한다.
시도 이후 activation·Web publication·smoke 실패에 이전 binary·Web를 자동 복구하지 않는다.
Migration 시도 이전 복구와 이후 forward-fix는 별도 조건과 절차를 적용한다.

## 대안과 절충

- 기존 migration 재작성은 신규 DB 구성을 단순화하지만 보존할 DB의 history와 정합하지 않을 수 있다.
- 자동 binary rollback은 복구 시간을 단축할 수 있지만 변경된 schema와 이전 writer의 호환성을 보장하지 못한다.
- 후속 migration·forward recovery는 단계와 검증 비용이 증가하지만 적용 이력과 복구 근거를 보존한다.

## 결과

SQL 문자열 검사만으로 PostgreSQL의 실제 failure semantics를 증명하지 않는다.
Fail-stop과 high-risk 변경에는 정책에 따른 실제 PostgreSQL 검증이 필요하다.
Image build 성공은 production deployment 완료 증거가 아니다.
배포 당시 workflow와 실제 required checks·approval 상태를 별도로 확인한다.

## 근거와 검증 위치

- [Database migration policy](../database-migration-policy.md)
- [Deploy Release](../../.github/workflows/release-api-cutover.yml), [PR Checks](../../.github/workflows/pr-checks.yml)
- [Release orchestrator](../../server/release-orchestrate.sh), [migration entry](../../server/deploy/migrate.sh)
- [Migration fence](../../apps/api/scripts/release-migrate.ts), [recovery boundary](../../server/release-recovery.mjs)
- [Release cutover tests](../../server/release-cutover.test.mjs), [migration fence tests](../../apps/api/scripts/release-migrate.test.ts)
- [Policy checker tests](../../scripts/check-migration-policy.test.mjs)

EOD
