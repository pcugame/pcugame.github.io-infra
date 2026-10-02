# Production 배포 절차

일반 운영 배포는 `Deploy Release`를 `master`에서 수동 실행한다. 정확한 source SHA의 검증된 불변 이미지를 사용하고, Web·API·DB migration을 같은 release에서 처리한다. master push에 따른 이미지 빌드는 운영 적용과 별개이다.

이 브랜치의 release 코드는 Quadlet 전환이 완료된 host와 일반 release의 schema 사전 조건이 충족된 DB를 대상으로 한다. 현재 production의 Quadlet 설치·기동·전환은 미수행 상태이며, 이 코드 정리를 운영 적용 완료로 간주하지 않는다. 신규 서버·빈 DB의 초기 설치 절차는 포함하지 않는다. 특정 migration의 최초 전환과 예외 이력은 [기존 전환 기록](manual-release.md)에 분리한다.

## Workflow와 실행 경계

| 이름 | 파일 | 실행과 역할 |
| --- | --- | --- |
| PR Checks | [pr-checks.yml](../../.github/workflows/pr-checks.yml) | master 대상 PR 또는 수동 실행. `verify` 후 `integration` 수행 |
| Build API Release Image | [deploy-api.yml](../../.github/workflows/deploy-api.yml) | master의 지정 경로 push, 수동 실행 또는 재사용 호출. API 이미지 빌드·검증·게시 |
| Deploy Release | [release-api-cutover.yml](../../.github/workflows/release-api-cutover.yml) | master에서 수동 운영 적용. 일반 입력은 `phase=release` |
| Deploy Web to GitHub Pages | [deploy-web-pages.yml](../../.github/workflows/deploy-web-pages.yml) | master에서 Web 단독 수동 게시 |

API build의 push 대상은 `apps/api/**`, `packages/contracts/**`, 루트 `package.json`·`package-lock.json`, `server/deploy.sh`, 해당 build workflow, `.github/release-gates/web-before-api/**`이다. Web 또는 문서만 변경된 커밋에는 이 push build가 실행되지 않을 수 있으며, 일반 release가 필요한 이미지를 생성한다.

운영 release와 Web 단독 게시는 `production` environment와 `production-object-cutover` 동시 실행 그룹을 사용한다. 실행 중인 작업을 자동 취소하지 않는다. control 검사는 `pcugame/pcugame.github.io-infra`, default branch `master`, 실행 ref `refs/heads/master`를 요구한다. 실제 GitHub required checks·review·environment 승인 설정은 저장소의 workflow 파일과 별도로 확인한다.

## 배포 전 조건

1. task PR의 검토와 필요한 `PR Checks`를 완료하고 `master`에 병합한다. 배포할 정확한 commit SHA를 확인한다.
2. 기존 `production` environment와 배포 설정을 확인한다. release 제어용 `.env`, operator-managed `runtime-env/common.env`·`api.env`·`postgres.env`, DB·백업 공간, Garage·NAS·reverse proxy 구성이 해당 이미지와 호환되어야 한다. runtime env 파일은 literal `KEY=value` 형식이며 shell로 실행하지 않는다.
3. Web·API 변경의 호환성과 서비스 중지 구간을 검토한다. 일반 release는 systemd로 API와 모든 worker를 중지하며, PostgreSQL과 pod는 유지한다. 최초 Quadlet 설치, 기존 generated unit 제거, pod 재생성은 release 스크립트에서 수행하지 않는다.
4. DB 변경은 [migration policy](../database-migration-policy.md)를 따른다. 적용된 SQL·checksum·receipt를 수정하거나 DB 상태 검사를 우회하지 않는다.

일반 release에서 사용하는 GitHub 설정은 다음과 같다. 값은 기존 배포 환경에서 관리하며 문서나 로그에 비밀 값을 기록하지 않는다.

| 설정 | 용도 |
| --- | --- |
| `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PORT` secrets | 서버에 release 제어 파일 전달과 SSH 실행 |
| `DEPLOY_COMPOSE_PATH` secret | 서버 배포 디렉터리. 일반 release의 기본 경로는 `/srv/graduationproject_v2` |
| `GHCR_USERNAME`, `GHCR_TOKEN` secrets | 운영 호스트의 GHCR 로그인 |
| `PAGES_DEPLOY_TOKEN` secret | 외부 Pages 저장소 게시 권한 |
| `SMOKE_PUBLIC_OBJECT_URL` secret | 선택 사항. 공개 파일 smoke 대상 지정. 없으면 실행 중인 API의 공개 전시회 poster에서 선택 |
| `VITE_API_BASE_URL`, `VITE_GOOGLE_CLIENT_ID` variables | Web build 설정 |
| `VITE_BASE_PATH`, `VITE_VISIBILITY_CONTROLS_ENABLED` variables | Web build 선택 설정. workflow 기본값은 `/`, `false` |
| `API_TARGET_PLATFORMS` variable | API 이미지 build 대상. 기본값 `linux/amd64` |

