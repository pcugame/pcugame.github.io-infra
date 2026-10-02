# Backend architecture

현재 backend는 HTTP 제어, durable 상태 전이, object byte 처리, 배포 실행을 구분한다.
아래 구조는 저장소 코드 기준이며 production 배포 상태나 검증 완료를 의미하지 않는다.
기존 감사의 수행 순서와 당시 증거는 [감사 이력](../history/2026-backend-audit/README.md)에 보존한다.
설계 선택의 배경은 [ADR 목록](../adr/README.md)에 기록한다.

## 의존성 방향

| 경계 | 역할 | 주요 근거 |
|---|---|---|
| HTTP composition | Fastify, plugin, route 등록과 요청·응답 계약 적용 | [app.ts](../../apps/api/src/app.ts) |
| Backend composition | 설정과 자원으로 feature graph 구성 | [backend-context.ts](../../apps/api/src/backend-context.ts) |
| Application·feature | 권한, 상태 전이, repository·storage port 사용 | [application ports](../../apps/api/src/application/ports.ts), [upload ports](../../apps/api/src/application/upload-ports.ts) |
| Adapter·persistence | Prisma, S3 SDK, OS 자원 연결 | [production ports](../../apps/api/src/infrastructure/production-ports.ts), [storage adapter](../../apps/api/src/lib/storage.ts) |
| Worker composition | 처리 repository, storage, workspace와 실행 loop 구성 | [image composition](../../apps/api/src/modules/image/composition.ts) |

Controller는 HTTP 입력과 출력을 연결하고 service는 업무 판단을 수행한다.
구체적인 Prisma·S3 자원 선택은 composition 및 adapter 경계에서 수행한다.
모든 feature를 동일한 port 구조로 전환한 상태로 간주하지 않는다.
새 변경은 해당 feature의 기존 composition과 repository 인터페이스를 먼저 확인한다.

[Architecture guard](../../apps/api/scripts/architecture-guard.mjs)는 API·worker의 도달 가능한 import graph를 검사한다.
API의 object body 읽기·전송·업로드 중계, 처리 library import와 feature의 직접 storage SDK import를 제한한다.
Worker의 Fastify·API controller import도 제한한다.
[Dependency rules](../../apps/api/.dependency-cruiser.cjs)는 순환 의존성과 직접 import 경계를 추가 검사한다.
이 검사는 정적 규칙에 대한 증거이며 모든 런타임 권한·동시성 조건을 증명하지 않는다.

## Composition과 자원 수명

`createProductionBackendContext(config)`는 자원과 feature graph를 구성한다.
DB·S3 작업, timer, maintenance와 signal listener의 실행은 생성 단계와 분리한다.
`BackendContext.start()`는 등록 순서로 소유 자원의 startup을 수행한다.
`close()`는 역순으로 소유 자원을 종료하며 반복 호출에 동일한 종료 promise를 사용한다.
외부 주입 자원은 `owned` 또는 `borrowed`를 명시한다.
`borrowed` 자원의 시작과 종료 책임은 호출자에게 있다.

| 구성 요소 | 책임 |
|---|---|
| [infrastructure.ts](../../apps/api/src/backend-context/infrastructure.ts) | 기본 factory와 외부 자원 주입 인터페이스 |
| [persistence.ts](../../apps/api/src/backend-context/persistence.ts) | production repository 구성 및 테스트용 persistence seam |
| [routes.ts](../../apps/api/src/backend-context/routes.ts) | feature route graph 구성과 추가 controller 연결 |
| [maintenance.ts](../../apps/api/src/backend-context/maintenance.ts) | API 내 주기 작업, 취소·진행 중 작업 추적 |
| [resource-owner.ts](../../apps/api/src/backend-context/resource-owner.ts) | 소유권 등록, start·close 중첩 및 실패 처리 |
| [server.ts](../../apps/api/src/server.ts) | signal 등록, listen, drain과 종료 deadline |

