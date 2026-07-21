# 백엔드 전수 감사 결과

감사 기준일은 2026-07-21이며, 기준선은 `a6275f1` (`Add secure Unity WebGL hosting`)을 포함한 당시 워킹트리다. 외부 URL, 정상 요청·응답 envelope, DB 모델의 의미, 기존 migration, S3 key 형식은 유지했다. 다만 완료 중인 업로드를 새 세션으로 교체하는 경쟁 요청은 데이터 유실 방지를 위해 이제 `409 CONFLICT`로 거절한다.

목표 구조는 다음과 같은 실용적 3계층과 작은 port다.

`Fastify controller → application service/use-case → repository / external-system port`

Fastify의 plugin 캡슐화와 schema 경계, Prisma의 의존성 주입 단위 테스트와 실제 DB 통합 테스트를 기준으로 삼았다. 범용 DI container, generic repository, Spring식 계층 복제는 도입하지 않았다.

## 결론

- 발견한 High 8건과 Medium 14건은 모두 `fixed`다.
- Low 4건은 현재 단일 API replica라는 운영 가정과 외부 계약 호환성을 근거로 `accepted` 또는 `backlog`로 남겼다.
- API 테스트는 49파일/445개에서 58파일/484개로 늘었다. 숫자보다 중요한 변화는 production module mock이 90회/27파일에서 42회/12파일로 감소한 것이다.
- `npm test`는 API 484개, Web 86개, contracts 22개를 통과한다.
- Docker 통합 환경에서 13개 migration, PostgreSQL, Garage multipart, 누락 chunk, 동시 complete, WebGL 배포·range·삭제를 검증했다.
- 전체 workspace dependency audit 결과는 취약점 0건이다. Prisma CLI/client/adapter는 동일한 7.9.0으로 맞췄고, lockfile의 React Router와 transitive build/test 의존성도 advisory가 해소된 호환 버전으로 갱신했다.

## 기준선과 최종 수치

| 지표 | 기준선 | 최종 |
|---|---:|---:|
| API test files | 49 | 58 |
| API tests | 445 | 484 |
| `vi.mock` 호출 | 90 | 42 |
| `vi.mock` 사용 파일 | 27 | 12 |
| application service의 Fastify/Prisma/env/S3 직접 import | 다수 | 0, architecture rule로 차단 |
| controller의 repository/Prisma 직접 import | 존재 | 0, architecture rule로 차단 |
| 순환 의존성 | `storage → orphan → storage` | 0, dependency-cruiser로 차단 |
| workspace dependency advisory | Prisma CLI 및 Web/transitive 계열 포함 | 0 |
| JSON/params/query/response schema slot | 대부분 없음 | 모든 route에 존재; 좁은 response runtime schema는 Low backlog |

테스트 수는 Vitest 실행 결과를, mock 수는 `^\s*vi\.mock\(` 정규식의 실제 호출만 집계했다.

## 감사 항목

