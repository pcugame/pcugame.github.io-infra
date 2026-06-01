# PCU 졸업작품 전시 플랫폼 운영 문서

배재대학교 게임공학과 졸업작품을 공개 전시하고, 학생과 운영자가 작품 자료를 등록/관리하는 웹 서비스입니다. 이 문서는 비전공자, 신규 운영자, 인수인계 담당자가 서비스 구조와 기본 운영 절차를 한 번에 파악할 수 있도록 작성했습니다.

## 먼저 볼 것

- 공개 웹사이트: `https://pcugame.github.io`
- 공개 API 상태 확인: `https://203.250.133.230/api/health`
- 담당자: `송지한`
- 운영 서버 기준 배포 위치: `/srv/graduationproject_v2`
- 전체 기능을 로컬에서 확인할 때: 루트에서 `npm run testenv:up`
- 화면만 빠르게 볼 때: `cd apps/web` 후 `npm run dev:mock`

문제가 생겼을 때는 먼저 API health를 확인합니다. `health`가 정상이면 웹 배포, 로그인, 권한, 파일 저장소 문제를 차례로 좁혀 봅니다. `health/deep`은 DB뿐 아니라 S3/NAS 계층까지 확인하므로 파일 업로드/이미지 문제를 볼 때 유용합니다.

## 용어 먼저 이해하기

이 프로젝트 문서에는 웹 개발, 서버 운영, 배포 자동화 용어가 섞여 있습니다. Unity로 게임을 만들어 본 경험만 있어도 이해할 수 있도록, 자주 나오는 단어를 “사전적 설명”과 “쉬운 설명”으로 나눠 적었습니다.

### Web, Frontend

- 사전적 설명: 사용자의 브라우저에서 실행되는 화면과 화면 동작을 말합니다. HTML, CSS, JavaScript/TypeScript, React 같은 기술로 구성됩니다.
- 쉬운 설명: Unity 게임에서 플레이어가 직접 보는 UI, 버튼, 메뉴, 화면 전환에 해당합니다. 이 프로젝트에서는 학생과 방문자가 보는 작품 목록, 작품 상세, 로그인 화면, 관리자 화면이 모두 Web입니다.
- 이 저장소에서는 `apps/web` 폴더가 Web입니다.

### API, Backend

- 사전적 설명: Web이 필요한 데이터를 요청하거나 작업을 실행할 수 있도록 서버가 제공하는 기능 입구입니다. Backend는 이런 API와 서버 내부 로직 전체를 뜻합니다.
- 쉬운 설명: Unity 게임이 저장/불러오기, 랭킹 서버, 로그인 서버에 요청을 보내는 것과 비슷합니다. 화면은 Web이 보여주지만, “작품 목록 주세요”, “로그인 처리해 주세요”, “파일 업로드할게요” 같은 실제 처리는 API가 담당합니다.
- 이 저장소에서는 `apps/api` 폴더가 API/Backend입니다.

### Server

- 사전적 설명: 네트워크를 통해 다른 컴퓨터나 브라우저에 서비스를 제공하는 컴퓨터 또는 프로그램입니다.
- 쉬운 설명: 우리 웹사이트의 실제 일을 대신 해주는 상시 켜진 컴퓨터입니다. 방문자의 브라우저는 이 서버에 “작품 데이터 주세요”라고 요청하고, 서버는 DB와 파일 저장소를 확인해 답합니다.
- 현재 운영 서버에는 API, PostgreSQL DB, nginx, Podman runtime이 있습니다.

### URL, Route, Endpoint

- 사전적 설명: URL은 웹 주소 전체이고, route는 앱 안에서 특정 화면이나 기능으로 가는 경로이며, endpoint는 API가 요청을 받는 구체적인 주소입니다.
- 쉬운 설명: Unity 씬 이름이나 메뉴 버튼 목적지처럼 “어디로 갈지”를 나타냅니다. `https://pcugame.github.io`는 사이트 주소이고, `/admin/projects`는 관리자 작품 목록 화면이며, `/api/health`는 API 상태 확인 기능입니다.
- 예: `https://203.250.133.230/api/health`는 API 서버의 health endpoint입니다.

### HTTP, HTTPS

- 사전적 설명: HTTP는 브라우저와 서버가 데이터를 주고받는 통신 규칙입니다. HTTPS는 HTTP에 암호화를 더한 안전한 통신 방식입니다.
- 쉬운 설명: HTTP는 브라우저와 서버가 대화하는 언어이고, HTTPS는 그 대화를 남이 훔쳐보기 어렵게 봉투에 넣어 보내는 방식입니다.
- 운영에서는 로그인과 파일 접근이 있으므로 HTTPS가 필요합니다.

### IP 주소, Domain, DNS

- 사전적 설명: IP 주소는 네트워크에서 컴퓨터를 찾는 숫자 주소입니다. domain은 사람이 읽기 쉬운 이름이고, DNS는 domain을 IP 주소로 바꿔 주는 시스템입니다.
- 쉬운 설명: IP 주소는 `203.250.133.230` 같은 실제 위치 좌표이고, domain은 `pcugame.github.io` 같은 별명입니다. DNS는 별명을 실제 위치로 찾아 주는 전화번호부입니다.
- 현재 공개 API는 domain이 아니라 IP 주소 `203.250.133.230`을 직접 사용합니다. 그래서 TLS 인증서 운영이 조금 더 까다롭습니다.

### Port

