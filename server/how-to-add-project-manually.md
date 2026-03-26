# How To Add Project Manually

이 문서는 서버에서 백엔드가 실행 중인 상태에서 작품을 수동 추가하거나 테스트 DB를 넣는 방법을 정리한 문서입니다.

기준 스크립트:

- [`server/db-seed.sh`](C:/Users/song/Desktop/pcu_graduationproject_v2/server/db-seed.sh)

기준 서버 경로 예시:

- `/srv/graduationproject_v2`

## 1. 사전 조건

아래 조건이 먼저 충족되어야 합니다.

- 서버에 프로젝트가 배포되어 있어야 합니다.
- Podman 기반 백엔드 컨테이너가 실행 중이어야 합니다.
- 기본 컨테이너 이름은 `gp-api`, `gp-postgres` 입니다.
- `.env` 파일이 `/srv/graduationproject_v2/.env` 에 있어야 합니다.

상태 확인:

```bash
cd /srv/graduationproject_v2/server
./deploy.sh status
```

스크립트 실행 권한이 없다면 한 번만 부여합니다.

```bash
cd /srv/graduationproject_v2/server
chmod +x db-seed.sh
```

## 2. 테스트 DB 넣기

테스트 관리자 계정, 테스트 세션, 테스트 작품 1건을 자동으로 넣습니다.

```bash
cd /srv/graduationproject_v2/server
./db-seed.sh seed
```

현재 기본으로 들어가는 테스트 데이터는 `apps/api/prisma/seed.ts` 기준입니다.

- 연도: `2026`
- 연도 제목: `2026 졸업작품전`
- 작품 제목: `테스트 졸업작품`
- slug: `test-project`
- 상태: `PUBLISHED`
- 멤버: `홍길동`, `김철수`
- 테스트 관리자 이메일: `admin@test.pcu.ac.kr`
- 테스트 세션 쿠키 값: `test-session-token`

빠르게 동작 확인용 데이터를 넣고 싶을 때 이 명령을 사용하면 됩니다.

## 3. 작품 1건 수동 추가

대화형 입력으로 작품을 1건 추가할 수 있습니다.

```bash
cd /srv/graduationproject_v2/server
./db-seed.sh add-project
```

실행하면 아래 항목을 순서대로 입력합니다.

- 연도
- 연도 제목
- 연도 공개 여부
- 작품 제목
- slug
- 한 줄 소개
- 상세 설명
- YouTube URL
- 상태
- 다운로드 정책
- 멤버 이름/학번

## 4. 수동 추가 예시

아래는 실제 입력 예시입니다.

```bash
연도 (예: 2026): 2025
연도 제목 [2025 졸업작품전]: 2025 게임학과 졸업작품전
연도 공개 여부 (true/false) [true]: true
작품 제목: 별빛 모험
슬러그 (비우면 자동 생성): starlight-adventure
한 줄 소개 [선택]: 2인 협동 퍼즐 어드벤처 게임
상세 설명 입력 후 Enter, 종료는 빈 줄에서 Enter
우주 정거장을 배경으로 한 협동 퍼즐 게임입니다.
두 플레이어가 각자 다른 능력을 사용해 스테이지를 해결합니다.

YouTube URL [선택]: https://www.youtube.com/watch?v=example123
상태 (DRAFT/PUBLISHED/ARCHIVED) [PUBLISHED]: PUBLISHED
다운로드 정책 (NONE/PUBLIC/SCHOOL_ONLY/ADMIN_ONLY) [PUBLIC]: PUBLIC

멤버 추가
멤버 이름 (종료하려면 빈 값): 김민수
학번 [선택]: 20201234
멤버 이름 (종료하려면 빈 값): 이서연
학번 [선택]: 20204567
멤버 이름 (종료하려면 빈 값):
```

입력이 끝나면 스크립트가 JSON 미리보기를 보여주고 마지막으로 확인을 받습니다.

예시:

```json
{
  "years": [
    {
      "year": 2025,
      "title": "2025 게임학과 졸업작품전",
      "isUploadEnabled": true
    }
  ],
  "projects": [
    {
      "year": 2025,
      "title": "별빛 모험",
      "summary": "2인 협동 퍼즐 어드벤처 게임",
      "description": "우주 정거장을 배경으로 한 협동 퍼즐 게임입니다.\n두 플레이어가 각자 다른 능력을 사용해 스테이지를 해결합니다.",
      "youtubeUrl": "https://www.youtube.com/watch?v=example123",
      "status": "PUBLISHED",
      "downloadPolicy": "PUBLIC",
      "slug": "starlight-adventure",
      "members": [
        { "name": "김민수", "studentId": "20201234", "sortOrder": 0 },
        { "name": "이서연", "studentId": "20204567", "sortOrder": 1 }
      ]
    }
  ]
}
```

여기서 `y`를 입력하면 DB에 반영됩니다.

## 5. 각 입력값 의미

- `연도`
  - 예: `2025`
  - DB에 없는 연도면 자동 생성됩니다.
- `연도 제목`
  - 예: `2025 게임학과 졸업작품전`
  - `years.title` 로 저장됩니다.