| 심각도 | 파일·심볼 | 증거 | 위반된 경계 | 테스트하기 어려웠던 기능 | 수정 방식 | 추가 테스트 | 상태 |
|---|---|---|---|---|---|---|---|
| High | `src/app.ts#buildApp`, `src/server.ts#main` | production singleton과 background repository가 조립 코드 밖에서 생성되고 server가 Prisma/use-case를 직접 호출 | composition/application 경계 우회 | DB/S3/clock/request-id/shutdown 실패를 격리하기 어려움 | `BackendContext`, production port, `BackgroundMaintenance`, 지연 production import 도입 | `backend-context.test.ts`, Docker health/migration smoke | fixed |
| High | `modules/admin/project/controller.ts`, `modules/me/project/controller.ts`, 기존 `project-access.ts` | controller가 repository 흐름을 직접 조립하고 접근 제어가 Fastify user와 Prisma를 동시에 앎 | controller → repository, framework → ORM 누출 | owner/member/operator/admin 분기와 거부 분기 | framework-neutral `Actor`, `createProjectAccessService`, `createProjectAccessRepository`로 분리 | `project-access.test.ts`, `admin-project-list-*.test.ts`, integration auth/session | fixed |
| High | 기존 project submit/asset, year poster, asset upload 흐름 | raw `request.parts()`, temp FS, 변환, S3, DB rollback이 한 함수에 혼재 | HTTP adapter와 application workflow 혼합 | limit 초과, 중단 stream, S3 성공 뒤 DB 실패, temp cleanup | `MultipartCommandInput`, collector/pipeline/coordinator port, `*.adapter.ts`, service factory로 분리 | `project-submit-routes.test.ts`, `project-asset-upload-resource-guards.test.ts`, `upload-finalizer.test.ts`, `file-validator.test.ts` | fixed |
| High | `lib/storage.ts`, 기존 orphan service | storage가 orphan service를 역참조하고 orphan이 다시 storage를 참조 | infrastructure 순환, 보상 정책이 storage에 침투 | 삭제 실패 queue와 reaper 실패·재시도 | `application/object-deletion.ts` coordinator와 `object-deletion.ts` production adapter 도입 | `object-deletion.test.ts`, `orphan-service.test.ts` | fixed |
| High | `game-upload/complete-session.service.ts`, `session-maintenance.service.ts`, `repository.ts` | complete/recovery 중복, 상태 문자열 임의 갱신, S3 결과 불명 시 PENDING 복귀, transient DB 오류에도 원본 삭제 | workflow/state/transaction 경계 불명확 | missing/duplicate/concurrent complete, S3 complete 뒤 DB 실패, restart repair | 명시적 state machine, CAS, 공통 finalizer, terminal validation 오류와 recoverable infra 오류 분리, boot repair 재사용 | `game-upload-state-machine.test.ts`, `webgl-completion.test.ts`, `game-upload-recovery.test.ts`, integration concurrent complete | fixed |
| High | `game-upload/repository.ts#createSessionReplacingActive` | 새 session이 `COMPLETING` session을 `CANCELLED`로 바꿀 수 있어 완료 객체가 복구 대상에서 이탈 | state machine과 repository transaction 불일치 | create/complete 경쟁과 orphan source | serializable transaction에서 COMPLETING active slot 교체 거부, 새 multipart 보상 abort, 409 반환 | `game-upload-resource-guards.test.ts` | fixed |
| High | `webgl/deployment.ts`, public WebGL service, game finalizer | 배포 파일 쓰기, project pointer swap, 이전 tree 삭제의 원자성·보상 순서가 흩어짐 | S3/DB orchestration 누출 | 부분 배포, pointer DB 실패, 이전 배포 cleanup 실패 | deployment descriptor, 공통 completed-upload finalizer, pointer CAS transaction, 새 tree rollback과 이전 tree orphan queue | `upload-finalizer.test.ts`, `webgl-completion.test.ts`, `webgl-deletion.test.ts`, Docker WebGL smoke | fixed |
| High | `assets/repository.ts#clearPosterIfMatches` | 함수명과 달리 poster 조건 없이 update했고 DB 오류를 삼킴; 동시 poster 교체를 지울 수 있음 | repository 원자성 위반 | asset 삭제와 poster 교체 경쟁 | `updateMany({ id, posterAssetId })` compare-and-set으로 변경하고 오류 전파 | `assets-repository.test.ts` | fixed |
| Medium | `assets/service.ts`, `public/webgl.service.ts` | application service가 `FastifyReply`로 header/status/stream을 직접 기록 | HTTP framework 누출 | range/redirect/CSP/404를 service 단위로 검증하기 어려움 | `{ status, headers, body, location }` response descriptor 반환, controller adapter만 reply 처리 | `protected-asset-download.test.ts`, `public-webgl.test.ts` | fixed |
| Medium | `project/serializer.ts` 및 기존 serializer | URL mapper가 `env()`를 직접 읽고 repository payload에 결합 | configuration/ORM 누출 | URL/base 변경, WebGL key 유효성 | `createProjectSerializer(baseUrl)`와 명시적 serializable DTO | `serialize-project.test.ts` (module mock 5개 제거) | fixed |
| Medium | `admin/import/service.ts`, `repository.ts` | service 안의 dynamic Prisma import와 transaction 세부 구현 | application → ORM 누출 | 전체 rollback, slug 충돌, preview/execute 분리 | `ImportRepository`, transaction-scoped adapter factory와 runtime 조립 | `import-schema.test.ts`, `import-project-detail-contract.test.ts` | fixed |
| Medium | `admin/export/service.ts`, 기존 export 전역 변수 | module-global lock/progress, 직접 FS/S3/time/UUID, destination 직접 쓰기 | application과 process/FS 인프라 혼합 | abort, 재실행, partial file, lock 해제 | `InMemoryExportProgressStore`, pure service, sibling temp + atomic rename file adapter | `export-service.test.ts`, `export-file-adapter.test.ts`, `webgl-export.test.ts` | fixed |
| Medium | `auth/service.ts`, `plugins/auth.ts`, `shared/session.ts` | OAuth/env/time/repository singleton, touch 실패 후 cookie 연장, credential·email 가능 로그 | application → env/OAuth/DB 및 PII 운영 경계 | hosted-domain, token 오류, idle/absolute expiry, touch 실패 | verifier/clock/repository/session store 주입, cookie는 touch 성공 때만 갱신, 고정 진단 필드만 로그 | `auth-domain.test.ts`, `backend-context.test.ts`, `session*.test.ts`, `dev-auth.test.ts` | fixed |
| Medium | `shared/site-settings.ts`, settings service/runtime | cache와 Prisma가 service 경계에 숨고 테스트가 module mock에 의존 | application → global cache/ORM | cache invalidate/update, 설정 기반 upload limit | `SettingsStore` port와 injected settings service/runtime | `site-settings-upload.test.ts`, `backend-context.test.ts` | fixed |
| Medium | `shared/upload-limits.ts`, `download-rate-limit.ts`, `protected-download-limiter.ts` | process-global counters/cache/timer와 `Date.now` 고정 | lifecycle/time 경계 누출 | concurrency release, window expiry, shutdown timer cleanup | limiter port, injected clock/scheduler, lazy process adapter, BackendContext shutdown resource | `upload-limits.test.ts`, `download-rate-limit.test.ts`, `backend-context.test.ts` | fixed |
| Medium | `lib/lifecycle.ts`, `server.ts` | hidden process lifecycle/timers와 direct background calls | server/application 경계 혼합 | drain timeout, scheduler cancel, startup recovery | injectable lifecycle delay/time, scheduler tasks, maintenance port, close resource 역순 정리 | `concurrency-guards.test.ts`, `backend-context.test.ts`, Docker restart/startup path | fixed |
| Medium | `shared/http-route-schemas.ts`, 모든 controller | JSON route 56개에 Fastify schema가 사실상 없고 controller parser에만 의존 | HTTP validation/serialization 경계 누락 | handler 전 validation과 일관된 400 envelope | Zod compiler와 global `onRoute` schema hook, contracts 기반 body/query, params/header slot, normalized error mapper | `backend-context.test.ts`, `validation.test.ts`, route characterization tests | fixed |
| Medium | logger/request context/auth logs/cleanup catch | request-id 전파가 약하고 일부 오류·PII 또는 cleanup 오류가 삼켜짐 | 운영 진단 경계 | OAuth 실패, session touch, rollback/temp cleanup 추적 | `AppLogger`, AsyncLocalStorage child logger, `x-request-id`, safe error type logging, cleanup warn/error | `request-context.test.ts`, `auth-domain.test.ts`, `export-file-adapter.test.ts` | fixed |
| Medium | project/year/member/banned-ip/public service와 repository | service가 repository module type/Prisma payload를 알고 production module mock이 필요 | application → adapter/ORM 타입 누출 | CRUD 실패·권한 분기를 fake로 구성하기 어려움 | 기능별 port DTO, `createXService(deps)`, repository factory, 얇은 runtime adapter | `admin-year-service.test.ts`, `admin-project-list-service.test.ts`, `banned-ip-service.test.ts`, `public-years.test.ts` | fixed |
| Medium | `prisma/schema.prisma`, game upload migration | status가 임의 문자열이고 양수 size/part 제약이 DB에 없음 | DB가 domain invariant를 보장하지 않음 | out-of-band writer, concurrent invalid state | status/sizes/part number CHECK migration 추가, application state machine과 일치 | Prisma validate/generate, fresh PostgreSQL migration, state-machine tests | fixed |
| Medium | API lint/architecture/CI | API ESLint와 cycle/layer guard, migration/S3 integration job이 없음 | 회귀 방지 경계 누락 | `any`, floating promise, 새 cycle/direct import를 review에 의존 | type-aware ESLint, dependency-cruiser forbidden rules, CI verify + PostgreSQL/Garage integration | 로컬 lint/architecture/build/audit/integration 전체 통과 | fixed |
| Medium | API test suite 전반 | 90개 module mock이 import graph와 전역 singleton을 복제 | 테스트가 production wiring에 결합 | 실제 실패 분기보다 mock shape 유지에 비용 발생 | fake port/service 주입으로 42개까지 축소; 남은 것은 HTTP wiring/legacy characterization 위주 | 신규 service/adapter/context 테스트 9파일 | fixed |
| Low | `shared/http-route-schemas.ts#schema.response` | response slot은 전 route에 있으나 호환성 때문에 `z.unknown()` | runtime response narrowing 미완료 | 잘못된 response field를 runtime에서 차단하지 못함 | TS `@pcu/contracts` 응답 타입은 유지; endpoint별 response Zod는 점진 도입 | 현재 build/route characterization | backlog |
| Low | `InMemoryExportProgressStore`, upload/download cache/lock | lock/cache가 process-local | 다중 replica 조정 부재 | replica 간 중복 export/limit 불일치 | 현재 단일 API container 가정으로 명시; Redis/DB lease port로 대체 가능 | process-local 동작 단위 테스트 | accepted |
| Low | 일부 production repository/runtime adapter | application은 port를 받지만 몇 adapter export는 module-level Prisma singleton을 보존 | adapter 조립이 완전히 BackendContext 한곳에 모이지 않음 | adapter 자체 교체에는 factory/runtime 변경 필요 | service 경계는 차단했고 신규/high-risk repository는 factory 사용; 외부 import 호환 때문에 wrapper 유지 | architecture guard + fake-port service tests | accepted |
| Low | fault-injected Docker matrix | 실제 PostgreSQL/Garage smoke는 핵심 transport와 concurrency를 검증하지만 DB/S3 강제 장애의 모든 조합은 fake-port 테스트 | 실제 장애 주입 harness 부재 | S3 성공 뒤 DB 실패 등 transport별 재현 | 결정 분기는 unit fake port, 실제 protocol은 Docker smoke로 분리 | recovery/finalizer/object-deletion unit + Docker smoke | backlog |