- 사전적 설명: 한 서버 안에서 어떤 프로그램과 통신할지 구분하는 번호입니다.
- 쉬운 설명: 하나의 건물에 여러 사무실이 있을 때 사무실 번호 같은 것입니다. 서버라는 건물 안에서 API는 보통 `4000`번 사무실을 씁니다.
- 운영에서는 외부 사용자가 `:4000`으로 직접 들어오지 못하게 하고, nginx가 HTTPS 요청을 받아 내부 `127.0.0.1:4000`으로 전달합니다.

### `127.0.0.1`, localhost, loopback

- 사전적 설명: 자기 자신을 가리키는 특수한 네트워크 주소입니다. 외부 컴퓨터가 아니라 현재 컴퓨터 내부에서만 접근합니다.
- 쉬운 설명: 서버가 자기 자신에게 말할 때 쓰는 주소입니다. “밖에서 API에 직접 들어오지 말고, 서버 안에서만 API를 보게 하자”는 구조에 사용합니다.
- `http://127.0.0.1:4000/api/health`는 운영 서버 내부에서만 직접 확인하는 health 주소입니다.

### Health Check, Deep Health

- 사전적 설명: health check는 서비스가 살아 있고 기본 의존성이 정상인지 확인하는 점검 endpoint입니다. deep health는 더 많은 내부 의존성까지 확인하는 확장 점검입니다.
- 쉬운 설명: health check는 “서버 숨 쉬고 있나?”를 보는 것이고, deep health는 “서버뿐 아니라 DB, 파일 저장소까지 제대로 연결됐나?”를 보는 것입니다.
- `/api/health`는 API와 DB 중심 확인입니다. `/api/health/deep`은 S3/NAS 쪽까지 확인하므로 이미지나 업로드 문제를 볼 때 더 중요합니다.

### DB, Database

- 사전적 설명: 구조화된 데이터를 저장하고 검색하는 시스템입니다.
- 쉬운 설명: 엑셀 파일보다 훨씬 크고 안전한 저장 장부입니다. 사용자, 전시 연도, 작품 제목, 멤버, 업로드된 파일 정보가 DB에 들어갑니다.
- 게임으로 비유하면 세이브 데이터, 유저 계정, 아이템 목록을 저장하는 서버 저장소에 가깝습니다.

### PostgreSQL

- 사전적 설명: 많이 쓰이는 오픈소스 관계형 데이터베이스입니다.
- 쉬운 설명: 이 프로젝트가 사용하는 DB 프로그램 이름입니다. Unity 프로젝트에서 특정 플러그인이나 에셋을 고르듯, 서버 데이터 저장 프로그램으로 PostgreSQL을 고른 것입니다.

### Prisma, Schema, Migration

- 사전적 설명: Prisma는 TypeScript 코드에서 DB를 다루기 쉽게 해 주는 도구입니다. schema는 DB 구조 정의서이고, migration은 DB 구조 변경 기록과 적용 절차입니다.
- 쉬운 설명: schema는 “DB에 어떤 표가 있고 각 칸이 어떤 의미인지 적은 설계도”입니다. migration은 “설계도가 바뀌었을 때 실제 DB도 똑같이 고치는 패치 파일”입니다.
- Unity로 비유하면 저장 데이터 클래스 구조를 바꾼 뒤, 기존 세이브 파일도 새 구조에 맞게 변환하는 작업과 비슷합니다.
- 운영 DB migration은 데이터가 바뀔 수 있으므로 백업 없이 실행하면 안 됩니다.

### Seed

- 사전적 설명: 개발이나 테스트를 위해 DB에 기본 데이터를 넣는 작업입니다.
- 쉬운 설명: 빈 게임 월드에 테스트용 캐릭터, 아이템, 맵 데이터를 미리 깔아 두는 것과 같습니다.
- 로컬 개발에서는 `npm run db:seed`로 테스트용 데이터를 넣을 수 있습니다.

### File Storage, Object Storage

- 사전적 설명: 이미지, 영상, 압축 파일 같은 바이너리 파일을 저장하는 공간입니다. object storage는 파일을 key-value 형태의 object로 저장하는 방식입니다.
- 쉬운 설명: DB는 작품 제목과 설명 같은 “글자 데이터”를 저장하고, 파일 저장소는 포스터 이미지, 게임 빌드 파일, 영상 같은 “무거운 파일”을 저장합니다.
- DB에 게임 파일 자체를 넣는 것이 아니라, 파일은 저장소에 두고 DB에는 파일 위치와 정보만 적습니다.

### S3, Garage

- 사전적 설명: S3는 AWS에서 시작된 object storage API 규격입니다. Garage는 S3와 비슷한 방식으로 동작하는 오픈소스 저장소입니다.
- 쉬운 설명: S3는 “파일 보관 창고에 파일을 넣고 빼는 표준 방식”이라고 보면 됩니다. Garage는 그 방식을 우리 환경에서 쓸 수 있게 해 주는 프로그램입니다.
- README에서 “S3/Garage”라고 쓰면, 실제 파일을 넣고 빼는 저장소 계층을 뜻합니다.

### NAS

- 사전적 설명: Network Attached Storage의 약자로, 네트워크로 연결해서 사용하는 저장장치입니다.
- 쉬운 설명: 여러 컴퓨터가 같이 접근하는 큰 외장하드입니다. 운영 서버가 NAS를 연결해서 export 대상이나 일부 파일 경로로 사용합니다.
- NAS가 꺼지거나 mount가 풀리면 API 자체는 살아 있어도 이미지, 업로드, export가 실패할 수 있습니다.

### Mount

