# ADR 0005 — Object 저장 위치와 접근 권한의 분리

상태: **기존 결정 기록** — 현재 구현의 소급 기록이며 신규 승인 기록이 아니다.

## 배경

Object byte 전송과 접근 권한 판단은 서로 다른 경계이다.
Public bucket에 저장된 object라도 project·exhibition visibility나 deployment 상태에 따라 접근 조건이 달라진다.
발급된 URL만으로 접근을 고정하면 공개 상태 변경과 session 만료를 반영하기 어렵다.

## 결정

API는 object 접근 권한과 capability를 제어하고 gateway가 object byte를 전달한다.
Public·protected bucket은 저장 위치이며 익명 접근 허용 여부를 정의하지 않는다.
접근 시 representation·deployment reference, `READY` 상태와 현재 visibility를 확인한다.
필요한 경우 session에 연결된 token 또는 공개 접근용 token을 발급한다.

Gateway의 `auth_request`는 내부 file-access API에서 token·session·현재 권한을 재검증한다.
API는 승인된 object path·upstream 정보를 반환한다.
Protected object의 서명은 승인된 접근 경계에서 수행한다.
WebGL 접근에는 deployment manifest·identity와 runtime 전용 권한 경계를 적용한다.

Upload에서는 API가 session·part capability를 제어하고 browser가 Garage로 part byte를 전송한다.
내부 storage client와 browser upload·protected download signing client의 endpoint를 구분한다.

## 대안과 절충

- Public bucket 전체의 익명 접근 허용은 구현을 단순화하지만 현재 visibility와 reference 검증을 우회할 수 있다.
- API의 byte 중계는 권한 검사와 전송을 통합하지만 대용량 I/O를 API graph에 포함한다.
- Gateway와 API의 분리는 추가 내부 인증·origin 구성이 필요하지만 전송과 권한 책임을 구분한다.

## 결과

Object key·bucket 이름이나 URL 보유만으로 접근 권한을 판단하지 않는다.
Token 만료·session 상태·공개 상태 변경은 재검증 경로에 반영한다.
Gateway 구성과 API 권한 구현을 함께 검증한다.
이 기록은 production에서 해당 검증을 수행하였다는 의미가 아니다.

## 근거와 검증 위치

- [File access service](../../apps/api/src/modules/file-access/service.ts), [controller](../../apps/api/src/modules/file-access/controller.ts)
- [Visibility policy](../../apps/api/src/shared/visibility.ts), [asset delivery policy](../../apps/api/src/modules/assets/delivery-policy.ts)
- [Public gateway](../../apps/db/public-origin.nginx.conf.template), [protected gateway](../../apps/db/protected-download.nginx.conf.template)
- [Signing client 구성](../../apps/api/src/backend-context.ts), [multipart composition](../../apps/api/src/backend-context/routes.ts)
- [File access tests](../../apps/api/src/__tests__/file-access.postgres.test.ts)
- [Visibility gateway tests](../../apps/api/src/__tests__/visibility-gateway.garage.postgres.test.ts), [gateway boundaries tests](../../apps/db/deployment-boundaries.test.mjs)
