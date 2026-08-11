# 백엔드 전수 감사 최종 검증 보고서

> 이전 판본의 최초 종결 선언은 production composition 증거가 부족해 무효 처리됐다. 이 판본은 티켓 000~014의 현재 코드, 티켓 015의 전체 production graph 재검증과 티켓 016의 dependency advisory 해소 결과만을 근거로 다시 판정한다.

## 1. 기준과 판정 규칙

- 최종 검증일: 2026-08-11
- 코드 기준: ticket 014 커밋 014403b, ticket 015 검증과 ticket 016 dependency remediation
- 범위: apps/api, packages/contracts, Prisma migration, PostgreSQL/Garage integration, 관련 Web build와 dependency graph
- 외부 HTTP payload, Prisma wire 의미와 S3 key 형식은 변경하지 않았다.
- 티켓 015는 production behavior를 새로 설계하지 않고 기존 구현 주장을 반증하는 검증 gate로만 사용했다.

| 상태 | 의미 |
|---|---|
| verified-fixed | production 코드 경로와 실패 분기 테스트 또는 강제 guard가 함께 존재한다. |
| open | 실제 위반, 검증 공백 또는 현재 dependency advisory가 남아 있다. |
| accepted | 사용자가 명시적으로 승인한 운영 제약이다. 이번 판정에는 0건이다. |
| backlog | 요구사항을 위반하지 않는 Low 개선이다. 이번 판정에는 0건이다. |

service fake, 빈 route plugin 또는 전체 테스트 통과만으로 production composition을 인정하지 않았다.

## 2. 결론

기존 재감사의 H-01~H-04, M-01~M-08, L-01은 모두 현재 production 코드와 실패 테스트로 verified-fixed다. 특히 한 BackendContext가 config에서 시작해 실제 55개 production route, controller, service, repository와 external adapter를 조립하며, 두 context의 limiter, settings, lifecycle, export progress, ban cache, scheduler와 close 경계가 분리됨을 다시 검증했다.

ticket 016은 clean install에서 발견한 dependency advisory D-01도 실제 사용 경로의 호환성 검증과 함께 해소했다.

- 전체 dependency graph와 production-only graph 모두 audit 0이다.
- Prisma, Fastify/URL parser, Web router와 image processor를 안전 버전으로 올렸다.
- 최신 `pdf-to-img`가 취약 PDF.js를 고정하는 경로는 patched PDF.js override와 정상/embedded-JavaScript/손상 PDF 실제 raster test로 검증했다.
- API Docker image의 Linux Sharp/libvips binary pin도 같은 안전 버전으로 맞췄다.

따라서 H-01~H-04, M-01~M-08, L-01, D-01은 모두 verified-fixed이며 저장소 전체 감사를 종결한다. accepted/backlog로 낮춘 항목은 없다.

## 3. Finding 최종 판정

