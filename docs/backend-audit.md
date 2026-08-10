# 백엔드 전수 재감사 정정 보고서

> **정정 공지:** 이 문서의 이전 판본이 선언한 “High 8건과 Medium 14건 모두 fixed”, `accepted` 2건, 감사 종결 판정은 모두 무효다. 이전 판본은 service fake와 빈 route plugin으로 만든 `BackendContext` 테스트를 production composition의 증거로 잘못 인정했고, module-level runtime/repository/cache의 실제 수명과 WebGL 복구 원본 삭제 경로를 놓쳤다. 오류가 있던 판본은 Git 이력에만 보존한다.

## 1. 재감사 기준, 범위, 판정 규칙

- 재감사일: 2026-07-21
- 실제 재감사 기준: `feature/webgl-hosting`의 `c3d2e51` (`Refactor backend boundaries and harden workflows`)
- 계획에 적힌 `master@ce9c2ad`는 이 clone에 존재하지 않는다(`git cat-file -t ce9c2ad` 실패). 현재 `master`는 `8e9f53b`, 현재 HEAD는 `c3d2e51`이므로 결과를 재현할 수 있는 실제 HEAD를 기준으로 삼았다.
- 범위: `apps/api`, 공유 `@pcu/contracts`, Prisma migration, Docker PostgreSQL/Garage 경계, API 관련 CI. 프론트엔드 구현은 제외한다.
- 산출물 범위: 이 감사 PR은 구현 코드·테스트·DB schema·외부 API를 변경하지 않고 이 문서만 정정한다.

판정은 다음 의미로만 사용한다.

| 상태 | 의미 |
|---|---|
| `verified-fixed` | production 경로의 코드 증거와 해당 실패 분기를 검증하는 테스트 또는 강제 guard가 모두 있다. 좁게 확인된 사실에만 붙인다. |
| `open` | 위반, 경쟁 조건, 수명 불명확성, 또는 production 경로 테스트 공백이 남아 있다. 완료 차단 항목이다. |
| `accepted` | 사용자가 명시적으로 승인한 운영 제약만 해당한다. 이번 재감사에는 그런 승인이 없어 0건이다. |
| `backlog` | 명시적 요구사항을 위반하지 않는 Low 개선만 해당한다. 이번 재감사에는 0건이다. |

service fake 테스트는 production wiring의 증거로 보지 않는다. lint, build, dependency-cruiser, 전체 테스트와 Docker smoke 통과는 회귀 기준선이지 composition 완료 증명이 아니다.

## 2. 결론

감사는 종결할 수 없다. 현재 완료 차단 항목은 **High 3건, Medium 8건, Low 1건**이다. H-02는 티켓 000의 구현과 독립 검증으로 `verified-fixed`가 됐다.

가장 중요한 결론은 `BackendContext`가 production composition root가 아니라는 점이다. `createProductionBackendContext()`는 새 resource를 생성하지 않고 process-global 객체를 다시 노출하며, 실제 route는 context의 port를 받지 않고 17개 feature runtime singleton을 import한다. 서로 다른 두 context는 Prisma, S3, lifecycle, settings cache, upload/download limiter, export progress와 feature service를 공유한다.

WebGL completion의 H-02 데이터 손실 경로는 티켓 000에서 수정됐다. public 배포 후 DB 전환이 일시적으로 실패하면 `rollbackWebglPublicDeployment()`가 public `sitePrefix`만 정리하고 protected `source.zip`은 보존한다. 상위 completion은 `COMPLETING`을 유지하며, 새 service/finalizer instance의 boot sweep이 보존된 source로 재배포와 DB finalization을 완료하는 연쇄 테스트가 이를 검증한다.

좁은 범위에서 재확인된 개선도 있다. application service의 Fastify 직접 의존 제거, storage↔orphan import cycle 제거, ZIP/path 방어, project poster clear CAS의 query shape, auth 로그의 credential/이메일 제거, import service의 Prisma dynamic import 제거, export sibling-temp/rename, game upload DB CHECK migration은 코드와 관련 테스트가 존재한다. 그러나 이 결과가 production graph 전체의 `fixed`를 뜻하지는 않는다.

## 3. 완료 차단 지적