이미지 build는 `GITHUB_TOKEN`으로 GHCR에 게시한다. Pages 검사는 대상 저장소 `pcugame/pcugame.github.io`의 활성 상태, default branch `master`, 토큰의 쓰기 권한을 확인한다. 특정 계정이나 관리자 권한을 요구하는 검사는 없다.

## 일반 release 실행

GitHub Actions에서 **Deploy Release**를 선택하고 다음과 같이 실행한다.

- Branch: `master`
- `phase`: `release`
- 이미지·source·관측·예외 ID 등 문자열 입력: 비워 둔다.
- `exception_profile`: 기본값 `age-only`를 그대로 둔다. 일반 release에서 예외를 승인하거나 적용하는 입력으로 사용하지 않는다.

### 이미지 선택과 사전 검증

[resolve-release-image.mjs](../../server/resolve-release-image.mjs)는 같은 SHA의 성공한 master build에서 `verified-api-release-<SHA>` artifact를 찾는다. manifest 보관 기간은 30일이다. 사용 가능한 결과가 없으면 기존 build workflow를 호출하여 같은 소스를 빌드한다.

이미지는 `ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:<digest>`로 선택한다. build가 게시하는 `latest` tag는 배포 입력이 아니다. build와 서버 사전 검사에서 OCI revision label, digest와 필요한 runtime·release CLI 구성을 검증한다. API·worker·migration에는 같은 release 이미지를 사용한다.

Web의 test·lint·build와 Pages 접근 검사를 수행한다. 서버에서는 중지 전에 공개 파일 smoke, 이미지·DB 호환성 검사, IP 차단 상태 점검과 온라인 DB snapshot·격리 복원 검증을 수행한다. 호환성 검사가 실패하면 일반 release를 계속 진행하지 않는다.

### 백업과 쓰기 중지

[release-db-snapshot.sh](../../server/release-db-snapshot.sh)는 온라인 PostgreSQL custom-format dump를 생성하고 checksum·archive 검사·격리 PostgreSQL 복원 시험 결과를 보존한다. 온라인 snapshot은 이후 쓰기를 동결하지 않으므로 다음 백업을 대체하지 않는다.

이전 Pages 소스와 실행 중인 앱의 복구 정보를 보관한 후 [deploy.sh](../../server/deploy.sh)의 `drain`으로 API·모든 worker를 중지하고 실제 중지 상태를 확인한다. PostgreSQL은 이 단계에서 유지한다. 이어 `pg_dump -Fc`로 쓰기가 중지된 DB를 추가 백업하고 SHA-256을 기록한다. 백업은 서버 `${DEPLOY_DIR}/backups`에 보관한다. DB dump에는 Garage 객체의 파일 내용이 포함되지 않는다.

### Web 게시와 migration

빌드한 `apps/web/dist`를 외부 Pages 저장소의 `master`에 게시한다. 운영 Web의 `release-sha.txt`가 이번 source SHA인지 최대 5분 동안 확인한다. 기존 Web workflow의 성공 여부를 기다리는 방식은 사용하지 않는다.

migration 호출 직전에 영속적인 시도 표시를 기록한다. release 이미지의 CLI가 기존 적용 이력·receipt를 확인하고 최신 migration까지 적용한다. workflow의 실제 명령 이름은 `release-migrate apply-contract`이지만, 일반 release에서도 후속 migration 적용에 사용한다. 적용된 이력을 보존한 채 DB에 기록된 migration 경로를 재사용한다.

API 시작과 migration은 별도 작업이다. `deploy.sh up`은 schema 호환성을 검사한 뒤 runtime을 시작하며, 컨테이너의 startup 명령도 migration을 실행하지 않는다. 운영 DB에 임의의 `prisma migrate deploy`를 실행하여 release 검사를 대체하지 않는다.

### 기동과 완료 검증

`deploy.sh up`은 설치된 Quadlet 정의와 generated unit, 실행 중인 pod·PostgreSQL을 확인한다. topology 변경은 일반 release에서 거부하며, API와 6개 worker의 불변 image digest만 갱신한다. 앱 unit을 중지한 뒤 digest를 반영하고 `daemon-reload`를 요청한다. 이후 PostgreSQL readiness·schema를 검사하고 API를 시작한다. API health 확인 후 GAME·WebGL·VIDEO·IMAGE/PDF·export·project publication worker를 시작한다. 컨테이너 생성·제거·restart policy는 Quadlet/systemd가 소유한다. API port 기본값은 `127.0.0.1:4000`이며 외부 요청은 reverse proxy를 사용한다.

