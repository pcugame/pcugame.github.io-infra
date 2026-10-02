# Production release 구조 조사와 정리 기준

> 분류: 특정 시점의 구조 조사와 과거 전환 기록. 본문의 현재 구조·정리 권고는 아래 조사 기준 커밋의 기록이다. 후속 release 정리를 반영한 운영 절차는 [production 배포 절차](../../operations/deployment.md), 현재 원칙은 [architecture](../../architecture/README.md)를 참조한다.

일반 release 기능과 과거 Phase 1 → Phase 2 전환 기능이 같은 배포 경로에 결합되어 있다. 전환 명령은 정리 대상이지만, 현재 일반 배포에서도 사용하는 migration 실행·이력 검증·백업·복구 기능은 유지해야 한다.

- 조사일: 2026-10-02
- 조사 기준: `29e360d3152d505d0ae2d7f1e39ca950fcea0df8`
- 조사 범위: README, 전체 GitHub workflow, `server/deploy.sh`와 release 보조 도구, deployment 문서, Prisma migration 코드
- 검증 범위: 저장소 정적 조사. 운영 서버·DB·GitHub 설정과 실제 배포 revision은 조회하지 않았다. 조사 중 배포·migration·테스트를 실행하지 않았다.

이 문서의 현재 구조는 조사 기준 커밋의 구현을 의미한다. 과거 배포 기록은 현재 운영 상태의 증거로 사용하지 않는다. 일반 실행 절차는 [production 배포 절차](../../operations/deployment.md), 최초 전환 기록은 [기존 migration 기록](../../operations/manual-release.md), migration 변경 기준은 [database migration policy](../../database-migration-policy.md)를 따른다.

## 현재 release 흐름

| 구성 | 구현된 역할 |
| --- | --- |
| [PR Checks](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/.github/workflows/pr-checks.yml) | migration 정책·배포 경계·test·lint·architecture·build와 PostgreSQL/Garage 통합 검증 |
| [Build API Release Image](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/.github/workflows/deploy-api.yml) | master의 대상 경로 변경 시 이미지 빌드·게시. source SHA와 구성을 검증한 digest manifest 보관. 운영 적용은 수행하지 않음 |
| [Deploy Release](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/.github/workflows/release-api-cutover.yml) | 수동 production 배포 진입점. 기본 `phase=release`와 `snapshot`, `preflight`, `phase1`, `phase2`, `phase2-forward-fix` 제공 |
| [Deploy Web to GitHub Pages](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/.github/workflows/deploy-web-pages.yml) | 수동 Web 단독 게시. production 환경과 release 동시 실행 잠금 공유 |
| [Update Phase 1 Runtime](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/.github/workflows/release-phase1-video-update.yml) | 기존 Phase 1 runtime 추가 업데이트. 정확한 dispatched master SHA와 Phase 1 marker 요구 |

일반 `phase=release`는 다음 순서로 수행된다.

1. 정확한 master SHA의 검증된 이미지 manifest를 조회한다. 보관된 결과가 없으면 기존 build workflow로 이미지를 생성한다.
2. Web을 검증·빌드하고 이전 Pages 상태를 보관한다.
3. 이미지와 DB의 Phase 2 호환성을 검사하고 온라인 DB 백업·격리 복원 검증을 수행한다.
4. API·worker를 중지하고 쓰기가 중지된 상태에서 추가 DB 백업을 생성한다.
5. 같은 SHA의 Web을 게시하고 실제 `release-sha.txt`를 확인한다.
6. migration을 적용하고 API·worker를 기동한다.
7. smoke test와 실행 이미지의 source SHA·digest 확인 결과를 기록한다.

주요 구현은 `release-api-cutover.yml`의 `resolve_image`, `build_image`, `cutover` job과 [이미지 resolver](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/server/resolve-release-image.mjs)에 있다. Web 대상은 `pcugame/pcugame.github.io`의 `master`이다. 일반 release도 Web과 API를 함께 배포하며 서비스 중지 구간을 포함한다.

## 일반 release 기능

