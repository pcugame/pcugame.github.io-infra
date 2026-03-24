# Claude Prompt 01: 공개 노출 및 인가 정책 불일치 수정

## 목적

`known_problems.md`의 아래 두 문제를 함께 해결하기 위한 Claude용 실행 프롬프트다.

- `F-02` 공개 연도 API가 비공개 연도까지 반환
- `F-03` poster PATCH / asset DELETE 인가 정책 불일치

이 묶음은 "공개 범위와 권한 정책을 현재 의도와 일치시키는 작업"이라는 점에서 같이 처리하는 것이 적절하다.

## Claude에 바로 넣는 프롬프트

```md
다음 두 문제를 함께 해결해줘. 목적은 공개 노출과 권한 우회를 막는 것이다.

해결 대상:
1. `GET /api/public/years` 가 비공개 연도까지 반환하고 있다.
2. poster PATCH 와 asset DELETE 에서 USER 권한의 수정 가능 조건이 다른 편집 엔드포인트와 일치하지 않는다.

관련 파일:
- `apps/api/src/modules/public/public.routes.ts`
- `apps/api/src/modules/admin/admin.routes.ts`
- `apps/api/src/modules/assets/assets.routes.ts`

문제 배경:
- 공개 API 는 관리자 비공개 설정을 존중해야 한다.
- USER 역할의 편집 가능 조건은 다른 관리 엔드포인트와 동일해야 한다.
- 현재는 일부 엔드포인트만 `DRAFT` 제약이 빠져 있어 정책이 틀어져 있다.

작업 원칙:
- 가장 작은 범위의 수정으로 끝내라.
- 기존 권한 정책과 최대한 일관되게 맞춰라.
- 이미 존재하는 헬퍼나 패턴이 있으면 재사용하라.
- 불필요한 리팩터링은 하지 마라.
- 동작 변경은 문제 해결에 필요한 범위로만 제한하라.

완료 조건:
- `GET /api/public/years` 는 반드시 `isOpen = true` 인 연도만 반환한다.
- poster PATCH 와 asset DELETE 는 다른 편집 API 와 동일한 프로젝트 수정 가능 조건을 따른다.
- USER 역할은 `DRAFT` 상태의 프로젝트만 수정 가능해야 한다.
- 변경 파일과 변경 이유를 명확히 설명한다.
- 가능하면 테스트 또는 최소 수동 검증 절차를 제시한다.

출력 형식:
1. 수정한 파일
2. 각 수정의 이유
3. 검증 방법
4. 남은 리스크

가능하면 실제 코드 수정까지 제안하고, 수정 diff 또는 패치 수준으로 보여줘.
```