- 사전적 설명: 외부 디스크나 네트워크 저장소를 특정 폴더 경로에 연결해 파일처럼 접근할 수 있게 만드는 작업입니다.
- 쉬운 설명: NAS라는 외장하드를 서버의 `/mnt/nas/pcu_storage` 폴더에 꽂아 둔 상태라고 생각하면 됩니다.
- `df -hT /mnt/nas/pcu_storage`는 그 외장하드가 제대로 꽂혀 있는지 보는 명령입니다.

### Export

- 사전적 설명: 시스템 안의 데이터를 외부에서 쓰기 쉬운 파일 구조로 내보내는 작업입니다.
- 쉬운 설명: 관리자 화면에 있는 작품 파일들을 NAS 쪽 폴더로 복사해서, 웹 서비스 밖에서도 정리된 파일 묶음으로 볼 수 있게 만드는 작업입니다.
- export는 파일을 많이 읽고 쓰므로 NAS 상태와 권한이 중요합니다.

### nginx, Reverse Proxy

- 사전적 설명: nginx는 웹 서버이자 reverse proxy로 자주 쓰이는 프로그램입니다. reverse proxy는 외부 요청을 받아 내부 서비스로 대신 전달하는 중간 서버입니다.
- 쉬운 설명: nginx는 건물 1층 안내데스크입니다. 사용자는 안내데스크로만 들어오고, 안내데스크가 내부 사무실인 API로 연결해 줍니다.
- 이 구조 덕분에 API의 `4000` 포트를 외부에 직접 열지 않고도 HTTPS로 API를 사용할 수 있습니다.

### TLS, Certificate, 인증서

- 사전적 설명: TLS는 HTTPS 암호화에 쓰이는 보안 프로토콜이고, certificate는 서버가 진짜 그 주소의 서버임을 증명하는 전자 문서입니다.
- 쉬운 설명: TLS는 브라우저와 서버 사이의 대화를 암호화하는 자물쇠이고, 인증서는 “이 서버가 가짜가 아니다”라고 보여 주는 신분증입니다.
- 인증서가 만료되면 브라우저에 보안 경고가 뜰 수 있습니다.

### OAuth, Google Login

- 사전적 설명: OAuth는 사용자가 비밀번호를 직접 서비스에 맡기지 않고, Google 같은 인증 제공자를 통해 로그인하게 하는 표준 방식입니다.
- 쉬운 설명: 우리 사이트가 Google 비밀번호를 직접 받지 않고, Google에게 “이 사람이 맞나요?”라고 물어보는 방식입니다. Google이 확인해 주면 우리 사이트는 그 결과만 믿고 로그인 세션을 만듭니다.
- 이 프로젝트는 Google OAuth를 사용하며, 학교 도메인 제한이 걸려 있습니다.

### Session, Cookie, HttpOnly Cookie

- 사전적 설명: session은 로그인 상태를 서버가 기억하는 정보입니다. cookie는 브라우저가 서버에 자동으로 함께 보내는 작은 데이터입니다. HttpOnly cookie는 JavaScript에서 읽지 못하게 막은 보안 cookie입니다.
- 쉬운 설명: 로그인 후 받는 입장 팔찌라고 생각하면 됩니다. 브라우저는 요청할 때마다 이 팔찌를 보여 주고, 서버는 “아, 로그인한 사용자구나”라고 판단합니다.
- HttpOnly는 웹 화면 코드가 팔찌 내용을 훔쳐보지 못하게 막는 설정입니다.

### Role, 권한, `USER`/`OPERATOR`/`ADMIN`

- 사전적 설명: role은 사용자가 시스템에서 수행할 수 있는 작업 범위를 나타내는 권한 등급입니다.
- 쉬운 설명: 게임 길드 권한처럼 일반 멤버, 운영진, 최고관리자 역할이 다른 것과 같습니다.
- `USER`는 일반 로그인 사용자, `OPERATOR`는 작품/전시 운영 담당자, `ADMIN`은 import 같은 더 위험한 작업까지 가능한 관리자입니다.

### Environment Variable, `.env`

- 사전적 설명: 프로그램 실행 시 외부에서 주입하는 설정값입니다. `.env` 파일은 이런 값을 저장하는 로컬 설정 파일입니다.
- 쉬운 설명: Unity의 Project Settings나 빌드 설정처럼, 코드에 박아 넣지 않고 환경별로 바꿔 끼우는 설정입니다. 로컬, 테스트, 운영 서버는 DB 주소나 API 주소가 다르기 때문에 `.env`를 씁니다.
- `.env`에는 비밀번호나 토큰이 들어갈 수 있으므로 절대 커밋하거나 채팅에 붙여 넣지 않습니다.

### Secret, Token, Private Key

- 사전적 설명: secret은 외부에 공개되면 안 되는 인증 정보이고, token은 접근 권한을 증명하는 문자열이며, private key는 암호화/접속 인증에 쓰는 개인키입니다.
- 쉬운 설명: 계정 비밀번호, 사무실 마스터키, 자동 로그인 열쇠 같은 것입니다. 한 번 유출되면 다른 사람이 서버나 저장소에 접근할 수 있습니다.
- README에는 값이 아니라 “이런 종류의 값은 쓰지 말라”는 원칙만 적습니다.

### GitHub Actions, Workflow

- 사전적 설명: GitHub Actions는 GitHub에서 제공하는 자동화 실행 환경입니다. workflow는 어떤 조건에서 어떤 명령을 실행할지 적은 자동화 파일입니다.
- 쉬운 설명: GitHub에 코드를 올리면 자동으로 테스트하고, 빌드하고, 배포까지 해 주는 작업 로봇입니다.
- `.github/workflows/deploy-api.yml`은 API 배포 로봇, `.github/workflows/deploy-web-pages.yml`은 Web 배포 로봇입니다.