## 1. 표준적이거나 합리적이지 않았던 파일 전체 목록과 근거

아래 목록은 단순히 변경된 파일 전체가 아니라, 기준선에서 책임 혼합·역방향 의존·전역 수명·무결성 위험을 실제로 가진 파일 전체다.

| 파일 | 기준선 문제 |
|---|---|
| `apps/api/src/app.ts` | production singleton 생성, request-id/error/schema/shutdown 조립 지점 부재 |
| `apps/api/src/server.ts` | Prisma, orphan, upload recovery와 timer를 직접 호출 |
| `apps/api/src/lib/storage.ts` | 삭제 실패 때 orphan application service를 역참조해 cycle 생성 |
| `apps/api/src/lib/lifecycle.ts` | process-global state와 실제 time/delay 고정 |
| `apps/api/src/lib/logger.ts`, `lib/request-context.ts` | request logger와 root logger 경계가 불명확 |
| `apps/api/src/modules/admin/project-access.ts` | 접근 정책, Fastify user, Prisma 조회가 한 모듈에 혼재 |
| `apps/api/src/modules/admin/project/controller.ts`, `modules/me/project/controller.ts` | 접근 조회와 upload orchestration을 controller가 직접 수행 |
| `apps/api/src/modules/admin/project/service.ts`, `project-submit.service.ts`, `project-asset.service.ts`, `serializer.ts`, `slug.service.ts`, `asset-cleanup.ts` | repository/config/upload/storage 책임과 ORM payload가 application에 누출 |
| `apps/api/src/modules/admin/project/repository.ts` | 다수 query/transaction의 전역 Prisma 결합과 암시적 반환 타입 |
| `apps/api/src/modules/admin/year/controller.ts`, `year/service.ts`, `year/repository.ts` | poster multipart, FS/S3, DB 보상과 HTTP가 혼재 |
| `apps/api/src/modules/assets/controller.ts`, `assets/service.ts`, `assets/repository.ts` | reply 직접 조작, 접근/ban/storage/delete 흐름 혼재, poster clear 경쟁 조건 |
| `apps/api/src/modules/assets/upload/upload.service.ts` | temp FS, validation, 변환, S3 commit/rollback을 하나의 service가 직접 수행; adapter임에도 service 이름 사용 |
| `apps/api/src/modules/assets/upload/multipart-collector.ts`, `pdf-processing.ts`, `video-processing.ts` | raw multipart/FS 작업 및 cleanup 오류 진단 부족 |
| `apps/api/src/modules/public/controller.ts`, `public/service.ts`, `public/webgl.service.ts` | Fastify reply/stream, env, storage query가 application 흐름에 결합 |
| `apps/api/src/modules/webgl/deployment.ts` | protected source, public tree, DB pointer 보상이 completion과 분리 |
| `apps/api/src/modules/admin/game-upload/controller.ts` | raw stream parser와 workflow 설정 혼재 |
| `apps/api/src/modules/admin/game-upload/service.ts`, `create-session.service.ts`, `upload-chunk.service.ts`, `complete-session.service.ts`, `session-maintenance.service.ts`, `session-loader.ts`, `session-sizing.ts` | 상태 전이·시간·UUID·S3·DB가 암시적으로 결합되고 normal/recovery orchestration 중복 |
| `apps/api/src/modules/admin/game-upload/repository.ts` | string state, broad update, active-slot 경쟁, transaction 경계가 외부에 노출 |
| `apps/api/src/modules/admin/import/service.ts`, `import/repository.ts` | service의 dynamic Prisma import와 transaction 세부 누출 |
| `apps/api/src/modules/admin/export/controller.ts`, `export/service.ts`, `export/repository.ts` | env path, module-global lock/progress, S3/FS/time/UUID 직접 접근 |
| `apps/api/src/modules/admin/member/controller.ts`, `member/service.ts`, `member/repository.ts` | controller/repository 결합과 Prisma payload 중심 service |
| `apps/api/src/modules/admin/banned-ip/controller.ts`, `banned-ip/service.ts`, `banned-ip/repository.ts` | DB와 process cache 동기화를 module singleton이 조립 |
| `apps/api/src/modules/admin/settings/controller.ts`, `settings/service.ts`, 기존 `settings/repository.ts` | settings cache/DB/env가 중복 계층에 분산 |
| `apps/api/src/modules/auth/controller.ts`, `auth/service.ts`, `auth/repository.ts`, `plugins/auth.ts` | OAuth/env/time/session DB/cookie와 PII 로그가 결합 |
| `apps/api/src/modules/dev-auth/controller.ts` | production auth runtime/config에 직접 결합 |
| `apps/api/src/modules/orphan/service.ts`, `orphan/repository.ts` | storage cycle, clock와 Prisma singleton 결합 |
| `apps/api/src/shared/site-settings.ts`, `upload-limits.ts`, `protected-download-limiter.ts`, `download-rate-limit.ts`, `session.ts` | 숨은 DB/cache/counter/timer/env/time process state |
| `apps/api/src/plugins/cookie.ts`, `cors.ts`, `csrf.ts`, `multipart.ts`, `rate-limit.ts` | 설정을 기본 `env()`로 숨겨 조립 경계 밖에서도 production config 생성 |

