# 배재대학교 게임공학과 졸업작품 전시 플랫폼 운영 매뉴얼

이 문서는 코드를 설명하기 위함이 아니다.
웹 개발에 대한 기초적 개념만 존재하거나 아예 없는 사람을 대상으로 작성되었다.
개발은 기본적으로 `AGENTS.md.example`을 읽은 Coding Agent를 이용해 할 것으로 가정한다.

이 저장소는 배재대학교 게임공학과 졸업작품 전시 페이지를 운영하기 위한 프로젝트다.
사람이 해야 할 일은 코드를 전부 외우는 것이 아니라, 아래 항목을 실수 없이 처리하는 것이다.

* 어떤 화면이 무엇을 하는지 이해한다.
* 학생 작품 자료를 올리기 전에 파일과 정보를 확인한다.
* 배포 전 최소 검증 명령을 실행한다.
* 오류가 나면 어디가 문제인지 큰 범주부터 좁힌다.
* 비밀키, 서버 계정, DB, 저장소를 함부로 건드리지 않는다.
* AI에게 일을 시킬 때 “수정 범위, 검증 방법, 롤백 기준”을 반드시 요구한다.

AI가 코드를 작성할 수는 있다.
그러나 운영 책임, 계정 관리, 업로드 승인, 배포 버튼, 서버 접속, 비밀키 보관, 장애 판단은 사람이 해야 한다.

---

## 1. 이 프로젝트가 하는 일

이 프로젝트는 졸업작품을 웹에서 전시하기 위한 시스템이다.

방문자는 다음을 볼 수 있다.

* 연도별 졸업작품 목록
* 전시회별 졸업작품 목록
* 작품 상세 페이지
* 포스터, 이미지, 게임 파일, 영상 등 작품 자료

관리자는 다음을 할 수 있다.

* Google 계정으로 로그인
* 작품 등록
* 작품 수정
* 포스터 및 이미지 업로드
* 게임 파일 업로드
* 전시회 관리
* 사이트 설정 변경
* IP 차단 관리
* JSON import
* NAS export 실행

---

## 2. 아주 가볍게 보는 기술 구성

기술 이름을 외울 필요는 없다.
다만 “어느 부분이 어느 역할을 하는지”는 알아야 한다.

### Web

위치:

```bash
apps/web
```

역할:

* 사용자가 보는 화면
* 관리자 화면
* 로그인 화면
* 파일 업로드 UI
* GitHub Pages로 배포되는 정적 사이트

사용 기술:

* React
* TypeScript
* Vite
* React Router
* TanStack Query
* Zod

쉽게 말해,

> 브라우저에 보이는 화면 담당

---

### API

위치:

```bash
apps/api
```

역할:

* 로그인 처리
* 작품 데이터 저장/조회
* 관리자 기능 처리
* 파일 업로드 처리
* DB와 파일 저장소 연결
* 권한 검사
* 다운로드 제한
* NAS export 처리

사용 기술:

* Node.js
* Fastify
* TypeScript
* Prisma
* PostgreSQL
* Vitest

쉽게 말해

> 화면 뒤에서 실제 일을 처리하는 서버 담당

---

### DB

로컬 위치:

```bash
apps/db
```

역할:

* 작품 정보 저장
* 사용자 정보 저장
* 전시회 정보 저장
* 파일 metadata 저장
* 로그인 session 저장

사용 기술:

* PostgreSQL

쉽게 말해

> “작품 제목, 학생 이름, 업로드 기록” 같은 표 형태 데이터를 저장하는 곳
> (데이터베이스 시간에 들은 그 DBMS가 맞다.)

---

### 파일 저장소

사용 기술:

* Garage / S3 호환 object storage

역할:

* 포스터 이미지
* 게임 파일
* 영상
* 기타 업로드 파일

쉽게 말해

> 실제 파일 덩어리를 저장하는 창고
> (단, 다운로드 / 업로드 / 보안등의 문제를 "알아서 잘" 처리해주는 편인)

DB는 파일 자체를 저장하지 않는다.
DB는 “이 파일이 어디에 있다”는 주소와 정보를 저장한다.

