# ADR 0002 — Durable cleanup과 outbox

상태: **기존 결정 기록** — 현재 구현의 소급 기록이며 신규 승인 기록이 아니다.

## 배경

DB reference 삭제와 Garage object 삭제는 단일 transaction으로 처리할 수 없다.
업무 상태 변경 후 process가 종료되거나 storage 요청이 실패하면 외부 자원이 잔존할 수 있다.
삭제 재시도는 현재 reference와 동시 작업의 소유권도 확인해야 한다.

## 결정

Reference 제거에 수반되는 삭제 의도는 업무 transaction 안에서 orphan outbox에 기록한다.
즉시 삭제 경로는 storage 삭제에 실패하면 durable orphan 기록을 시도한다.
삭제와 기록이 모두 실패하면 오류를 반환한다.

대상은 `EXACT`와 `PREFIX`로 구분하며 prefix 재시도는 object를 다시 열거한다.
Reaper는 persisted claim·lease와 reference resolver를 사용하여 삭제 가능성을 확인한다.
Upload intent와 multipart abort는 별도의 durable 상태로 복구한다.
Context runtime은 시작·주기 실행·wake 요청과 종료를 관리한다.

## 대안과 절충

- 삭제 실패의 로그 기록만으로는 process 종료 후 재시도 대상을 복구하기 어렵다.
- 요청마다 DB와 storage를 동기 처리해도 두 시스템의 원자성을 보장하지 못한다.
- Durable outbox는 추가 row·claim·reconciliation 비용이 발생하지만 재시도 대상과 책임을 보존한다.

## 결과

업무 성공과 object 삭제 완료 시점은 분리될 수 있다.
Lease와 재시도는 중복 실행 가능성을 전제로 하며 exactly-once 실행 보장이 아니다.
Durable reference 제거 전 inventory·이전 또는 cleanup 증거를 확인한다.
Queue 기록과 즉시 삭제가 모두 실패한 상태를 성공으로 취급하지 않는다.

## 근거와 검증 위치

- [Transactional outbox](../../apps/api/src/modules/orphan/outbox.ts)
- [업무 transaction 예시](../../apps/api/src/modules/admin/year/repository.ts)
- [Deletion coordinator](../../apps/api/src/application/object-deletion.ts)
- [Reaper](../../apps/api/src/modules/orphan/service.ts), [reference resolver](../../apps/api/src/modules/orphan/reference-resolver.ts)
- [Upload lifecycle runtime](../../apps/api/src/modules/upload-lifecycle/runtime.ts)
- [Deletion failure tests](../../apps/api/src/__tests__/object-deletion.test.ts), [claim lease tests](../../apps/api/src/__tests__/orphan-claim-lease.test.ts)
- [Reference ownership tests](../../apps/api/src/__tests__/object-reference-ownership.test.ts)
- [Database migration policy](../database-migration-policy.md)

EOD
