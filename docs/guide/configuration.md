# 설정·권한

[가이드](README.md) · [다음: 컨테이너 계약](containers.md)

## 파일 계약

`server/manual/config/*.example`을 아래 이름으로 복사한 뒤 직접 편집한다. 환경 파일은 `literal KEY=value`이다. `export`, shell command, `${OTHER_VAR}` 참조, 따옴표를 통한 shell 해석을 사용하지 않는다. URL의 비밀번호에는 URL percent encoding이 필요하므로 문자·숫자로 생성한 DB 비밀번호를 사용하면 입력을 단순화할 수 있다. secret을 명령 인수·Git·로그·Web JSON에 기재하지 않는다.

| `/srv/pcu/config` 파일 | 읽는 구성요소 | 필수 설정 |
| --- | --- | --- |
| `postgres.env` | PostgreSQL | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` |
| `app.env` | API·worker·일회성 Prisma | DB·session·OAuth·origin·S3·기능 설정 |
| `gateway.env` | upload·assets·download | resolver·API/S3 upstream·gateway secret·CORS·연결 한도 |
| `web.json` | Web 브라우저 | `apiBaseUrl`, `googleClientId`, `visibilityControlsEnabled` |
| `garage.toml` | Garage | data/meta·단일 node·RPC secret·admin token |
| `ca.crt` | Node API·worker | 내부 S3 인증서 CA 또는 CA chain(PEM) |
| `ca-bundle.crt` | gateway | 시스템 CA와 필요한 사설 CA를 포함한 PEM bundle |
| `tls/internal/{fullchain.pem,privkey.pem}` | 내부 S3 proxy | 내부 S3 이름의 TLS 인증서·키 |
| `tls/public/{fullchain.pem,privkey.pem}` | 외부 TLS proxy | 5개 공개 이름의 SAN을 포함한 인증서·키 |
| Nginx `.conf`·`.template`, validation script | 해당 proxy | 예제 파일과 기존 gateway template |

`web.json`은 비밀정보가 없는 공개 파일이며 0644로 읽을 수 있게 설정한다. 컨테이너 Web은 파일 로드 성공 이후에만 앱을 import한다. 파일 누락·HTML fallback·잘못된 JSON·자료형·HTTP URL·경로가 있는 URL은 구성 오류로 처리한다. 필수 설정 오류에서 `localhost:4000`으로 대체하지 않는다. `/runtime-config.json`은 `no-store`, conditional cache 비활성화, 브라우저 `cache: no-store`를 적용한다. Web 경로는 `/`이며 기존 개발·Pages는 Vite 설정을 유지한다.

## 환경값 기준

아래 표는 이번 실행 정의의 운영 설정 기준이다. 전체 앱 설정의 자료형·기본값은 [env schema](../../apps/api/src/config/env.ts)를 참조한다. 개발 예제는 [개발 가이드](development.md)의 별도 범위이다.

| 항목 | 기준·필수 여부 |
| --- | --- |
| `DATABASE_URL` | 필수. pod 내부 `postgres:5432`, `postgres.env`의 DB·계정·비밀번호와 일치 |
| `SESSION_SECRET` | 필수. 32자 이상 독립 secret |
| `FILE_GATEWAY_SECRET` | 운영 gateway에 필수. URL-safe 32자 이상; API와 gateway의 값 일치, session secret과 분리 |
| `COOKIE_SECURE`, `COOKIE_SAME_SITE` | 예제는 `true`, `lax`. 같은 site의 서로 다른 HTTPS origin. 서로 다른 site로 분리하면 기존 cookie·브라우저 제약을 별도 검증 |
| `SESSION_COOKIE_NAME`, session 시간 | 예제 `sid`; 시간값 생략 시 기존 schema 기본값. root path·HttpOnly 유지 |
| `GOOGLE_CLIENT_IDS` | API 허용 client ID 목록. Web의 client ID를 포함 |
| `ALLOWED_GOOGLE_HD` | 테스트는 `pcu.ac.kr`. 검증된 token의 `hd` 정확한 일치. 이메일 접미사 검사와 다름; 실제 운영값을 임의 변경하지 않음 |
| `DEV_AUTH_ENABLED` | `false`. production 인증 우회 없음 |
| `CORS_ALLOWED_ORIGINS` | 정확한 Web HTTPS origin. wildcard 금지 |
| `API_PUBLIC_URL`, `WEB_PUBLIC_URL` | 필수. 공개 API·Web origin |
| `PUBLIC_ASSET_ORIGIN` | 필수. assets origin |
| `S3_ENDPOINT` | 내부 TLS proxy HTTPS origin |
| `S3_PUBLIC_SIGNING_ENDPOINT` | upload HTTPS origin |
| `S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT` | download HTTPS origin |
| `S3_REGION`, `S3_FORCE_PATH_STYLE` | `garage`, `true` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Garage가 발급한 앱 key. DB·RPC·admin·session secret과 별도 |
| `S3_BUCKET_PUBLIC`, `S3_BUCKET_PROTECTED` | `pcu-public`, `pcu-protected`. Garage·SQL registry·gateway의 이름과 일치 |
| `NODE_EXTRA_CA_CERTS` | 컨테이너 내부 `/etc/pcu/ca.crt` |
| `TRUST_PROXY` | 최초 관찰 시 `false`. 이후 [client IP 검사](single-pc.md#client-ip-검사)의 정확한 proxy peer IP 목록; `true`·hop count 사용 금지 |
| `WEBGL_PLAY_ENABLED` | 예제 `true`. 공개 전 gateway·play 검사 필수 |
| `WEBGL_EXTERNAL_CONNECTIONS_ENABLED` | 기본 `false`. 활성화는 기존 승인 연결 정책과 별도 검증 필요 |
| worker temp 설정 | GAME/WebGL 6 GiB, video 2 GiB, image 512 MiB의 독립 tmpfs. worker 상한과 일치 |
| `NAS_EXPORT_ROOT` | export worker의 `/exports`. Web에서 제공하지 않는 전용 경로 |
| `NGINX_RESOLVER` | 운영자가 명시하는 DNS IP. 단일 PC 예제 `10.89.40.1`; Docker 예제만 `127.0.0.11` 기본값 |
| `FILE_GATEWAY_API_UPSTREAM` | 단일 PC `http://10.89.40.10:4000`; NAS는 신뢰 TLS와 정확한 server name |
| `GARAGE_S3_UPSTREAM`, `GARAGE_PUBLIC_WEB_UPSTREAM` | 격리 저장소 네트워크의 `10.89.41.10:3900`, `:3902` |
| `PUBLIC_CORS_ORIGIN_PRIMARY/SECONDARY`, `WEB_PUBLIC_ORIGIN` | 정확한 Web·API origin. null·wildcard를 운영 허용값으로 추가하지 않음 |
| `NGINX_ENVSUBST_FILTER` | 예제 allowlist 유지. Nginx의 `$request_uri` 등 내부 변수를 환경 치환하지 않음 |
| 투표 조사 설정 | 기본 미설정. 별도 secret과 승인된 개인정보 안내를 함께 구성한 경우만 활성화 |