| ID | 최종 production 증거 | 실패·회귀 증거 | 상태 |
|---|---|---|---|
| H-01 | backend-context.ts#createProductionBackendContext가 context별 Prisma, S3, storage, settings, limiter, lifecycle, feature graph와 실제 route tree를 조립한다. | production-resource-ownership.test.ts의 full graph A/B test가 등록 I/O 0, 55 route, warmup, 격리와 owner-only close를 한 harness에서 검증한다. | verified-fixed |
| H-02 | WebGL public rollback과 protected recovery source terminal deletion이 별도 operation이다. | webgl-completion.test.ts, webgl-deployment-compensation.test.ts와 game-upload-production.postgres.test.ts가 DB pointer 실패 뒤 source 보존과 새 graph recovery를 검증한다. | verified-fixed |
| H-03 | asset delete/GAME replace/setPoster는 bounded Serializable transaction, row lock, CAS와 durable outbox를 사용한다. | asset-poster-concurrency.postgres.test.ts 5개와 orphan-durability.postgres.test.ts가 실제 PostgreSQL 경쟁 및 이중 실패를 검증한다. | verified-fixed |
| H-04 | assets/banned-IP controller는 context graph와 명시적 startup warmup을 사용한다. | assets-banned-production-wiring.test.ts가 등록 I/O 0, fail-closed, warmup 실패, A/B cache와 close를 검증한다. | verified-fixed |
| M-01 | project multipart, game upload를 포함한 모든 feature가 composition factory를 통해 context resource를 받는다. runtime compatibility consumer는 0이다. | full graph test, project-multipart-production-wiring.test.ts, game-upload-production-wiring.test.ts와 architecture inventory가 실제 controller route를 검증한다. | verified-fixed |
| M-02 | BackendResourceOwner가 owned/borrowed lease, start, reverse close와 exactly-once promise를 소유하고 server runtime은 signal만 소유한다. | production-resource-ownership.test.ts와 server-runtime.test.ts가 partial construction/start, 동시 close, signal/listen 실패와 S3/Prisma exactly-once close를 검증한다. | verified-fixed |
| M-03 | context-owned cached settings store가 bounded warmup/TTL/retry/close를 제공하고 같은 instance가 project/year/game upload에 주입된다. | project-member-settings-production-wiring.test.ts와 실제 game route의 낮은 maxGameFileMb 회귀가 실패 후 회복과 A/B 격리를 검증한다. | verified-fixed |
| M-04 | exhibition poster mutation은 locked Serializable transaction과 durable cleanup intent를 사용한다. | year-poster-concurrency.postgres.test.ts 7개와 year-production-wiring.test.ts가 경쟁, abort, limiter, storage/DB/outbox/temp 실패를 검증한다. | verified-fixed |
| M-05 | ROUTE_RUNTIME_CONTRACTS가 가능한 명시 route 57개와 production route 55개의 input/response schema를 소유한다. | http-route-runtime-contracts.test.ts가 57/55/21 inventory, family별 negative input, response drift와 parser 400/415를 실제 Fastify injection으로 검증한다. | verified-fixed |
| M-06 | fake external adapter를 넣되 실제 createProductionBackendContext, default route loader와 controller factory를 조립하는 full graph harness가 존재한다. | production slice 12파일/110 tests와 새 full graph lifecycle test가 empty route 없이 production graph를 실행한다. vi.mock은 legacy characterization 12회/5파일로 제한된다. | verified-fixed |
| M-07 | architecture guard와 dependency-cruiser가 controller→runtime/env/global resource, repository→global Prisma, feature runtime과 stateful singleton을 금지한다. | 금지 fixture 16개가 실제 exit 1, 허용 factory/port runner 2개가 exit 0이며 production graph violation은 0이다. | verified-fixed |
| M-08 | 일반 delete+queue 이중 실패는 전파되고 commit 후 cleanup 경로는 exact/prefix outbox를 transaction 안에 기록한다. | orphan unit/reaper tests와 실제 PostgreSQL fault 5개가 nonterminal/committed state 및 재시도 가능성을 검증한다. | verified-fixed |
| L-01 | year, ID, chunk, byte count는 canonical safe integer만 받고 numeric-looking slug는 명시적으로 분리된다. | validation, public-years, game upload와 route runtime contract test가 suffix/sign/decimal/exponent/overflow를 거부한다. | verified-fixed |
| D-01 | Prisma/Fastify/Web router/Sharp와 lockfile 전이 의존성을 안전 버전으로 갱신하고, `pdf-to-img@6.2.0`에는 `pdfjs-dist@6.2.108`을 강제한다. Docker Linux Sharp/libvips pin도 함께 정렬했다. | clean install의 전체/production audit 0, media processor 4 tests, Docker Prisma generate/validate/build와 전체 unit/integration이 통과한다. | verified-fixed |

## 4. Production object graph와 resource 수명

