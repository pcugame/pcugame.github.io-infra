# 일반 운영

[가이드](README.md) · [다음: 검증](verification.md)

## 시작·상태 확인

초기화 완료 이후에는 기존 설정·volume으로 기동한다. migration·seed·관리자 지정 SQL을 다시 실행하지 않는다.

```sh
systemctl --user start gp-postgres.service pcu-garage.service pcu-s3-tls.service
podman exec gp-postgres psql -U pcu -d pcu -v ON_ERROR_STOP=1 -c 'SELECT 1;'
podman exec pcu-garage /garage status
systemctl --user start gp-api.service
curl --fail http://127.0.0.1:4000/api/health/deep
systemctl --user start gp-worker-game-validation.service gp-worker-webgl.service \
  gp-worker-video.service gp-worker-image.service gp-worker-export.service \
  gp-worker-project-publication.service pcu-upload.service pcu-assets.service \
  pcu-download.service pcu-web.service
sudo systemctl start pcu-edge.service
systemctl --user --failed
```

journal·job 상태·객체·export 파일을 함께 검사한다. 시작 순서만으로 readiness를 보장하지 않는다. DB·Garage 준비 지연 시 서비스 재시작 정책과 실제 health를 확인한다.

## 설정 변경

환경 파일·JSON·인증서·template 변경은 해당 파일을 읽는 컨테이너를 `systemctl --user restart UNIT.service`로 재생성한 뒤 확인한다. rootful edge는 `sudo systemctl restart pcu-edge.service`를 사용한다. bind mount 파일을 rename으로 교체한 경우 실행 중인 컨테이너가 이전 inode를 계속 읽을 수 있으므로 재생성을 생략하지 않는다.

Quadlet 자체 변경은 `daemon-reload` 후 restart가 필요하다. API 공통 설정 변경은 API와 모든 worker에 적용한다. gateway secret 교체는 API·gateway 양쪽을 함께 갱신한다. 인증서 갱신 후 유효기간·SAN·chain·hostname 검증을 다시 수행한다. Web JSON 변경은 재빌드가 필요하지 않으며 브라우저 새로고침으로 다시 읽는다.

## 종료·보존

새 요청·업로드를 중단하고 진행 중인 job 완료를 확인한다. 작업이 남아 있으면 정상 완료를 기다리거나 기존 운영 절차로 취소·재시도 상태를 확인한다. tmpfs의 미완료 파일은 컨테이너 종료 시 사라지므로 DB의 lease·재시도 결과를 확인한다.

```sh
sudo systemctl stop pcu-edge.service
systemctl --user stop pcu-web.service pcu-upload.service pcu-assets.service pcu-download.service
systemctl --user stop gp-worker-game-validation.service gp-worker-webgl.service \
  gp-worker-video.service gp-worker-image.service gp-worker-export.service \
  gp-worker-project-publication.service
systemctl --user stop gp-api.service
systemctl --user stop gp-postgres.service pcu-s3-tls.service pcu-garage.service
systemctl --user stop graduationproject-pod.service
```

일반 stop·restart·컨테이너 재생성은 named volume과 export를 제거하지 않는다. `podman volume rm`, `system prune --volumes`, 데이터 디렉터리 삭제는 정상 종료와 다른 파괴 작업이다. 정상 운영 명령에 포함하지 않는다. 유지보수 중 재부팅하면 `[Install]`에 의해 재기동되므로 장기 중지는 별도 maintenance 계획에 기록한다.

## 백업·버전 변경·복구

DB backup은 권한 0600의 `/srv/pcu/backups`에 보관한다. backup 파일은 컨테이너 밖 host에서 redirection한다.

```sh
umask 077
podman exec gp-postgres pg_dump -U pcu -d pcu -Fc > /srv/pcu/backups/pcu-before-change.dump
```

덤프의 실제 복원 검사를 별도 DB에서 수행한다. DB와 Garage·export의 reference를 보존하려면 쓰기 중지 시점을 일치시키고 Garage data/meta를 함께 백업한다. 동작 중인 SQLite metadata·객체 디렉터리를 단순 복사한 결과를 정합한 backup으로 간주하지 않는다. 설정·key·CA·인증서는 제한된 별도 백업에 포함한다. 동일 PC의 `/srv/pcu/backups`만으로 디스크 장애 복구를 보장하지 않으므로 다른 저장소의 복사본을 유지한다.

버전 변경은 [기존 release·backup·migration·forward recovery](../operations/deployment.md)를 따른다. task branch → 검토 PR·필수 CI → master merge → 정확한 merged source의 검증된 immutable image → 기존 CD·운영 검증 순서를 유지한다. 현재 수동 설치 예제는 기존 renderer로 관리되는 운영 호스트의 경로와 동일하지 않으므로 배포 스크립트를 그대로 실행하지 않는다. 실제 호스트를 기존 release 체계에 편입할 때 [adoption 절차](../../server/quadlet/ADOPTION.md)와 경로 차이를 검토한다.

migration이 한 번이라도 시도되면 이전 API·Web으로 자동 복귀하지 않는다. DB 상태·적용 이력과 실행 로그를 확인하여 기존 recovery 절차로 진행한다. 로컬 테스트·이미지 빌드를 운영 release gate의 대체 증거로 사용하지 않는다.