## 2. 구조 때문에 테스트하기 어려웠던 기능과 누락됐던 실패 시나리오

| 기능 | 기준선에서 어려웠던 이유 | 누락·취약했던 실패 시나리오 | 현재 증명 |
|---|---|---|---|
| project 접근/CRUD | Fastify user와 Prisma 조회가 결합 | linked member 허용, unrelated user 거부, status update 권한 | pure policy/service + route tests |
| project/year multipart | request stream, temp FS, 변환, S3, DB가 한 객체 | stream abort, slot release, temp cleanup, S3 commit 뒤 DB rollback | fake upload coordinator와 resource-guard tests |
| asset 삭제 | S3 삭제와 DB poster/status 순서가 암시적 | poster 동시 교체 CAS, playback object cleanup 실패 | repository CAS test + deletion service tests |
| game chunk upload | global limiter와 repository module mock 필요 | 중단 body, short chunk, S3 실패 뒤 slot release, retry | `game-upload-resource-guards.test.ts` |
| game complete | 상태 전이와 S3 완료 결과가 분리되지 않음 | missing chunk, duplicate/concurrent complete, outcome unknown | unit tests + actual Docker concurrent complete |
| restart recovery | normal complete와 별도 코드, storage error를 not-found로 취급 | S3 complete 뒤 DB failure, head outage, invalid archive cleanup | `game-upload-recovery.test.ts`와 공통 finalizer |
| WebGL deploy | public upload와 pointer swap/cleanup 결합 | partial deploy, DB swap failure, old tree cleanup failure | finalizer/completion/deletion tests + Docker smoke |
| storage delete compensation | storage와 orphan이 순환 | queue write 실패, reaper retry/backoff | object-deletion/orphan tests |
| export | module-global lock와 직접 destination write | concurrent start, abort, partial file 노출, retry/cleanup | export service/file adapter tests |
| import | dynamic Prisma import | transaction 전체 rollback, slug collision | import schema/contract tests와 transaction adapter |
| OAuth/session | OAuth client, time, DB, cookie가 고정 | bad token, hosted-domain 거부, idle/absolute expiry, touch DB failure | auth/session/context/dev-auth tests |
| settings/limiter | process cache/timer를 import할 때 생성 | cache update, timer shutdown, deterministic window expiry | settings/upload/download/context tests |
| HTTP boundary | handler 내부 parse만 존재 | handler 진입 전 schema 거부, 일관된 error envelope | injected BackendContext route test |
| observability | logger singleton과 PII-rich 오류 | request-id 누락, cleanup/session 오류 무진단 | request-context/auth/export tests |