| ID / 심각도 | 파일·심볼 | production 증거와 위반 경계 | 테스트 공백 | 요구되는 수정과 완료 테스트 | 상태 |
|---|---|---|---|---|---|
| H-01 High | `apps/api/src/backend-context.ts:77#createProductionBackendContext`, `apps/api/src/app.ts:121#buildApp` | context는 `objectStorage`, `processUploadLimiter`, `cachedSettingsStore`, `processLifecycle`, `prismaHealth`, `prismaAuthSessions` 같은 전역 객체를 반환한다. `routes`도 이미 runtime을 import한 고정 plugin이다. context가 resource·feature graph를 생성하거나 소유하지 않는다. | `backend-context.test.ts`는 실제 route tree 대신 `emptyRoutes`와 가짜 auth route를 넣는다. production context 생성, 실제 controller factory, 두 context 격리를 전혀 실행하지 않는다. | stateful resource factory와 feature controller factory를 만들고 한 composition root에서 `config → adapter → repository → service → controller`를 조립한다. 두 context가 limiter/settings/lifecycle/export progress를 공유하지 않는 테스트와 fake adapter로 실제 route tree 전체를 조립하는 테스트가 필요하다. | `open` |
| H-02 High | `modules/admin/game-upload/finalize-completed-upload.service.ts#createCompletedUploadFinalizer`, `modules/webgl/deployment.ts#rollbackWebglPublicDeployment`, `complete-session.service.ts#completeSession`, `session-maintenance.service.ts#sweepStaleCompletingSessions` | DB pointer finalization 실패는 `rollbackWebglPublicDeployment()`만 호출한다. 이 operation의 타입에는 protected `sourceKey`가 없고 production adapter는 public bucket의 정확한 `sitePrefix`만 삭제한다. protected source 삭제와 terminal 전체 삭제는 `deleteWebglProtectedSource()`/`deleteWebglDeployment()`로 분리됐다. 비-terminal 오류는 `COMPLETING`과 source를 보존한다. | `webgl-completion.test.ts`가 source complete→public deploy→DB pointer fault→public rollback 순서, `COMPLETING`, source 보존, partial public tree 제거를 검증하고 새 service/finalizer instance의 sweep으로 `COMPLETED`와 단일 final tree를 확인한다. `webgl-deployment-compensation.test.ts`는 production rollback helper가 protected object deletion을 호출하지 않음을 직접 검증한다. | 독립 검증에서 좁은 테스트, API 전체 487 tests, lint, architecture, build, PostgreSQL/Garage integration과 환경 정리가 통과했다. 실제 DB fault injection은 티켓 012/015의 전체 production fault matrix에서도 재검증한다. | `verified-fixed` |
| H-03 High | `modules/assets/mutation-transaction.ts`, `modules/assets/repository.ts`, `modules/admin/project/repository.ts` | asset delete는 짧은 bounded Serializable transaction에서 project→asset row를 잠그고 snapshot·`DELETING`·poster clear를 함께 commit한다. storage 작업은 transaction 밖이며 최종 `DELETED`는 identity/status/storage snapshot 전체 CAS로만 기록된다. direct/chunked GAME 교체는 기존 row를 재사용하지 않고 old row 전이·orphan outbox·새 READY identity를 같은 transaction에 기록한다. `setPoster`도 project 소속·kind·READY 재검증과 pointer 갱신을 한 transaction에서 수행한다. | PostgreSQL trigger/advisory-lock과 `pg_stat_activity`로 실제 critical-section overlap을 확인하는 5개 경쟁 테스트를 각 3회 반복해 delete↔GAME, delete↔setPoster, setPoster↔status, storage+queue 이중 실패, retry loser cleanup의 pointer/READY/storage/orphan invariant를 검증한다. | 독립 검증에서 좁은 35 tests, PostgreSQL concurrency 5/5, orphan fault 5/5, API 537 tests, lint, architecture, build, 전체 integration·Docker E2E와 환경 정리가 통과했다. retry는 최대 3회이며 지정 conflict만 재시도하고 소진 시 기존 409 의미를 유지한다. | `verified-fixed` |
| H-04 High | `modules/assets/composition.ts`, `modules/assets/controller.ts#createAssetsController`, `modules/admin/banned-ip/controller.ts#createBannedIpController`, `backend-context.ts` | assets/banned production graph는 context-owned Prisma, storage, limiter, settings, logger, clock으로 조립된다. controller/index의 runtime·env·global Prisma/S3 import와 compatibility limiter singleton은 제거됐다. route import/factory/registration은 DB·S3·timer 작업을 하지 않으며, context start가 ban cache를 정확히 한 번 warmup한다. warmup 전 요청은 503으로 fail-closed되고 실패 시 startup이 resource를 정리하며 중단된다. | production controller/prefix 조립 테스트가 registration I/O 0, warmup 실패·복구, 기존 ban 차단, A/B cache·bucket·mutation·close 격리와 protected redirect·Range·rate-limit 동작을 검증한다. | 독립 검증에서 좁은 34 tests, API 536 tests, lint, architecture, build, PostgreSQL/Garage integration·E2E와 환경 정리가 통과했다. H-01/M-01은 다른 slice 이전이 남아 있어 `open`을 유지한다. | `verified-fixed` |
| M-01 Medium | 남은 runtime/compatibility graph와 project multipart/game route | 티켓 004의 assets/banned, 006의 auth/dev-auth, 007의 public/WebGL read, 008의 project CRUD/access/member/settings, 009의 year, 010의 import/export가 context-owned controller factory로 이전됐다. Project multipart와 me submit은 011 compatibility graph, game-upload와 recovery는 012 runtime을 계속 사용한다. | 이전된 slice는 실제 production route-tree와 transitive dependency closure 테스트가 있지만 project multipart/game controller factory와 전체 route graph 증거가 아직 없다. | 011~012에서 남은 feature별 controller graph를 context에서 조립하고 runtime/env import를 제거한다. feature 간 사용은 명시적 port로 전달하며 013 정적 규칙과 015 전체 조립 테스트를 추가한다. | `open` |
| M-02 Medium | `backend-context.ts`, 남은 `lib/{prisma,s3,logger,lifecycle}.ts` compatibility singleton, `shared/*` compatibility resource, `server.ts` | 티켓 010 production export는 context-owned progress/lock/storage/filesystem/clock/ID/config/logger graph를 사용한다. active export를 graph가 소유해 context close가 abort·sibling-temp cleanup 완료·lock/progress finish를 기다린 뒤 progress store를 닫고, A/B context와 concurrent/double close가 격리된다. 다만 compatibility runtime과 server signal/timer 및 아직 이전되지 않은 feature가 전역 resource를 계속 참조한다. | actual production route에서 A/B progress·lock, real TCP abort, concurrent start, storage/FS/cleanup 실패, exact sibling-temp atomicity, WebGL protected export를 검증한다. 독립 재검증에서 production wiring 12/12, API 583 tests, PostgreSQL import 2/2, lint, architecture, build, 전체 integration·E2E와 환경 정리가 통과했다. 전체 global inventory 0과 server runner ownership은 아직 증명되지 않았다. | 011~013에서 남은 compatibility consumer/singleton을 제거하고 server signal·timer 및 partial-startup rollback의 단일 owner를 고정한 뒤 015에서 전체 graph close를 재검증한다. export progress/lock 좁은 범위만 `verified-fixed`; Finding 행 전체는 `open`이다. | `open` |
| M-03 Medium | `shared/site-settings.ts#createCachedSettingsStore`, `shared/site-settings.runtime.ts`, `game-upload/runtime.ts` | 티켓 008에서 defaults fallback을 제거하고 bounded startup warmup, TTL/retry/invalidate/close를 가진 context-owned settings store와 controller graph를 도입했다. 다만 game-upload production runtime은 012까지 process-global compatibility store를 사용하므로 실제 upload consumer가 같은 context settings instance를 사용한다는 증거는 아직 없다. | 008 production graph가 최초 DB 실패→retry→낮은 값, TTL reload, A/B cache·close 격리를 검증한다. 실제 game-upload route가 context store의 제한을 적용하는 실패 테스트는 012 범위로 남아 있다. | 티켓 012에서 game-upload service에 동일 context settings port를 전달하고 낮은 DB 제한이 실제 create/chunk route를 제한하는 production wiring 테스트를 추가한다. | `open` |
| M-04 Medium | `modules/admin/year/repository.ts#withExhibitionMutationTransaction`, `year/service.ts#replacePoster`, `year/poster-upload.adapter.ts` | year production graph는 context-owned Prisma/storage/filesystem/limiter/settings/logger/clock/ID로 조립된다. poster replace·clear·exhibition delete는 exhibition row를 잠근 bounded Serializable transaction에서 pointer mutation과 이전 key orphan outbox를 함께 commit하며 storage I/O는 transaction 밖에서 실행한다. 업로드 key는 object PUT 전에 cleanup 대상으로 등록되어 저장 후 오류도 삭제 또는 durable orphan으로 보상된다. | 실제 PostgreSQL에서 replace→replace, replace→clear, clear→replace를 각각 3회 반복하고 advisory-lock trigger와 `pg_stat_activity`로 두 critical section의 실제 lock wait를 확인한다. 각 반복은 최종 pointer, winner·loser·old object, outbox를 검증한다. 실제 production route graph는 invalid/oversize/abort/limiter/storage/DB/outbox/cleanup 실패와 temp 정리를 재실행한다. | 동일 검증자가 최초 transitive singleton·ambiguous upload·route failure·역방향 반복 누락을 FAIL 처리한 뒤 재검증했다. 좁은 37 tests, API 571 tests, PostgreSQL year 7/7, lint, architecture, build, 전체 integration·E2E와 환경 정리가 통과했다. M-01은 후속 import/export·multipart·game wiring 때문에 계속 `open`이다. | `verified-fixed` |
| M-05 Medium | `shared/http-route-schemas.ts#ROUTE_RUNTIME_CONTRACTS`, `#registerRouteSchemas`, `packages/contracts/src/response-schemas.ts` | 가능한 명시 route 합집합 57개(상시 production 55개 + non-production dev-auth 2개)를 endpoint schema로 고정했다. CORS `OPTIONS *`와 GET에서 파생되는 HEAD 21개를 별도 계수하며, inventory 밖 route와 mixed method-array 우회는 broad schema를 직접 달아도 등록이 실패한다. JSON/error/no-content/redirect/stream response와 no-body/multipart/octet-stream 책임을 분리했고 production schema에 `z.unknown()` fallback은 없다. | 최초 독립 검증은 WebGL export 음수 synthetic ID, legacy `githubUrl`, 소수 `totalBytes`, canonical body ID와 family별 injection 공백을 반증했다. 해당 분기를 실제 Fastify/서비스 회귀로 추가해 family별 happy/invalid input, response drift, no-body·optional body, multipart/octet parser 400/415, redirect/204/stream/CORS/health를 실행한다. | 최초 FAIL을 낸 adversarial, response, route-boundary 검증자 3명이 최신 snapshot을 재실행해 57/55/21 inventory, status schema, method-array guard와 실제 service wire를 모두 PASS 판정했다. | `verified-fixed` |
| M-06 Medium | `src/__tests__/backend-context.test.ts`, module mock 사용 43회/13파일 | production context/route graph 테스트가 없고, context 테스트는 실제 feature route를 비운다. resource-guard, WebGL, auth 테스트 대부분은 fake service/adapter를 직접 호출한다. 이는 분기 로직에는 유효하지만 production module wiring을 증명하지 않는다. | context→실제 controller→service→fake repository/storage 전체 조립, import-side-effect, multi-context, production adapter contract 테스트가 없다. | factory 기반 실제 route tree test kit를 만들고 핵심 실패 분기를 같은 production wiring으로 재실행한다. module mock은 legacy characterization으로만 남기고 수치를 정확히 추적한다. | `open` |
| M-07 Medium | `apps/api/.dependency-cruiser.cjs` | 현재 cycle과 일부 service 경계는 막지만 controller→runtime, controller→env, repository→global Prisma, runtime singleton export, feature 간 runtime 참조를 허용한다. 그래서 위반 0이면서 production graph는 전역 결합 상태다. | 금지돼야 할 import fixture 또는 rule self-test가 없다. | `controller -> runtime/env`, `repository -> lib/prisma`, 비-composition-root의 stateful runtime import를 금지하고 factory/port 방향만 허용한다. rule 위반 fixture를 CI에서 검사한다. | `open` |
| M-08 Medium | `modules/orphan/service.ts#recordOrphan`, `application/object-deletion.ts#deleteOrQueue`, `modules/orphan/outbox.ts` | 일반 삭제의 storage+queue 이중 실패는 `DurableObjectDeletionError`로 전파된다. DB commit 후 cleanup이 필요한 GAME/WebGL/project/year 경로는 상태·pointer mutation과 exact/prefix orphan upsert를 같은 Prisma transaction에 기록하고, commit 후에는 durable row를 보존한 best-effort 삭제를 수행한다. malformed WebGL entry도 transaction을 실패시킨다. | unit 66개와 실제 PostgreSQL fault 5개가 asset nonterminal+retry, GAME 교체, project exact/WebGL prefix 삭제, WebGL finalizer, exhibition replace/delete를 검증한다. exact/prefix reaper의 missing/empty/partial failure 재시도와 scheduler close의 in-flight 대기도 production graph에서 검증했다. | 독립 검증에서 API 531 tests, PostgreSQL fault 5/5, Docker PostgreSQL/Garage smoke·E2E, lint, architecture, build와 환경 정리가 모두 통과했다. 성공 반환은 object 삭제 또는 durable 재조정 가능성 중 하나를 보장한다. | `verified-fixed` |
| L-01 Low | `shared/http-route-schemas.ts`, `shared/validation.ts`, `modules/public/service.ts`, `modules/admin/game-upload/controller.ts`, `create-session.service.ts` | year, positive ID, zero-based chunk는 전체 문자열 canonical decimal과 JS safe integer만 받는다. JSON/multipart의 `exhibitionId`, `assetId`, member IDs, `totalBytes`도 숫자면 safe integer, 문자열이면 canonical decimal만 허용한다. `:idOrSlug`는 canonical positive decimal만 ID lookup에 사용하고 `1e3`, `+1`, `1.0` 등은 slug로 처리한다. | suffix/sign/decimal/exponent/공백/hex/overflow와 소수 byte count를 unit 및 production Fastify injection에서 거부한다. numeric-looking slug가 ID repository를 호출하지 않고, upload service 직접 호출도 fractional/unsafe `totalBytes`를 I/O 전에 거부함을 고정했다. | 세 독립 검증자가 400/404/slug 의미, multipart JSON field 정규화와 service 우회 방어를 최신 snapshot에서 PASS 판정했다. | `verified-fixed` |