### Deploy, 배포

- 사전적 설명: 개발한 코드를 실제 사용자가 접근할 수 있는 운영 환경에 올리는 작업입니다.
- 쉬운 설명: Unity에서 에디터 안에서만 돌리던 게임을 빌드해서 실제 플레이어가 받을 수 있게 올리는 과정과 비슷합니다.
- 이 프로젝트는 Web을 GitHub Pages에 배포하고, API를 운영 서버에 배포합니다.

### Build, Lint, Test

- 사전적 설명: build는 실행 가능한 결과물을 만드는 작업, lint는 코드 스타일/문법 위험을 검사하는 작업, test는 정해 둔 기능 검증 코드를 실행하는 작업입니다.
- 쉬운 설명: build는 Unity 빌드, lint는 코드 맞춤법 검사, test는 자동 플레이 테스트에 가깝습니다.
- 문서만 바꿀 때는 보통 전체 build/test가 필수는 아니지만, 코드 변경 때는 실행해야 합니다.

### Node.js, npm

- 사전적 설명: Node.js는 JavaScript/TypeScript를 브라우저 밖에서 실행하는 런타임입니다. npm은 패키지 설치와 명령 실행 도구입니다.
- 쉬운 설명: Unity 프로젝트에 Unity Editor와 Package Manager가 필요하듯, 이 웹 프로젝트에는 Node.js와 npm이 필요합니다.
- `npm install`은 필요한 패키지를 설치하고, `npm run build`는 `package.json`에 적힌 build 명령을 실행합니다.

### Docker, Docker Compose

- 사전적 설명: Docker는 프로그램과 실행 환경을 container로 묶어 실행하는 도구입니다. Docker Compose는 여러 container를 한 번에 띄우는 설정 도구입니다.
- 쉬운 설명: “내 컴퓨터에는 되는데 다른 컴퓨터에는 안 돼요”를 줄이기 위해, 프로그램이 돌아갈 작은 가상 실행 박스를 만드는 도구입니다.
- 로컬/통합 테스트에서는 Docker Compose로 PostgreSQL, Garage, API, Web을 함께 띄웁니다.

### Container, Image

- 사전적 설명: image는 실행 환경을 담은 템플릿이고, container는 그 image를 실제로 실행한 인스턴스입니다.
- 쉬운 설명: image는 Unity 빌드 파일이고, container는 그 빌드를 실제로 실행한 게임 프로세스에 가깝습니다. 같은 image로 container를 다시 만들 수 있습니다.
- API 운영 image는 GHCR에 올라가고, 서버는 그 image를 받아 container로 실행합니다.

### Podman, Pod, Volume

- 사전적 설명: Podman은 Docker와 비슷하게 container를 실행하는 도구입니다. pod는 여러 container를 묶은 실행 단위이고, volume은 container가 지워져도 유지되는 저장공간입니다.
- 쉬운 설명: Podman은 운영 서버에서 container를 돌리는 프로그램입니다. pod는 API와 DB를 같은 작업 묶음으로 묶은 것이고, volume은 DB 데이터를 잃지 않게 따로 보관하는 세이브 폴더입니다.
- 운영 서버에서는 Podman pod `graduationproject` 안에 `gp-api`, `gp-postgres`가 있습니다.

### GHCR

- 사전적 설명: GitHub Container Registry의 약자로, container image를 저장하는 GitHub의 registry 서비스입니다.
- 쉬운 설명: API 서버 빌드 결과물을 보관하는 창고입니다. GitHub Actions가 API image를 GHCR에 올리고, 운영 서버가 그 image를 내려받아 실행합니다.

### GitHub Pages

- 사전적 설명: GitHub가 정적 웹사이트를 호스팅해 주는 서비스입니다.
- 쉬운 설명: HTML/CSS/JS로 만들어진 Web 결과물을 무료 웹 호스팅 공간에 올려서 방문자가 볼 수 있게 하는 서비스입니다.
- 이 프로젝트의 공개 Web은 `pcugame/pcugame.github.io` 저장소에 배포됩니다.

### Mock

- 사전적 설명: 실제 API나 DB 대신 가짜 데이터를 사용해 화면이나 기능을 테스트하는 방식입니다.
- 쉬운 설명: Unity에서 실제 서버 연결 없이 임시 JSON 데이터나 더미 캐릭터 데이터로 UI를 확인하는 것과 같습니다.
- `npm run dev:mock`은 API/DB/S3 없이 Web 화면만 빠르게 확인할 때 씁니다.

### Integration Test, 통합 테스트 환경

- 사전적 설명: 여러 구성요소를 실제와 비슷하게 함께 실행해 전체 흐름을 검증하는 테스트입니다.
- 쉬운 설명: 캐릭터 컨트롤러만 따로 보는 것이 아니라, 실제 맵, UI, 저장, 네트워크까지 같이 켜고 플레이해 보는 테스트입니다.
- `npm run testenv:up`은 Web, API, PostgreSQL, Garage를 함께 띄워 실제 경로에 가깝게 확인합니다.

### Production, Local, Development

- 사전적 설명: production은 실제 사용자가 쓰는 운영 환경입니다. local/development는 개발자 컴퓨터에서 작업하고 확인하는 환경입니다.
- 쉬운 설명: production은 출시 서버, local은 내 PC 테스트 환경입니다. local에서 되는 설정을 production에 그대로 켜면 보안 문제가 생길 수 있습니다.
- 특히 dev login, mock, local secret은 production에서 사용하면 안 됩니다.

