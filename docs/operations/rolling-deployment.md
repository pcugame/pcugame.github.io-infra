# API 슬롯 병행 배포

`Deploy Release`의 `operation=rolling`은 DB 변경이 없는 호환 release를 대상으로 한다. 같은 Pod에서 API A(`4000`)와 B(`4001`)를 일시적으로 병행하며, PostgreSQL·Garage와 session·서명 설정을 공유한다. API는 사용자별 슬롯 고정을 사용하지 않는다. 서버 장애·재부팅 고가용성은 범위에 포함하지 않는다.

저장소 구현과 운영 설치는 별도 상태이다. 최초 Pod 포트·Quadlet·Nginx 전환은 점검 시간에 수행해야 하며, 이 문서의 추가는 운영 전환 완료를 의미하지 않는다.

## 최초 설치 조건

1. 기존 [Quadlet 도입 절차](../../server/quadlet/ADOPTION.md)에 따라 실제 운영 unit·Pod·Nginx 설정과 환경 파일을 조사한다. 기존 변경 사항을 보존하고 TLS, 접근 제한, 원본 IP 및 전달 헤더 정책을 검토한다.
2. 검증된 불변 이미지로 `API_SLOTS=true API_IMAGE=… DEPLOY_DIR=… bash server/quadlet/render.sh /새/검토/디렉터리`를 실행한다. 두 API의 loopback 공개 포트는 `127.0.0.1:4000`, `127.0.0.1:4001`이다. 슬롯 모드는 다른 공개 주소·포트를 거부한다. 기존 Pod의 포트 변경은 Pod 재생성이 필요하므로 점검 시간에 수행한다.
3. 검토한 정의를 설치한다. 기존 `gp-api` unit과 컨테이너는 정리하고 `gp-api-a`, `gp-api-b`를 사용한다. 두 슬롯과 worker는 `StartWithPod=false`이며 `pcu-slot-boot.service`가 기록된 활성 슬롯과 worker를 복원한다. 렌더링 결과의 `.service`는 `~/.config/systemd/user/`에, 나머지는 기존 Quadlet 디렉터리에 설치한다. `systemctl --user enable pcu-slot-boot.service`와 배포 계정의 linger 설정을 확인한다. 두 슬롯은 동일한 `common.env`·`api.env`를 참조한다.
4. `runtime-env/slot-a.env`에 `API_MAINTENANCE_PAUSED=false`, `slot-b.env`에 `API_MAINTENANCE_PAUSED=true`를 설정한다. `cutover-state/active-slot`에 `a`와 LF를 기록한다. 환경 파일과 상태 디렉터리는 배포 계정만 수정할 수 있도록 제한한다. 활성 슬롯만 시작하고 worker 6종을 시작한다.
5. [공유 upstream 예시](../../server/nginx/api-upstream.conf)를 Nginx `http` context에 설치한다. 공개 API의 `proxy_pass`는 `http://pcu_api_active`를 사용한다. gameserver의 내부 TLS 인증 vhost와 WebGL report 전달 경로도 `http://pcu_api_active`를 사용한다. [TLS vhost 생성기](../../server/prepare-file-gateway-tls.sh)는 신규 identity의 검토용 예시이며, 기존 인증서를 일반 배포에서 교체하지 않는다. NAS의 공개·보호 gateway는 현재 TLS 주소·인증서 검증·파일 전송 경로를 유지한다. NAS template의 응답 헤더 변경은 최초 점검에서만 설치한다. 일반 앱 배포는 NAS 컨테이너와 Garage를 재시작하지 않는다.
6. 기존 요청 제한 시간은 유지한다. `worker_shutdown_timeout`을 추가하지 않는다. 기존 값이 0이 아니면 rolling 검사는 거부한다. Nginx reload는 구 worker가 기존 client 요청을 마칠 때까지 유지하는 동작을 사용한다. [Nginx 공식 제어 문서](https://nginx.org/en/docs/control.html)
7. [설치 manifest 예시](../../server/rolling-installation.example.json)를 `DEPLOY_DIR/rolling-installation.json`에 작성한다. `version=2`와 실제 Quadlet 경로를 지정한다. [전용 helper](../../server/nginx/pcu-api-proxy.py)를 root 소유 `/usr/local/sbin/pcu-api-proxy`에 mode 0755로 설치한다. `/etc/nginx/pcu`와 upstream 파일은 root만 수정할 수 있도록 설정한다. [sudoers](../../server/nginx/pcu-api-proxy.sudoers)를 `visudo -cf`로 검증 후 root 소유 mode 0440으로 설치한다. 허용 명령은 `check`, `status`, `switch a`, `switch b`뿐이다. helper는 고정 경로만 사용하며 설정 교체·검사·reload를 잠금으로 직렬화하고 의도·결과를 syslog/journal에 기록한다.
8. `DEPLOY_DIR=… python3 server/rolling-release.py fingerprint-nginx`로 실제 `nginx -T` 결과의 fingerprint를 확인하고, 검토한 설정과 일치할 때 manifest에 기록한다. 변경 가능한 upstream 본문만 fingerprint에서 제외한다. `audit-installation`으로 실제 Pod 포트, legacy API 부재, Quadlet source, Nginx worker 및 gameserver의 세 경로가 공유 upstream을 사용하는지 확인한다. NAS 경로는 로컬 Nginx 설정 검사 대상에 포함하지 않고, 아래 공개·보호 probe로 확인한다. 파일 존재만으로 설치 완료를 판단하지 않는다.

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

`DEPLOY_DIR/rolling-probes.json`은 권한 `0600`으로 저장한다. 검증 전용 사용자·작품·업로드를 사용하며 실제 사용자 데이터에 대한 임의 쓰기를 구성하지 않는다. 같은 `cookie`를 후보 슬롯과 공개 경로에 사용한다. 모든 쓰기 요청은 재실행 가능한 `PATCH`·`PUT` 설정 요청이며 `category=authenticated-write`, `replaySafe=true`를 요구한다. `fixtures`에는 전용 자원의 `id`, 정확한 `path`, `dedicated=true`를 기록하고 같은 경로의 멱등 정리 요청을 `cleanup` 배열에 구성한다. 승인 전 정리는 기존 API, 편입 후 정리는 신 API의 loopback에서 실행하며 기대 응답을 검증한다. 일반 운영 데이터 rollback이나 반복 생성 `POST`는 허용하지 않는다. 배포 중 probe 설정은 권한 0600의 release별 사본으로 고정한다. 전용 사용자·자원과 멱등성은 fixture 구성 시 실제 API 계약으로 검증해야 한다. 각 request는 `path`, `method`, `status`, `category`, 선택적인 `headers`·`body`, 기대 JSON 경로인 `json` 또는 `responseHeaders`를 포함한다.

- `candidate`: 직접 loopback 후보 API의 deep health, 인증된 `/api/me`, 인증된 쓰기, 빈·채워진 collection, `/api/internal/file-access` 승인 검사를 포함한다. 범주는 `authenticated-read`, `authenticated-write`, `empty-collection`, `populated-collection`을 사용한다.
- `public`: `publicOrigin` HTTPS 주소에서 같은 인증·쓰기·collection 검사를 수행한다.
- `nas-public`, `nas-protected`: 각각 `nas-publicOrigin`, `nas-protectedOrigin` HTTPS 주소에서 기존 capability의 실제 다운로드와 예상 응답 헤더를 검사한다. 두 group 모두 실제 GET 200 검사를 요구한다. HEAD·Range·304·416 응답도 fixture에 맞게 추가한다. 응답 `X-PCU-API-Slot`은 후보 슬롯과 같아야 한다.

예를 들어 `/api/me`의 기대 JSON은 `{"ok":true,"data.authenticated":true}`, 빈 목록은 `{"ok":true,"data.items":[]}`, 채워진 목록은 `{"ok":true,"data.items.length":1}`로 지정한다. 쓰기 요청에는 해당 route의 JSON body와 CSRF `Origin` 등 기존 인증 정책에 필요한 헤더를 지정한다. 내부 승인 요청에는 기존 gateway secret·파일 종류·capability URI를 지정한다. URL, cookie, token 및 request body는 배포 로그에 출력하지 않는다. 준비되지 않은 probe 설정은 전환 전에 실패한다.

## 실행 순서와 재개

`operation=rolling`은 기존 production gate, 정확한 source 검증과 불변 이미지 선택을 사용한다. 다음 순서를 수행한다.

1. 실제 설치 상태·artifact·capacity·호환성·probe 설정을 확인한다. 대상 이미지의 모든 migration 이름·checksum을 운영 적용 이력과 비교한다. 미적용·실패·rollback·중복·추가 이력은 전환 전에 거부한다. 승인된 과거 alternate contract 경로는 기존 receipt 검사와 같은 선택 규칙을 사용한다.
2. 기존 온라인 DB snapshot과 격리 복원 검증을 수행한다. SQL migration은 실행하지 않는다.
3. 최초 후보 서비스 변경 전에 대상 슬롯·SHA·digest, 기존 이미지 조합·슬롯 정의·환경과 전용 probe 사본을 journal에 기록하고 fsync한다. 후보는 loopback에서 검증하며 maintenance를 중지 상태로 유지한다. DB·Garage 연결은 허용한다. 배포 관리자는 readiness·호환성·인증·업무 probe와 fixture 정리를 확인하고 release ID·슬롯·SHA·digest·컨테이너 ID·시작 시각·PID·boot ID에 결부한 승인 근거를 기록한다. 수동 승인이나 API의 자기 승인은 사용하지 않는다.
4. 후보 인스턴스를 다시 확인하고 전환 의도(`switch`)와 구 Nginx worker의 PID·시작 시각을 fsync한 뒤 기존 proxy helper로 공유 upstream을 변경하고 Nginx 설정 검사·reload를 수행한다. 공개·내부 probe가 신 슬롯에 도달해야 활성 슬롯 기록을 갱신한다.
5. 구 API의 maintenance 수신을 중지한다. 구 Nginx worker가 모두 종료된 후 구 API의 HTTP 수신을 중지한다. 요청·hook/handler 실행·maintenance가 모두 0일 때만 systemd stop을 실행한다.
6. 신 API의 maintenance를 활성화하고 worker를 순차 교체한다. worker는 claim 수신을 중지한 뒤 기존 작업과 heartbeat가 종료될 때까지 유지한다. 실행 중 작업의 AbortSignal은 배포 drain으로 취소하지 않는다.
7. 전체 runtime 검사를 통과하면 같은 SHA의 Web을 게시한다. 공개·내부 smoke와 실제 Web SHA 확인 후 journal을 완료 처리한다.

`cutover-state/host-release.lock`은 host 동시 실행을 차단한다. `rolling-release.json`은 source SHA, image digest, 이전 image, 양쪽 슬롯, 단계, Nginx worker 세대와 완료 worker 목록을 저장하며 파일·디렉터리를 fsync한다. SSH·workflow가 중단되어도 같은 release를 재실행하면 실제 runtime과 대조하여 재개한다. 부팅 복원은 journal과 실제 upstream 파일의 슬롯을 대조한다. 승인 전에는 구 API maintenance를 유지하고 후보 maintenance를 중지한다. 전환 의도 이후에는 양쪽 API를 maintenance 중지 상태로 복원하며, 완료되지 않은 worker 교체는 이전에 기록한 이미지로 복원한다. 완료 worker는 새 이미지를 유지한다. 부팅은 release 단계를 진행하지 않으며, 같은 SHA·digest로 재개할 때만 교체한다. journal과 upstream이 불일치하면 자동 복원을 거부한다. 점검 배포 중 표시가 있으면 명시적 복구를 요구한다. 다른 release와 기존 점검 배포·자동 복구는 `complete` 또는 안전한 취소 완료인 `aborted`만 허용한다. 미완료·알 수 없는 상태는 거부한다.

관찰 시간은 단계별 기본 10분이다. 초과 시 `deferred=true`와 종료 코드 `75`를 반환한다. 이 값은 **정리 보류**이며 강제 종료가 아니다. 신 API가 전환된 경우 계속 요청을 처리하고, 구 API·worker 및 journal은 유지된다. 다음 실행에서도 이전 상태 기록만으로 idle을 판단하지 않는다.

사전 검사와 온라인 snapshot은 운영 서비스 변경·인증된 쓰기 probe 전에 수행하며 새 미완료 journal을 남기지 않는다. 후보 준비 이후의 인증된 쓰기는 전용 fixture에 한정한다. 후보 기동·검증 실패는 같은 host lock 아래에서 `candidate → aborting → aborted` 취소를 시도한다. 후보 quiesce 후 요청·handler·maintenance가 모두 종료되고, 서비스가 중지되어 재기동 대기 상태가 아니며, fixture 정리와 기존 슬롯 정의·환경 복원이 완료되어야 `aborted`를 기록한다. 불명확한 상태나 정리 실패는 `aborting`에 유지하며 강제 종료하지 않는다.

승인 전 취소를 명시적으로 실행할 때는 기존 `DEPLOY_DIR`, `RELEASE_SOURCE_SHA`, `FINAL_IMAGE`를 유지하고 `python3 "$DEPLOY_DIR/rolling-release.py" abort`를 실행한다. 중단된 취소는 같은 release의 일반 재실행 또는 `abort`로 재개한다. `aborted` 이후에는 다른 이미지의 배포·점검 배포·복구가 각 경로의 기존 안전 조건에 따라 진행된다. 구형 `preflight` journal은 실제 proxy·active slot·서비스 이미지와 비활성 슬롯 중지 상태를 대조하고 전용 fixture 정리를 수행한 뒤 해제한다. 정리 설정이 없으면 `rolling-probes.json`에 기존 검증 fixture의 재실행 가능한 정리 요청을 구성한 뒤 재실행한다. 정상 복구에 journal 수동 삭제는 필요하지 않다.

`switch`가 기록된 이후에는 helper 실패·응답 유실도 미편입의 증거로 취급하지 않는다. 취소를 금지하고 같은 SHA·digest로 재개한다. 승인 전 후보의 systemd 자동 재시작을 비활성화하여 마지막 인스턴스 확인과 proxy 변경 사이에 새 프로세스가 자동 기동하지 않도록 한다. handoff에서 기존 자동 재시작 정책을 복원한다. 후보가 명시적 재개·부팅으로 재시작되면 새 인스턴스의 readiness·업무 probe를 다시 실행하며 이전 승인 결과를 재사용하지 않는다. 공개 API와 NAS 공개·보호 경로 검증 이후에만 `drain`을 기록한다. 부팅 복원은 기록된 이미지 조합을 유지하고 proxy를 변경하지 않는다. 취소 중 이미 중지한 후보를 부팅 시 다시 시작하지 않는다.

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

`node scripts/test-rolling-release.mjs`는 별도 PostgreSQL·Garage 컨테이너와 임의 loopback 포트를 생성한다. 같은 코드의 실제 API 두 개, 별도 API proxy·NAS gateway 컨테이너, 검증된 TLS·keep-alive·HTTP/2, 인증된 조회·쓰기와 collection, 업로드 전환, 파일 권한 갱신·다운로드 및 worker lease 유지·작업 재개를 검사한다. 테스트 종료 시 자신이 생성한 Compose project만 정리한다. PR Checks의 integration job에 연결되어 있다.

`server/rolling-release.test.py`는 준비·snapshot·reload·공개 probe 실패, 긴 drain, worker 교체 실패 및 같은 release 재개를 검사한다. API runtime 테스트는 연결 종료 이후 실행 중인 hook·handler와 heartbeat 완료 대기를 검사한다. 이 검증은 실제 운영 설치나 서로 다른 운영 release의 업무 호환성 검증을 대신하지 않는다.

## 운영 설치 전 수용 검사

운영 점검에서 단일 API `127.0.0.1:4000`, NAS의 Garage·업로드·공개·보호 gateway 분리 구성을 확인하였다. 당시 운영 source는 `fd3093531277a042d24ac340b466d53e1c0b4871`이다. runtime 제어가 포함된 이미지와 helper 설치는 아직 운영에 적용하지 않았다. `20261014000000_upload_creation_identity`와 기존 migration 예외 이력은 유지한다.

최초 설치 전에 동일 Podman 버전·분리 gateway 환경에서 다음 항목을 검증하고 점검 시간을 산정한다. DB volume `gp_pg_data`와 PostgreSQL 이미지 identity를 보존하며, 슬롯 설치 자체는 migration을 실행하지 않는다. 운영 환경 파일·Quadlet·proxy·이미지·volume 정보를 보존하고 온라인 백업의 checksum·격리 복원을 확인한다. 점검 중 쓰기 중지 이후 백업을 추가 확보한다.

- 서로 다른 불변 이미지로 A→B와 다음 release의 B→A를 실행한다. 양쪽에서 전환 전후 각 5분 이상 인증 조회·쓰기·빈/채워진 목록 요청을 유지한다.
- multipart 생성·part·완료, 기존 capability 갱신, 공개·보호 다운로드의 GET·HEAD·Range·304·416 및 WebGL 요청을 확인한다.
- 전환을 가로지르는 장시간 다운로드와 worker 작업의 완료, 유실·중복 확정 부재를 확인한다.
- 후보 기동·TLS·reload·전환 후 probe·worker 교체 실패, SSH 종료, drain 보류, 단계별 재부팅과 같은 release 재개를 검증한다.
- 배포로 인한 연결 끊김·5xx·인증 손실 0건을 합격 기준으로 사용하고 source SHA·digest·활성 슬롯·측정 구간·검사 결과를 보존한다.

로컬 상태 머신·HTTP 통합 검사는 위 운영 리허설의 대체 근거가 아니다. Podman 실설치·재부팅, 서로 다른 release 이미지의 5분 연속 양방향 전환 및 운영 계정의 업무 검사는 운영 설치 전 별도 합격 조건이다. 이 변경의 PR·CI 시작 이후 병합·최초 점검·배포는 후속 요청 범위에서 진행한다.

## 로컬 검증 기록 — 2026-10-15

- API 단위·회귀 테스트 1,232개, API script 테스트 82개, release artifact 테스트 31개가 통과하였다. 환경 조건부 API 테스트 289개는 기본 실행에서 제외되었다.
- 별도 PostgreSQL·Garage와 API proxy·공개/보호 gateway로 구성한 통합 테스트 2개가 통과하였다. 인증 조회·쓰기·빈/채워진 목록, multipart 생성·part·완료, capability 갱신, 양쪽 다운로드의 GET·HEAD·Range·304·416, WebGL, 기존 HTTP/1.1·HTTP/2 요청 완료 및 worker lease 갱신·작업 완료를 검증하였다. TLS 인증서 검증을 유지하였다.
- 제한 helper의 잘못된 인자·설정 검사 실패·reload 실패, 배포 상태 머신의 실패·drain 보류·재개와 부팅 계획을 검증하였다. 점검 배포·활성 슬롯별 snapshot·pre-migration 복구는 shell double로 검증하였다.
- API lint·build, architecture, CI 선택·workflow 검사, 기존 gateway TLS 검사와 diff 검사가 통과하였다. 로컬 NixOS의 Prisma 생성에는 설치된 schema engine 경로를 지정하였다. 이는 운영 환경 변경이 아니다.
- Podman native generator 검사 1개는 실행 환경 부재로 제외되었다. 실제 Podman 설치·재부팅, 서로 다른 불변 이미지의 5분 연속 양방향 전환, 전환을 가로지르는 장시간 파일 전송은 미검증이다. 운영 설치 전 수용 검사를 유지한다.