---

### NAS export

역할:

* API가 저장소에 있는 파일을 읽어서 NAS 경로로 내보내는 기능

쉽게 말해

> 전시 자료를 NAS에서 바로 다운로드 받아 쓸 수 있는 파일 형태로 저장하기 위함

---

## 3. 폴더를 볼 때 기준

처음 보는 사람은 이 정도만 기억하면 된다.

```text
apps/api        서버 코드
apps/web        화면 코드
apps/db         로컬 DB와 Garage 실행용 compose
packages        Web과 API가 공유하는 타입
server          운영 서버 배포 스크립트
.github         GitHub Actions 배포/검증 설정
assets          학교/학과 관련 원본 이미지
docs            현재 상태, 구조, 배포, 검증 문서
prompts         AI에게 재사용할 프롬프트
analysis        과거 분석/감사 기록
```

중요한 폴더:

* `apps/api`
* `apps/web`
* `apps/db`
* `packages/contracts`
* `server`
* `.github/workflows`

위 폴더는 함부로 삭제하지 않는다.

---

## 4. 사람이 반드시 해야 하는 운영 원칙

### 원칙 1. 비밀값은 절대 README, 채팅, 이슈, 커밋에 적지 않는다

아래 값은 절대 공개하지 않는다.

* DB 비밀번호
* Google OAuth client secret
* session secret
* S3 access key
* S3 secret key
* 서버 SSH key
* GitHub token
* 운영 서버 `.env`
* 실제 production 접속 정보

AI에게 보여줄 때도 실제 값을 넣지 않는다.

나쁜 예:

```env
SESSION_SECRET=진짜값
S3_SECRET_ACCESS_KEY=진짜값
```

좋은 예:

```env
SESSION_SECRET=<replace-me>
S3_SECRET_ACCESS_KEY=<replace-me>
```

---

### 원칙 2. 수정 전에는 현재 상태를 본다

작업 전 항상 실행한다.

```bash
git status --short
```

이미 수정된 파일이 많으면 바로 작업하지 않는다.
먼저 “내가 이번에 건드릴 파일”과 “기존에 이미 더러워진 파일”을 구분한다.

AI에게 맡길 때도 이렇게 말한다.

```text
현재 git status를 먼저 확인하고,
이번 작업과 직접 관련 없는 변경은 건드리지 마세요.
수정 파일 목록을 마지막에 보고하세요.
```

---

### 원칙 3. 배포 전에는 최소 검증 3종을 통과시킨다

루트에서 실행한다.

```bash
npm test
npm run lint
npm run build
```

이 3개가 실패하면 배포하지 않는다.

각 명령의 의미:

* `npm test`: 자동 테스트 실행
* `npm run lint`: 타입/문법/규칙 검사
* `npm run build`: 실제 배포용 빌드가 되는지 확인

---

### 원칙 4. DB migration은 DB 변경이 있을 때에만 같이 실행한다

아래 명령은 DB 구조를 바꿀 수 있다.

```bash
npm run db:migrate
npm run db:migrate:deploy
```

실행 전에 반드시 확인한다.

* 지금 로컬 DB인가?
* 운영 DB인가?
* 백업은 있는가?
* migration 파일이 의도한 것인가?
* rollback 방법은 있는가?

잘 모르겠으면 실행하지 않는다.

---

### 원칙 5. production `.env`는 사람이 최종 확인한다

운영 서버에는 많은 환경변수가 필요하다.

대략 이런 종류다.

* PostgreSQL 관련 값
* `DATABASE_URL`
* session/cookie 관련 값
* Google OAuth client id
* CORS 허용 origin
* API 공개 URL
* Web 공개 URL
* S3/Garage 관련 값
* NAS export 경로

AI가 `.env.example`을 만들 수는 있다.
하지만 실제 `.env` 값은 사람이 직접 확인하고 넣는다.

---

### 원칙 6. public 파일 삭제는 보수적으로 한다

`apps/web/public` 안의 파일은 코드에서 import하지 않아도 외부 URL로 직접 쓰고 있을 수 있다.