## 4. Production resource 소유권·수명 매트릭스

### 4.1 Stateful/external resource

| Resource | 실제 생성 위치 | 실제 사용자 | 상태 범위 / 시작 작업 | 종료 주체 | 판정 |
|---|---|---|---|---|---|
| env cache | `config/env.ts:105#_env` | server, context, controller 6개, runtime 다수, S3/logger/limit helper | process; 첫 `loadEnv/env` | 없음 | context 밖 전역 |
| Prisma client/pool | `lib/prisma.ts:5-20#prisma` | 직접 repository 7계열, runtime factory 5계열, settings, health/session maintenance | module/process; import 시 생성 | signal path의 `databaseHealth.close()`만 | context별 소유 아님 |
| S3 client/socket | `lib/s3.ts:6-35#_client` | `lib/storage`, export, WebGL, upload adapters, context health | process; 첫 S3 call | 없음 (`S3Client.destroy` 미호출) | 누수/소유 불명 |
| root logger | `lib/logger.ts:6#_root` | context와 모든 runtime/background | process; 첫 log | 없음 | 공유 singleton |
| OAuth client | `auth/composition.ts#createAuthProductionGraph` | 실제 auth/dev-auth login route | context당 1개; context verifier/config/clock/ID/repository를 공유 | context owner | 티켓 006에서 context graph로 이전 |
| filesystem | `production-ports.ts:74#nodeFileSystem`; export/upload/WebGL은 `node:fs` 직접 import | deep context field는 feature에서 미사용 | wrapper는 stateless; stream/temp file은 request/workflow | 각 adapter의 cleanup | context port 우회 |
| clock | `systemClock`; runtime의 `new Date/Date.now` | health/auth plugin은 context, feature runtime은 전역/direct | 혼합 | 해당 없음 | 결정성 분할 |
| UUID/session ID | context `cryptoIdGenerator`; runtime `randomUUID`, `crypto.randomUUID`, `generateSessionId` | context ID는 request-id 중심; upload/export/session은 direct | 혼합 | 해당 없음 | context port 우회 |
| scheduler tasks | `nodeScheduler`; server의 purge/orphan task; download limiter 내부 default scheduler | server와 protected limiter | server context처럼 보이나 limiter timer는 process singleton | server task는 signal cancel, limiter는 app `onClose` | owner 분할 |
| lifecycle/in-flight | `lib/lifecycle.ts:38#processLifecycle` | app hooks, server, game runtime | process 전체 | reset/close 없음 | 두 app/context 공유 |
| settings cache | `shared/site-settings.ts:65#productionStore` | context alias, settings runtime, game runtime | process; 첫 get 실패도 cache | invalidate만, shutdown 없음 | 두 context 공유 |
| upload semaphore | `shared/upload-limits.ts:210#processUploadLimiter` | context alias, submit/asset/year/game runtimes | process counter | test-only reset | 두 context 공유 |
| protected download buckets/ban cache/timer | `shared/protected-download-limiter.ts:10#processLimiter` | assets와 banned-ip runtimes | process; 첫 use에 interval 시작 | 어느 app든 `onClose`가 destroy | cross-context 영향 |
| export lock/progress | `backend-context.ts#createProductionBackendContext`의 context별 `createExportProgressStore` | production export controller graph | context; export start부터 finish/abort까지 | import/export graph abort·settled 대기 후 context owner가 store close | 티켓 010 production 경로 격리 완료; compatibility runtime만 후속 제거 대상 |
| server signal handlers | `server.ts:57-83` | process | main 실행 후 영구 등록 | 없음 | runner 소유 불명 |