## 소유권·mount

운영 계정은 rootless namespace에서 UID 0에 해당한다. 앱 이미지 UID/GID `1001:1001`은 호스트의 UID 1001과 같지 않다. `podman unshare cat /proc/self/uid_map`으로 범위를 확인한다. 새 로컬 export 디렉터리에 다음과 같이 적용한다.

```sh
podman unshare chown 1001:1001 /srv/pcu/exports
podman unshare chmod 0750 /srv/pcu/exports
chmod 0600 /srv/pcu/config/*.env /srv/pcu/config/garage.toml
chmod 0600 /srv/pcu/config/tls/internal/privkey.pem /srv/pcu/config/tls/public/privkey.pem
chmod 0644 /srv/pcu/config/web.json /srv/pcu/config/ca.crt /srv/pcu/config/ca-bundle.crt
chmod 0755 /srv/pcu/config/validate-data-plane-env.sh
```

DB와 Garage data/meta named volume의 내부 소유권은 각 이미지가 관리한다. `chmod 777`로 권한 문제를 대체하지 않는다. 환경 파일은 Podman이 읽고, CA는 UID 1001의 Node process도 읽을 수 있어야 한다. Nginx worker가 읽는 공개 JSON은 0644를 사용한다. 설정 상위 디렉터리는 계정 소유 0700으로 유지할 수 있다.

SELinux enforcing 환경에서 여러 컨테이너가 공유하는 CA·인증서·template은 `:ro,z`, 한 컨테이너 전용 data/export는 `:Z`를 사용한다. host 전체·홈·NAS 공용 tree를 재라벨하지 않는다. NFS는 별도 mount 옵션·NAS ACL과 host UID 매핑을 확인하고 [NAS 차이](nas.md)를 적용한다.
