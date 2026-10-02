# 2026 backend 감사·수정 이력

감사 당시의 결과와 수정 근거를 보존한다. 각 문서의 검증일·조사 기준이 적용 범위이며, `verified-fixed`, dependency audit 결과, route·test 수, commit SHA는 현재 구현이나 운영 상태의 증거로 재사용하지 않는다.

## 문서 분류

| 분류 | 문서 | 해석 기준 |
| --- | --- | --- |
| 특정 시점의 감사 결과 | [백엔드 전수 감사](backend-audit.md) | 2026-08-11의 finding 판정과 production graph·HTTP contract 검증 결과 |
| 특정 시점의 구조 조사 | [Production release 조사](production-release-audit.md) | 2026-10-02 조사 기준의 release 구조와 정리 권고. 이후 변경 전의 기록 |
| 과거 defect/fix 기록 | [Dependency advisory 수정](tickets/016-current-dependency-advisories.md) | 당시 재현·버전 선택·완료 증거. 현재 취약점 상태의 보증이 아님 |
| 과거 defect/fix 기록 | [감사 finding과 수정 근거](backend-audit.md#3-finding-최종-판정) | 감사 보고서의 원래 판정과 실패·회귀 증거 |
| 과거 전환·복구 기록 | [Release 과거 전환 기록](production-release-audit.md#pr-49-통합-기록) | 당시 source·artifact·승인·복원 증빙. 새 배포에 대한 승인으로 사용하지 않음 |

기존 `docs/backend-audit.md`, `docs/production-release-audit.md`, 추적 중이던 dependency ticket을 이 경로로 이동하였다. 본문은 역사 자료로 보존하고, 분류 안내와 이동에 따른 링크만 정리하였다. Release 조사의 구현 링크는 조사 기준 커밋의 원문에 연결한다.

감사에 언급된 다른 번호 ticket은 이 브랜치의 Git 추적 문서가 아니다. 보고서 안의 당시 참조는 보존하지만, 로컬에서만 존재하는 파일을 공개 이력이나 현재 검증 근거로 추가하지 않는다.

## 현재 설계와 운영 기준

| 목적 | 문서 |
| --- | --- |
| 현재 dependency·resource·HTTP·storage 경계 | [Backend architecture](../../architecture/README.md) |
| 장기 설계 결정과 trade-off | [ADR 목록](../../adr/README.md) |
| 아직 구현하지 않은 route 계약 배치 제안 | [Route contract ownership](../../architecture/route-contract-ownership.md) |
| Migration 변경·검토 기준 | [Database migration policy](../../database-migration-policy.md) |
| 운영 배포 절차 | [Production deployment](../../operations/deployment.md) |

새 감사 결과는 검증 시점과 범위를 명시한 별도 기록으로 추가한다. 과거 완료 수치를 수정하여 현재 상태처럼 표현하지 않는다. 현재 architecture에는 구현에서 유지해야 할 조건을 기록하고, 결정의 근거·대안·영향은 ADR에 기록한다.