- `연도 공개 여부`
  - `true` 또는 `false`
  - 공개 전시 연도인지 여부입니다.
- `작품 제목`
  - 예: `별빛 모험`
- `slug`
  - URL용 문자열입니다.
  - 예: `starlight-adventure`
  - 비워두면 제목 기준으로 자동 생성됩니다.
- `한 줄 소개`
  - 목록 카드 등에 들어갈 짧은 설명입니다.
- `상세 설명`
  - 여러 줄 입력 가능합니다.
  - 빈 줄을 입력하면 종료됩니다.
- `YouTube URL`
  - 없으면 비워도 됩니다.
- `상태`
  - `DRAFT`, `PUBLISHED`, `ARCHIVED` 중 하나입니다.
- `다운로드 정책`
  - `NONE`, `PUBLIC`, `SCHOOL_ONLY`, `ADMIN_ONLY` 중 하나입니다.
- `멤버 이름/학번`
  - 작품 참여자 정보를 순서대로 추가합니다.
  - 이름을 빈 값으로 입력하면 멤버 입력을 종료합니다.

## 6. 실제 저장되는 작성자

`add-project`는 수동으로 creator를 받지 않습니다.

대신 `apps/api/prisma/seed.ts`가 생성하는 테스트 관리자 계정을 작성자로 사용합니다.

- email: `admin@test.pcu.ac.kr`
- name: `Test Admin`
- role: `ADMIN`

즉 수동 추가한 작품의 creator는 테스트 관리자 계정으로 들어갑니다.

## 7. JSON 파일로 여러 작품 한 번에 추가

작품이 여러 개라면 JSON 파일을 만든 뒤 `import-json` 으로 넣는 것이 더 편합니다.

예시 파일:

`/srv/graduationproject_v2/data/projects-2025.json`

```json
{
  "years": [
    {
      "year": 2025,
      "title": "2025 게임학과 졸업작품전",
      "isUploadEnabled": true
    }
  ],
  "projects": [
    {
      "year": 2025,
      "title": "별빛 모험",
      "slug": "starlight-adventure",
      "summary": "2인 협동 퍼즐 어드벤처 게임",
      "description": "우주 정거장을 배경으로 한 협동 퍼즐 게임",
      "youtubeUrl": "https://www.youtube.com/watch?v=example123",
      "status": "PUBLISHED",
      "downloadPolicy": "PUBLIC",
      "members": [
        { "name": "김민수", "studentId": "20201234" },
        { "name": "이서연", "studentId": "20204567" }
      ]
    },
    {
      "year": 2025,
      "title": "마지막 수업",
      "slug": "last-class",
      "summary": "스토리 중심 비주얼 노벨",
      "description": "졸업을 앞둔 학생들의 마지막 하루 이야기",
      "status": "DRAFT",
      "downloadPolicy": "SCHOOL_ONLY",
      "members": [
        { "name": "박준호", "studentId": "20207890" }
      ]
    }
  ]
}
```

실행:

```bash
cd /srv/graduationproject_v2/server
./db-seed.sh import-json /srv/graduationproject_v2/data/projects-2025.json
```

## 8. 추가 후 확인 방법

테이블 건수 확인:

```bash
cd /srv/graduationproject_v2/server
./db-seed.sh tables
```

직접 SQL 확인:

```bash
cd /srv/graduationproject_v2/server
./db-seed.sh psql
```

예시 쿼리:

```sql
SELECT y.year, y.title, p.title, p.slug, p.status
FROM projects p
JOIN years y ON y.id = p.year_id
ORDER BY y.year DESC, p.created_at DESC;
```

멤버까지 같이 보고 싶으면:

```sql
SELECT
  y.year,
  p.title,
  p.slug,
  m.name,
  m.student_id
FROM projects p
JOIN years y ON y.id = p.year_id
LEFT JOIN project_members m ON m.project_id = p.id
ORDER BY y.year DESC, p.title, m.sort_order;
```

## 9. 문제 발생 시 확인할 것

- `container does not exist`
  - `gp-api`, `gp-postgres` 컨테이너가 실제로 떠 있는지 확인합니다.
- `.env not found`
  - `/srv/graduationproject_v2/.env` 경로를 확인합니다.
- JSON 임포트 실패
  - JSON 문법 오류가 없는지 확인합니다.
- 중복 slug 문제
  - `import-json` 에서 slug를 비우면 자동 생성됩니다.
  - 같은 연도에 동일 slug가 있으면 seed 스크립트가 뒤에 번호를 붙입니다.

## 10. 빠른 사용 예시 모음

테스트 데이터 넣기:

```bash
cd /srv/graduationproject_v2/server
./db-seed.sh seed
```

작품 1건 수동 입력:

```bash
cd /srv/graduationproject_v2/server
./db-seed.sh add-project
```

JSON 파일로 여러 작품 추가:

```bash
cd /srv/graduationproject_v2/server
./db-seed.sh import-json /srv/graduationproject_v2/data/projects-2025.json
```

데이터 확인:

```bash
cd /srv/graduationproject_v2/server
./db-seed.sh tables
```