따라서 public asset 삭제 전에는 반드시 확인한다.

* 화면에서 쓰는가?
* GitHub Pages URL로 외부에 공유된 적이 있는가?
* 학교/학과 자료로 보존해야 하는가?
* 대체 파일이 있는가?

확신 없으면 삭제하지 말고 archive 후보로 둔다.

---

## 5. 로컬에서 화면만 빠르게 확인하기

API나 DB 없이 Web UI만 확인하고 싶을 때 사용한다.

```bash
cd apps/web
npm run dev:mock
```

이 모드는 mock 데이터를 사용한다.

주의:

현재 mock mode에는 `/api/public/exhibitions/:id/projects` route가 빠져 있을 수 있다.
따라서 전시회별 작품 목록 화면이 mock mode에서 깨질 수 있다.

이 경우 운영 장애가 아니라 mock 구현 누락일 가능성이 있다.

---

## 6. 로컬에서 전체 시스템 실행하기

전체 실행은 Web, API, DB, 파일 저장소를 모두 띄우는 방식이다.

### 1단계. 의존성 설치

루트에서 실행한다.

```bash
npm install
```

---

### 2단계. DB와 Garage 실행

```bash
cd apps/db
docker compose up -d
```

이 명령은 로컬 개발용 PostgreSQL과 Garage를 띄운다.

---

### 3단계. API 환경변수 준비

```bash
cd apps/api
cp .env.example .env
```

그 다음 `.env`를 연다.
필요한 값을 채운다.

주의:

* `.env`는 커밋하지 않는다.
* 실제 비밀값은 채팅에 붙여넣지 않는다.
* Google OAuth를 실제로 쓰려면 client id와 허용 domain 설정이 맞아야 한다.

---

### 4단계. Prisma 준비 및 API 실행

