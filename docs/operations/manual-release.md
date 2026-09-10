# 수동 배포와 최초 DB 전환

## 평상시 배포

GitHub Actions의 `Deploy Release`에서 master를 선택하고 기본값 `phase=release`로 실행한다. 나머지 입력은 비워 둔다. master 변경의 작성자나 배포 토큰 소유자에 대한 별도 허용 목록은 사용하지 않는다.

배포는 해당 master 커밋의 성공한 이미지 빌드 기록을 찾는다. 보관된 이미지 기록이 없으면 기존 빌드를 재사용하여 생성한다. 실제 이미지 라벨과 digest를 검사하며 mutable tag를 배포 입력으로 사용하지 않는다. Phase 1 DB가 남아 있으면 서비스 중지 전에 거부한다.

웹 검증·빌드와 운영 DB 단계 확인은 서비스 중지 전에 수행한다. 이후 백업, 필요한 migration, 웹·API 적용, 실제 배포 소스·digest·동작 확인을 한 실행에서 처리한다. master push는 이미지를 빌드하며 운영 적용은 수동 실행으로 유지한다.

Pages에는 대상 저장소 `pcugame/pcugame.github.io`, master 브랜치, 활성 상태, 토큰의 쓰기 권한만 요구한다. 관리자 권한·특정 배포 계정·조직 전용 push 제한·보호 설정 조회는 요구하지 않는다. 기존 협업자 권한은 변경하지 않는다.

## 이번 최초 전환

최초 전환은 `phase=phase2`로 실행하며, 기존 Phase 1 source/image와 새 master의 불변 image를 지정한다. `observation_exception_id`에 실행 식별자를 넣고 `observation_attestation=I_ACCEPT_SHORT_OBSERVATION`, `exception_profile=image-bridge-traffic`을 사용한다. `observation_started_at`은 비워 둔다.

`public_image_legacy_bridge`의 `api-route` 요청 횟수는 차단 조건에서 제외한다. 기존 웹이 canonical 이미지 키를 이전 API로 요청한 뒤 정상 공개 URL로 이동하는 경우에도 이 값이 증가하기 때문이다. 전환 시점의 실제 횟수·시각·상세 정보는 초기화하지 않고 영수증에 보존한다.

양수인 이미지 브리지 기록은 `details.usedLegacyLookup`이 boolean `false`여야 한다. 다른 양수 지표, 관측 누락·음수·비정상 시각, 파일 누락·참조 불일치는 계속 차단한다. 24시간 관측 기간 생략은 기존 명시적 승인에 따른다. 브리지의 상세 정보는 마지막 요청의 상태이므로 전체 과거 요청의 증명으로 사용하지 않는다. 보존된 API 경고 로그와 객체·DB 정합성 검사 결과도 확인한다.

기존 normal·age-only·36건 고정 SQL은 보존한다. 새 준비 migration `20260821992000_release_image_bridge_traffic`과 실제 전환 migration `20260822000003_canonical_asset_contract_image_bridge_traffic`을 사용한다. 승인·실행·이미지·SQL checksum과 전체 관측·이관 대응 정보를 DB 영수증에 남긴다. 이후 배포는 이 실제 이력을 검증하여 같은 경로로 새 migration을 적용하며 예외 입력을 다시 요구하지 않는다.

## 실패와 복구

서비스 중지 전 웹 소스와 실제 실행 중인 컨테이너 ID를 보관한다. migration을 시도하기 전 실패하면 이번 실행이 게시한 Pages만 이전 커밋으로 복원한다. 비교 후 갱신 방식으로 다른 작성자의 후속 변경을 덮지 않는다. 이전 웹 소스가 실제 제공되는 것을 확인한 후 기존 컨테이너 ID를 재시작한다.

migration 호출 직전에 영속 시도 표시를 기록한다. 호출 후 실패는 SQL COMMIT 이후 오류일 수도 있으므로 이전 웹·API를 자동 복원하지 않는다. DB 이력과 영수증을 확인해 전진 수정하거나 보존한 백업을 이용한 복구를 결정한다. 실패한 실행 로그에는 실제 중지·migration·복구 결과가 남는다.

## 보존된 운영 자료

- DB: `/srv/graduationproject_v2/backups/phase2-observation-0496738842950bd9891cac3f944636db5385bb38-uqRqTrJF/database.dump` — 실제 격리 복원 성공.
- 삭제한 WebGL 18개: `/srv/graduationproject_v2/backups/orphan-webgl148-20260910-YLN1sN/` — 파일 내용·복원 메타데이터·해시·삭제 영수증 보존. 재삭제하지 않는다.
- 이번 전환 직전에는 새 DB 백업과 객체 정합성을 다시 검사한다. 최종 배포 커밋·digest·실행 결과는 해당 PR과 서버 `cutover-state`에 기록한다.