### 4.2 최초 17개 feature runtime 전수 표 (현재 12개)

| # | Runtime export | 생성 시점·상태 | 외부 의존 | controller/background 사용자 | owner / 상태 |
|---:|---|---|---|---|---|
| 1 | ~~`admin/banned-ip/runtime.ts#bannedIpService`~~ | 티켓 004에서 삭제 | context-owned Prisma, limiter, cache로 이전 | controller factory | context / 이전 완료 |
| 2 | `admin/export/runtime.ts#exportService` | legacy characterization용 lazy compatibility wrapper | env, Prisma, S3, FS, UUID, clock, logger | production controller는 미사용 | compatibility only / 013 제거 대상 |
| 3 | `game-upload/finalize-completed-upload.runtime.ts#completedUploadFinalizer` | first finalize lazy | env, storage, repository, WebGL deployment, orphan coordinator | game runtime | module / `open` |
| 4 | `game-upload/runtime.ts#gameUploadService` | first call lazy | env, repository, S3, lifecycle, settings, limiter, clock, UUID | game controller, startup recovery | module / `open` |
| 5 | `admin/import/runtime.ts#importService` | legacy compatibility export | global Prisma adapter | production controller는 미사용 | compatibility only / 013 제거 대상 |
| 6 | `admin/member/runtime.ts#memberService` | import 시 eager | global Prisma, project repository 직접 참조 | member controller | module / `open` |
| 7 | `project/project-asset.runtime.ts#projectAssetService` | import 시 eager | project repository, S3 policy, orphan, upload limiter/coordinator | project controller | module / `open` |
| 8 | `project/project-submit.runtime.ts#submitProject` | first call lazy | env, project repository, upload limiter/pipeline/collector | admin project와 me controller | module / `open` |
| 9 | `project/runtime.ts#projectService` | first call lazy | env, repository, storage/WebGL cleanup, logger | project controller | module / `open` |
| 10 | `project/serializer.runtime.ts#assetUrl/#serializeProjectDetail` | first call lazy | env | project runtimes | module / `open` |
| 11 | `admin/settings/runtime.ts#settingsService` | first call lazy | env, global cached settings store | settings controller | module / `open` |
| 12 | `admin/year/runtime.ts#exhibitionService` | first call lazy | env, global repo, S3/orphan/limiter/coordinator | year controller | module / `open` |
| 13 | ~~`assets/runtime.ts#assetsService`~~ | 티켓 004에서 삭제 | context-owned repository/storage/limiter/settings로 이전 | controller factory + 명시적 startup warmup | context / 이전 완료 |
| 14 | ~~`auth/runtime.ts#authService`~~ | 티켓 006에서 삭제 | context-owned repository/OAuth/config/clock/ID/logger로 이전 | auth/dev-auth controller factory와 auth plugin | context / 이전 완료 |
| 15 | `orphan/runtime.ts#orphanService` | import 시 eager | global Prisma, S3, clock, logger | object-deletion singleton, startup scheduler | module / `open` |
| 16 | ~~`public/runtime.ts#publicService`~~ | 티켓 007에서 삭제 | context-owned Prisma repository/storage/config/logger/clock으로 이전 | public controller factory | context / 이전 완료 |
| 17 | ~~`public/webgl.runtime.ts#publicWebglService`~~ | 티켓 007에서 삭제 | 같은 public context graph의 storage/config 사용 | public controller factory | context / 이전 완료 |

### 4.3 Module-level service/repository/cache/limiter export inventory

| 종류 | Module-level exports | 비고 |
|---|---|---|
| service/runtime | 최초 17개 중 assets/banned/auth/public/WebGL 5개 제거, 현재 runtime 파일 12개 | 남은 runtime은 후속 vertical slice에서 context route factory로 이전 예정 |
| global-Prisma repository exports | `auth/repository.ts` 함수 6개, `public/repository.ts` 함수 7개, `admin/project/repository.ts`, `admin/year/repository.ts`, `admin/game-upload/repository.ts`, `assets/repository.ts` destructured functions, `projectAccessRepository` | repository가 factory만 export한다는 규칙이 없음 |
| runtime-created repository | banned-ip, export, import, member, orphan runtime의 `createXRepository(prisma)` | factory는 있으나 global Prisma로 module scope에서 고정 |
| runtime 밖 singleton service facade | `project-access.ts#loadProjectWithAccess`, `object-deletion.ts#safeDeleteObject/#safeDeletePrefix` | 각각 global project-access repository와 global orphan/storage coordinator를 캡처 |
| cache/limiter/lifecycle | `get/update/reloadSiteSettings`, `acquire/releaseUploadSlot`, `protectedDownloadLimiter`, `gameDownloadLimiter` alias, lifecycle 함수 7개 | compatibility alias와 test reset도 production module에 노출 |
| coordinators/adapters | `safeDeleteObject/safeDeletePrefix`, `singleAssetUploadCoordinator`, `exhibitionPosterUploadCoordinator` | direct storage/FS/global orphan runtime을 캡처 |