| 기능 | 판단과 근거 |
| --- | --- |
| 정확한 source SHA와 불변 image digest 연결 | 유지. build 성공과 실제 운영 적용의 구분 |
| API·worker·migration 이미지 일치 | 유지. 서로 다른 버전의 실행·DB 변경 방지 |
| 환경·용량·DB 호환성 사전 검사 | 유지. 가능한 실패 조건을 서비스 중지 전에 확인 |
| 쓰기 프로세스 중지와 중지 상태 확인 | 유지. 현재 Web/API 전환과 migration 순서의 전제 |
| DB 백업·격리 복원 검증 | 유지. 최초 전환 이후에도 필요한 복구 기능 |
| migration과 runtime 시작 분리 | 유지. 컨테이너 재시작이 DB 변경을 유발하지 않음 |
| migration 시도 전후의 복구 구분 | 유지. 호출 오류가 SQL 미적용을 의미하지 않음 |
| 배포 후 smoke와 source/digest 기록 | 유지. 실제 적용 결과 확인 |
| migration history 보호·실제 DB 테스트 | 유지. 특정 Phase와 무관한 정책 |

[release-db-snapshot.sh](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/server/release-db-snapshot.sh)는 설명에 Phase 2 observation이 남아 있지만 일반 release에서도 호출한다. 온라인 dump·격리 복원 시험과 쓰기 중지 후 dump는 목적이 다르다. 온라인 snapshot만으로 이후 DB 쓰기나 Garage 객체 변경까지 동결하지는 않는다. DB dump와 Garage inventory에는 객체 파일 내용이 포함되지 않는다.

[release-recovery.mjs](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/server/release-recovery.mjs)와 [pages-release-recovery.mjs](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/server/pages-release-recovery.mjs)는 일반 배포의 migration 시도 전 복구 기능이다. 기존 Pages 제공 상태를 검증한 후 보관된 컨테이너 ID를 복구한다. migration 시도 표시 이후에는 자동으로 구형 runtime을 시작하지 않는다.

## systemd와 Podman 책임

컨테이너 실행, 프로세스 재시작, 부팅 시 기동, 종료 순서, 네트워크·volume·tmpfs·NAS mount와 자원 제한은 호스트 runtime 관리 영역이다. 이미지 선택·배포 승인·Web 게시·DB 전환 여부 판단은 release 제어 영역이다.

[deploy.sh](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/server/deploy.sh)의 `do_up`은 PostgreSQL·API·6개 worker를 같은 pod에 구성한다. 기존 PostgreSQL을 포함한 pod를 재생성하되 `gp_pg_data` volume은 보존한다. API port는 기본 loopback에 bind한다. worker는 같은 API 이미지를 사용하고, 작업별 tmpfs와 export용 NAS mount를 구분한다. startup은 schema를 검사하지만 migration을 적용하지 않는다.

현재 스크립트는 `--restart unless-stopped`로 컨테이너를 실행한 뒤 `podman generate systemd --new`로 user unit을 생성하고 restart 제한을 추가하여 enable한다. 저장소에는 고정된 서비스 unit이 없다.

다음은 운영 호스트 확인이 필요한 사항이다.

- unit 생성과 enable 실패를 일부 무시한다. 배포 성공만으로 systemd 관리 상태를 입증할 수 없다.
- 생성한 unit의 명시적 start와 user lingering 설정은 스크립트에 없다.
- `drain`·`down`은 systemd unit 중지 없이 Podman을 직접 조작한다. 활성 unit과 유지보수 작업이 충돌하는지는 미확인이다.

상시 서비스 정의와 release 작업의 분리를 권고한다. 기존 restart·unit 생성 코드는 실제 관리 주체와 재부팅 후 기동 상태를 확인하고 대체 구성을 검증한 뒤 정리해야 한다.

## GitHub Actions 책임

Actions는 PR 검증, artifact 빌드·게시, master와 배포 대상 확인, production environment 연결, 동시 실행 제한, 정확한 SHA의 artifact 선택, Web/API 배포 순서와 결과 기록을 담당하는 것이 적절하다. DB 변경의 세부 구현은 Prisma/release CLI, 컨테이너 실행은 호스트에 유지한다.

현재 workflow의 긴 SSH shell에는 최초 전환 정책과 일반 release 정책이 혼재한다. 호출 순서를 보존하면서 전환 전용 분기를 분리할 수 있다. 단순히 중복된 검사처럼 보인다는 이유로 사전 검사와 쓰기 중지 후 재검사를 합치지 않는다.