`buildApp({ context })`는 HTTP app을 구성하고 `onClose`에서 context 종료를 요청한다.
Server runtime은 context startup 이후 listen을 수행한다.
구성·startup 실패도 context 종료 경로로 수렴한다.
종료에서는 요청 drain 이후 Fastify와 backend 자원 종료를 수행한다.
근거 테스트는 [backend-context](../../apps/api/src/__tests__/backend-context.test.ts)와
[server-runtime](../../apps/api/src/__tests__/server-runtime.test.ts)이다.
관련 결정은 [ADR 0001](../adr/0001-explicit-composition-and-resource-ownership.md)에 기록한다.

## HTTP 계약 경계

[Shared contracts](../../packages/contracts/src/index.ts)는 API와 Web에서 사용하는 schema·enum을 제공한다.
`app.ts`는 Zod validator·serializer compiler를 설정한 후 route schema hook을 등록한다.
[http-route-schemas.ts](../../apps/api/src/shared/http-route-schemas.ts)의 runtime inventory는
method·URL별 params, query, body와 response 경계를 명시한다.
등록되지 않은 route는 명시적 schema가 있어도 app 구성 단계에서 거부된다.
`HEAD`는 대응하는 `GET` 계약을 참조할 수 있다.

JSON, multipart, no-content, redirect와 plugin 경계의 처리 방식은 동일하지 않다.
Multipart scalar field와 import parsing은 해당 처리 경계에서 검증한다.
오류 응답은 `app.ts`의 공통 handler에서 공개 API 형태로 정규화한다.
인증·CSRF·권한 판단은 schema 검증과 별도이며 성공 응답 serializer도 검증 대상이다.
변경 검증에는 실제 인증된 요청의 최종 응답과 빈·채워진 collection을 포함한다.
[Runtime contract tests](../../apps/api/src/__tests__/http-route-runtime-contracts.test.ts)는 inventory와 HTTP 경계를 검사한다.

[Route contract 소유권 후속안](./route-contract-ownership.md)의 상태는 **PROPOSED**이다.
중앙 inventory에서 feature별 계약으로 소유권을 이전하는 구조는 현재 구현으로 간주하지 않는다.

## Durable cleanup과 외부 자원

DB transaction과 object storage 작업은 하나의 원자적 transaction이 아니다.
업무 reference 제거에 수반되는 cleanup 의도는 같은 DB transaction에서
[orphan outbox](../../apps/api/src/modules/orphan/outbox.ts)에 기록한다.
[Object deletion coordinator](../../apps/api/src/application/object-deletion.ts)는 즉시 삭제 실패 시 durable orphan 기록을 시도한다.
삭제와 기록이 모두 실패하면 오류를 반환하여 cleanup 보장을 주장하지 않는다.

[Upload lifecycle runtime](../../apps/api/src/modules/upload-lifecycle/runtime.ts)은 orphan deletion,
upload intent sweep, multipart abort와 idempotency 정리를 구성한다.
Orphan 처리에는 [repository](../../apps/api/src/modules/orphan/repository.ts)의 claim과
[reference resolver](../../apps/api/src/modules/orphan/reference-resolver.ts)의 현재 소유 관계 확인을 사용한다.
`EXACT`와 `PREFIX` 대상은 구분하며 prefix는 재시도 시 object를 다시 열거한다.
Lease·claim token·재시도는 중복 실행 가능성을 관리하며 exactly-once 실행을 보장하지 않는다.
Durable reference 제거는 [migration policy](../database-migration-policy.md)의 inventory·이전·cleanup 증거 요구를 따른다.
근거와 대안은 [ADR 0002](../adr/0002-durable-cleanup-outbox.md)에 기록한다.

## 전용 worker와 API maintenance