### CORS, CSRF

- 사전적 설명: CORS는 브라우저가 다른 출처의 API를 호출할 수 있는지 정하는 보안 정책입니다. CSRF는 로그인된 사용자의 브라우저를 악용해 원치 않는 요청을 보내는 공격입니다.
- 쉬운 설명: CORS는 “우리 웹사이트에서 우리 API로 요청해도 되나요?”를 브라우저가 확인하는 규칙입니다. CSRF는 사용자가 로그인한 상태를 나쁜 사이트가 몰래 이용하는 공격입니다.
- 로그인과 관리자 기능이 있는 서비스에서는 둘 다 중요합니다.

### Rate Limit

- 사전적 설명: 일정 시간 동안 허용되는 요청 수를 제한하는 정책입니다.
- 쉬운 설명: 로그인 시도나 파일 다운로드를 너무 많이 반복하는 사람을 자동으로 막는 장치입니다. 게임 서버에서 비정상적으로 빠른 요청을 보내는 클라이언트를 제한하는 것과 비슷합니다.

### Presigned URL, Redirect

- 사전적 설명: presigned URL은 제한된 시간 동안만 접근 가능한 임시 파일 주소입니다. redirect는 한 주소로 들어온 요청을 다른 주소로 보내는 응답입니다.
- 쉬운 설명: 파일 창고에 바로 들어갈 수 있는 1회용 임시 입장권을 만들어 주는 방식입니다. 사용자는 API 주소를 눌렀지만, 실제 파일은 S3/Garage 임시 주소에서 내려받게 됩니다.

### TypeScript, React, Vite, Fastify, Zod, TanStack Query

- 사전적 설명: TypeScript는 타입이 있는 JavaScript입니다. React는 화면 UI를 만드는 라이브러리, Vite는 Web 개발/빌드 도구, Fastify는 API 서버 프레임워크, Zod는 데이터 검증 라이브러리, TanStack Query는 Web에서 API 데이터를 불러오고 캐시하는 라이브러리입니다.
- 쉬운 설명: 전부 “웹 서비스를 만들기 위한 도구들”입니다. Unity로 치면 C# 언어, UI Toolkit, Addressables, 입력 시스템, 검증용 유틸리티처럼 각자 담당 영역이 있는 도구 묶음입니다.
- 운영자가 매일 이 도구의 내부를 알 필요는 없지만, 오류 메시지나 package 이름에서 보이면 어느 영역 문제인지 감을 잡는 데 도움이 됩니다.

### Contract

- 사전적 설명: API 요청과 응답의 형태를 Web과 API가 함께 맞추기 위한 타입 정의입니다.
- 쉬운 설명: Web과 API 사이의 약속 문서입니다. Web이 “작품 목록은 이런 모양으로 주세요”라고 기대하고, API가 같은 모양으로 답해야 화면이 깨지지 않습니다.
- 이 저장소에서는 `packages/contracts`가 그 약속을 담습니다.

### 로그, Smoke Check, Runbook

- 사전적 설명: 로그는 프로그램이 남기는 실행 기록입니다. smoke check는 큰 문제 없이 켜졌는지 빠르게 보는 최소 점검입니다. runbook은 운영자가 따라 하는 절차서입니다.
- 쉬운 설명: 로그는 게임 콘솔 출력, smoke check는 게임 실행 후 메인 화면/저장/로그인만 빠르게 눌러 보는 점검, runbook은 장애가 났을 때 따라 할 체크리스트입니다.
- README의 “문제 발생 시 확인표”와 “배포 전후 smoke check”는 runbook 역할을 합니다.

### CLI 명령어, `cd`, `curl`, `sudo`

- 사전적 설명: CLI는 터미널에서 글자로 명령을 입력하는 방식입니다. `cd`는 폴더 이동, `curl`은 HTTP 요청 실행, `sudo`는 관리자 권한으로 명령을 실행하는 도구입니다.
- 쉬운 설명: Unity Editor 버튼 대신 검은 창/PowerShell에서 직접 명령 버튼을 누르는 방식입니다. `cd apps/web`은 `apps/web` 폴더로 들어가라는 뜻이고, `curl .../api/health`는 브라우저 대신 API 주소를 한 번 호출해 보라는 뜻입니다.
- `sudo`가 붙은 명령은 서버에 큰 영향을 줄 수 있으므로 승인 없이 실행하지 않습니다.

## 현재 운영 정보

| 항목 | 현재 기준 |
| --- | --- |
| 담당자 | `송지한` |
| Web | `https://pcugame.github.io` |
| API | `https://203.250.133.230` |
| 공개 API health | `https://203.250.133.230/api/health` |
| 서버 내부 health | `http://127.0.0.1:4000/api/health` |
| 서버 내부 deep health | `http://127.0.0.1:4000/api/health/deep` |
| 서버 배포 디렉터리 | `/srv/graduationproject_v2` |
| 운영 런타임 | Podman pod `graduationproject` |
| 주요 컨테이너 | `gp-api`, `gp-postgres` |
| API 이미지 | `ghcr.io/pcugame/pcu-graduationproject-v2-api:latest` |
| 공개 프록시 | nginx HTTPS -> `127.0.0.1:4000` |

운영 서버의 API는 외부에 `:4000` 포트를 직접 열지 않고, nginx가 HTTPS 요청을 받아 내부 `127.0.0.1:4000`으로 전달하는 구조입니다. 서버 내부에서는 `http://127.0.0.1:4000/api/health`를 보고, 외부에서는 `https://203.250.133.230/api/health`를 봅니다.

