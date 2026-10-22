# 단일 PC 배치

[가이드](README.md) · [다음: NAS 차이](nas.md)

## 호스트 준비

새 검증 VM에서 관리자 계정으로 실행한다. 기존 운영 호스트 전환에는 [Quadlet adoption](../../server/quadlet/ADOPTION.md) 절차를 사용한다. 아래 계정·경로가 이미 존재하면 소유권과 사용 현황을 먼저 확인한다.

```sh
sudo apt-get update
sudo apt-get install podman uidmap dbus-user-session slirp4netns passt ca-certificates curl
sudo adduser pcu
sudo loginctl enable-linger pcu
sudo install -d -o pcu -g pcu -m 0700 /srv/pcu /srv/pcu/config /srv/pcu/exports /srv/pcu/backups
```

`pcu` 계정으로 직접 SSH/login한 shell에서 이후 rootless 명령을 실행한다. `sudo podman`과 `podman`의 storage·network·unit은 서로 다르다. `/etc/subuid`, `/etc/subgid`에 이 계정의 충돌 없는 subordinate 범위(최소 65536개)가 있어야 한다.

```sh
podman --version
podman info --format '{{.Host.CgroupsVersion}} {{.Host.NetworkBackend}}'
podman unshare cat /proc/self/uid_map
systemctl --user is-system-running
ss -ltn
mkdir -p ~/.config/containers/systemd
```

Podman 5.4.2·cgroup v2·Netavark/Aardvark를 기준으로 한다. host 443·4000·8080·3901·3904·3906이 다른 서비스와 충돌하지 않는지 확인한다. 방화벽은 공개 443 및 승인된 관리 접속만 수신한다. 원격 접속 중 관리 포트를 임의로 차단하지 않는다.

## 설정 배치

전달받은 `pcu-runtime-files.tar.gz`를 `pcu` 계정의 별도 작업 디렉터리에 해제한다. 이후 명령은 이 디렉터리 기준이다.

```sh
tar -xzf pcu-runtime-files.tar.gz
install -m 0600 server/manual/config/postgres.env.example /srv/pcu/config/postgres.env
install -m 0600 server/manual/config/app.env.example /srv/pcu/config/app.env
install -m 0600 server/manual/config/gateway.env.example /srv/pcu/config/gateway.env
install -m 0600 server/manual/config/garage.toml.example /srv/pcu/config/garage.toml
install -m 0644 server/manual/config/web.json /srv/pcu/config/web.json
install -m 0644 server/manual/config/*.conf /srv/pcu/config/
install -m 0644 apps/db/*.nginx.conf.template /srv/pcu/config/
install -m 0755 apps/db/validate-data-plane-env.sh /srv/pcu/config/
mkdir -p /srv/pcu/config/tls/internal /srv/pcu/config/tls/public
```

`REPLACE_WITH_…`를 실제 값으로 직접 수정한다. 독립 secret은 안전한 난수 도구로 각각 생성하여 해당 파일에 기록한다. Garage RPC는 32-byte hex, DB·session·gateway·Garage admin은 서로 다른 값이다. S3 앱 key는 Garage 초기화 후 기재한다. 인증서·키·CA를 [파일 계약](configuration.md)에 따라 제공하고 `ca-bundle.crt`는 신뢰할 시스템 CA와 필요한 사설 CA를 합친 PEM 파일로 준비한다. 인증서 검증을 끄지 않는다.

`server/manual/rootless/gp-*.container`의 API 이미지 7개와 `pcu-web.container`를 실제 digest로 편집한다. 이미지 pull은 rootless 계정에서 미리 완료한다. rootful edge 이미지도 관리자 계정에서 별도로 pull한다. runtime 계정은 Git checkout·npm·Node 설치가 필요하지 않다.

## 네트워크·DB·Garage 기동

최초에는 기반 unit만 설치한다. 앱·gateway unit의 자동 시작은 DB 초기화 뒤 추가한다.

```sh
cp server/manual/rootless/*.network server/manual/rootless/*.volume \
  server/manual/rootless/graduationproject.pod \
  server/manual/rootless/gp-postgres.container \
  server/manual/rootless/pcu-garage.container \
  server/manual/rootless/pcu-s3-tls.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start gp-postgres.service pcu-garage.service pcu-s3-tls.service
podman exec gp-postgres psql -U pcu -d pcu -v ON_ERROR_STOP=1 -c 'SELECT current_database(), 1;'
podman exec pcu-garage /garage status
podman exec pcu-garage /garage layout show
```