| 실행 경계 | 현재 책임 |
|---|---|
| [game-validation worker](../../apps/api/src/game-validation-worker.ts) | 직접 업로드된 GAME·DOCUMENT·ATTACHMENT source 검증 |
| [WebGL worker](../../apps/api/src/webgl-worker.ts) | WEBGL source 검증과 deployment 처리 |
| [video worker](../../apps/api/src/video-worker.ts) | video byte 처리 |
| [image worker](../../apps/api/src/image-worker.ts) | image·poster 및 PDF 처리 |
| [export worker](../../apps/api/src/export-worker.ts) | export 생성·staging 처리 |
| [publication worker](../../apps/api/src/project-publication-worker.ts) | staging에서 public object로 publication 처리 |
| API context | session 만료 정리, stale direct upload recovery, orphan·upload lifecycle maintenance |

처리 worker는 각 entry point에서 DB·S3 자원과 signal 수명을 소유한다.
API와 worker는 DB에 보존된 상태·job을 통해 연결되며 API 요청에서 byte 처리 graph를 실행하지 않는다.
Worker별 repository의 claim·lease와 완료 조건을 유지하여 재시작·재시도 시 stale 결과의 반영을 제한한다.
API maintenance는 context-owned runtime과 scheduler에 유지된다.
따라서 전용 worker 분리는 모든 background task의 process 분리를 의미하지 않는다.
관련 근거는 [processing fences tests](../../apps/api/src/__tests__/processing-worker-fences.test.ts),
[upload lifecycle tests](../../apps/api/src/__tests__/upload-lifecycle-runtime.test.ts)와 [ADR 0004](../adr/0004-dedicated-workers.md)이다.

## Object 접근 경계

Upload part byte는 browser에서 서명된 capability를 사용하여 Garage로 전송한다.
API는 session 생성·part 서명·완료 제어와 권한 검사를 수행한다.
내부 S3 endpoint, browser upload origin과 protected download signing endpoint는 별도 구성한다.
Public·protected bucket 구분은 저장 위치이며 익명 접근 허용 여부와 동일하지 않다.

[File access service](../../apps/api/src/modules/file-access/service.ts)는 representation·deployment identity,
`READY` 상태, project·exhibition visibility와 필요한 session·token을 검사한다.
Gateway는 [public origin](../../apps/db/public-origin.nginx.conf.template)과
[protected download](../../apps/db/protected-download.nginx.conf.template)의 `auth_request`로 API에 접근 권한을 재검증한다.
API는 승인된 object path·upstream 정보를 반환하고 gateway가 object byte를 전달한다.
Token 발급 당시 권한만으로 접근을 고정하지 않으며 만료·session 상태·현재 공개 상태를 재검증한다.
근거는 [file access tests](../../apps/api/src/__tests__/file-access.postgres.test.ts),
[gateway integration tests](../../apps/api/src/__tests__/visibility-gateway.garage.postgres.test.ts)와 [ADR 0005](../adr/0005-object-access-boundary.md)이다.

## Migration과 release 경계

적용되었거나 적용 여부가 불명확한 published migration의 수정은 정책상 제한한다.
변경은 후속 migration과 필요한 compatibility·reconciliation 단계로 구성한다.
외부 storage I/O는 schema SQL에 포함하지 않고 application command로 분리한다.
구체적인 atomicity·fail-stop 검증은 [database migration policy](../database-migration-policy.md)를 따른다.

[PR Checks](../../.github/workflows/pr-checks.yml),
[Build API Release Image](../../.github/workflows/deploy-api.yml),
[Deploy Release](../../.github/workflows/release-api-cutover.yml)는 CI·image build·production release 경계이다.
일반 release는 merged `master` source와 immutable image identity를 확인하고
production gate, preflight, backup, migration, API·worker activation, health, Web publication과 smoke 순서로 수행한다.
[Release orchestrator](../../server/release-orchestrate.sh)는 SQL 실행 전 migration 시도를 영속 기록한다.
시도 이후에는 이전 binary·Web로 자동 복구하지 않고 forward recovery 절차를 따른다.
[Migration entry](../../server/deploy/migrate.sh)는 runtime schema 조건을 확인하고
[release-migrate](../../apps/api/scripts/release-migrate.ts)를 실행한다.
이 구조의 기록은 [ADR 0003](../adr/0003-forward-only-database-migrations.md)에 명시한다.
