# 검증 절차와 기록

[가이드](README.md)

## 상태·범위

2026-10-16 로컬 작업 기준이다. 기본 브랜치 `origin/master`를 다시 확인한 결과 계획 기준 `fd3093531277a042d24ac340b466d53e1c0b4871`과 동일하였다. 작업 checkout은 `5b4f4a1` 및 기존 미커밋 변경을 포함한다. 기존 변경을 보존하였으며 로컬 이미지 결과를 master release 이미지나 운영 배포 증거로 사용하지 않는다.

| 항목 | 상태·근거 |
| --- | --- |
| API·Web 이미지 | 현재 작업 tree의 Docker build 통과. API 기존 Dockerfile·entrypoint 유지, Web 다단계 정적 이미지 추가 |
| 기존 Web 빌드 | runtime 모드를 끈 Vite `/repository/` subpath 빌드와 Pages `404.html` 생성 통과 |
| Web 설정 | parser·loader 12개 통과. 실제 이미지와 Chromium에서 JSON no-store·deep link·설정 origin 사용·잘못된/누락 파일의 구성 오류 확인 |
| Google 허용 논리 | 실제 production context·controller·service·PostgreSQL·session·cookie·serializer를 경유한 7개 테스트 통과. 외부 Google verifier만 주입 |
| 인증된 쓰기·collection | 기존 교원 관리 HTTP PostgreSQL 테스트 통과. 인증·관리자 등록·작품 작성·빈/채워진 목록의 응답 검사 |
| 신규 DB | 동일 API 이미지의 Prisma CLI로 43개 migration 적용. 빈 DB 확인 후 적용, 비어 있지 않은 DB의 재초기화 거부 |
| registry·최초 관리자 | 실제 psql로 정상 적용·충돌 rollback·ID/subject 불일치 거부·기존 ADMIN 존재 시 거부 확인 |
| 일반 API 시작 | 새 DB에서 API 이미지 시작·재생성·health·익명 me 확인. 사용자 seed 없음, migration 이력 수 불변 |
| Garage 초기화·S3 | pinned 이미지의 layout·bucket·key·CORS 설정/조회, 신뢰 TLS, owner 제거 후 read/write·Range·익명 보호 객체 접근 거부, 재시작 후 객체 보존·host port 미공개 확인 |
| DB 보존 | 격리 PostgreSQL 컨테이너 재시작 후 registry·관리자 행 보존 |
| gateway 기존 경계 | 실제 Nginx의 auth_request·CSP·누락 policy 차단·service worker 거부·GET/HEAD·Range·압축 byte 테스트 통과 |
| 수동 Nginx 설정 | 3개 gateway의 실제 read-only root·mount·환경 치환·health 통과. 내부/외부 TLS config와 CA 검증 통과; 실제 rootless upstream 연결은 미검증 |
| gateway TLS | 기존 실제 Nginx fixture에서 신뢰 TLS 성공·잘못된 이름/인증서 거부·report 경계 테스트 통과 |
| Quadlet | upstream 5.4.2 generator로 rootless 20개 정의와 rootful edge 생성 검사. 실제 systemd·Podman 기동 증거와 구분 |
| 정적 검사 | 변경 Web/API 파일 lint, 실행 시점 API TypeScript 검사, integration runner 30개, 문서 링크·문체 검사·diff whitespace 통과. 문체 검사기의 선택적 형태소 검사는 미설치로 생략 |
| CI·운영 | CI 시작·commit·push·merge·배포·운영 서비스 변경 없음 |

추가 Web 전체 검사에서는 863개가 통과하고 1개가 실패하였으며, builder에 API source가 없어 3개 suite를 로드하지 못하였다. 검증 전용 read-only API source를 연결한 재검사에서 계약 suite 2개는 통과하였으나 `mockApiParity` 4개(`loadProjectWithAccess` fixture 의존성 누락)와 `ProjectSubmissionStudio` 1개(업로드 호출 3회 기대·2회 관찰)가 실패하였다. **이번 변경 전 env 모듈을 연결한 대조 검사에서도 같은 5개 실패를 재현**하였다. 이번 범위 밖의 기존 작업을 수정하지 않았으며 전체 Web 검사 통과로 표시하지 않는다.

작업 중 API schema·worker·Web 화면 등 다른 영역에도 변경이 발생하였다. 위 build·검증은 각 실행 시점의 작업 tree와 이미지에 대한 결과이며, 이후 모든 동시 변경의 통합 검증을 의미하지 않는다.

이 호스트에는 Docker가 있고 Podman은 없다. 위 결과는 Debian 13 VM 수용 검사의 대체 증거가 아니다. 실제 Google token 검증·OAuth console 설정·실제 계정 로그인·공개 DNS·공인 인증서 발급·운영 방화벽은 수행하지 않았다.

## 재현 명령

빌드·테스트 장비의 저장소 루트에서 실행한다. test script는 고유한 이름의 Docker 자원만 생성·정리한다. 운영 호스트의 설치 도구가 아니다.

```sh
docker build -f apps/api/Dockerfile -t pcu-manual-api:verify .
docker build -f apps/web/Dockerfile -t pcu-manual-web:verify .
node server/manual/verify-bootstrap.mjs
node server/manual/verify-nginx.mjs
node server/manual/verify-storage.mjs
# Playwright가 별도로 설치된 검증 장비; 필요하면 BROWSER_EXECUTABLE 지정
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node server/manual/verify-web.mjs
npm exec -w apps/web -- vitest run src/__tests__/runtime-config.test.ts
RUN_POSTGRES_INTEGRATION=true DATABASE_URL='postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:TEST_PORT/TEST_DB' \
  npm exec -w apps/api -- vitest run \
  src/__tests__/manual-bootstrap-auth.postgres.test.ts \
  src/__tests__/faculty-management-http.postgres.test.ts
npm run test:file-gateway
node --test scripts/run-integration.test.mjs
```