운영에서 금지할 것:

- `.env`, 토큰, 비밀번호, 개인키, 쿠키 값을 문서나 이슈에 붙여 넣지 않습니다.
- DB 마이그레이션, 복구, 대량 삭제, NAS 권한 변경은 백업과 승인 없이 실행하지 않습니다.
- 루트 `docker-compose.yml`이 있다고 가정하지 않습니다. 현재 저장소 루트에는 없습니다.
- 운영 배포는 `server/deploy.sh` 기준입니다. 서버에 남아 있는 오래된 compose 파일이 있더라도 현재 기준이 아닙니다.
- production에서 `DEV_AUTH_ENABLED` 또는 `VITE_DEV_AUTH_ENABLED`를 켜지 않습니다.

## 서비스 구조

이 서비스는 크게 다섯 부분으로 나뉩니다.

| 구성 | 역할 | 저장소 위치 |
| --- | --- | --- |
| Web | 사용자가 보는 화면입니다. 공개 전시, 로그인, 내 작품, 관리자 화면을 제공합니다. | `apps/web` |
| API | 로그인, 작품 조회/등록/수정, 업로드, 관리자 기능을 처리합니다. | `apps/api` |
| DB | 사용자, 전시, 작품, 멤버, 파일 메타데이터를 저장합니다. PostgreSQL을 사용합니다. | `apps/api/prisma` |
| 파일 저장소 | 이미지, 게임 파일, 영상 파일을 저장하고 내려줍니다. Garage/S3 호환 저장소를 사용합니다. | `apps/db`, API S3 설정 |
| NAS/export | 관리자 export 기능의 대상 경로입니다. 운영 서버에서는 NAS mount가 연동됩니다. | 서버 `/mnt/nas/pcu_storage`, 컨테이너 `/nas` |

Web은 GitHub Pages에 정적 파일로 배포됩니다. API는 GitHub Actions가 Docker 이미지를 만들고 GHCR에 올린 뒤, 운영 서버에서 Podman으로 실행합니다. DB는 운영 서버의 Podman volume에 저장됩니다.

## 페이지 사용법

### 방문자

- `/`: 공개 홈 화면입니다.
- `/years`: 전시 연도 목록을 봅니다.
- `/years/:year`: 특정 연도의 작품 목록을 봅니다.
- `/exhibitions/:id`: 특정 전시 기준 작품 목록을 봅니다.
- `/years/:year/:slug`, `/projects/:projectId`: 작품 상세를 봅니다.

방문자는 로그인 없이 공개된 전시와 작품을 볼 수 있습니다. 작품 이미지나 파일이 보이지 않으면 API health보다 `health/deep`을 먼저 확인합니다.

### 로그인 사용자

- `/login`: Google 계정으로 로그인합니다.
- `/me`: 내 계정 정보를 확인합니다.
- `/me/projects`: 내가 만든 작품 또는 멤버로 포함된 작품을 봅니다.
- `/me/projects/new`: 작품을 제출합니다.

로그인은 Google OAuth와 HttpOnly session cookie를 사용합니다. 학교 도메인 제한이 설정된 경우 허용되지 않은 계정은 로그인할 수 없습니다.

### 관리자/운영자

- `/admin`: 관리자 홈 진입점입니다. 현재는 `/admin/projects`로 이동합니다.
- `/admin/projects`: 작품 목록을 관리합니다.
- `/admin/projects/new`: 운영자가 작품을 직접 등록합니다.
- `/admin/projects/:id/edit`: 작품 정보, 멤버, 이미지, 포스터, 게임 파일을 수정합니다.
- `/admin/years`: 전시 연도와 전시 포스터를 관리합니다.
- `/admin/settings`: 업로드 제한 등 사이트 설정을 조정합니다.
- `/admin/banned-ips`: 보호 파일 접근 차단 IP를 확인/해제합니다.
- `/admin/import`: JSON import를 preview/execute 합니다. `ADMIN` 권한만 접근합니다.

권한은 `USER`, `OPERATOR`, `ADMIN`으로 나뉩니다. 일반 사용자는 본인 작품 중심으로 접근하고, 운영자는 전시/작품 운영 화면을 다루며, 관리자는 import와 일부 위험 작업까지 수행합니다.

## 문제 발생 시 확인표

### 사이트 접속이 안 됨

1. 브라우저에서 `https://pcugame.github.io`가 열리는지 확인합니다.
2. API 상태를 확인합니다.

```bash
curl -fsS https://203.250.133.230/api/health
```

3. 운영 서버 안에서는 내부 API도 확인합니다.

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

4. 서버에서 Podman 상태를 확인합니다.

```bash
/srv/graduationproject_v2/deploy.sh status
```

5. API 로그를 봅니다.

```bash
/srv/graduationproject_v2/deploy.sh logs api
```

### 로그인 실패

- Google 계정이 허용 도메인인지 확인합니다.
- 브라우저에서 쿠키가 차단되어 있지 않은지 확인합니다.
- API health가 정상인지 확인합니다.
- 운영 환경에서 dev login 패널이 보이면 설정 오류입니다. `DEV_AUTH_ENABLED`, `VITE_DEV_AUTH_ENABLED`는 production에서 꺼져 있어야 합니다.
- `EMAIL_DOMAIN_NOT_ALLOWED` 오류는 학교 도메인 제한에 걸린 경우입니다.

### 이미지, 포스터, 게임 파일이 안 뜸

1. 일반 health를 확인합니다.

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

2. deep health를 확인합니다.

```bash
curl -fsS http://127.0.0.1:4000/api/health/deep
```