```bash
cd apps/api
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

의미:

* `db:generate`: Prisma client 생성
* `db:migrate`: DB 구조 반영
* `db:seed`: 초기 데이터 넣기
* `dev`: API 개발 서버 실행

---

### 5단계. Web 실행

새 터미널에서 실행한다.

```bash
cd apps/web
npm run dev
```

브라우저에 출력된 주소로 접속한다.

---

## 7. 배포 전 사람이 눌러야 하는 체크리스트

배포 전에는 아래를 순서대로 확인한다.

### 코드 상태 확인

```bash
git status --short
```

확인할 것:

* 이번 작업과 관련 없는 파일이 섞였는가?
* `.env`가 올라가려 하고 있지 않은가?
* 대용량 파일이 실수로 포함되지 않았는가?
* 삭제 파일이 의도한 것인가?

---

### 전체 검증

```bash
npm test
npm run lint
npm run build
```

모두 성공해야 한다.

---

### API만 집중 검증

```bash
npm run db:generate --workspace=apps/api
npm test --workspace=apps/api
npm run lint --workspace=apps/api
npm run build --workspace=apps/api
```

---

### Web만 집중 검증

```bash
npm test --workspace=apps/web
npm run lint --workspace=apps/web
npm run build --workspace=apps/web
```

---

### 운영 API health 확인

운영 서버 배포 후에는 health endpoint를 확인한다.

서버 내부에서:

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

외부 공개 주소에서:

```bash
curl -fsS https://203.250.133.230/api/health
```

둘 다 성공해야 한다.

> Coding Agent들은 curl등을 사용해서 api를 확인하겠지만,
> 만일 사람이 수동으로 확인할 생각이라면 그냥 저 링크에 브라우저로 접속하면 된다.

---

## 8. GitHub Actions를 볼 때 기준

GitHub Actions는 자동으로 테스트, 빌드, 배포를 실행한다.

대략 역할은 이렇다.

### Web 배포

* `apps/web` 빌드
* GitHub Pages용 정적 파일 생성
* 외부 Pages repo에 배포

Web은 정적 사이트다.
DB를 직접 들고 있지 않다.
필요한 데이터는 API에서 받아온다.

---

### API 배포

* API 테스트
* API 빌드
* Docker image 생성
* GHCR에 push
* 서버에서 `server/deploy.sh` 실행

API는 운영 서버에서 돌아간다.
DB, S3/Garage, NAS export와 연결된다.

---

## 9. 운영 서버에서 자주 쓰는 명령

`server/deploy.sh`가 있는 위치 기준으로 사용한다.

```bash
server/deploy.sh up
server/deploy.sh down
server/deploy.sh restart
server/deploy.sh status
server/deploy.sh logs api
server/deploy.sh logs pg
```

의미:

* `up`: 서버 올리기
* `down`: 서버 내리기
* `restart`: 재시작
* `status`: 상태 확인
* `logs api`: API 로그 보기
* `logs pg`: PostgreSQL 로그 보기

주의:

`down`은 서비스 중단이다.
운영 중 함부로 실행하지 않는다.

---

## 10. 작품 업로드 운영 기준

작품을 올릴 때 사람은 아래를 확인한다.

### 텍스트 정보

* 작품 제목
* 연도
* 전시회
* 팀원 이름
* 학번
* 작품 설명
* 요약문
* 공개 여부
* 미완성 표시 여부

오타는 코드가 잡아주지 못한다.
사람이 봐야 한다.

---

### 이미지 파일

확인할 것:

* 포스터가 맞는가?
* 이미지가 깨지지 않는가?
* 해상도가 너무 작지 않은가?
* 이상한 여백이나 워터마크가 없는가?
* 저작권 문제가 없는가?

---

### 게임 파일

확인할 것:

* 압축 파일이 맞는가?
* 실행 파일이 포함되어 있는가?
* 불필요한 개발 파일이 들어있지 않은가?
* 용량 제한을 넘지 않는가?
* 업로드 후 다운로드가 되는가?

---

### 영상 파일

확인할 것:

* 재생이 되는가?
* 소리가 정상인가?
* 너무 큰 파일은 아닌가?
* 공개해도 되는 내용인가?

---

## 11. 자주 나는 문제와 대응

이 섹션은 개발 중 오류가 아니라 운영 중 실제 서비스 장애를 다룬다.
예를 들어 “사이트가 안 열린다”, “다운로드가 안 된다”, “NAS export가 실패한다” 같은 상황이다.

### 먼저 할 현실적인 확인

서버에 접속하기 전에 사람이 먼저 확인할 것이 있다.

* 브라우저 새로고침을 한다.
* 다른 브라우저 또는 시크릿 창에서도 같은지 본다.
* 다른 PC나 휴대폰에서도 같은지 본다.
* 학교망과 외부망, 가능하면 휴대폰 테더링에서도 확인한다.
* 한 사람의 PC에서만 안 되면 브라우저 cache, 확장 프로그램, 보안 프로그램, 네트워크 설정 문제일 수 있다.
* 여러 곳에서 동시에 안 되면 운영 서버, API, DB, 파일 저장소, NAS 문제일 수 있다.

그 다음 물리 상태를 확인한다.

* API 서버 PC가 켜져 있는가?
* NAS가 켜져 있는가?
* 랜선, 공유기, 스위치, 전원 어댑터가 빠져 있지 않은가?
* 서버 PC 또는 NAS 화면/상태등이 정상인가?
* 정전, 학교망 점검, 장비 이동이 있었는가?

꺼져 있거나 응답이 없으면 전원을 켜거나 1회 재부팅을 시도한다.
재부팅 후에는 바로 판단하지 말고 몇 분 기다린 뒤 다시 확인한다.

절대 먼저 하지 말 것:

* 반복 재부팅
* Docker/Podman volume 삭제
* DB migration 실행
* DB restore
* NAS 권한 전체 변경
* 업로드 파일 대량 삭제
* 원인을 모르는 상태에서 `down` 반복 실행

이런 작업은 데이터를 망가뜨릴 수 있다.
필요하면 먼저 백업 상태와 영향 범위를 확인하고, 작업 기록을 남긴다.

### 접속 정보는 어디에 있는가

README에는 실제 서버 접속 정보를 쓰지 않는다.
SSH 포트, 서버 주소, 계정명, 비밀번호, key 경로 같은 값은 연구실에 있는 종이문서를 기준으로 확인한다.

문서나 채팅에 실제 값을 붙여넣지 않는다.
예시는 항상 placeholder로만 쓴다.

```bash
ssh -p <종이문서의 SSH_PORT> <계정>@<서버주소>
```

비밀번호나 private key가 필요하면 사람이 직접 확인하고 입력한다.
Agent에게도 실제 secret을 오래 남는 채팅, README, 이슈, 커밋에 쓰게 하지 않는다.

### Code Agent에게 서버를 보게 하는 방법

가능한 경우, SSH 접속이 되는 PC에서 Code Agent를 실행한다.
Agent에게는 종이문서의 접속 정보를 기준으로 서버에 접속해서 읽기 중심 점검부터 하라고 지시한다.

처음에는 이런 범위만 허용한다.

* 상태 확인
* health 확인
* 로그 읽기
* 디스크 용량 확인
* NAS mount 확인
* 환경변수 key 이름 확인

처음부터 허용하지 말 것:

* DB migration
* volume 삭제
* 파일 대량 삭제
* 권한 전체 변경
* production `.env` 값 출력
* 비밀번호나 token 출력

SSH 접속이 어렵다면 API 서버 PC를 직접 켠다.
그 PC에서 Code Agent를 실행하고, 아래 “문제 설명 양식”을 붙여넣는다.
이 경우에도 Agent에게 먼저 읽기 중심 점검을 시키고, 위험한 복구 작업은 사람이 승인한 뒤 진행한다.

### 서버가 꺼졌어요

먼저 API 서버 PC와 NAS의 전원, 랜선, 네트워크 장비를 확인한다.
꺼져 있으면 전원을 켜고, 부팅이 끝날 때까지 기다린다.

서버에 접속할 수 있으면 상태를 본다.

```bash
server/deploy.sh status
```

API 로그와 DB 로그를 본다.

```bash
server/deploy.sh logs api
server/deploy.sh logs pg
```

서버 내부에서 health를 확인한다.

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

확인할 것:

* API 컨테이너가 실행 중인가?
* DB 컨테이너가 실행 중인가?
* 로그에 env validation 실패가 있는가?
* 로그에 DB 연결 실패가 있는가?
* 로그가 같은 오류로 계속 반복되는가?

서버가 한 번 재부팅된 뒤 정상으로 돌아오면 바로 추가 작업을 하지 않는다.
왜 꺼졌는지 전원, 발열, 학교망 점검, 최근 배포 여부를 기록한다.

### 다운로드가 안돼요

먼저 범위를 좁힌다.

* 특정 작품의 특정 파일만 안 되는가?
* 모든 게임 파일 다운로드가 안 되는가?
* 이미지와 포스터도 안 뜨는가?
* 관리자만 안 되는가, 방문자도 안 되는가?
* 학교망에서만 안 되는가, 외부망에서도 안 되는가?
* 같은 IP에서 여러 번 다운로드를 시도했는가?

확인할 것:

* API health가 정상인가?
* 해당 파일 metadata가 DB에 남아 있는가?
* S3/Garage 저장소가 응답하는가?
* API 로그에 401, 403, 404, 429, 500 중 무엇이 찍히는가?
* IP 차단 또는 다운로드 제한에 걸린 것은 아닌가?
* 파일 하나만 실패하면 업로드가 깨졌거나 object key가 틀어진 것은 아닌가?

바로 파일을 삭제하거나 재업로드하지 않는다.
특정 파일만 문제라면 원본 파일, DB metadata, 저장소 object 존재 여부를 먼저 확인한다.

### NAS export가 안돼요

NAS export는 API, 저장소, NAS mount, 파일 권한, 디스크 용량을 모두 탄다.
API health가 정상이어도 NAS export만 실패할 수 있다.

확인할 것:

* NAS 전원이 켜져 있는가?
* NAS가 서버에서 mount되어 있는가?
* export 대상 경로가 존재하는가?
* API process가 그 경로에 쓸 권한이 있는가?
* NAS 남은 용량이 충분한가?
* `NAS_EXPORT_*` 환경변수의 key 이름과 경로가 의도한 값인가?
* export 실행 로그에 permission denied, no space left, not mounted, timeout 같은 문구가 있는가?

서버에서 mount와 용량을 확인한다.
실제 경로는 종이문서와 운영 `.env`를 기준으로 본다.

```bash
df -hT <NAS_EXPORT_PATH>
mount | rg "<NAS_EXPORT_PATH 또는 NAS 식별자>"
```

주의:

* mount가 풀렸다고 바로 임의 경로에 export하지 않는다.
* NAS 권한을 전체 개방하지 않는다.
* 기존 export 결과물을 먼저 지우지 않는다.
* export 대상 경로를 바꾸기 전에는 기존 운영 경로와 관리자 화면 기대값을 확인한다.

### Agent에게 붙여넣을 문제 설명 양식

```text
장애 종류:
- 서버 꺼짐 / 다운로드 실패 / NAS export 실패 / 기타