PostgreSQL 인증 테스트는 임의 이름의 독립 schema를 생성·정리한다. 테스트 전용 DB만 사용한다. 신규 인증 테스트는 기존 `phase2-transition` integration suite에도 포함하였다. `verify-bootstrap`은 실제 Prisma migration history를 포함한 별도 DB·volume으로 초기화 절차를 검사한다.

Web host 의존성에 Vite 누락이 있어 로컬 직접 테스트 대신 Docker builder의 lockfile 설치로 검사하였다. 예를 들어 `docker build --target builder -f apps/web/Dockerfile -t pcu-manual-web-builder:verify .` 후 `docker run --rm -e VITE_RUNTIME_CONFIG=false -v "$PWD/apps/api/src:/app/apps/api/src:ro" pcu-manual-web-builder:verify npm test -w apps/web`를 사용한다. 이 변수는 기존 개발·Pages 모드의 회귀 테스트에만 적용하며 배포 Web 이미지의 runtime 모드를 변경하지 않는다.

Quadlet 검사는 [기존 pinned generator 준비](../../server/quadlet/COMPATIBILITY.md)를 재사용한다.

```sh
QUADLET_UNIT_DIRS="$PWD/server/manual/rootless" /absolute/path/to/quadlet --user --dryrun
QUADLET_UNIT_DIRS="$PWD/server/manual/rootful" /absolute/path/to/quadlet --dryrun
```

## 인증 수용 기준

| 입력·행위 | 기대 결과 |
| --- | --- |
| 검증된 `hd=pcu.ac.kr`, subject·email 존재 | HTTP 200, USER·session 저장, Secure·HttpOnly·SameSite cookie |
| `hd=g.pcu.ac.kr`, 다른 domain | HTTP 403, 사용자·session 생성 없음 |
| email 접미사는 `@pcu.ac.kr`, `hd` 없음 | HTTP 403 |
| verifier 실패·subject 또는 email 누락 | HTTP 401, session 생성 없음 |
| 발급된 session의 `/api/me` | 인증된 성공 응답과 직렬화 |
| ID·subject 확인 후 ADMIN 지정 | 한 행 승격, 인증된 관리자 작업·빈/채워진 collection |
| logout·session 만료 후 보호 API | HTTP 401. `/api/me`는 기존 계약대로 HTTP 200·`authenticated:false` |

운영 이미지에 가짜 credential·production 인증 우회 flag를 추가하지 않았다. 테스트 성공은 실제 Google 로그인 성공을 의미하지 않는다.

## Debian VM 수용 검사 — 미완료

이미지·설정·volume만 전달한 별도 Debian 13 amd64 VM에서 수행한다. 앱 source·Node·npm·Prisma를 호스트에 설치하지 않는다. host 계정·Podman 버전·cgroup·자원·이미지 digest·설정 변경 내역을 결과에 함께 기록한다.

1. [단일 PC](single-pc.md)와 [초기화](initialization.md) 순서대로 설치하고 원시 DB/S3/RPC/website/admin 포트의 외부 접근 불가를 확인한다. `podman port pcu-garage`는 비어 있어야 한다.
2. 제공된 CA로 5개 공개 origin과 내부 S3 TLS를 검사한다. 잘못된 CA·hostname에서 연결이 거부되어야 한다. TLS 검증을 끄지 않는다.
3. client IP 정상 전달·위조 header 제거·비신뢰 직접 요청의 header 무시를 확인한다. [IP 검사](single-pc.md#client-ip-검사) 기록 없이 `TRUST_PROXY` 검증 완료로 표시하지 않는다.
4. 빈 DB migration·registry·실제 인증 사용자 최초 ADMIN 지정 후 인증된 읽기·쓰기·빈/채워진 collection을 확인한다. API 재시작 전후 `_prisma_migrations`, 사용자·전시 행 수를 대조한다.
5. image·PDF·video·GAME·WebGL 파일을 업로드하고 각각의 worker job 완료·최종 representation·재생/실행을 확인한다. API health는 worker 완료 근거가 아니다.
6. publication job과 공개 전환·비공개 복귀를 검사한다. 공개/보호 gateway를 통한 GET·HEAD·Range와 만료·변조 capability 거부를 확인한다. 직접 저장소 접근은 거부되어야 한다.
7. export job 완료와 `/srv/pcu/exports`의 결과를 확인한다. 외부 HTTP로 export를 읽을 수 없어야 한다.
8. 정상 종료·컨테이너 재생성·VM 재부팅 후 DB 행·객체 checksum·export 파일·unit 자동 시작을 대조한다. 임시 tmpfs만 재생성되는지 확인한다.
9. [NAS 변경 계약](nas.md)을 적용한 격리된 두 호스트에서 HTTPS·mount·ACL·단절·복구 후 job 완료를 확인한다. 실제 NAS 설정은 변경하지 않는다.

실제 Google OAuth·운영 DNS·공인 인증서·운영 firewall 확인은 운영자가 수행할 별도 항목으로 기록한다. 외부 준비물을 가정한 사실을 실제 검증한 사실로 표현하지 않는다. CI를 시작하는 후속 작업에서는 실행 링크와 마지막 관찰 상태를 보고하고 종료하며, 별도 요청 없이 CI 대기·merge·배포를 진행하지 않는다.