3. `deep health`에서 `s3=fail`이면 S3/Garage/NAS 계층을 의심합니다.
4. NAS 작업 직후라면 mount 상태도 확인합니다.

```bash
df -hT /mnt/nas/pcu_storage
mount | grep /mnt/nas/pcu_storage
```

5. 관리자 화면에서 파일 삭제/재업로드를 하기 전, 원본 파일과 저장소 상태를 먼저 확인합니다.

### 업로드 실패

- 파일 크기가 현재 업로드 제한을 넘지 않는지 확인합니다.
- 대용량 게임 파일은 chunked upload 경로를 사용합니다.
- 브라우저 네트워크 탭에서 401/403이면 로그인 또는 권한 문제입니다.
- 413 또는 request size 관련 오류면 nginx `client_max_body_size`, API upload limit, 관리자 설정을 함께 확인합니다.
- `health/deep`이 실패하면 업로드 저장소가 정상이 아닐 수 있습니다.

### 관리자 접근 불가

- `/me`에서 로그인 사용자를 먼저 확인합니다.
- 사용자의 role이 `OPERATOR` 또는 `ADMIN`인지 확인합니다.
- `/admin/import`는 `ADMIN`만 접근 가능합니다.
- `/admin`이 `/admin/projects`로 이동하지 않으면 Web 배포가 최신인지 확인합니다.

### 배포 직후 장애

1. API workflow가 성공했는지 GitHub Actions에서 확인합니다.
2. 서버에서 상태를 봅니다.

```bash
/srv/graduationproject_v2/deploy.sh status
```

3. API 로그를 봅니다.

```bash
/srv/graduationproject_v2/deploy.sh logs api
```

4. health를 순서대로 확인합니다.

```bash
curl -fsS http://127.0.0.1:4000/api/health
curl -fsS http://127.0.0.1:4000/api/health/deep
curl -kfsS https://203.250.133.230/api/health
```

5. DB migration이 포함된 배포라면 백업 존재 여부와 migration 로그를 확인합니다. DB restore는 승인 없이 실행하지 않습니다.

### 인증서 경고

- 현재 공개 API는 IP 주소 `203.250.133.230` 기준입니다. IP 기반 TLS 운영은 일반 도메인보다 갱신/호환성 리스크가 큽니다.
- 언젠가 학교의 도메인을 받을 수 있게 된다면, 교체가 시급하다고 생각합니다. (송지한 주)
- 서버에서 인증서 만료일과 nginx 설정을 확인합니다.

```bash
openssl x509 -in /etc/ssl/acme/203.250.133.230/fullchain.pem -noout -subject -issuer -enddate
sudo nginx -t
```

- 임의로 인증서 파일을 교체하지 말고, 운영 담당자 확인 후 처리합니다.

## 로컬/통합 확인법

사전 조건:

- Node.js 22 이상
- Docker Desktop 또는 Docker daemon
- 루트에서 `npm install` 실행

루트 기본 검증:

```bash
npm install
npm test
npm run lint
npm run build
```

### 통합 테스트 환경

실제 API, PostgreSQL, Garage(S3), Web을 함께 띄우는 기본 확인 방법입니다. Google OAuth 자체만 test/dev 전용 로그인 패널로 대체하고, 이후 session cookie, role guard, API/Web 오류 처리는 실제 경로를 사용합니다.

```bash
npm run testenv:up
```

접속:

- Web: `http://localhost:5173`
- API: `http://localhost:4000`
- PostgreSQL host port: `15432`
- Garage S3 host port: `3900`

상태 초기화와 종료:

```bash
npm run testenv:reset
npm run testenv:down
npm run testenv:clean
```

`testenv:reset`과 `testenv:clean`은 볼륨을 삭제합니다. 로컬 테스트 데이터가 사라져도 되는 상황에서만 사용합니다.

### UI mock 모드

API, DB, S3 없이 화면만 빠르게 확인하는 방법입니다.

```bash
cd apps/web
npm run dev:mock
```

mock 모드는 UI-only 확인용입니다. 로그인, 세션, 실제 업로드, DB 저장, S3 저장까지 보려면 통합 테스트 환경을 사용합니다.

### full-stack local

개발자가 API와 Web을 따로 띄우는 방식입니다. 통합 환경보다 설정을 직접 만져야 합니다.

1. DB와 Garage를 실행합니다.

```bash
cd apps/db
docker compose up -d
```

2. API 환경 파일을 만듭니다.

```bash
cd apps/api
cp .env.example .env
```

3. 로컬 Garage key를 확인해 API `.env`에 넣습니다. 출력값은 문서나 채팅에 공유하지 않습니다.

```bash
docker compose -f ../db/docker-compose.yml exec garage garage -c /etc/garage.toml key info pcu-dev-key
```

4. API를 준비하고 실행합니다.

```bash
cd apps/api
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

5. Web을 실행합니다.

```bash
cd apps/web
npm run dev
```

## 운영/배포 기본

### Web 배포

- workflow: `.github/workflows/deploy-web-pages.yml`
- trigger: `master` push 또는 수동 실행
- 주요 단계: install, test, lint, build, GitHub Pages 배포
- 배포 대상 저장소: `pcugame/pcugame.github.io`
- 공개 URL: `https://pcugame.github.io`

Web 배포 변수는 GitHub Actions variables/secrets에서 관리합니다. README에는 값을 쓰지 않습니다.

### API 배포

