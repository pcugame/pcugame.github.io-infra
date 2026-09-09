# Phase 2 관측 기간 예외와 복구 기록

## 적용 범위

사용자가 승인한 예외는 24시간 관측 기간의 생략에 한정한다. 관측 완료를 선언하거나 지표·시각을 수정하지 않는다. 실제 fallback 발생, 지표 누락, null·무한대·미래 시각, 파일 누락, 참조 불일치 등은 계속 전환을 차단한다. 정상 관측 경로와 Pages 보호 검사는 유지한다.

이번 변경은 기존 `Authorized API Schema Cutover`에 읽기 전용 `preflight`와 명시적 관측 기간 예외를 추가한다. 작업 브랜치 배포나 별도 배포 workflow는 사용하지 않는다. PR 검증·master 병합 후 정확한 병합 커밋의 불변 이미지를 빌드·검증하여 사용한다.

## DB 및 파일 복구 기반

[운영 스냅샷 34389930145](https://github.com/pcugame/pcugame.github.io-infra/actions/runs/34389930145)는 전체 DB dump 생성과 격리 PostgreSQL 복원을 성공하였다.

- 보관 위치: `${DEPLOY_DIR}/backups/phase2-observation-6841186032267a8176198cdc7b1caf9c1e3f6b9a-NoKBM8KL/database.dump`
- SHA-256: `243167f2b831c0c0ca3f3064421c006e6dd49de9f80e8e51d38749a5825ecbee`
- 당시 실제 API source: `d103504a004b9b04e174a7483810c4d0568ff32f`
- 당시 실제 API digest: `sha256:6e00b4adfda6ac51095b7d91ce60e8d842fe6f9a89bf8242b3e21c0c398904c0`

DB dump에는 프로젝트·파일 참조·이관 대응·기존 DB 이력이 포함된다. 파일 내용은 포함되지 않는다. 이전 Garage 객체가 정리되더라도 동일한 새 객체와 대응 정보가 보존되어 있으면 해당 정보를 이용한 복구를 검토할 수 있다. 양쪽 객체가 모두 삭제되거나 새 객체의 내용이 다르면 DB만으로 파일을 복구할 수 없다.

예외 전환 직전에는 온라인 dump·격리 복원 검사를 다시 수행하고, 이후 기존 쓰기 중지·DB backup·Garage inventory 절차를 수행한다. 온라인 dump는 이후 쓰기까지 동결한 스냅샷이 아니므로 쓰기 중지 후 백업을 대체하지 않는다.

## 실제 마이그레이션 경로

| 경로 | 실행 및 기록 |
| --- | --- |
| 정상 | 기존 `20260822000000_canonical_asset_contract` 실행. 24시간 검사 유지. |
| 예외 준비 | 추가 migration `20260821990000_release_exception_receipts`로 운영 승인·영수증 테이블 생성. 실제 Prisma 이력에 기록. |
| 예외 전환 | `prisma/contract-migration-paths/20260822000001_canonical_asset_contract_age_exception/migration.sql`을 별도 이름으로 실제 실행. 원래 contract는 해당 staged tree에서 제외. |
| 후속 실행 | DB의 완료된 경로와 영수증을 검증하여 동일 경로 선택. 예외 DB에 원래 contract를 다시 적용하지 않음. |

기존 SQL은 수정하지 않는다. 원래 contract를 미실행 상태에서 완료로 표시하지 않는다. 예외 SQL에도 동일한 데이터 검사·잠금·DDL을 유지하며, 24시간 경과 대신 현재 시각까지의 유효한 관측을 요구한다. 비어 있는 업무 DB에서도 예외 경로에는 모든 지표가 필요하다.

승인에는 예외 ID, 승인 계정, GitHub 실행 ID, 정확한 source·image digest, SQL checksum과 1시간 유효기간을 기록한다. 다른 승인 내용으로 기존 행을 덮어쓰지 않는다. 전환 트랜잭션 안에서 실제 관측값과 전체 이관 대응 행을 영수증에 보존하고 승인 소진·적용 시각을 기록한다. DDL 실패 시 영수증 변경도 함께 롤백된다. 사전 생성한 빈 테이블과 승인 행이 남을 수 있으며 이는 전환 완료를 의미하지 않는다.

Prisma 완료 이력과 SQL 트랜잭션 사이의 장애는 자동 보정하지 않는다. SQL이 완료되었더라도 Prisma 이력이 불완전하면 서비스 시작을 거부하고 실제 schema·영수증·로그를 검토한다. 완료 이력과 영수증의 checksum 불일치, 정상·예외 경로 혼재도 거부한다.

## CD 입력과 실행 순서

읽기 전용 `preflight`는 배포·관측 입력을 받지 않는다. 현재 API에 포함된 CLI로 DB·Garage를 검사하고 실행 전후 이미지 일치를 확인한다. 전체 report와 관측 기록은 서버의 권한 제한 디렉터리에 저장하고 로그에는 집계·소스·digest만 출력한다. 이 검사는 온라인 참고 근거이며 최종 쓰기 중지 상태의 검사를 대체하지 않는다.

예외 전환은 기존 `phase2`에서 다음 입력을 사용한다.

- `observation_exception_id`: 검토된 전환을 식별하는 8~128자의 ID
- `observation_attestation`: `I_ACCEPT_SHORT_OBSERVATION`
- `phase1_api_image`, `phase1_source_sha`: 현재 운영 Phase 1의 정확한 이미지와 소스
- `final_api_image`: 이번 master 병합 커밋의 검증된 불변 이미지
- `observation_started_at`: 비워 둠. 과거 시각을 확인 완료로 제출하지 않음.

현재 Phase 1 이미지와 입력의 일치를 확인한 뒤 최종 아티팩트·복원 시험을 검사한다. 이후 쓰기 중지, DB backup, Garage inventory, 최종 web 게시·소스 확인, 파일·DB 정합성 검사, 실제 migration, Phase 2 시작 및 운영 smoke 순서로 진행한다. 예외 승인자와 실행 ID는 GitHub 실행 정보로 전달한다.

## 복구 및 잔여 조건

contract 이전 실패는 schema와 web/runtime 상태를 확인하여 복구한다. contract 이후에는 기존 전진 복구 경로를 사용한다. 이전 이미지만 재시작하지 않는다. DB 복원이 필요하면 실패 시점 DB도 보존하고 검증된 dump·파일 대응 정보를 이용해 복원 대상을 확정한다. 전환 후 쓰기가 발생하였다면 해당 쓰기의 별도 보존·재적용이 필요하다.

현재 로컬 GitHub 연결 계정의 Pages 권한은 `push=true`, `admin=false`이다. 실제 CD 배포 토큰의 계정·권한은 다를 수 있으므로 `preflight`의 별도 Pages 읽기 전용 검사로 확인한다. 로컬 계정의 보호 설정 조회는 404를 반환하고 `PAGES_DEPLOY_ACTOR`는 미확인이다. 이 제약은 관측 기간 예외로 면제하지 않는다. Pages 검사는 유지보수 전에 실행하므로 실패하면 서비스 중지·DB 전환을 시작하지 않는다.

## 검증 근거

- 독립 안전 검토: 기존 SQL 보존, 실제 예외 이력, 트랜잭션 영수증, 일반 경로 유지, Pages 검사 유지 확인.
- 기본 테스트 1,149개, release·정책 검사 38개, build·lint·architecture 통과.
- 격리 PostgreSQL에서 정상 관측 경로, 최근 zero 관측의 예외, 누락·non-zero·null·무한대·미래 시각 및 승인 누락·만료의 원자적 거부 10개 검사 통과.
- 실제 Prisma CLI fixture에서 준비→예외→승인 기능 migration 실행 및 옵션 없는 재실행 통과. 원래 contract 완료 행 없음, 예외 checksum 일치, 실제 관측 7행 보존 확인.

위 구현 검증은 운영 전환 결과와 구분한다. 실제 운영 읽기 전용 검사·배포 결과는 PR에 source·digest·실행 링크와 함께 기록한다.

EOD