## 3. Before/after 파일·테스트 대응표

| Before | After | 책임 이동 | 증명 테스트 |
|---|---|---|---|
| `app.ts`, `server.ts`의 singleton 조립 | `backend-context.ts`, `application/ports.ts`, `infrastructure/production-ports.ts` | production 생성과 background maintenance를 composition root로 | `backend-context.test.ts`, health smoke |
| `storage.ts ↔ orphan/service.ts` | `application/object-deletion.ts`, `object-deletion.ts`, `orphan/runtime.ts` | storage는 object operation만, coordinator가 queue 보상 | `object-deletion.test.ts`, `orphan-service.test.ts` |
| Fastify/Prisma 결합 `project-access.ts` | `project-access.ts` pure policy/service + `project-access.repository.ts` | 접근 정책과 DB adapter 분리 | `project-access.test.ts` |
| project service의 repository/env payload | `project/ports.ts`, `runtime.ts`, `serializer.runtime.ts` | application DTO와 production adapter 분리 | admin project service/route/serializer tests |
| raw multipart project submit | `application/http-input.ts`, `upload-ports.ts`, `project-submit.service.ts`, `project-submit.runtime.ts` | HTTP parts adapter와 upload use-case 분리 | project submit/resource guard tests |
| 단일 asset upload의 FS/S3/DB 혼합 | `project-asset-upload.adapter.ts`, `project-asset.service.ts`, `project-asset.runtime.ts` | temp 수집은 adapter, 보상은 coordinator/service | project asset resource guard tests |
| exhibition poster service의 raw request/FS | `year/poster-upload.adapter.ts`, `year/ports.ts`, `year/runtime.ts` | poster lifecycle port 주입 | `admin-year-service.test.ts` |
| `assets/upload/upload.service.ts` | `assets/upload/upload.adapter.ts` | 인프라 작업을 정확히 adapter로 명명·격리 | file validator/video/resource tests |
| asset/public service의 `FastifyReply` | `shared/response-descriptor.ts`, controller reply adapter | service는 framework-neutral descriptor 반환 | protected asset/public WebGL tests |
| game completion/recovery 중복 | `state-machine.ts`, `finalize-completed-upload.service.ts`, `complete-session.service.ts`, `session-maintenance.service.ts` | 정상/재시작이 같은 finalizer와 상태 규칙 사용 | state-machine/finalizer/recovery/completion tests |
| active upload broad status update | repository serializable CAS + `ActiveUploadCompletionInProgressError` | COMPLETING 보존, 새 multipart abort | game upload resource guard test |
| 문자열 상태만 있는 DB | `20260721010000_game_upload_state_constraints/migration.sql` | DB CHECK로 상태/양수 invariant 보장 | Prisma validate + fresh Docker migration |
| import service의 dynamic Prisma | `import/repository.ts#createImportRepository`, `import/runtime.ts` | transaction adapter 주입 | import contract/schema tests |
| export global lock/직접 file write | `export/service.ts`, `export/file.adapter.ts`, `export/runtime.ts` | progress store와 atomic file adapter 분리 | export service/file tests |
| auth service/plugin singleton | `auth/service.ts#createAuthService`, `auth/runtime.ts`, injected auth plugin | verifier/clock/session store/config 주입 | auth-domain/context/session tests |
| settings repository/cache 중복 | `settings/service.ts`, `settings/runtime.ts`, `SettingsStore` | cache는 production adapter, service는 port만 | site settings tests |
| eager protected limiter | lazy `protected-download-limiter.ts`, injected-clock `download-rate-limit.ts` | import side effect 제거, shutdown 명시 | download limiter/context tests |
| route별 schema 부재 | `shared/http-route-schemas.ts` + Zod compiler | HTTP 조립 경계에서 schema 일괄 부착 | backend context/validation/route tests |
| 수동 review에 의존한 경계 | `eslint.config.js`, `.dependency-cruiser.cjs`, CI workflow | lint/cycle/layer/audit/integration 자동 차단 | lint/architecture/CI 명령 |