~~~
runProductionServer(config)
  → createProductionBackendContext(config)
      → context-owned external resources
      → feature composition factories
      → actual BackendRoutes
  → buildApp({ context })
      → plugins + schemas + actual route tree
  → context.start()
      → settings warmup
      → banned-IP warmup
      → stale upload recovery
      → protected-download and maintenance schedules
  → app/server close
      → BackendResourceOwner reverse close, exactly once
~~~

### 4.1 Resource ownership matrix

| Resource | 생성/조립 위치 | 상태와 start | close owner | 최종 판정 |
|---|---|---|---|---|
| Env | server/app가 loadEnv 결과를 context에 전달 | immutable context config | 해당 없음 | context input |
| Logger | createRootLogger(config) | context별 logger/child logger | close 불필요 | isolated |
| Prisma client/pool | createPrismaClientForDatabase | context별 DB adapter | BackendResourceOwner → $disconnect | owned |
| S3 client/socket | createS3Client(config) | context별 client, construction socket I/O 0 | BackendResourceOwner → destroy | owned |
| ObjectStorage | createObjectStorage(context S3) | context bucket/config adapter | S3 owner가 transport 종료 | owned adapter |
| FileSystem/processing | createNodeFileSystem, createNodeProjectUploadProcessing | stateless adapter; request workflow가 temp cleanup | workflow/context close 대기 | context port |
| Google verifier | createGoogleTokenVerifier | context별 OAuth client | close 불필요 | isolated |
| Clock/ID | production-ports factories | context별 deterministic seam | close 불필요 | isolated |
| Scheduler | createNodeScheduler | task handle은 각 owning resource가 start에서 생성 | dependent resource close가 cancel | isolated |
| Settings cache | createPrismaSettingsStore | explicit warmup, TTL/retry/invalidate | store close | owned |
| Upload limiter | createUploadLimiterPort | context-local semaphore | limiter close | owned |
| Lifecycle | createLifecyclePort | context-local state/in-flight | lifecycle close | owned |
| Protected limiter/ban cache | createProtectedDownloadLimiter | explicit timer start, DB ban warmup | close/cancel | owned |
| Export progress/lock | createExportProgressStore | context-local active export | importExport settle 후 store close | owned |
| Import/export workflow | createImportExportProductionGraph | active export/abort tracking | graph close | owned |
| Game/WebGL/orphan workflow | createGameUploadProductionGraph | explicit stale recovery, active work tracking | graph close | owned |
| Maintenance schedule | createMaintenanceSchedule | explicit purge/reaper timers | cancel 후 in-flight settle | owned |
| Fastify app | buildApp(context) | request lifecycle, route/plugins | onClose → context.close | owner bridge |
| Signal runner | createServerRuntime | SIGTERM/SIGINT와 drain sequence | handler removal, app/context close | runner-owned |

등록 순서는 logger, clock, IDs, scheduler, filesystem, verifier, Prisma, S3, storage, settings, upload limiter, lifecycle, protected limiter, export progress, assets warmup, import/export, game workflow, maintenance schedule다. close는 이 순서의 역순이며 borrowed lease는 시작하거나 닫지 않는다.

### 4.2 Runtime/compatibility inventory

| Inventory | 최종 값 |
|---|---:|
| feature runtime files | 0 |
| controller runtime imports | 0 |
| controller env imports | 0 |
| repository global Prisma imports | 0 |
| non-composition stateful imports | 0 |
| feature runtime imports | 0 |
| production architecture violations | 0 |
| stateful allowlist | request-scoped AsyncLocalStorage 1개 |

## 5. Production graph와 실패 matrix 증거