발생 시간:
- YYYY-MM-DD HH:mm KST

문제가 난 URL:
- 예: https://.../projects/...

어떤 버튼/파일에서 실패했는지:
- 예: 2025 전시회 A작품 game.zip 다운로드

오류 문구:
- 브라우저에 보이는 문구
- 관리자 화면에 보이는 문구
- 가능하면 HTTP status code

범위:
- 내 PC만 / 여러 PC / 학교망 / 외부망 / 휴대폰에서도 발생

최근 변경:
- 최근 배포 여부
- 최근 작품 업로드 여부
- 최근 NAS/서버 전원/네트워크 작업 여부

재부팅 여부:
- 아직 안 함 / API 서버 1회 재부팅함 / NAS 1회 재부팅함

SSH 가능 여부:
- 가능 / 불가능 / API 서버 PC 앞에서 직접 작업 가능

접속 정보:
- 실제 값은 README나 채팅에 쓰지 말고 연구실 종이문서 기준으로 확인

금지 작업:
- 반복 재부팅 금지
- DB migration 금지
- DB restore 금지
- Docker/Podman volume 삭제 금지
- 업로드 파일 대량 삭제 금지
- production .env 값 출력 금지

Agent에게 원하는 일:
- 먼저 읽기 중심으로 상태, health, 로그, 용량, NAS mount를 확인
- 원인 후보를 정리
- 위험한 복구 작업은 실행 전에 사람에게 확인
```

### 복구 후 확인

복구했다고 판단하기 전에 실제 사용자 경로를 확인한다.

* 공개 사이트가 열리는가?
* 작품 목록이 열리는가?
* 작품 상세 페이지가 열리는가?
* 포스터와 이미지가 보이는가?
* 문제가 된 파일 다운로드가 되는가?
* 관리자 로그인이 되는가?
* 관리자 화면에서 최근 작품 정보가 보이는가?
* NAS export가 문제였다면 새 export 결과물이 NAS 경로에 생겼는가?
* API 로그에 같은 오류가 계속 반복되지 않는가?

마지막으로 기록을 남긴다.

* 언제 발생했는가?
* 사용자가 본 증상은 무엇이었는가?
* 원인은 무엇으로 판단했는가?
* 어떤 조치를 했는가?
* 재부팅, 배포, 설정 변경, 파일 복구가 있었는가?
* 다시 발생하면 무엇을 먼저 볼 것인가?

---

## 12. AI에게 일을 맡길 때의 기본 양식

AI에게 “고쳐줘”라고만 말하면 위험하다.
항상 아래 형식으로 준다.

```text
목표:
- 무엇을 고칠지 한 문장으로 설명