## 외부 계약과 무결성 변경

- URL, 정상 응답 envelope, S3 bucket/key layout, public WebGL URL, 기존 migration은 변경하지 않았다.
- Fastify error mapper는 기존 `{ ok: false, error: { code, message, details? } }` envelope를 유지한다.
- multipart와 stream route는 body를 JSON schema로 잘못 해석하지 않고 params/query/header/response slot만 적용한다.
- 완료 중인 동일 종류 upload를 교체하려는 요청만 새로 `409 CONFLICT`가 된다. 이전 동작은 완료 객체를 orphan으로 만들 수 있어 호환성보다 무결성을 우선했다.
- 새 migration은 기존 string column을 enum으로 바꾸지 않고 CHECK만 추가하므로 Prisma payload와 wire contract는 그대로다.

## 검증 결과

| 명령 | 결과 |
|---|---|
| `npm run lint -w apps/api` | ESLint type-aware 규칙 + `tsc --noEmit` 통과 |
| `npm run architecture -w apps/api` | cycle/layer 위반 0 |
| `npm test -w apps/api` | 58 files, 484 tests 통과 |
| `npm test` | API 484 + Web 86 + contracts 22 통과 |
| `npm run build` | contracts/API/Web production build 통과 |
| `prisma generate` / `prisma validate` | Prisma Client 7.9.0 생성, schema valid |
| `npm audit --audit-level=high` | 전체 workspace 0 vulnerabilities |
| `npm run test:integration` | PostgreSQL + Garage host/e2e smoke 모두 통과 |

