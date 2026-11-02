# 프로젝트 업데이트 경계

`PATCH /api/admin/projects/:id`의 구현 경로는 다음과 같다.

| 책임 | 구현 |
| --- | --- |
| HTTP 형식 검증·인증·응답 | [update.controller.ts](update.controller.ts): 기존 `UpdateProjectBody`, 로그인 검사, `sendOk` 사용 |
| 업데이트 실행·정책 | [update.service.ts](update.service.ts), [update.policy.ts](update.policy.ts): 직접 서비스 호출에도 접근·상태 변경 정책 적용 |
| 순수 접근 정책 | [project-access.policy.ts](../project-access.policy.ts): #113의 `assertWriteAccess`, 일반 staging 변경 금지 정책 재사용 |
| 잠금·저장 | [update.repository.ts](update.repository.ts): project → exhibition → member 순서의 잠금, 최신 snapshot, patch·version 저장 |
| 조립 | [project-member-settings.composition.ts](../project-member-settings.composition.ts), [crud.repository.ts](crud.repository.ts): 접근·외부 링크·직렬화 의존성과 업데이트 adapter 구성 |

[update.ports.ts](update.ports.ts)의 transaction 계약은 #113 assets 삭제의
잠긴 snapshot과 저장 연산을 callback에 제공하는 방식을 따른다. Prisma 타입은
repository와 [detail.projection.ts](detail.projection.ts)에만 포함한다.
범용 UnitOfWork와 추가 전달 계층은 사용하지 않는다.

접근 선검사는 기존 오류 우선순위와 외부 링크 처리 전 권한 검사를 유지하기 위한
절차이다. 최종 변경 허용 여부는 transaction 안의 최신 snapshot으로 다시 판단한다.
링크의 DNS·네트워크 처리는 잠금 밖에서 수행한다. USER의 상태 변경은 동일 상태를
지정한 경우에도 거부하며, ADMIN·OPERATOR도 DRAFT에서 직접 이탈할 수 없다.

기존 PATCH의 Prisma 기본 transaction 설정과 **자동 재시도 없음**을 유지한다.
assets 삭제의 Serializable 재시도 설정을 PATCH에 추가하지 않는다.
빈 patch도 성공하면 version을 한 번 증가시키며, patch 또는 version 쓰기 실패 시
두 변경 모두 rollback한다. 응답 직렬화는 기존과 같이 commit 이후 수행한다.

비교할 assets 삭제 구현은 [#113의 deletion.repository.ts](https://github.com/pcugame/pcugame.github.io-infra/blob/c95de4be9825af7f7cc064b92f6372b27f0ebdc2/apps/api/src/modules/assets/deletion.repository.ts)와
[deletion.policy.ts](https://github.com/pcugame/pcugame.github.io-infra/blob/c95de4be9825af7f7cc064b92f6372b27f0ebdc2/apps/api/src/modules/assets/deletion.policy.ts)이다.
현재 작업트리의 [assets/service.ts](../../assets/service.ts)는 claim/complete 경로를
유지하므로 해당 PR 구현이 로컬에 통합되어 있다고 간주하지 않는다.

08A scoped guard는 업데이트 controller·service·policy·repository와 순수 접근 정책에
동일한 import 규칙을 적용한다. 다른 admin 기능과 기존 접근 service의 transaction
함수는 이번 정상화 범위에 포함하지 않는다.

검증은 API 타입·lint, `npm run architecture`, 업데이트 단위 테스트 및 전용 테스트
환경의 `npm run test:integration:suite -- year-change-approval`을 사용한다.
직접 호출·인증 HTTP·빈/채워진 collection·접근 상태 경쟁·쓰기 실패 rollback을 포함한다.