수정 범위:
- 건드려도 되는 파일
- 건드리면 안 되는 파일

제외 범위:
- 이번 작업에서 하지 말아야 할 것

검증:
- 실행할 명령어

완료 조건:
- 어떤 상태가 되면 완료인지

롤백 기준:
- 어떤 문제가 생기면 되돌릴지

보고 형식:
- 수정 파일 목록
- 변경 요약
- 실행한 검증 명령
- 실패/미실행 항목
```

---

## 13. AI 작업 지시 예시

### 작은 버그 수정용

```text
현재 레포에서 chunked game upload CORS 문제만 수정하세요.

목표:
- 브라우저 cross-origin 환경에서 PUT chunk upload preflight가 실패하지 않게 한다.

수정 범위:
- apps/api/src/plugins/cors.ts
- 관련 API test 파일

제외 범위:
- game upload service 로직 변경 금지
- UI 변경 금지
- 인증/권한 정책 변경 금지

검증:
- npm test --workspace=apps/api
- npm run lint --workspace=apps/api

완료 조건:
- CORS allowed methods에 PUT이 포함됨
- OPTIONS preflight test가 통과함

보고 형식:
- 수정 파일 목록
- 변경 요약
- 검증 결과
- 남은 위험
```

---

### 문서 정리용

```text
README.md를 운영자용 매뉴얼 중심으로 정리하세요.

