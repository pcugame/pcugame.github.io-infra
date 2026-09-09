# 연도별 수정·삭제 및 변경 승인

## 정책과 화면

전시회의 `isModificationEnabled`가 신규 등록과 등록자·연결된 팀원의 직접 수정·삭제를 제어한다. 화면 명칭은 **수정 허용**이다. DB 컬럼 `is_upload_enabled`는 유지하며, 기존 API 필드 `isUploadEnabled`도 호환용으로 지원한다. 두 필드의 값이 다르면 요청을 거부한다.

수정 불허 전시회에서는 등록자 또는 연결된 팀원이 변경 요청을 작성한다. 요청 작성자만 초안 수정·제출·취소가 가능하다. OPERATOR/ADMIN은 승인·반려하며, 기존 직접 수정·삭제 권한도 유지한다. 승인은 제출된 변경 내용의 반영이며 추가 편집 권한을 부여하지 않는다.

- 내 작품: 직접 수정·삭제 또는 수정·삭제 요청, 최근 요청 이력.
- 요청 작성: 텍스트·참여 학생·기존 파일 제거·포스터·영상 순서·WebGL 및 새 파일 업로드.
- 운영자 요청함: 상태별 목록과 페이지 이동, 변경 전후 비교, 보호된 파일 미리보기, 승인·반려·실패 재시도.
- 삭제된 작품의 요청도 요청 ID를 통해 조회할 수 있다.

## 저장과 반영

`ProjectChangeRequest`에 사유, 요청자·처리자, 원본 버전, 변경 전후 내용, 파일 이력과 처리 시각을 저장한다. 프로젝트별 활성 요청은 초안을 포함해 한 건이다. 제출 후 내용은 고정한다. 버전 또는 요청자 소속이 달라지면 반영을 차단한다.

파일 처리는 요청에 연결된 비공개 DRAFT 프로젝트와 업로드 슬롯을 사용한다. 기존 업로드·검증·변환·공개 작업을 재사용하며 요청의 승인 상태는 별도로 관리한다. 내부 프로젝트는 일반 작품 목록·상세·전시회 작품 수·내보내기에서 제외한다. 업로드 전에 manifest를 저장하고 서버가 발급한 항목 ID와 clientToken으로 업로드를 연결한다.

파일이 없는 수정과 삭제는 승인 트랜잭션에서 처리한다. 파일이 있으면 `APPLYING`으로 전환한 뒤 기존 공개 작업자가 준비를 완료하고 원본 내용·파일 참조·완료 상태를 함께 반영한다. 실패 시 원본을 유지하고 같은 승인 내용을 재시도한다. 완료된 내부 업로드 제출은 DB 제약에 따라 `CANCELLED`, 요청과 공개 작업은 `COMPLETED`로 기록한다. 내부 제출의 취소 상태는 승인 반려를 의미하지 않는다.

삭제·교체 파일은 기존 영속 정리 작업으로 제거한다. 작업 도중 프로젝트가 삭제되어도 작업자가 보관한 공개 계획으로 늦게 생성된 파일을 다시 정리한다. 현재 참조 중인 파일은 기존 참조 검사로 보호한다. 영구 삭제 후에도 요청·승인 이력은 유지한다.

## API

- `/api/me/projects/:id/change-requests`: 프로젝트별 조회·생성.
- `/api/me/change-requests`: 본인 관련 요청 조회.
- `/api/me/change-requests/:id`: 상세·초안 수정, 하위 `submit`·`cancel`.
- `/api/admin/change-requests`: 운영자 조회, 상세의 하위 `approve`·`reject`·`retry`.
- `/api/assets/:assetId/download`: 인증된 임시 파일 검토. WebGL은 소스 ZIP을 제공한다.

공유 요청·응답 계약은 `packages/contracts/src/project-change-schemas.ts`에 있다. 작품 목록·상세에는 서버가 계산한 `canEdit`, `canDelete`, `canRequestChange`와 설정 값을 포함한다. 화면의 버튼 노출과 별도로 실제 DB 반영 시 권한을 다시 검사한다.

## 검증과 출시 기준

전용 PostgreSQL 테스트는 `RUN_POSTGRES_INTEGRATION=true`와 **격리된 테스트 DB**의 `DATABASE_URL`을 설정하여 실행한다.

```sh
npm exec -w apps/api -- vitest run --no-file-parallelism \
  src/modules/project-change/repository.postgres.test.ts \
  src/modules/project-change/transfer-review.postgres.test.ts \
  src/__tests__/project-year-policy.postgres.test.ts \
  src/__tests__/project-year-http.postgres.test.ts
```

실제 로그인 쿠키·응답 직렬화, 연도별 등록자·팀원·운영자 권한, 연도 폐쇄와 수정의 경합, 중복 승인, 파일 종류별 이전, 삭제 후 늦은 파일 생성, 정리 대상의 활성 참조 보호를 검증한다. 전체 `npm test`, `npm run build`, `npm run lint`, `npm run architecture -w apps/api`도 출시 전 검사에 포함한다.

마이그레이션 `20260909100000_project_change_requests`는 버전 필드와 요청 테이블을 추가한다. 기존 Phase 2 `apply-contract` 경로에서 적용하며 새 Phase 2 런타임 검증은 해당 마이그레이션 완료를 요구한다. Phase 1 마이그레이션 범위는 확대하지 않는다.

구현 시작 시 기준 커밋은 `080eda5`, 당시 master는 Phase 1의 `d103504`였다. 선행 Phase 2 변경은 PR #49에서 검토·검증한 뒤 `5ad6bf4`로 master에 병합하였다. 기존 작업 보존 커밋은 `d90be24`이다.

기능 PR #50은 병합된 master를 기준으로 검토한다. 기존 Phase 2 변경을 다시 추가하지 않고 수정·삭제 승인 기능과 필요한 검증만 포함한다. 운영자의 파일 삭제·일괄 상태 변경도 프로젝트 버전을 증가시켜 이전 승인 요청을 CONFLICT로 처리한다. DB 테스트는 독립 마이그레이션 스키마를 사용해 상시 워커와의 간섭을 방지한다.

master 병합과 운영 배포는 구분한다. 배포 전 관측·DB 전환·Pages 조건은 `docs/operations/phase2-pr49-integration.md`를 참조한다. 이 기능만을 이유로 Phase 2 contract 전환을 실행하거나 작업 브랜치에서 배포하지 않는다. 배포 시에는 병합된 master 커밋의 검증된 불변 아티팩트를 사용하고 실제 운영 동작, 소스 커밋, 이미지 digest를 별도로 기록한다.

EOD
