# NAS 분리 차이

[가이드](README.md) · [다음: 최초 초기화](initialization.md)

단일 PC의 실행 계약에서 저장소 위치와 호스트 간 연결만 변경한다. NAS 전용 설치기·새 renderer는 추가하지 않는다. 실제 NAS 변경은 이번 작업에 포함하지 않는다.

| 항목 | 변경·검증 |
| --- | --- |
| Garage·gateway 위치 | NAS의 격리 저장소 network 사용. 원시 S3·RPC·website·admin을 외부에 공개하지 않음 |
| `S3_ENDPOINT` | NAS 내부 S3 TLS proxy 주소. 앱 호스트의 DNS·routing·방화벽·CA 신뢰 확인 |
| gateway API upstream | 앱 호스트의 검증된 HTTPS origin으로 변경. `FILE_GATEWAY_TLS_SERVER_NAME` 일치, `proxy_ssl_verify on`·CA bundle 유지 |
| `NGINX_RESOLVER` | NAS 컨테이너의 실제 resolver. Docker이면 명시적으로 `127.0.0.11`; Podman 주소를 복사하지 않음 |
| 공개 DNS·TLS | upload·assets·download의 목적지와 인증서 갱신 경로 변경. Web/API/file origin 분리 유지 |
| client IP | NAS 외부 proxy peer·gateway source IP를 다시 측정하여 `set_real_ip_from`·`TRUST_PROXY` 재설정 |
| export | `/srv/pcu/exports`에 비공개 NFS 등 mount. NAS ACL·root squash·subuid 매핑에 맞춰 앱 UID 1001의 host UID에 쓰기 권한 부여 |
| 기동 의존성 | export worker는 mount 완료 후 시작. 예: `[Unit] RequiresMountsFor=/srv/pcu/exports`; NFS mount unit은 host system 영역에서 관리 |
| 기존 NAS Tailscale | 기존 helper와 release 정의 보존. 단일 PC 기본 unit에 추가하지 않음 |

NFS mount가 해제된 빈 로컬 경로에 export가 생성되지 않도록 시작 전 `findmnt /srv/pcu/exports`와 앱 UID로 쓰기 검사를 수행한다. NFS 전체 tree에 `chown -R`·SELinux relabel·`chmod 777`을 적용하지 않는다. 서비스 계정·NAS ACL·mount 옵션을 함께 설계한다.

검증은 격리된 두 호스트에서 TLS 검증 성공·이름 불일치 거부·DNS 단절·mount 단절·권한 부족·재연결 후 job 완료로 수행한다. 단일 호스트 Docker network 분리만으로 NAS 두 호스트 검증을 완료하였다고 기록하지 않는다. 기존 NAS TLS 관리 절차는 [DB/Garage 참조](../../apps/db/README.md#file-gateway-upstream-tls)를 따른다.
