# 최초 DB 전환과 관측 예외 기록

일반 production 배포 절차는 [deployment.md](deployment.md)를 따른다. 아래 내용은 특정 canonical schema의 최초 전환을 위해 마련한 입력·예외 조건과 보존 자료이다. 전환 완료 여부와 현재 운영 상태는 별도로 확인해야 하며, 과거 승인 기록은 새로운 예외 실행의 승인이 아니다.

## 최초 전환 입력과 조건

최초 전환은 `phase=phase2`로 실행하며, 기존 Phase 1 source/image와 새 master의 불변 image를 지정한다. `observation_exception_id`에 실행 식별자를 넣고 `observation_attestation=I_ACCEPT_SHORT_OBSERVATION`, `exception_profile=image-bridge-traffic`을 사용한다. `observation_started_at`은 비워 둔다.

`public_image_legacy_bridge`의 `api-route` 요청 횟수는 차단 조건에서 제외한다. 기존 웹이 canonical 이미지 키를 이전 API로 요청한 뒤 정상 공개 URL로 이동하는 경우에도 이 값이 증가하기 때문이다. 전환 시점의 실제 횟수·시각·상세 정보는 초기화하지 않고 영수증에 보존한다.

양수인 이미지 브리지 기록은 `details.usedLegacyLookup`이 boolean `false`여야 한다. 다른 양수 지표, 관측 누락·음수·비정상 시각, 파일 누락·참조 불일치는 계속 차단한다. 24시간 관측 기간 생략은 기존 명시적 승인에 따른다. 브리지의 상세 정보는 마지막 요청의 상태이므로 전체 과거 요청의 증명으로 사용하지 않는다. 보존된 API 경고 로그와 객체·DB 정합성 검사 결과도 확인한다.

기존 normal·age-only·36건 고정 SQL은 보존한다. 새 준비 migration `20260821992000_release_image_bridge_traffic`과 실제 전환 migration `20260822000003_canonical_asset_contract_image_bridge_traffic`을 사용한다. 승인·실행·이미지·SQL checksum과 전체 관측·이관 대응 정보를 DB 영수증에 남긴다. 이후 배포는 이 실제 이력을 검증하여 같은 경로로 새 migration을 적용하며 예외 입력을 다시 요구하지 않는다.

## 실패와 복구

현재 일반 release의 복구 경계는 [배포 절차의 실패와 복구](deployment.md#실패와-복구)를 따른다. 최초 전환에서도 contract 적용 후에는 이전 Phase 1 이미지만 재시작하지 않는다. DB 이력·실제 schema·예외 영수증을 확인하고 전진 수정 또는 DB·Garage 복구 범위를 판단한다.

## 보존된 운영 자료

- DB: `/srv/graduationproject_v2/backups/phase2-observation-0496738842950bd9891cac3f944636db5385bb38-uqRqTrJF/database.dump` — 실제 격리 복원 성공.
- 삭제한 WebGL 18개: `/srv/graduationproject_v2/backups/orphan-webgl148-20260910-YLN1sN/` — 파일 내용·복원 메타데이터·해시·삭제 영수증 보존. 재삭제하지 않는다.
- 이번 전환 직전에는 새 DB 백업과 객체 정합성을 다시 검사한다. 최종 배포 커밋·digest·실행 결과는 해당 PR과 서버 `cutover-state`에 기록한다.