YAML의 `environment: production`은 확인하였지만 실제 승인자·required checks·branch protection 설정은 미확인이다. [verify-github-release-boundaries.mjs](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/server/verify-github-release-boundaries.mjs)의 `control` 검사는 저장소·default branch·ref 확인이며 PR 승인 상태 검사가 아니다. Pages 검사는 대상 저장소의 활성 상태·default branch·토큰 쓰기 권한을 확인한다.

## Phase 전환 전용 기능과 잔여 의존성

| 대상 | 전환 전용 성격 |
| --- | --- |
| `phase1` 배포 분기 | expand·backfill·관측 시작·Phase 1 재기동 |
| `release-phase1-video-update.yml`과 대응 shell | contract 이전 Phase 1의 추가 업데이트 |
| Phase 1 rollback nonce·인증 파일 | contract 이전 구형 이미지 복귀 장치 |
| `phase1-observation`과 24시간 zero-fallback 확인 | canonical 전환 관측 조건 |
| `observation_exception_id`와 exception profile | 최초 contract 전환의 관측 예외 승인 생성 |
| canonical backfill·contract preflight·cutover report | legacy 데이터 이관과 전환 완료 판단 |
| canonical correction 도구 | legacy 자산 구조에 의존하는 수정 경로 |

관련 도구는 `apps/api/scripts`, `apps/api/src/modules/migration`, `server/deploy.sh`, `server/release-online-preflight.sh`에 분산되어 있다. correction은 contract에서 제거하는 `storage_key`, playback 필드 등에 의존하므로 일반 Phase 2 복구 도구로 간주할 수 없다. Garage inventory 자체는 운영 점검에도 재사용할 수 있어 전환 전용 호출과 구현을 구분해야 한다.

### 일반 migration과 전환 명령의 결합

[release-migrate.ts](../../../apps/api/scripts/release-migrate.ts)의 `apply-contract`는 최초 전환뿐 아니라 이후 이미지에 포함된 최신 migration까지 적용한다. 일반 release도 이 명령을 사용한다. 파일 전체를 제거하려면 후속 migration 실행과 호환성 검사를 대체해야 한다.

예외 경로를 사용한 DB는 `exceptionReceipt`에서 해당 SQL checksum과 승인·실행 기록을 검증한다. 이후 `stagedMigrate`는 원래 contract 대신 DB에 기록된 alternate 경로를 구성한다. 전환이 완료되었다는 이유로 `contract-migration-paths`나 receipt 검증을 삭제하면 후속 release가 실패할 수 있다.

기존 `apps/api/prisma/migrations`, `apps/api/prisma/contract-migration-paths`, 최상위 `prisma/migrations`의 SQL과 기록은 보존한다. 신규 migration의 기준 위치는 `apps/api/prisma`이다. 적용되었거나 적용 가능성이 있는 SQL과 DB receipt는 정리 편의를 위해 수정하지 않는다.

`phase2-forward-fix`는 이미 contract가 적용된 DB에서 새 이미지를 기동하는 복구 경로이다. 일반 release로 복구 요구를 대체할 수 있는지 확인하기 전에는 일회성 코드로 분류하여 삭제하지 않는다.

### 동시 정리 대상

전환 명령을 제거할 때는 workflow 호출, `server/deploy.sh` 명령·artifact 검사, API package script·`tsconfig.release.json`, 이미지 구성 검사, PR Checks의 전용 테스트를 함께 정리해야 한다. 현재 이미지 검증은 전환용 CLI의 존재도 요구한다. 기존 migration 이력의 재현성을 검증하는 SQL·통합 테스트는 별도로 유지한다.

## README와 구현의 불일치

