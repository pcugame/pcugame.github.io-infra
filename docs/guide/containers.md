# 컨테이너 계약

[가이드](README.md) · [다음: 단일 PC](single-pc.md)

## 이미지·명령·저장소

| unit | 이미지·명령 | 영속·임시 저장소 |
| --- | --- | --- |
| `gp-postgres` | PostgreSQL 16 Alpine | `gp_pg_data` |
| `gp-api` | 공통 API 이미지, `node dist/server.js` | 이미지 내 앱·Prisma·native library |
| `gp-worker-game-validation` | 같은 이미지, `node dist/game-validation-worker.js` | `/tmp` 6 GiB |
| `gp-worker-webgl` | 같은 이미지, `node dist/webgl-worker.js` | 독립 `/tmp` 6 GiB |
| `gp-worker-video` | 같은 이미지, `node dist/video-worker.js` | `/tmp` 2 GiB |
| `gp-worker-image` | 같은 이미지, `node dist/image-worker.js` | `/tmp` 512 MiB |
| `gp-worker-export` | 같은 이미지, `node dist/export-worker.js` | `/srv/pcu/exports` → `/exports` |
| `gp-worker-project-publication` | 같은 이미지, `node dist/project-publication-worker.js` | DB·S3의 job 상태 |
| `pcu-garage` | Garage v1.1.0 | `pcu_garage_data`, `pcu_garage_meta` |
| `pcu-s3-tls` | Nginx 1.27 Alpine | 인증서·설정 read-only |
| `pcu-upload`, `pcu-assets`, `pcu-download` | Nginx 1.27 Alpine, 기존 gateway template | read-only root, Nginx 한정 tmpfs |
| `pcu-web` | 새 정적 Web 이미지 | 공개 JSON read-only |
| `pcu-edge` (rootful) | Nginx 1.27 Alpine, host network | 공개 TLS·proxy 설정 read-only |

API·worker의 기존 entrypoint를 재사용한다. 별도 renderer 없이 `.container`를 직접 편집한다. 새 DB 초기화는 동일 API 이미지의 Prisma CLI를 일회성 컨테이너로 실행한다. 정상 startup에는 migration·seed가 없다. 앱 이미지의 UID/GID는 `1001:1001`이다.

## 연결·신뢰 경계

`pcu-app`은 `10.89.40.0/24`, 내부 `pcu-storage`는 `10.89.41.0/24`이다. 기존 호스트·VPN 대역과 충돌하면 `.network` 및 모든 명시적 주소를 함께 변경한다. 앱 pod의 고정 주소는 `10.89.40.10`, Garage는 `10.89.41.10`, 내부 TLS proxy는 양쪽 `.30`, gateway는 upload `.21`·assets `.22`·download `.23`이다.

| 연결 | 경로 |
| --- | --- |
| API·worker → DB | 같은 `graduationproject` pod의 `postgres:5432` (`AddHost=postgres:127.0.0.1`) |
| API·worker → S3 | `s3.internal.pcu.test:443`, 내부 TLS proxy |
| upload·download → Garage | 저장소 network `10.89.41.10:3900` |
| assets → Garage | 저장소 network `10.89.41.10:3902` |
| assets·download → 권한 검사 | 앱 network `10.89.40.10:4000`, 독립 gateway secret |
| 외부 proxy → API·Web | host loopback `4000`, `8080` |
| 외부 proxy → gateway | host loopback `3901`, `3904`, `3906` |

Garage의 S3 3900·RPC 3901·website 3902·admin 3903은 host에 공개하지 않는다. 호스트의 **3901은 upload gateway**이며 Garage RPC와 다른 연결이다. DB host port도 없다. 내부 S3 proxy는 host publish가 없으며 앱 network에서만 접근한다. 단일 PC의 전용 계정과 앱 network는 신뢰 경계에 포함된다. 관련 없는 컨테이너를 이 network에 추가하지 않는다.

외부 proxy는 클라이언트의 `X-Forwarded-For`, `X-Real-IP`, `Forwarded` 주장을 덮어쓴다. gateway는 확인한 rootless port-forwarding peer만 신뢰하여 client IP를 복원한다. API는 확인한 외부 proxy peer와 assets·download gateway의 정확한 IP만 신뢰한다. 실제 peer는 Podman network backend에 따라 달라질 수 있으므로 [검사](single-pc.md#client-ip-검사)를 완료한다.

## 버전 고정

2026-10-16 로컬 Docker에서 pull 후 확인한 OCI digest이다. 실행 정의에는 tag와 digest를 함께 기재하였다. 이 표는 Debian Podman 전체 수용 검사 완료를 의미하지 않는다.

| 이미지 | digest |
| --- | --- |
| `postgres:16-alpine` | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` |
| `nginx:1.27-alpine` | `sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10` |
| `dxflrs/garage:v1.1.0` | `sha256:fdb8272fcbe643eef830ee17874d5d4ed623a86501f1acbac8012583113b1c26` |

Podman 5.4.2에서 pod의 exit policy는 기존 `PodmanArgs=--exit-policy=continue`를 유지한다. `StartWithPod=false`로 초기화 단계에서 pod start가 앱을 함께 시작하지 않도록 하였다. 초기화 완료 후 각 unit의 `[Install]`로 부팅 시 시작한다. `After=`는 순서만 지정하며 DB·S3 readiness는 아래 실제 연결 검사로 확인한다. [Podman 5.4.2 Quadlet 문서](https://docs.podman.io/en/v5.4.2/markdown/podman-systemd.unit.5.html)의 user/system 경로와 generator 규칙을 따른다.