- workflow: `.github/workflows/deploy-api.yml`
- trigger: `master` push 또는 수동 실행
- 주요 단계: install, Prisma generate, API test, API build, Docker image build/push, 서버 SSH deploy
- 이미지 registry: GHCR
- 운영 서버 실행 스크립트: `/srv/graduationproject_v2/deploy.sh`

운영 서버의 기본 명령:

```bash
/srv/graduationproject_v2/deploy.sh status
/srv/graduationproject_v2/deploy.sh logs api
/srv/graduationproject_v2/deploy.sh logs pg
/srv/graduationproject_v2/deploy.sh restart
```

`restart`는 API와 DB 컨테이너를 재생성합니다. 배포, DB migration, NAS 작업 전후에는 backup과 smoke check를 먼저 확인합니다.

### 배포 전후 smoke check

배포 전:

- 최신 백업이 있는지 확인합니다.
- `.env` 파일 권한이 제한되어 있는지 확인합니다.
- `/`, `/srv`, NAS 여유 공간을 확인합니다.
- API가 외부 `:4000`으로 직접 노출되지 않는지 확인합니다.
- `http://127.0.0.1:4000/api/health`와 `/api/health/deep`을 확인합니다.

배포 후:

- Podman pod와 컨테이너가 실행 중인지 확인합니다.
- 내부 health와 공개 HTTPS health를 확인합니다.
- nginx가 `127.0.0.1:4000`으로 proxy하는지 확인합니다.
- API 로그에 env validation 실패, migration 실패, 반복 재시작이 없는지 확인합니다.

## 기술 스택

- Frontend: React 19, Vite 8, TypeScript, React Router 7, TanStack Query, Zod v4
- Backend: Fastify 5, TypeScript, Prisma 6, PostgreSQL, Zod v3
- Storage: Garage 또는 S3 호환 오브젝트 스토리지
- Auth: Google OAuth 2.0, HttpOnly cookie session
- Local/Integration: Docker Compose, PostgreSQL 16, Garage v1.1.0
- Production runtime: Podman, nginx, systemd user service
- CI/CD: GitHub Actions, GHCR, GitHub Pages
- Shared contracts: `packages/contracts`

## Known pitfalls

### 현재 남은 문제

- 루트 `docker-compose.yml`은 현재 저장소에 없습니다. 일부 workflow path나 오래된 문서/서버 파일에 이름이 남아 있을 수 있지만 현재 local DB compose는 `apps/db/docker-compose.yml`, 통합 compose는 `docker-compose.integration.yml`, 운영 배포는 `server/deploy.sh`가 기준입니다.
- production 서버용 `.env.example`은 아직 없습니다. 운영 서버 `.env`는 `/srv/graduationproject_v2/.env`에 있으나 값은 문서화하지 않습니다.
- `AUTO_PUBLISH_DEFAULT` 설정은 env/schema/deploy에 남아 있지만 현재 작품 제출 로직은 `PUBLISHED`로 고정되어 있습니다. 값을 바꿔도 등록 상태가 바뀐다고 가정하면 안 됩니다.
- API error code 문자열은 아직 `packages/contracts`에 중앙화되어 있지 않습니다. 현재 `EMAIL_DOMAIN_NOT_ALLOWED`는 테스트로 고정되어 있지만, 새 오류 코드가 늘면 backend/frontend drift 가능성이 있습니다.
- API `health/deep`과 파일 접근은 S3/NAS 계층에 영향을 받습니다. NAS 점검이나 mount 장애 중에는 일반 health가 정상이더라도 이미지/업로드/export가 실패할 수 있습니다.
- 공개 API가 IP 주소 기반 TLS를 사용합니다. 실제 DNS 이름으로 이전하기 전까지 인증서 갱신과 브라우저 호환성 리스크를 계속 확인해야 합니다.
- 백업과 복구 자동화가 아직 충분하지 않습니다. 수동 DB/NAS 백업 기록은 있으나, 자동 백업, off-host 보관, 복구 rehearsal, restore runbook이 추가로 필요합니다.
- 서버 `.env`에는 과거 session 관련 key가 남아 있을 수 있습니다. 현재 API schema는 `SESSION_IDLE_MS`, `SESSION_ABSOLUTE_MS`, `SESSION_TOUCH_MIN_INTERVAL_MS` 기준입니다.
- DB/import schema에는 `githubUrl`, `platforms`가 있지만 현재 public/admin 응답 serializer에서 사용자 화면으로 노출되는 경로는 확인되지 않았습니다.

### 이미 해결된 과거 함정

- CORS allowed methods에 `PUT`이 포함되어 chunked game upload preflight 문제가 해결됐습니다.
- mock API에 `/api/public/exhibitions/:id/projects` route가 추가됐습니다.
- `/admin` 직접 접근 시 `/admin/projects`로 이동하도록 index route가 추가됐습니다.
- Google hosted domain mismatch는 403 `EMAIL_DOMAIN_NOT_ALLOWED`로 정리됐고, invalid token은 401 `UNAUTHORIZED`를 유지합니다.

## 안전수칙

- 운영 값은 “키 이름”까지만 공유하고 값은 공유하지 않습니다.
- 로그를 공유할 때도 토큰, 쿠키, 개인키, DB 접속 문자열, S3 access key가 포함되지 않았는지 먼저 확인합니다.
- 배포 전에는 백업과 health를 확인합니다.
- 배포 후에는 내부 health, deep health, 공개 HTTPS health를 모두 확인합니다.
- NAS 이동/재부팅/네트워크 작업 전에는 업로드 중단 안내와 사후 smoke check를 준비합니다.
- DB restore, volume 삭제, NAS 권한 변경, 대량 삭제는 승인 없이는 실행하지 않습니다.