## 5. 실제 dependency map

```text
server.ts
  ├─ loadEnv() → process env cache
  ├─ createProductionBackendContext()
  │   ├─ global Prisma/S3/storage/logger/lifecycle/settings/limiters
  │   ├─ orphanService runtime
  │   ├─ gameUploadService runtime
  │   └─ fixed route plugins
  ├─ buildApp(context)
  │   ├─ injected ports: request ID, health, auth-session plugin, lifecycle hooks
  │   └─ route plugins
  │       └─ controller → module runtime singleton → repository/global external system
  └─ startup recovery + process scheduler + signal shutdown
```

| Route family | Controller → application path | 실제 repository/external path | context가 실제로 지배하는 부분 |
|---|---|---|---|
| health | `app.ts` handler | context DB health, context storage | 대부분 주입됨 |
| auth/dev-auth | context → `createAuthProductionGraph` → controller/service/plugin | context-owned Prisma repository, OAuth/config/clock/session ID/logger | login/logout/session lookup·touch·expiry 전체를 같은 context가 지배 |
| public/project | context → public controller factory → public service | context-owned Prisma repository, storage/config | 조회·poster 응답을 context가 지배 |
| public/WebGL | 같은 public controller factory → WebGL service | context-owned storage/bucket/public config/logger/clock | root/wildcard/range/CORS/CSP를 context가 지배 |
| me submit | me controller → **admin** project-submit runtime | global project repository, upload pipeline/limiter/env | 없음 |
| admin exhibition | year controller → year runtime/service | global year repository, FS/S3/orphan/limiter | 없음 |
| admin project/member | controllers → project/member/project-access singletons | global project/member/access repositories, S3/WebGL cleanup | 없음 |
| game upload | controller → game runtime → split services/finalizer | global repository/S3/settings/limiter/lifecycle/UUID/clock | startup method만 context maintenance wrapper가 같은 singleton 호출 |
| settings/import/export | controllers → 각 runtime | global Prisma/cache/S3/FS/env/export progress | 없음 |
| assets/banned IP | context → controller factories → services | context-owned repositories/storage/limiter/cache; registration I/O 0 | startup warmup과 close를 context가 소유 |
| orphan/background | server maintenance → orphan runtime | global Prisma/S3/clock | scheduler 호출 껍데기만 context |

현재 dependency-cruiser는 174 modules, 440 dependencies, cycle/layer violation 0을 보고한다. 이는 위 graph를 금지하지 않는 rule set에서의 0이다.

## 6. HTTP route runtime schema 전수 분류

범례:

- `Z`: endpoint 의미를 반영한 Zod schema
- `Z∅`: 입력이 없어야 함을 나타내는 strict empty-object schema
- `N`: body-capable method의 null/undefined-only no-body schema
- `M`: `@fastify/multipart`와 feature collector가 소유하는 streaming multipart
- `O`: scoped octet-stream parser가 만든 실제 readable-stream schema
- `J`: success status별 JSON schema + documented error envelope
- `204`, `R`, `S`, `E`, `C`: 각각 no-content, redirect, raw stream, errors-only, CORS plugin 경계
- GET/HEAD body는 Fastify method 의미상 `—`이며 unknown body slot을 만들지 않는다.