목표:
- 기술 과시용 설명을 줄이고, 사람이 실제로 해야 할 절차를 명확히 한다.

포함할 내용:
- 프로젝트 목적
- 가벼운 기술스택
- 로컬 실행법
- 배포 전 검증
- 운영자가 주의할 점
- troubleshooting
- AI에게 작업을 맡길 때의 지시 양식

제외 범위:
- 코드 수정 금지
- 실제 secret 작성 금지
- 오래된 내용을 사실처럼 단정 금지

검증:
- markdown 링크와 명령어를 눈으로 확인
- README 외 파일 수정 금지
```

---

## 14. 절대 함부로 삭제하지 말 것

아래는 삭제 위험이 크다.

```text
packages/contracts/src/index.ts
apps/api/prisma/migrations/*
server/deploy.sh
apps/web/public/pcu_logo.png
apps/web/public/pcu_signature.svg
apps/api/src/shared/storage-path.ts
```

이유:

* `packages/contracts/src/index.ts`: Web과 API가 공유하는 타입
* `apps/api/prisma/migrations/*`: DB 이력
* `server/deploy.sh`: 운영 배포 스크립트
* `pcu_logo.png`, `pcu_signature.svg`: 화면과 favicon에서 사용 가능
* `storage-path.ts`: 일부 함수가 deprecated여도 현재 코드에서 사용 가능

삭제하고 싶으면 먼저 참조 검색을 한다.

```bash
rg -n "파일명또는함수명"
```

그리고 테스트한다.

```bash
npm test
npm run lint
npm run build
```

---

## 15. 커밋 전 마지막 확인

커밋 전에는 아래를 확인한다.

```bash
git status --short
git diff --stat
```

확인할 것:

* README만 고치는 작업인데 코드가 섞이지 않았는가?
* 코드 수정 작업인데 관련 없는 문서가 섞이지 않았는가?
* `.env`가 포함되지 않았는가?
* 빌드 결과물 `dist`가 실수로 포함되지 않았는가?
* 대용량 파일이 들어가지 않았는가?
* 삭제 파일이 의도한 것인가?

검증 후 커밋한다.

```bash
npm test
npm run lint
npm run build
```

---

## 16. 이 프로젝트에서 사람이 책임져야 하는 것

AI가 할 수 있는 것:

* 코드 작성
* 테스트 추가
* 문서 초안 작성
* 오류 원인 추정
* 리팩터링 제안
* 반복 작업 자동화

사람이 해야 하는 것:

* 어떤 기능이 실제로 필요한지 결정
* 학생 정보와 작품 정보 검수
* 공개해도 되는 파일인지 판단
* 운영 비밀값 관리
* 배포 승인
* 서버 접속 권한 관리
* 장애 발생 시 최종 판단
* 학교/학과 운영 맥락 반영
* 잘못된 AI 수정 거절

> 이 저장소에서 사람의 역할은 시스템이 현실에서 망가지지 않도록 결정하고 확인하는 것이다. 명심해주세요.