DB 조회는 `pg_isready`만의 결과와 구분한다. Garage는 다음 [최초 초기화](initialization.md)의 node/layout·bucket·key·CORS 준비가 필요하다. 같은 사용자 영역의 기존 `graduationproject` pod나 `gp_pg_data`가 존재하면 새 설치 명령을 진행하지 않고 기존 배치 여부를 확인한다.

문법 검사는 활성 unit에 영향을 주지 않는 별도 디렉터리에서 실행할 수 있다.

```sh
QUADLET_UNIT_DIRS="$PWD/server/manual/rootless" \
  /usr/lib/systemd/system-generators/podman-system-generator --user --dryrun
```

Quadlet generated service에 `systemctl enable`을 실행하지 않는다. 부팅 연결은 `[Install]` 및 linger로 구성한다. 기준 문서는 [Podman Quadlet](https://docs.podman.io/en/v5.4.2/markdown/podman-systemd.unit.5.html)이다.

## client IP 검사

초기 공개 전 maintenance 상태에서 API를 잠시 중지하고 같은 pod·port의 일회성 진단 server로 실제 peer를 관찰한다. 운영 API는 기본 요청 logger가 비활성화되어 있으므로 journal에 `req.remoteAddress`가 있다고 가정하지 않는다. 다음 명령은 인증 기능을 제공하지 않으며 `/__pcu_proxy_probe`만 응답한다. 첫 terminal에서 실행하고 두 번째 terminal에서 외부 proxy를 통해 요청한다.

```sh
systemctl --user stop gp-api.service
podman run --rm --name pcu-proxy-probe --pod graduationproject \
  --env-file /srv/pcu/config/app.env \
  -v /srv/pcu/config/ca.crt:/etc/pcu/ca.crt:ro,z --entrypoint node "$PCU_API_IMAGE" --input-type=module -e '
import Fastify from "fastify";
import { parseTrustProxy } from "./dist/shared/trust-proxy.js";
const app = Fastify({ trustProxy: parseTrustProxy(process.env.TRUST_PROXY) });
app.get("/__pcu_proxy_probe", request => ({ peer: request.raw.socket.remoteAddress, client: request.ip }));
await app.listen({ host: "0.0.0.0", port: 4000 });
'
```

```sh
curl --fail --cacert /srv/pcu/config/ca-bundle.crt \
  -H 'X-Forwarded-For: 203.0.113.99' https://api.pcu.test/__pcu_proxy_probe
```

`TRUST_PROXY=false`에서 `peer`를 기록한다. API env를 수정한 뒤 probe를 종료·재실행하여 `client`가 실제 외부 client IP인지 확인한다. 종료는 `podman stop pcu-proxy-probe`, API 복귀는 `systemctl --user start gp-api.service`이다. 진단 중에는 일반 API 요청이 실패하므로 운영 중 임의 실행하지 않는다.

gateway도 임시 query-free access log에 `$realip_remote_addr`와 `$remote_addr`만 기록하여 외부 proxy가 실제로 연결하는 peer를 확인한다. 요청 URL·query·cookie·token은 로그에 추가하지 않는다.

`gateway-realip.conf`의 `set_real_ip_from`을 관찰한 정확한 peer로 수정한다. 예제의 `10.89.40.1`을 검증 없이 신뢰하지 않는다. API `TRUST_PROXY`에는 API에서 관찰한 외부 proxy peer와 assets gateway `10.89.40.22`·download gateway `10.89.40.23`을 comma-separated IP로 설정한다. IPv4-mapped IPv6이면 관찰값과 라이브러리 해석을 검사한다. 전체 subnet·`true`·숫자 hop count로 대체하지 않는다.

설정 변경 후 API·gateway를 재생성한다. 외부에서 임의 `X-Forwarded-For: 203.0.113.99`를 보낸 요청과 정상 요청의 API client IP가 동일한 실제 client IP인지 확인한다. 보호 다운로드 권한 검사에서도 동일하게 확인한다. API에 직접 연결한 비신뢰 network peer의 위조 header는 무시되어야 한다. loopback publish는 같은 호스트의 신뢰된 process도 접근할 수 있는 경계이다. 임시 진단 log를 제거한 뒤 공개한다.
