# API 변경 지침

## 책임 경계

- Controller는 HTTP 입력 검증·인증·응답 변환, service는 유스케이스 실행과 정책 호출, policy는 값 기반 판단을 담당한다. Repository는 잠금·조회·저장을 담당하며 service·controller를 호출하지 않는다.
- Service·policy에서 Fastify·Prisma·구체 repository를 import하지 않는다. Composition에서 자원과 adapter를 주입하며 import 시 자원을 생성하지 않는다. 범용 UnitOfWork나 단순 전달 계층을 추가하지 않는다.
- 권한·상태 선검사는 최종 쓰기 허용의 근거로 사용하지 않는다. Repository가 transaction 안에서 잠근 최신 snapshot과 저장 연산을 callback에 제공하고, service·policy가 그 snapshot으로 판단한 뒤 저장한다. 외부 네트워크 작업은 잠금 밖에서 수행한다.

## 대표 구현과 적용 범위

- 08A: [architecture guard](scripts/architecture-guard.mjs)와 [경계 guard의 strictRoots](scripts/assets-boundary-guard.mjs)를 기준으로 검사 범위를 확인한다. 허용 fixture는 자원 조립 예외이며 service·policy의 우회 경로가 아니다.
- 08B: assets 삭제의 잠긴 snapshot·삭제 계획 분리는 로컬 Git 객체 `c95de4be9825af7f7cc064b92f6372b27f0ebdc2`의 `apps/api/src/modules/assets/deletion.repository.ts`·`deletion.policy.ts`가 참조 구현이다. 현재 작업트리에 통합된 구현으로 간주하지 않는다.
- 08C: 현재 PATCH 구현은 [프로젝트 업데이트 경계](src/modules/admin/project/README.md)를 따른다. Controller·service·policy·repository 경로, 잠금 순서, 상태 제한, transaction·재시도·version 규칙은 해당 문서에서 관리한다. Assets 삭제의 transaction 설정을 다른 유스케이스에 일괄 적용하지 않는다.

## 검증 명령

저장소 루트에서 실행한다. 아래 명령은 검증 절차이며 실행 완료 기록이 아니다.

```sh
npm run build -w @pcu/contracts
npm run db:generate -w apps/api
npm run lint -w apps/api
npm run architecture
npm exec -w apps/api -- vitest run src/modules/admin/project/update.service.test.ts src/__tests__/project-update-repository.test.ts
npm run test:integration:suite -- year-change-approval
```

통합 검증은 전용 테스트 환경에서만 수행한다. 변경한 유스케이스의 직접 호출과 인증된 HTTP 응답·직렬화, 빈/채워진 collection, 잠금 경쟁과 rollback을 확인한다. `401` 또는 mock 통과만으로 성공 경계 검증을 대체하지 않는다.