로컬 NixOS에서는 Prisma가 존재하지 않는 `linux-nixos` precompiled schema-engine URL을 요청했다. 동일 7.9.0 commit의 설치된 `schema-engine-debian-openssl-3.0.x`를 `PRISMA_SCHEMA_ENGINE_BINARY`로 지정해 generate/validate했고, Debian 기반 Docker/CI에서는 기본 generate가 통과했다.

## CI와 rollback

CI `verify`는 install → Prisma generate → 전체 test → lint → architecture → workspace audit → build 순서다. 이후 별도 `integration` job이 PostgreSQL과 Garage를 띄우고 항상 volume까지 정리한다.

코드 rollback은 논리 단계별로 context/ports, feature runtime, upload state machine 순서의 revert가 가능하다. 새 DB 제약만 되돌릴 때는 다음 SQL이면 충분하다.

```sql
ALTER TABLE "game_upload_parts"
DROP CONSTRAINT IF EXISTS "game_upload_parts_part_number_check";

ALTER TABLE "game_upload_sessions"
DROP CONSTRAINT IF EXISTS "game_upload_sessions_sizes_check";

ALTER TABLE "game_upload_sessions"
DROP CONSTRAINT IF EXISTS "game_upload_sessions_status_check";
```

이 rollback은 데이터나 S3 object를 변환하지 않는다. 외부 key migration도 없으므로 별도 object rollback은 필요하지 않다.

## 남은 Low 작업

1. endpoint별 Zod response schema를 추가해 현재 `z.unknown()` runtime response slot을 좁힌다.
2. API를 다중 replica로 확장할 때 export lock, download ban cache, upload limiter, scheduler leader를 Redis/DB lease 구현으로 교체한다.
3. legacy production repository wrapper를 기능별 factory만 export하도록 점진 정리한다.
4. Docker fault proxy 또는 test-only failure port를 추가해 DB/S3 오류 조합도 실제 transport 환경에서 반복한다.
