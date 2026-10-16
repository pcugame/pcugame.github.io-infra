# 수동 컨테이너 운영 가이드

[개요](../../README.md) | **가이드**

운영자는 설정 파일과 실행 정의를 직접 편집하고 Podman·systemd 명령으로 서비스를 관리한다. API·worker는 기존 공통 이미지의 실행 명령을 사용하고 Web은 정적 Nginx 이미지로 공급한다. 일반 기동에 설치·빌드·migration·seed·관리자 생성을 포함하지 않는다.

| 순서 | 항목 | 산출물·확인 범위 |
| --- | --- | --- |
| 1 | [준비 조건](#준비-조건) | 계정·이미지·주소·TLS·저장소 |
| 2 | [설정·권한](configuration.md) | 환경 파일·JSON·secret·UID·SELinux |
| 3 | [컨테이너 계약](containers.md) | 이미지·네트워크·포트·mount·entrypoint |
| 4 | [단일 PC 배치](single-pc.md) | 수동 Quadlet 설치·DB·Garage 시작 |
| 5 | [NAS 분리 차이](nas.md) | 변경할 연결·CA·export·기동 의존성 |
| 6 | [최초 초기화](initialization.md) | Garage·빈 DB·bucket registry·최초 ADMIN |
| 7 | [일반 운영](operations.md) | 시작·변경·종료·보존·버전 변경 |
| 8 | [검증 절차와 기록](verification.md) | 실제 확인 범위·미검증 항목 |

## 준비 조건

- 별도 Linux 운영 계정 `pcu`, rootless Podman 5.4.2, systemd, cgroup v2를 사용한다. 기준 OS는 Debian 13 amd64이다.
- 4 vCPU·RAM 32 GiB·디스크 160 GiB는 검증 장비의 기준이다. 제품의 검증된 최소 사양이 아니다. PostgreSQL, Garage data/meta, export와 백업의 증가량을 별도로 산정한다.
- `/srv/pcu/config`, `/srv/pcu/exports`, `/srv/pcu/backups`를 사용한다. DB·Garage는 별도 named volume이다. 단일 PC에는 NAS가 필요하지 않다.
- 외부 443은 rootful system Quadlet Nginx 한 개가 수신한다. 앱·DB·Garage·gateway·Web은 `pcu` 계정의 rootless Quadlet으로 실행한다.
- 단일 PC 구성의 VM 수용 검사는 아직 완료하지 않았다. [검증 기록](verification.md)의 미검증 항목을 완료한 뒤 해당 환경의 운영 가능 상태로 판정한다.

| 주소 | 용도 | 필요한 접근 |
| --- | --- | --- |
| `web.pcu.test` | Web·Google 승인 origin | 브라우저 → 443 |
| `api.pcu.test` | API·WebGL play shell | 브라우저 → 443 |
| `upload.pcu.test` | 서명된 multipart PUT | 브라우저 → 443 |
| `assets.pcu.test` | 공개 파일·WebGL runtime | 브라우저 → 443 |
| `download.pcu.test` | 보호 파일·Range | 브라우저 → 443 |
| `s3.internal.pcu.test` | 내부 S3 TLS | 앱 네트워크 내부 → 443 |

위 이름은 격리 검증용이다. 실제 Google OAuth에 `.test` 이름을 등록할 수 있다는 의미가 아니다. 실제 배치에서는 운영 주소, DNS·필요한 NAT, 이름에 일치하는 인증서·키와 접속 주체가 신뢰할 CA를 준비한다. 내부 S3 이름은 Quadlet의 network alias로 해석되며 외부 DNS에 공개하지 않는다. 실제 이름으로 변경하면 alias·JSON·환경 파일·Nginx server name·인증서 SAN·CORS를 함께 수정한다.

## 제공 파일과 빌드 경계

[server/manual](../../server/manual)은 편집 가능한 정적 파일 묶음이다. 앱 소스·의존성·Prisma 생성물·dist는 이미지에 포함한다. VM에는 다음 설정 묶음과 API/Web 이미지, PostgreSQL·Garage·Nginx 이미지가 필요하다.

빌드 장비에서 저장소 루트를 기준으로 실행한다. `PCU_SOURCE_SHA`는 실제 빌드 소스의 commit이어야 한다. 미커밋 변경을 포함한 검증 이미지는 release 이미지로 취급하지 않는다.

```sh
PCU_SOURCE_SHA=$(git rev-parse HEAD)
docker build -f apps/api/Dockerfile --build-arg RELEASE_SOURCE_SHA="$PCU_SOURCE_SHA" -t pcu-api:review .
docker build -f apps/web/Dockerfile --build-arg RELEASE_SOURCE_SHA="$PCU_SOURCE_SHA" -t pcu-web:review .
tar -czf pcu-runtime-files.tar.gz server/manual/rootless server/manual/rootful \
  server/manual/config server/manual/sql docs/guide \
  apps/db/upload-part.nginx.conf.template \
  apps/db/public-origin.nginx.conf.template \
  apps/db/protected-download.nginx.conf.template \
  apps/db/validate-data-plane-env.sh
```

운영 실행 정의의 API/Web `Image=` placeholder는 전달받은 검증 이미지의 `repository@sha256:…`로 직접 변경한다. API와 모든 worker에 같은 digest를 사용한다. 로컬 tag를 immutable digest로 간주하지 않는다. 이미지 공급·승인·버전 변경은 [기존 release 절차](../operations/deployment.md)를 따른다. 이번 수동 설치 파일을 기존 release renderer 출력과 같은 디렉터리에 혼합하지 않는다.

## 기존 운영과 이력

조사 기준 운영은 API·worker의 rootless Podman Quadlet, NAS Docker Garage·gateway, GitHub Pages 조합이다. 기존 Quadlet renderer·Tailscale 대기 helper·release·복구 스크립트를 보존한다. PR #118의 슬롯 배포는 이번 수동 설치의 선행 조건이 아니다.

NAS Compose에 남은 개발 PostgreSQL 정의와 Garage S3 loopback 공개는 [기존 NAS 참조](../../apps/db/README.md)에 해당한다. 단일 PC에서는 Garage 원시 포트를 공개하지 않는다. 실제 NAS의 잔존 API·DB 정의와 포트 공개 상태 정리는 별도 작업이며, 이번 변경으로 운영 설정을 변경하지 않았다.