| Endpoint | params | query | body | response |
|---|---|---|---|---|
| `OPTIONS *` (CORS plugin) | C | C | C | C `204/400` + E |
| `GET /api/health` | Z∅ | Z∅ | — | J health |
| `GET /api/health/deep` | Z∅ | Z∅ | — | J health |
| `POST /api/auth/google` | Z∅ | Z∅ | Z `GoogleLoginBody` | J auth |
| `POST /api/auth/logout` | Z∅ | Z∅ | N | J logout |
| `GET /api/me` | Z∅ | Z∅ | — | J auth union |
| `POST /api/dev/auth/login` | Z∅ | Z∅ | Z `DevAuthLoginBody` | J auth |
| `POST /api/dev/auth/login-error` | Z∅ | Z∅ | Z `DevAuthLoginErrorBody` | E |
| `OPTIONS /api/public/webgl/:projectId` | Z positive ID | Z∅ | N | 204 + E |
| `OPTIONS /api/public/webgl/:projectId/` | Z positive ID | Z∅ | N | 204 + E |
| `OPTIONS /api/public/webgl/:projectId/*` | Z positive ID/path | Z∅ | N | 204 + E |
| `GET /api/public/webgl/:projectId` | Z positive ID | Z∅ | — | S `200/206`, 204 `416` + E |
| `GET /api/public/webgl/:projectId/` | Z positive ID | Z∅ | — | S `200/206`, 204 `416` + E |
| `GET /api/public/webgl/:projectId/*` | Z positive ID/path | Z∅ | — | S `200/206`, 204 `416` + E |
| `GET /api/public/years` | Z∅ | Z∅ | — | J year list |
| `GET /api/public/exhibition-posters/:storageKey` | Z storage key | Z∅ | — | R `302` + E |
| `GET /api/public/years/:year/projects` | Z four-digit year | Z∅ | — | J year projects |
| `GET /api/public/exhibitions/:id/projects` | Z positive ID | Z∅ | — | J exhibition projects |
| `GET /api/public/projects/:idOrSlug` | Z canonical ID/slug | Z optional year | — | J project detail |
| `GET /api/assets/public/:storageKey` | Z storage key | Z∅ | — | R `302` + E |
| `GET /api/assets/protected/:storageKey` | Z storage key | Z∅ | — | R `302` + E |
| `DELETE /api/admin/assets/:assetId` | Z positive ID | Z∅ | N | 204 + E |
| `POST /api/me/projects/submit` | Z∅ | Z∅ | M payload/files | J `201` submit |
| `GET /api/admin/exhibitions` | Z∅ | Z∅ | — | J exhibition list |
| `POST /api/admin/exhibitions` | Z∅ | Z∅ | Z create body | J `201` create |
| `DELETE /api/admin/exhibitions/:id` | Z positive ID | Z∅ | N | 204 + E |
| `PATCH /api/admin/exhibitions/:id` | Z positive ID | Z∅ | Z update body | J exhibition |
| `POST /api/admin/exhibitions/:id/poster` | Z positive ID | Z∅ | M poster | J exhibition |
| `DELETE /api/admin/exhibitions/:id/poster` | Z positive ID | Z∅ | N | 204 + E |
| `GET /api/admin/projects` | Z∅ | Z list query | — | J paginated projects |
| `GET /api/admin/projects/:id` | Z positive ID | Z∅ | — | J project detail |
| `PATCH /api/admin/projects/:id` | Z positive ID | Z∅ | Z update body | J project detail |
| `DELETE /api/admin/projects/:id` | Z positive ID | Z∅ | N | 204 + E |
| `PATCH /api/admin/projects/bulk/status` | Z∅ | Z∅ | Z bulk status | J bulk result |
| `POST /api/admin/projects/bulk/delete` | Z∅ | Z∅ | Z bulk delete | J bulk result |
| `POST /api/admin/projects/submit` | Z∅ | Z∅ | M payload/files | J `201` submit |
| `POST /api/admin/projects/:id/assets` | Z positive ID | Z∅ | M asset | J `201` asset |
| `PATCH /api/admin/projects/:id/poster` | Z positive ID | Z∅ | Z canonical asset ID | J poster |
| `DELETE /api/admin/projects/:id/webgl` | Z positive ID | Z∅ | N | 204 + E |
| `POST /api/admin/projects/:id/members` | Z positive ID | Z∅ | Z member body | J `201` member |
| `PATCH /api/admin/projects/:id/members/:memberId` | Z positive IDs | Z∅ | Z member body | 204 + E |
| `DELETE /api/admin/projects/:id/members/:memberId` | Z positive IDs | Z∅ | N | 204 + E |
| `PATCH /api/admin/projects/:id/members/swap` | Z positive ID | Z∅ | Z canonical member IDs | 204 + E |
| `POST /api/admin/projects/:id/game-upload-sessions` | Z positive ID | Z∅ | Z safe integer bytes | J `201` session |
| `PUT /api/admin/game-upload-sessions/:sessionId/chunks/:index` | Z session/nonnegative index | Z∅ | O | J chunk |
| `GET /api/admin/game-upload-sessions/:sessionId` | Z session | Z∅ | — | J status |
| `POST /api/admin/game-upload-sessions/:sessionId/complete` | Z session | Z∅ | N | J complete |
| `DELETE /api/admin/game-upload-sessions/:sessionId` | Z session | Z∅ | N | 204 + E |
| `GET /api/admin/projects/:id/game-upload-sessions` | Z positive ID | Z∅ | — | J session list |
| `GET /api/admin/banned-ips` | Z∅ | Z∅ | — | J banned list |
| `DELETE /api/admin/banned-ips/:id` | Z positive ID | Z∅ | N | 204 + E |
| `GET /api/admin/settings` | Z∅ | Z∅ | — | J settings |
| `PATCH /api/admin/settings` | Z∅ | Z∅ | Z settings | J settings |
| `POST /api/admin/import/preview` | Z∅ | Z∅ | M JSON file | J preview |
| `POST /api/admin/import/execute` | Z∅ | Z∅ | M JSON file | J import result |
| `POST /api/admin/export` | Z∅ | Z∅ | Z export body | J export result |
| `GET /api/admin/export/status` | Z∅ | Z∅ | — | J export progress |

합집합은 명시 route 57개다. 실제 `NODE_ENV=production` graph는 dev-auth 2개를 제외한 55개이며, GET 21개에서 파생되는 synthetic HEAD 21개는 같은 schema를 재사용한다. 모든 현재 route는 machine-readable inventory에 존재하고, inventory 밖 route와 서로 다른 contract를 섞은 method-array route는 schema slot을 직접 제공해도 등록되지 않는다. Multipart는 collector, octet-stream은 scoped parser, redirect/stream은 Fastify raw reply가 body serialization을 소유하며 나머지 relevant input과 JSON/error response에는 unknown fallback이 없다.

## 7. 이전 `fixed/accepted` 판정 재검증

| 이전 판정 대상 | 재검증 결과 | 근거 |
|---|---|---|
| BackendContext/composition root | `open` | H-01, M-01, M-02. production feature graph가 context 밖이다. |
| project access 분리 | `open` | pure policy/service는 생겼지만 `project-access.ts:63`이 global repository를 직접 조립하고 controller가 singleton 함수를 import한다. policy 단위 테스트만 존재한다. |
| multipart HTTP/application 분리 | `open` | `MultipartCommandInput`과 coordinator port는 유효하나 controller/runtime/global limiter·FS wiring이 context 밖이다. production route-tree 주입 테스트가 없다. |
| storage↔orphan cycle 제거 | `verified-fixed` | `application/object-deletion.ts`로 import cycle이 제거됐고 dependency-cruiser cycle 0, coordinator/reaper 단위 테스트가 통과한다. durable queue failure는 별도 M-08이다. |
| game upload state/recovery | `open` | H-02의 source 보존/restart 연쇄는 `verified-fixed`다. 다만 actual repository active-slot 경쟁과 전체 production wiring은 M-01/M-06 및 티켓 012 범위로 남아 있다. |
| COMPLETING active slot 교체 거부 | `open` | repository guard와 serializable transaction은 있으나 테스트는 repository가 예외를 던지도록 mock한 service test뿐이다. 실제 repository concurrency/409 production wiring이 증명되지 않았다. |
| WebGL pointer swap/rollback | `verified-fixed` (H-02 경계) | DB pointer 실패 시 public tree만 rollback하고 protected source를 보존하며 새 instance recovery가 성공한다. 전체 game-upload/WebGL composition과 actual fault matrix는 티켓 012/015에서 별도로 검증한다. |
| project poster clear CAS | `verified-fixed` (좁은 query) | `assets/repository.ts:58`의 `updateMany({id, posterAssetId})`와 query-shape test가 있다. 전체 asset/poster workflow는 H-03으로 `open`이다. |
| service의 FastifyReply 제거 | `verified-fixed` | service/serializer/state-machine에서 Fastify import 0, response descriptor 단위/route tests가 통과한다. |
| serializer env/ORM 누출 제거 | `open` | pure serializer factory는 유효하지만 `serializer.runtime.ts`가 env singleton을 캡처하고 context 밖이다. |
| import dynamic Prisma 제거 | `verified-fixed` (dependency) | service는 `ImportRepository`를 받고 adapter가 transaction을 소유한다. 실제 rollback Docker test는 아직 없다. |
| export lock/file 원자성 | `open` | sibling temp+rename과 abort/lock 단위 테스트는 통과하나 progress store와 FS/S3/env가 module runtime singleton이며 context 수명 요구를 위반한다. |
| auth/OAuth/session 주입과 PII 로그 | `verified-fixed` (auth slice) | 티켓 006에서 runtime을 제거하고 실제 auth/dev-auth controller와 auth plugin이 context의 단일 repository/OAuth/config/clock/ID/logger graph를 공유한다. production route-tree가 login/logout, 실패·expiry·A/B 격리와 PII 비기록을 검증했다. M-01 전체는 다른 slice 때문에 `open`이다. |
| settings store 주입 | `open` | service port는 생겼지만 global cache와 sticky defaults, 미사용 warmup이 남는다(M-03). |
| upload/download limiter 수명 | `open` | factory 단위 테스트는 있으나 production은 process singleton이고 context 간 격리/owner close가 없다. |
| lifecycle/scheduler/shutdown | `open` | drain 로직 단위는 있으나 process lifecycle 공유, startup partial failure, S3 close, 두 app close가 증명되지 않았다. |
| HTTP route schema | `verified-fixed` | 가능한 명시 route 57개(상시 production 55개 + dev-auth 2개), synthetic HEAD 21개의 machine-readable inventory와 endpoint별 runtime contract를 실제 production graph에서 검증했다. unknown route와 mixed method-array 우회도 registration에서 거부되며 세 독립 검증자가 최신 snapshot을 PASS 판정했다. |
| logger/request context/PII | `verified-fixed` (요청 상관관계/로그 payload) | request ID propagation과 auth credential/identifier 비노출 테스트가 있다. logger 자체 수명은 M-02다. |
| feature service/repository port 분리 | `open` | 여러 pure factory는 생겼지만 repository global export와 17 runtime singleton이 production 경로를 지배한다. |
| game upload DB invariant | `verified-fixed` | CHECK migration이 있고 fresh 13 migration Docker deploy와 Prisma validate가 통과했다. repository의 string API 정리는 별도 구조 과제다. |
| lint/architecture/CI | `open` | 명령은 통과하지만 rule이 composition 위반을 허용한다(M-07). CI integration은 정상 smoke이지 fault matrix가 아니다. |
| module mock 감소 | `open` | 현재 실제 수치는 43회/13파일이다. 감소 자체는 완료 증명이 아니며 production graph test가 없다. |
| response schema Low backlog | `verified-fixed` | JSON/error/no-content/redirect/stream family의 strict runtime response contract를 실제 Fastify happy/drift injection과 service wire로 검증했다. WebGL 음수 synthetic ID, legacy link와 error-code enum 반증도 회귀로 고정했고 독립 response 검증자가 승인했다. |
| process-local lock/cache accepted | `open` | 사용자의 명시적 단일 replica 승인 기록이 없고, 이번 요구의 context 격리와 충돌한다. |
| repository/runtime compatibility export accepted | `open` | 사용자의 승인 없이 요구사항 위반을 accepted 처리했다. global Prisma/runtime alias를 제거해야 한다. |
| 실제 DB/S3 fault matrix backlog | `open` | WebGL에서 실제 오류가 발견됐고 production 보상 증명에 필요한 테스트이므로 단순 Low backlog가 아니다. |