API의 `/api/health` 응답에서 `ok:true`를 최대 90초 동안 확인하고 worker 실행 상태를 검사한다. 최종 workflow에서도 health, IP 차단 상태, 공개 파일의 GET·HEAD·304·Range·416 응답을 검사한다. 이 smoke는 전체 인증 사용자 경로를 검증하지 않으므로 변경 기능에 필요한 인증된 성공 응답 검증은 별도로 수행한다.

마지막으로 실제 실행 이미지의 OCI source label과 digest를 대상과 비교한다. 결과는 실행 로그와 `${DEPLOY_DIR}/cutover-state/deployed-<SHA>.txt`에 기록한다. release 완료 기록에는 source SHA, image digest, workflow 실행 링크와 변경 기능 검증 결과를 남긴다.

## Quadlet 전환 전 host 검증

[Quadlet 정의와 runtime env 규약](../../server/quadlet/README.md)을 기준으로 다음 항목을 별도 검증한다. 이번 저장소 정리에서는 production의 `systemctl`·`podman` 상태를 변경하지 않는다.

- 실제 `DATABASE_URL`과 pod의 `AddHost=postgres:127.0.0.1` 연결 및 인증된 API 성공 응답
- PostgreSQL image 최초 pull·컨테이너 생성과 기존 DB volume 사용
- rootless user linger·부팅 시 자동 시작과 실제 pod/container lifecycle
- API·worker drain 중 PostgreSQL 유지, readiness·health·schema·capacity gate 연결

검증과 기존 master/PR/CI/CD 절차를 완료한 뒤 host 전환을 진행한다. Quadlet 미전환 host에서는 release가 사전 검사에서 중단되며 legacy runtime을 자동 변환하지 않는다.

## Web 단독 게시

**Deploy Web to GitHub Pages**를 `master`에서 수동 실행한다. Web test·lint·build 후 `release-sha.txt`를 생성하고 Pages 대상·쓰기 권한을 검사하여 게시한다. `404.html`은 Web의 post-build script에서 생성한다.

이 workflow는 API·DB를 배포하지 않으며, 실행 중인 API의 source나 schema 호환성도 검사하지 않는다. API 계약 변경이 함께 필요한 경우 일반 release를 사용한다. Web 단독 게시에는 일반 release의 서버 측 SHA 재확인과 Pages 자동 복구 단계가 없으므로 실행 결과와 실제 제공되는 Web을 확인한다.

## 실패와 복구

| 실패 시점 | 현재 복구 동작 |
| --- | --- |
| migration 적용 step 시작 전 | Pages capture 성공·migration step 생략 조건에서 Pages 복구 시도. 이번 실행의 게시 결과인지 비교하여 후속 작성자의 변경을 덮지 않음 |
| 이전 Pages 제공 상태 확인 후 | 영속 migration 시도 표시가 없는 경우 보관한 unit·이미지와 현재 정의의 일치 확인 후 systemd로 이전 앱 복구 |
| migration 적용 step 시작 이후 | 자동 Pages/runtime 복구 경로를 실행하지 않음. DB 적용 이력·실제 schema·receipt와 로그 확인 필요 |
| 새 runtime 기동 또는 최종 smoke 실패 | 이전 이미지 자동 rollback 없음. DB 호환성을 확인한 수정 release 또는 별도로 판단한 DB·객체 복구 필요 |

복구는 [pages-release-recovery.mjs](../../server/pages-release-recovery.mjs)와 [release-recovery.mjs](../../server/release-recovery.mjs)의 조건을 따른다. 오류가 SQL COMMIT 이후에 발생할 수 있으므로 실패 메시지만으로 DB 미변경을 단정하지 않는다. DB 복원이 필요한 경우 백업 시점 이후 쓰기와 Garage 객체·참조의 복구 범위도 함께 판단한다.

## 관련 자료

- [production release 구조 조사](../history/2026-backend-audit/production-release-audit.md): 조사 기준 구현, 정리 후보와 과거 전환 증빙
- [기존 최초 DB 전환 기록](manual-release.md): 특정 migration의 입력·예외·보존 자료
- [과거 master 통합 기록](README.md): 보존 branch와 migration checksum 예외
- [database migration policy](../database-migration-policy.md): migration 이력과 변경 검증 기준
