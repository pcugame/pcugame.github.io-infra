# API 슬롯 병행 배포

`Deploy Release`의 `operation=rolling`은 DB 변경이 없는 호환 release를 대상으로 한다. 같은 Pod에서 API A(`4000`)와 B(`4001`)를 일시적으로 병행하며, PostgreSQL·Garage와 session·서명 설정을 공유한다. API는 사용자별 슬롯 고정을 사용하지 않는다. 서버 장애·재부팅 고가용성은 범위에 포함하지 않는다.

저장소 구현과 운영 설치는 별도 상태이다. 최초 Pod 포트·Quadlet·Nginx 전환은 점검 시간에 수행해야 하며, 이 문서의 추가는 운영 전환 완료를 의미하지 않는다.

## 최초 설치 조건

1. 기존 [Quadlet 도입 절차](../../server/quadlet/ADOPTION.md)에 따라 실제 운영 unit·Pod·Nginx 설정과 환경 파일을 조사한다. 기존 변경 사항을 보존하고 TLS, 접근 제한, 원본 IP 및 전달 헤더 정책을 검토한다.
2. 검증된 불변 이미지로 `API_SLOTS=true API_IMAGE=… DEPLOY_DIR=… bash server/quadlet/render.sh /새/검토/디렉터리`를 실행한다. 두 API의 loopback 공개 포트는 `127.0.0.1:4000`, `127.0.0.1:4001`이다. 슬롯 모드는 다른 공개 주소·포트를 거부한다. 기존 Pod의 포트 변경은 Pod 재생성이 필요하므로 점검 시간에 수행한다.
3. 검토한 정의를 설치한다. 기존 `gp-api` unit과 컨테이너는 정리하고 `gp-api-a`, `gp-api-b`를 사용한다. 두 슬롯과 worker는 `StartWithPod=false`이며 PostgreSQL·API 확인 후 명시적으로 시작한다. 두 슬롯은 동일한 `common.env`·`api.env`를 참조한다.
4. `runtime-env/slot-a.env`에 `API_MAINTENANCE_PAUSED=false`, `slot-b.env`에 `API_MAINTENANCE_PAUSED=true`를 설정한다. `cutover-state/active-slot`에 `a`와 LF를 기록한다. 환경 파일과 상태 디렉터리는 배포 계정만 수정할 수 있도록 제한한다. 활성 슬롯만 시작하고 worker 6종을 시작한다.
5. [공유 upstream 예시](../../server/nginx/api-upstream.conf)를 Nginx `http` context에 설치한다. 공개 API의 `proxy_pass`는 `http://pcu_api_active`를 사용한다. 공개·보호 파일 gateway 모두 `FILE_GATEWAY_API_UPSTREAM=http://pcu_api_active`로 렌더링한다. 두 파일 gateway가 별도 Nginx host에 있으면 현재 자동화의 설치 조건을 충족하지 않는다. 동일 Nginx master가 세 경로를 관리해야 한다.
6. 기존 요청 제한 시간은 유지한다. `worker_shutdown_timeout`을 추가하지 않는다. 기존 값이 0이 아니면 rolling 검사는 거부한다. Nginx reload는 구 worker가 기존 client 요청을 마칠 때까지 유지하는 동작을 사용한다. [Nginx 공식 제어 문서](https://nginx.org/en/docs/control.html)
7. [설치 manifest 예시](../../server/rolling-installation.example.json)를 `DEPLOY_DIR/rolling-installation.json`에 작성한다. 명령 배열과 파일 경로는 실제 운영 구성에 맞게 지정한다. 배포 계정에는 해당 upstream 파일 변경과 명시된 Nginx 검사·reload 권한이 필요하다. 일반 shell 문자열은 실행하지 않는다.
8. `DEPLOY_DIR=… python3 server/rolling-release.py fingerprint-nginx`로 실제 `nginx -T` 결과의 fingerprint를 확인하고, 검토한 설정과 일치할 때 manifest에 기록한다. 변경 가능한 upstream 본문만 fingerprint에서 제외한다. `audit-installation`으로 실제 Pod 포트, legacy API 부재, Quadlet source, Nginx worker 및 세 경로의 공유 upstream을 확인한다. 파일 존재만으로 설치 완료를 판단하지 않는다.

파일 gateway 응답의 `X-PCU-API-Slot`은 실제 `auth_request` 응답에서 전달된다. API의 같은 헤더와 함께 전환 후 공개·내부 경로 도달 여부를 확인하는 데 사용한다. 제어 route나 secret을 공개하지 않는다.

## Release별 사전 자료

`DEPLOY_DIR/rolling-compatibility.json`은 다음 구조이며, 정확한 두 이미지에 대한 검토 결과를 기록한다. 메모리 값은 신 API의 예상 최대 추가 사용량으로 산정한다. 연결 값은 Prisma pool의 기본 최대값 10 이상이어야 한다. 배포기는 host와 cgroup의 실제 메모리 여유 및 PostgreSQL의 연결 여유를 추가 확인한다.

```json
{
  "source_sha": "40자리 source SHA",
  "image": "ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:64자리 digest",
  "previous_image": "ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:64자리 digest",
  "old_web_new_api": true,
  "old_new_api_data": true,
  "old_new_worker_jobs": true,
  "additional_api_memory_mb": 512,
  "additional_api_connections": 10
}
```

세 compatibility 값은 구 Web과 신 API의 요청·응답, 구·신 API의 데이터 의미, 구·신 worker의 대기 작업 형식 검토를 나타낸다. 같은 DB schema라는 사실만으로 설정해서는 안 된다. PR 또는 검증 기록에 실제 두 artifact와 검증 근거를 남긴다.

`DEPLOY_DIR/rolling-probes.json`은 권한 `0600`으로 저장한다. 검증 전용 사용자·작품·업로드를 사용하며 실제 사용자 데이터에 대한 임의 쓰기를 구성하지 않는다. 같은 `cookie`를 후보 슬롯과 공개 경로에 사용한다. 각 request는 `path`, `method`, `status`, `category`, 선택적인 `headers`·`body`, 기대 JSON 경로인 `json` 또는 `responseHeaders`를 포함한다.

- `candidate`: 직접 loopback 후보 API의 deep health, 인증된 `/api/me`, 인증된 쓰기, 빈·채워진 collection, `/api/internal/file-access` 승인 검사를 포함한다. 범주는 `authenticated-read`, `authenticated-write`, `empty-collection`, `populated-collection`을 사용한다.
- `public`: `publicOrigin` HTTPS 주소에서 같은 인증·쓰기·collection 검사를 수행한다.
- `internal`: `internalOrigin` HTTPS 파일 gateway에서 기존 capability의 실제 다운로드와 예상 응답 헤더를 검사한다. 응답 `X-PCU-API-Slot`은 후보 슬롯과 같아야 한다.

예를 들어 `/api/me`의 기대 JSON은 `{"ok":true,"data.authenticated":true}`, 빈 목록은 `{"ok":true,"data.items":[]}`, 채워진 목록은 `{"ok":true,"data.items.length":1}`로 지정한다. 쓰기 요청에는 해당 route의 JSON body와 CSRF `Origin` 등 기존 인증 정책에 필요한 헤더를 지정한다. 내부 승인 요청에는 기존 gateway secret·파일 종류·capability URI를 지정한다. URL, cookie, token 및 request body는 배포 로그에 출력하지 않는다. 준비되지 않은 probe 설정은 전환 전에 실패한다.

## 실행 순서와 재개

`operation=rolling`은 기존 production gate, 정확한 source 검증과 불변 이미지 선택을 사용한다. 다음 순서를 수행한다.

1. 실제 설치 상태·artifact·capacity·호환성·probe 설정을 확인한다. 대상 이미지의 모든 migration 이름·checksum을 운영 적용 이력과 비교한다. 미적용·실패·rollback·중복·추가 이력은 전환 전에 거부한다. 승인된 과거 alternate contract 경로는 기존 receipt 검사와 같은 선택 규칙을 사용한다.
2. 기존 온라인 DB snapshot과 격리 복원 검증을 수행한다. SQL migration은 실행하지 않는다.
3. `candidate` journal을 원자적으로 저장하고 파일·디렉터리 fsync를 완료한 뒤, 비활성 슬롯을 maintenance 중지 상태로 시작한다. DB·storage·인증·직렬화·파일 승인 검사가 성공하면 구 Nginx worker의 PID와 시작 시각을 영속 기록한다.
4. 공유 upstream을 변경하고 Nginx 설정 검사·reload를 수행한다. 공개·내부 probe가 신 슬롯에 도달해야 활성 슬롯 기록을 갱신한다.
5. 구 API의 maintenance 수신을 중지한다. 구 Nginx worker가 모두 종료된 후 구 API의 HTTP 수신을 중지한다. 요청·hook/handler 실행·maintenance가 모두 0일 때만 systemd stop을 실행한다.
6. 신 API의 maintenance를 활성화하고 worker를 순차 교체한다. worker는 claim 수신을 중지한 뒤 기존 작업과 heartbeat가 종료될 때까지 유지한다. 실행 중 작업의 AbortSignal은 배포 drain으로 취소하지 않는다.
7. 전체 runtime 검사를 통과하면 같은 SHA의 Web을 게시한다. 공개·내부 smoke와 실제 Web SHA 확인 후 journal을 완료 처리한다.

`cutover-state/host-release.lock`은 사전 검사 시작부터 journal 저장·서비스 상태 변경·해당 실행 종료까지 유지하여 host 동시 실행을 차단한다. `rolling-release.json`은 source SHA, image digest, 이전 image, 양쪽 슬롯, 단계, Nginx worker 세대와 완료 worker 목록을 저장하며 파일·디렉터리를 fsync한다. SSH·workflow가 중단되어도 같은 release를 재실행하면 실제 runtime과 대조하여 재개한다. `candidate` 이후 미완료 journal이 있으면 다른 release와 기존 점검 배포·자동 복구를 거부한다. 후보 시작 직전에 프로세스가 중단된 경우도 동일 release로 재개하여 실제 상태를 확인한다.

읽기 전용 사전 검사 또는 온라인 snapshot 검증 실패는 신규 rolling journal을 생성하지 않으며, 기존 journal을 성공한 `complete`로 변경하거나 삭제하지 않는다. migration이 있는 release의 rolling 거절 이후에는 다른 release의 사전 검사 또는 기존 점검 배포·복구 절차에 진입할 수 있다. 각 절차의 schema·artifact·호환성 검사와 migration 시도 후 복구 제한은 그대로 적용한다. 이전 구현이 기록한 `preflight` journal도 서비스 변경 전 단계이므로 세 진입점(`rolling-release.py`, `deploy.sh`, `release-orchestrate.sh`)에서 차단 대상으로 취급하지 않는다. 이 기록으로 재시도할 때는 현재 활성 슬롯을 다시 읽고 사전 검사를 모두 수행한다. 수동 journal 삭제는 필요하지 않다.

관찰 시간은 단계별 기본 10분이다. 초과 시 `deferred=true`와 종료 코드 `75`를 반환한다. 이 값은 **정리 보류**이며 강제 종료가 아니다. 신 API가 전환된 경우 계속 요청을 처리하고, 구 API·worker 및 journal은 유지된다. 다음 실행에서도 이전 상태 기록만으로 idle을 판단하지 않는다.

전환 전 실패는 구 API 서비스를 유지한다. 전환 후에는 이전 binary·Web로 자동 복귀하지 않는다. 같은 release 재개가 불가능하면 양쪽 artifact·실제 DB·journal을 보존하고 별도 forward-fix 절차를 검토한다. journal을 삭제하여 다른 release를 강제 실행해서는 안 된다. DB migration을 시도한 점검 배포는 기존 forward-only 복구 제한을 그대로 적용한다.

## 수동 상태 조회

```sh
podman exec gp-api-a node dist/infrastructure/runtime-control.js status
podman exec gp-api-a node dist/infrastructure/runtime-control.js quiesce maintenance
podman exec gp-worker-image node dist/infrastructure/runtime-control.js quiesce
podman exec gp-worker-image node dist/infrastructure/runtime-control.js resume
```

API scope는 `all`·`http`·`maintenance`이다. worker는 새 pass와 claim 수신만 중지하며 이미 claim한 batch의 heartbeat를 유지한다. socket은 컨테이너 내부 `/tmp/pcu-runtime-control.sock`, 권한은 `0600`이다. `status` 확인 전에 SIGTERM이나 `systemctl stop`을 보내지 않는다. 기존 강제 종료 예산은 idle 확인 이후 실제 프로세스 종료 단계에만 적용한다.

## 검증 범위

`node scripts/test-rolling-release.mjs`는 별도 PostgreSQL·Garage 컨테이너와 임의 loopback 포트를 생성한다. 실제 API 두 개, Nginx TLS·keep-alive·HTTP/2, 인증된 조회·쓰기와 collection, 업로드 전환, 파일 권한 갱신·다운로드 및 worker lease 유지·작업 재개를 검사한다. 테스트 종료 시 자신이 생성한 Compose project만 정리한다. PR Checks의 integration job에 연결되어 있다.

`server/rolling-release.test.py`는 준비·snapshot·reload·공개 probe 실패, 긴 drain, worker 교체 실패 및 같은 release 재개를 검사한다. 실제 shell 진입점의 journal 차단, 프로세스 중단·재실행과 host lock 경합도 격리 fixture로 검증한다. API runtime 테스트는 실제 CORS OPTIONS 완료, 응답·연결 종료 이후 실행 중인 hook·handler와 heartbeat 완료 대기를 검사한다. Nginx 슬롯 전환 검사는 유효한 preflight 이후 구 슬롯 drain과 긴 HTTP/1.1·HTTP/2 요청 보존을 포함한다. 이 검증은 실제 운영 설치나 서로 다른 운영 release의 업무 호환성 검증을 대신하지 않는다.