## 8. 테스트하기 어려운 기능과 누락 실패 시나리오

| 기능 | 현재 테스트가 증명하는 것 | 증명하지 못하거나 잘못 고정한 것 |
|---|---|---|
| BackendContext | injected health/session fake와 단일 shutdown callback | production context, 실제 controller tree, resource 생성·격리·owner close |
| controller/routes | 일부 route를 module mock으로 characterise | controller factory에 fake port를 넣은 전체 route tree, registration I/O 없음 |
| banned IP | limiter/service 단위 동작 | DB warmup 실패 시 fail-open 방지, refresh/retry, 두 context cache 격리 |
| settings | factory cache update/invalidate | production startup warmup, DB 실패 후 sticky default 회복 |
| asset/poster | poster clear `updateMany` query shape | delete↔GAME replace, delete↔setPoster 실제 transaction race |
| exhibition poster | 순차 upload/rollback/delete | concurrent replace/clear의 orphan·last-writer consistency |
| game active slot | fake repository가 completion-in-progress 예외를 던질 때 409/abort | actual Prisma serializable race와 active slot invariant |
| game/WebGL complete | missing/duplicate/head outage와 normal happy path | deploy 성공→DB 실패→source 보존→restart 성공; 현재 test는 잘못된 전체 cleanup을 기대 |
| orphan deletion | S3 delete 실패→queue 성공, reaper retry | S3와 queue DB가 동시에 실패한 뒤 caller DB state/reconcile |
| import | schema/contract와 adapter transaction 구조 | 중간 create 실패의 실제 PostgreSQL 전체 rollback/동시 slug contention |
| export | fake S3/FS에서 lock, abort, sibling temp cleanup | 실제 filesystem rename 오류, S3 중단, context별 progress 격리 |
| auth/session | domain, bad token, PII, idle/absolute helper, touch failure | 실제 controller가 injected context clock/OAuth/config를 쓰는지 |
| shutdown | lifecycle helper와 app resource callback 하나 | active stream disconnect, partial startup, scheduler/S3/Prisma close exactly once |
| route schema | 가능한 57/production 55 inventory, family별 input rejection, JSON/error/204/redirect/stream/CORS response와 parser media-type 회귀 | 신규 endpoint가 inventory guard와 family 회귀 없이 추가되는 경우 |
| Docker smoke | fresh migration, 정상 auth/S3 multipart/WebGL/range/delete와 concurrent complete winner | DB/S3 강제 실패, restart recovery, multi-context/process, asset/poster concurrency |

## 9. 현재 구조 → 목표 구조 → 완료 증명

| 현재 구조 | 목표 구조 | 완료를 증명할 필수 테스트 |
|---|---|---|
| `createProductionBackendContext`가 singleton alias 반환 | config를 받아 Prisma/S3/cache/limiter/lifecycle/repository/service/controller를 새로 만드는 resource factory | context A/B 상태 불공유; A close가 B에 영향 없음; 각 owned resource exactly once close |
| controller가 runtime/env import | `createXController({service, config})` | fake adapter + 실제 controller factory + 전체 route prefix 조립; controller import 시 env/DB/S3/timer 0 |
| repository가 global Prisma export | `createXRepository(client)`만 export | static forbidden rule; 서로 다른 fake/real client로 독립 adapter contract |
| assets plugin 등록 중 ban DB load | route 등록은 순수, runner의 명시적 warmup | registration I/O 0; warmup 성공/실패 정책과 retry 검증 |
| settings 첫 실패 defaults 영구 cache | context-owned cache + 명시적 warmup/TTL/retry | 첫 실패 뒤 DB 복구가 실제 제한 반영; 두 cache 독립 |
| WebGL DB 실패 시 source+site cleanup | **완료:** public site rollback과 protected source 삭제 operation 분리 | deterministic DB pointer fault 뒤 source 존재/COMPLETING, 새 instance restart 후 COMPLETED, public partial tree 없음; production rollback bucket/prefix 직접 검증 |
| asset/poster check-then-act | transaction/lock/CAS 기반 state mutation | delete↔replace/setPoster barrier concurrency에서 pointer/status/object invariant |
| year poster 기본 isolation | locked/serializable pointer swap + loser cleanup | 두 replace/clear 동시 실행 후 DB key 1개와 orphan 0 |
| orphan DB 기록 실패를 삼킴 | durable outbox 또는 실패 전파+reconcile | S3 delete+queue write 동시 실패에도 완료 상태 오기록 없음 |
| global onRoute의 unknown fallback | endpoint contract schema와 inventory 밖 route 등록 거부 | 가능한 명시 route 57개(상시 production 55개)의 relevant input과 response negative tests |
| 부분 architecture rule | composition-aware forbidden rule | controller→runtime/env, repo→global Prisma fixture가 CI에서 실패 |
| module mock/fake service 중심 | production graph contract + DB/S3 fault integration | 기존 upload/WebGL/export/auth 실패 분기가 새 production wiring에서도 동일 통과 |