| 영역 | 실제 production graph 증거 |
|---|---|
| 전체 graph | production-resource-ownership.test.ts가 fake Prisma/S3/storage/filesystem/OAuth/clock/ID/scheduler로 두 개의 default production context와 app을 조립한다. |
| registration | context construction와 buildApp 등록 전후 DB/S3/storage/timer call 0, production route 55개 존재를 확인한다. |
| startup | settings warmup, banned DB load, stale COMPLETING sweep와 context별 scheduler 3개가 explicit start에서만 실행된다. |
| isolation/close | limiter, lifecycle, ban cache, export progress, settings가 A/B에서 분리되고 A close가 A timer/S3/Prisma만 한 번 닫는다. B health route는 계속 동작한다. |
| feature wiring | assets, auth, public, project/member/settings, year, import/export, multipart, game/WebGL의 각 production-wiring test가 실제 controller factory와 prefix를 사용한다. |
| server | import side-effect 0, startup/listen/signal race, drain과 close 오류가 server-runtime.test.ts에 고정됐다. |
| DB 경쟁/fault | asset 5, year 7, orphan durability 5, import transaction 2, game upload/recovery 4개가 실제 PostgreSQL transaction을 사용한다. |
| Garage protocol | integration smoke/E2E가 multipart, missing chunk, concurrent complete, WebGL deploy/CSP/CORS/Range/encoding/delete를 실제 Garage에서 검증한다. |
| HTTP contract | health/auth/public/assets/admin/me/game/import/export 전체 family를 actual Fastify injection으로 검증한다. |

## 6. HTTP runtime contract matrix

### 6.1 Route family

| Family | 가능한 명시 route |
|---|---:|
| CORS | 1 |
| Health | 2 |
| Auth | 3 |
| Dev auth | 2 |
| Public WebGL | 6 |
| Public data | 5 |
| Assets | 3 |
| Me project | 1 |
| Admin exhibitions | 6 |
| Admin projects | 10 |
| Admin members | 4 |
| Game upload | 6 |
| Admin banned IP | 2 |
| Admin settings | 2 |
| Admin import | 2 |
| Admin export | 2 |
| 합계 | 57 |

production은 dev-auth 2개를 제외한 55개다. GET 21개에서 synthetic HEAD 21개가 파생된다.

### 6.2 Boundary classification

| Body boundary | 수 |
|---|---:|
| none | 34 |
| JSON | 15 |
| multipart | 6 |
| octet-stream | 1 |
| CORS plugin | 1 |

| Response boundary | 수 |
|---|---:|
| JSON | 36 |
| no-content | 13 |
| stream | 3 |
| redirect | 3 |
| errors-only | 1 |
| CORS plugin | 1 |

모든 route에 params/query/response 분류가 있고 JSON/octet route에는 body schema가 있다. multipart와 raw stream은 handler parser 책임을 명시하며 z.unknown fallback은 없다.

## 7. 이전 open 항목의 해소

| 이전 open 주장 | 현재 증거 | 판정 |
|---|---|---|
| BackendContext가 singleton alias만 반환 | context별 resource와 모든 feature graph를 직접 생성한다. | verified-fixed |
| project access/controller가 global repository 사용 | project access/repository factory identity가 multipart/game consumer까지 공유된다. | verified-fixed |
| multipart가 global limiter/FS/runtime 사용 | context port와 실제 admin/me route resource-guard tests가 존재한다. | verified-fixed |
| game active slot은 fake 예외만 검증 | 실제 PostgreSQL COMPLETING replacement와 concurrent CAS를 검증한다. | verified-fixed |
| serializer가 env runtime 캡처 | createProjectSerializer(baseUrl)만 사용하고 runtime 파일은 없다. | verified-fixed |
| export progress/FS/S3가 module singleton | context-owned import/export graph와 A/B close/abort/atomic rename tests가 있다. | verified-fixed |
| settings first-failure sticky default | bounded retry/TTL/reload와 actual upload consumer가 같은 store를 사용한다. | verified-fixed |
| limiter/lifecycle/scheduler가 process-global | factory가 context별 instance를 만들고 full graph A/B test가 분리를 검증한다. | verified-fixed |
| feature runtime/repository compatibility export | architecture inventory 0, 금지 fixture가 회귀를 차단한다. | verified-fixed |
| architecture rule 공백 | guard 10개, dependency-cruiser 6개 금지 fixture와 허용 fixture가 실행된다. | verified-fixed |
| module mock 중심 | module mock 12회/5파일, production wiring과 full graph test가 별도 증거를 제공한다. | verified-fixed |
| process-local lock/cache accepted 필요 | production feature lock/cache가 context별로 격리돼 예외 승인이 필요 없다. | verified-fixed |
| DB/S3 fault matrix가 backlog | 실제 PostgreSQL fault/concurrency와 Garage protocol smoke로 분리 검증한다. | verified-fixed |

