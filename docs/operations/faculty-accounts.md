# 교원 계정과 관리자 권한 운영

## 계정 처리 기준

`A/a`와 숫자 5자리로 구성된 `@pcu.ac.kr` 이메일은 작품 신규 등록 화면에서 이름·학번·참여자 계정을 자동 입력하지 않는다. 도메인 대소문자는 구분하지 않는다. 이 규칙은 모든 역할에 적용하는 화면 정책이며 권한 부여 조건이 아니다. 다른 도메인과 다른 자리 수는 대상에서 제외한다.

교원 계정의 `studentId`는 신규 로그인 시 DB에 `NULL`로 저장되고 인증 응답에서 생략된다. 기존 값이 있으면 로그인 시 유지한다. 작품 등록자는 `creatorId`와 제출 기록에 저장하며, 참여 학생은 별도로 입력한다. 이름이 같은 학생도 교원 계정에 자동 연결하지 않는다. 기존 작품과 진행 중인 제출의 참여자 정보는 소급 수정하지 않는다.

`ADMIN`은 조회 전용이 아닌 기존 전체 관리 권한이다. 이메일 접두사로 자동 승격하지 않는다.

## 사전 확인

1. 대상자의 실제 전체 이메일과 관리자 지정 의사를 확인한다. `A00000@pcu.ac.kr`은 예시이며 운영 대상을 의미하지 않는다.
2. 운영 API의 `ALLOWED_GOOGLE_HD`를 확인한다. 이메일 문자열 대신 Google의 검증된 조직 도메인 `hd`와 비교하는 설정이다. 도메인 불일치 시 계정의 조직 정보를 확인하고, 접근 허용을 위해 제한을 해제하지 않는다.
3. 대상자가 Google로 최초 로그인한 후 `users`의 `id`, `google_sub`, `email`, `role`을 대조한다. 이메일 검색 결과가 복수이면 대상을 추정하지 않는다. 승인된 사용자 ID와 Google `sub`를 확정한다.
4. 아래 절차는 [운영 배포 절차](deployment.md)의 운영 DB 접속 경로에서 실행한다. DB 주소·비밀번호·Google 토큰·세션 쿠키는 작업 기록에 포함하지 않는다. 관리자 지정은 schema migration이나 seed 실행을 필요로 하지 않는다.

## 단일 계정 역할 변경

운영 `psql`에서 다음 변수를 실제 확인값으로 설정한다. `target_email`은 DB에 저장된 정확한 문자열이다. 신규 지정은 `expected_role=USER`, `desired_role=ADMIN`이며, 기존 운영자는 확인한 역할을 사용한다. 아래 예시 식별자로 실행하면 대상 불일치 오류가 발생해야 한다.

```sql
\set ON_ERROR_STOP on
\set target_id 0
\set target_sub 'REPLACE_WITH_VERIFIED_GOOGLE_SUB'
\set target_email 'REPLACE_WITH_VERIFIED_EMAIL'
\set expected_role 'USER'
\set desired_role 'ADMIN'

BEGIN;
CREATE TEMP TABLE role_change_target ON COMMIT DROP AS
SELECT :'target_id'::integer AS id, :'target_sub'::text AS google_sub,
       :'target_email'::text AS email, :'expected_role'::text AS old_role,
       :'desired_role'::text AS new_role;
DO $$
DECLARE changed integer;
BEGIN
  IF EXISTS (SELECT 1 FROM role_change_target
             WHERE old_role NOT IN ('USER', 'OPERATOR', 'ADMIN')
                OR new_role NOT IN ('USER', 'OPERATOR', 'ADMIN')
                OR old_role = new_role) THEN
    RAISE EXCEPTION 'Invalid role transition';
  END IF;
  UPDATE users u SET role = t.new_role::"UserRole", updated_at = CURRENT_TIMESTAMP
  FROM role_change_target t
  WHERE u.id = t.id AND u.google_sub = t.google_sub
    AND u.email = t.email AND u.role::text = t.old_role;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'Expected one verified account; changed %', changed;
  END IF;
END $$;
SELECT u.id, u.email, t.old_role, u.role AS new_role, CURRENT_TIMESTAMP AS changed_at
FROM users u JOIN role_change_target t ON u.id = t.id;
COMMIT;
```

예외 발생 시 트랜잭션 전체를 취소한다. 대화형 접속에서는 `ROLLBACK;`으로 종료한 뒤 계정 식별자와 기존 역할을 다시 확인한다. 조건을 제거하여 재실행하지 않는다. 변경 대상·수행자·사유·변경 전후 역할·시각·승인 근거를 접근이 제한된 운영 작업 기록에 보존한다.

## 적용 확인과 권한 회수

- 대상자가 로그아웃·재로그인한 후 `/api/me`의 `role=ADMIN`과 `studentId` 생략을 확인한다. 기존 학번 값이 있는 계정은 해당 값이 유지될 수 있다.
- 관리자 작품 목록의 빈 결과와 기존 자료 조회, 신규 등록의 참여자 빈칸을 확인한다. 학생 정보를 입력한 후 등록·업로드 재개·편집이 가능하고 교원이 참여자로 자동 등재되지 않는지 확인한다.
- 서버는 요청마다 세션의 사용자 역할을 조회하므로 역할 변경은 기존 세션의 후속 요청에도 적용된다. 재로그인은 브라우저에 표시된 권한 정보를 갱신하고 적용 결과를 확인하는 절차이다.
- 권한 회수는 동일한 SQL에 `expected_role=ADMIN`, `desired_role=기록된 이전 역할`을 적용한다. 회수 후 재로그인과 관리자 전용 API 접근 거부를 확인한다. 이전 역할이 `OPERATOR`이면 운영자에게 허용된 관리 기능은 유지된다. 이미 처리 중인 요청까지 소급 취소하는 절차는 아니다.

코드 적용은 작업 브랜치의 PR 검토·필수 CI·`master` 병합·정식 배포 순서를 따른다. 배포 source SHA·이미지 digest·운영 확인 결과를 별도로 기록한다. 로컬 테스트는 실제 교원 Google 계정 로그인이나 운영 배포 검증을 대신하지 않는다.