## 10. 후속 구현 PR 순서와 독립 완료 조건

한 PR에서 여러 feature를 한꺼번에 옮기지 않는다. 외부 API, DB wire 의미, S3 key는 유지한다.

아래 6개 단계는 상위 묶음이다. 실제 merge 순서는 [`docs/backend-audit-tickets/README.md`](backend-audit-tickets/README.md)의 000~015 티켓을 따른다. H-02의 복구 원본 삭제는 구조 이전을 기다리지 않는 000 긴급 수정으로 앞당겼다. 각 티켓은 한 구현 에이전트·한 PR을 원칙으로 하며, 별도 검증자가 production 경로와 실패 테스트를 확인하기 전에는 `verified-fixed`로 바꾸지 않는다.

1. **Stateful resource factory와 실제 production composition root**
   - Prisma/S3/lifecycle/settings/upload/download limiter/export progress/logger/clock/UUID factory와 idempotent ownership/close를 도입한다.
   - context A/B 격리, owner-only reverse close, partial construction cleanup 테스트가 통과해야 한다.
2. **Assets/banned-IP vertical slice, controller factory, 명시적 startup warmup**
   - plugin registration DB I/O를 제거하고 ban warmup 실패 정책을 고정한다.
   - 실제 assets controller factory route test와 warmup 실패 테스트가 통과해야 한다.
3. **Auth/public/project/member/year/settings/import/export wiring 이전**
   - controller runtime/env import와 repository global Prisma export를 각 slice에서 제거한다.
   - 이 단계에서 H-03, M-03, M-04의 transaction/concurrency 테스트를 함께 완료한다.
4. **Game-upload/WebGL/orphan/multipart workflow wiring 이전**
   - public site rollback과 protected recovery source 보존을 분리하고 orphan durable failure 정책을 고정한다.
   - DB 실패→restart recovery와 S3/DB fault test가 통과해야 한다.
5. **Runtime singleton·compatibility alias 제거와 architecture guard 강화**
   - 17 runtime singleton, `gameDownloadLimiter` alias, controller→runtime/env, repo→global Prisma를 제거한다.
   - dependency rule self-test와 module-global inventory가 0을 보여야 한다.
6. **Production graph, DB/S3 integration, 감사 종결**
   - fake external adapter로 실제 route tree 전체를 조립하고, fresh PostgreSQL/Garage에서 concurrency/fault/restart matrix를 실행한다.
   - 모든 runtime/resource/route family와 본 문서의 open 항목이 새 증거로 `verified-fixed`가 되어야 한다.

## 11. 재실행한 기준선

| 명령/질의 | 결과와 한계 |
|---|---|
| `npm test` | 통과: API 58 files/484, Web 17/86, contracts 2/22; 총 592. production composition 증거는 아님. |
| `npm run lint` | API type-aware ESLint+`tsc --noEmit`, Web ESLint 통과. |
| `npm run build` | contracts/API/Web production build 통과. |
| `npm run architecture` | 174 modules, 440 dependencies, violation 0. 현재 rule 공백은 M-07. |
| dependency-cruiser JSON graph query | modules 174, dependency edges 440, reported violations 0. |
| 별도 import inventory | 티켓 007 직후 runtime 파일 12개; controller runtime import 8파일; controller env import 4파일. direct Prisma와 최종 singleton 수치는 티켓 013에서 다시 확정한다. |
| module mock inventory | `vi.mock(` 43회/13파일. 이전 문서의 42회/12파일 수치는 부정확했다. |
| `npm audit --audit-level=high` | 0 vulnerabilities. |
| Prisma validate | NixOS 기본 실행은 존재하지 않는 `linux-nixos` engine checksum 404로 실패. 설치된 7.9.0 `schema-engine-debian-openssl-3.0.x`를 `PRISMA_SCHEMA_ENGINE_BINARY`로 지정하면 schema valid. |
| `npm run test:integration` (빈 compose 상태) | 새 volume 생성, 13 migration deploy, seed, PostgreSQL/Garage/API/Web 기동, host smoke와 e2e smoke 모두 통과. 정상 multipart, missing chunk, concurrent complete, WebGL deploy/range/delete를 검증한다. |
| `npm run testenv:clean` | integration container/network/volume을 모두 제거했다. |

CI의 verify/integration job은 위 정상 기준선을 자동화한다. 그러나 production graph test, startup warmup test, 실제 DB/S3 fault injection, asset/poster concurrency, restart recovery 연쇄는 현재 CI에 없다.

## 12. 감사 종료 조건

다음이 모두 충족되기 전에는 테스트가 전부 통과해도 감사를 완료로 판정하지 않는다.

- 남은 runtime singleton과 모든 stateful resource의 생성자·사용자·owner·close가 production composition root에 명시된다.
- 실제 controller factory/route tree가 fake external adapter와 조립되는 production graph 테스트가 존재한다.
- controller 등록은 DB/S3/timer 작업을 하지 않고 명시적 startup만 warmup한다.
- 서로 다른 두 context는 limiter, settings cache, lifecycle, export progress를 공유하지 않는다.
- context 종료는 자신이 생성한 resource만 정확히 한 번 닫고 다른 context에 영향을 주지 않는다.
- controller→runtime/env, repository→global Prisma가 정적 rule로 금지된다.
- WebGL DB 실패 복구 원본, asset/poster/year 경쟁, orphan durable failure가 실제 DB/S3 또는 동등한 fault harness로 증명된다.
- 가능한 명시 route 57개(상시 production 55개)의 relevant params/query/body/response runtime contract가 분류·검증된다.
- 본 문서의 `open`이 모두 production 증거와 함께 `verified-fixed`로 바뀌고, 근거 없는 `fixed/accepted/backlog`가 하나도 남지 않는다.