## 8. D-01 dependency advisory 해소

ticket 016에서 다음 경로를 안전 버전으로 갱신했다.

- API/Prisma graph: Prisma CLI/client/adapter 7.9.1, @prisma/dev 0.24.17, find-my-way 9.7.0, valibot 1.4.2
- API route/schema graph: Fastify 5.11.3, fast-uri 3.1.5/4.1.2
- 실제 PDF upload processing: pdf-to-img 6.2.0 + pdfjs-dist 6.2.108 override
- 실제 image processing: sharp 0.35.3, Docker Linux sharp 0.35.3/libvips 1.3.2
- Web router: react-router-dom/react-router 7.18.2
- 전체 build graph: brace-expansion 1.1.18/5.0.9, js-yaml 4.3.1, nanoid 3.3.18, postcss 8.5.26

`npm audit fix --force`의 PDF converter downgrade나 검증 없는 major 변경은 사용하지 않았다. PDF.js override는 정상 PDF, embedded JavaScript action 비실행, 손상 PDF 거부를 실제 raster processor에서 검증했고 Sharp는 정상/손상 image decode 경계와 Debian image에서 함께 검증했다.

재현, 버전 선택과 완료 증거는 backend-audit-tickets/016-current-dependency-advisories.md에 고정했다.

## 9. 최종 검증 기준선

| 명령/질의 | 결과 |
|---|---|
| production graph 집중 suite | 12 files / 110 tests 통과 |
| npm test | API 671, Web 86, contracts 26 통과; PostgreSQL 조건부 23개 skip |
| npm run lint | API type-aware ESLint/tsc와 Web ESLint 통과 |
| npm run architecture | runtime/import inventory 0, self-test 18 runners 통과, 176 modules/354 dependencies violation 0 |
| npm run build | contracts, API, Web production build 통과 |
| Prisma generate/validate | host NixOS는 존재하지 않는 linux-nixos engine URL 때문에 실행 불가; Debian API builder의 clean install에서 Prisma 7.9.1 generate/build/schema validate 통과 |
| npm audit --audit-level=high | 0 vulnerabilities |
| npm audit --omit=dev --audit-level=high | 0 vulnerabilities |
| npm run test:integration | Garage smoke/E2E 통과; PostgreSQL orphan 5, asset 5, year 7, import 2, game/recovery 4 통과 |
| npm run testenv:clean | 이번 실행의 container, network와 volume 제거 완료; compose ps 0 확인 |

## 10. 감사 종료 판정

다음 구조 조건은 모두 충족됐다.

- 모든 stateful resource의 생성자, 사용자, start와 close owner가 production composition root에 명시된다.
- actual controller factory와 55-route production tree가 fake external adapter로 조립된다.
- registration은 DB/S3/timer I/O가 없고 explicit startup만 warmup/recovery/schedule을 수행한다.
- 두 context의 state와 owned close가 격리된다.
- runtime/env/global Prisma/singleton 회귀가 정적 guard로 차단된다.
- WebGL recovery, asset/year 경쟁, orphan durability, import transaction과 game upload CAS가 실제 PostgreSQL 또는 명시적 storage fault harness로 검증된다.
- 가능한 route 57개와 production route 55개의 input/response runtime contract가 고정된다.

D-01을 포함한 모든 finding이 verified-fixed이고 전체 검증 기준선이 다시 통과했다. accepted 또는 backlog 예외 없이 저장소 전체 감사를 종결한다.