다음은 조사 기준 커밋의 README 배포 설명과 실제 구현을 비교한 결과이다. 후속 문서 정리에서 [README 배포 설명](../../../README.md#배포-구조)을 수정하고 [production 배포 절차](../../operations/deployment.md)를 분리하였다. 아래 표는 수정 전 조사 기록이다.

| README 설명 | 실제 구현 |
| --- | --- |
| master의 Web 변경 시 자동 게시 | Web workflow는 `workflow_dispatch`만 제공 |
| `deploy-api.yml`에서 SSH 배포 | 해당 workflow는 이미지 빌드·검증·게시만 수행. 운영 적용은 `Deploy Release` |
| `latest`와 `sha-<commit>` tag 게시 | 명시적 tag는 `latest`. 배포 입력은 검증된 `@sha256` digest |
| API workflow가 같은 SHA의 Web workflow 성공 대기 | 일반 release가 Web을 직접 빌드·게시하고 실제 SHA 확인 |
| API health 실패 시 이전 이미지 자동 rollback | 일반 release는 migration 시도 이후 자동 구형 runtime 복귀 금지 |
| Web/API 독립 배포 순서와 rollback 유지 | 기본 release는 Web/API 동시 배포. 복구 가능 시점도 제한 |

[operations README](../../operations/README.md)의 Phase 1 설명은 2026-09-09 통합 당시 기록이다. 현재 Dockerfile과 build workflow는 Phase 2 artifact를 요구한다. 과거 checksum 예외와 배포 증거는 보존하되 현행 실행 절차와 구분해야 한다.

## 유지

- CI, migration 정책 검사, source SHA·digest 검증, artifact 선택.
- 백업·복원 검증, 배포 전 검사, drain, migration 전 복구, smoke와 배포 기록.
- runtime과 migration 실행 분리, 필요한 Podman/systemd 서비스 관리.
- 기존 Prisma migration·alternate SQL과 적용 이력·receipt 호환성.
- PostgreSQL/Garage·gateway 구성과 데이터 접근 제어.
- 과거 운영 증빙과 checksum 예외 기록. 일반 legacy 자료 가져오기 기능은 Phase 전환 정리와 별개이다.

## 제거 후보

- README의 구형 자동 배포·SHA tag·자동 rollback 설명.
- 과거 Phase 1 설명을 현행 절차로 제시하는 문구와 중복된 전환 준비 문서.
- 일반 release에 남은 최초 Phase 2 전환 명칭·주석.
- 은퇴할 전환 명령만 검사하는 artifact 필수 항목과 전용 테스트. 명령·호출부 정리와 함께 제거한다.

## Production 상태 확인 후 제거 가능

- Phase 1 workflow·업데이트 shell·배포 분기·rollback 인증 장치.
- 최초 전환용 backfill·관측·contract preflight·예외 승인 생성 경로와 관련 CLI.
- legacy schema에 의존하는 canonical correction 도구.
- 전환 전용 online preflight와 관련 package/build/CI 연결.
- 실제 서비스 관리 주체 확인 후 중복된 restart·systemd 생성 절차.

제거 전에는 실행 중인 API·worker의 source/digest, Web SHA, 실제 contract migration 경로·checksum, 예외 receipt, 남은 복구 요구, 활성 systemd unit을 확인해야 한다. 전환 완료가 확인되어도 일반 migration의 이력 검증과 SQL은 호환성 설계 없이 제거하지 않는다.

## 과거 전환 기록과 문서 통합

아래는 기존 문서의 과거 기록을 옮긴 것이다. 이번 조사에서 운영 상태나 과거 실행 결과를 재검증하지 않았다. 과거의 예외 승인은 새로운 운영 변경에 대한 승인이 아니다.

### PR 49 통합 기록

- 기준 master는 `d103504`, 보존 커밋은 `d90be24`였다. 이미 반영된 영상 순서·자료 migration을 보존하고 Phase 2 runtime·단일 자산 표현·DRAFT·게시 worker를 통합하였다. 승인 기능은 PR #50의 별도 범위였다.
- 2026-09-10 문서에 기록된 CD `34327945210`의 source는 `d103504a004b9b04e174a7483810c4d0568ff32f`, digest는 `sha256:6e00b4adfda6ac51095b7d91ce60e8d842fe6f9a89bf8242b3e21c0c398904c0`, 상태는 `expand=true`, `contract=false`였다. 현재 상태의 직접 조회 결과는 아니다.
- 당시 Pages도 같은 source를 반환하였다. API health 확인 시각은 `2026-09-09T15:39:12Z`였으나 TLS 검증을 생략하여 인증서 정상 여부는 입증하지 않았다. 관측 시작 기록은 `2026-09-09T06:38:04Z`였다.
- 당시 `PAGES_DEPLOY_ACTOR`는 미확인, 보호 설정 조회는 404였다. 현재 일반 배포 정책은 [production 배포 절차](../../operations/deployment.md), 후속 전환 예외는 [최초 전환 기록](../../operations/manual-release.md)을 참조한다.

### PR 51 준비 기록

- 대상 source는 `57ab7419a8e44f3d9a2485e9e4ac54a0985aa851`, image digest는 `sha256:f1911a8929e89cc4a7d0c17a890168dd73dbc2817785816f6e2674672f221984`였다.
- [build 34378556894](https://github.com/pcugame/pcugame.github.io-infra/actions/runs/34378556894), [CI 34377694311](https://github.com/pcugame/pcugame.github.io-infra/actions/runs/34377694311)는 검증 통과로 기록되었다. [CD 34387107065](https://github.com/pcugame/pcugame.github.io-infra/actions/runs/34387107065)는 관측 확인 누락으로 authorize 실패, cutover 생략으로 기록되었다.
- 해당 문서는 snapshot 구현·로컬 복원 검증 후, 예외 실행 제어 구현 전의 제안이었다. 제안된 원본 삭제 보류와 파일 백업을 구현 완료로 해석하지 않는다. 동일 내용의 새 객체와 연결 정보가 검증되면 이전 객체 전체의 영구 보존은 필수 조건이 아니라는 당시 요구가 기록되어 있다.
- contract는 이관 목록을 제거하고 이전 객체를 orphan 정리 대상으로 등록한다. inventory나 DB dump만으로 파일 내용을 복원할 수 없다는 제약은 계속 유효하다.

### PR 52 복원 증빙과 예외 경로

[운영 snapshot 34389930145](https://github.com/pcugame/pcugame.github.io-infra/actions/runs/34389930145)의 DB dump·격리 PostgreSQL 복원 성공 기록을 보존한다.

- 경로: `${DEPLOY_DIR}/backups/phase2-observation-6841186032267a8176198cdc7b1caf9c1e3f6b9a-NoKBM8KL/database.dump`
- dump SHA-256: `243167f2b831c0c0ca3f3064421c006e6dd49de9f80e8e51d38749a5825ecbee`
- 당시 API source: `d103504a004b9b04e174a7483810c4d0568ff32f`
- 당시 API digest: `sha256:6e00b4adfda6ac51095b7d91ce60e8d842fe6f9a89bf8242b3e21c0c398904c0`

PR #52는 24시간 관측 기간만 생략하는 age-only 예외를 구현하였다. `20260821990000_release_exception_receipts`로 준비한 뒤 `20260822000001_canonical_asset_contract_age_exception`을 실제 실행하고 원래 contract는 staged tree에서 제외하는 설계였다. 후속 image bridge 예외와 현재 입력 조건은 manual release에 기록되어 있다.

당시 승인은 source·digest·실행 ID·SQL checksum과 1시간 유효기간에 결합되었다. 관측값·이관 대응·승인 소진은 전환 트랜잭션의 receipt에 보존되며, 준비 테이블·승인 행의 존재만으로 전환 완료를 판단하지 않는다. SQL commit과 Prisma 완료 이력 사이의 실패는 실제 schema·receipt·로그를 확인해야 한다.

기존 문서는 기본 테스트 1,149개, release·정책 검사 38개, PostgreSQL 예외·거부 검사 10개, 실제 Prisma CLI 재실행과 관측 7행 보존을 기록하였다. 이는 당시 구현 검증이며 운영 전환 성공 기록이 아니다. 당시 로컬 Pages 계정의 `push=true`, `admin=false`도 실제 CD 토큰 권한의 증거가 아니다.

### 문서 정리 내역과 원문

중복된 준비·통합 절차 3개를 이 문서로 통합하고 삭제하였다. 상세 원문은 조사 기준 커밋에 보존되어 있다.

| 삭제 문서 | 보존 원문 |
| --- | --- |
| `operations/phase2-pr49-integration.md` | [PR 49 통합 기록](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/docs/operations/phase2-pr49-integration.md) |
| `operations/phase2-observation-exception.md` | [PR 51 예외 준비안](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/docs/operations/phase2-observation-exception.md) |
| `operations/phase2-reviewed-cutover.md` | [PR 52 구현과 복원 기록](https://github.com/pcugame/pcugame.github.io-infra/blob/29e360d3152d505d0ae2d7f1e39ca950fcea0df8/docs/operations/phase2-reviewed-cutover.md) |

`operations/README.md`는 보존 branch·과거 runtime 식별자·checksum 예외의 고유 기록이 있어 역사 자료로 유지한다. `manual-release.md`, 업로드 lifecycle runbook, database migration policy와 JSON 운영 증빙도 유지한다. 이번 정리는 문서에 한정하며 실행 코드·workflow·SQL·운영 환경은 변경하지 않는다.
