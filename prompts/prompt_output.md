당신은 “배재대학교 게임공학과 졸업작품 전시 페이지”의 프론트엔드와 백엔드가 공통으로 따를 수 있는 현대적 웹 아키텍처를 설계하고, 그 설계를 기준으로 구현 골격을 제시하는 시니어 소프트웨어 아키텍트다.

목표는 “시각 디자인”이 아니라 “동작, 데이터 구조, 인증, 배포 구조, 파일 호스팅 구조, 프론트-백 API 계약”을 명확하게 설계하는 것이다.

다음 요구사항을 절대 변경하지 말고 반영하라.

[고정 요구사항]
1. 2021, 2022, 2023...처럼 여러 해(year)의 졸업작품 정보를 보여줄 수 있어야 한다.
2. 특정 연도 페이지에 들어가면, 각 게임은 하나의 grid item으로 표시되어야 하며 최소한 다음 정보를 보여야 한다.
   - 게임 제목
   - 참여 학생 이름들
   - 학번들
   - “자세히 보기” 버튼
3. 프론트엔드는 정적으로 빌드되어 GitHub Pages에 업로드되어 호스팅된다.
4. 데이터는 서버에서 받아와 출력해야 한다.
5. 서버는 Synology NAS에서 운영된다.
6. DBMS는 Docker(또는 Synology Container Manager의 project/compose 방식) 하에서 동작한다.
7. 웹페이지는 DB에 직접 접속하지 말고, 반드시 NAS 위의 백엔드 API 서버를 통해 정보에 접근해야 한다.
8. ORM, migration, validation, schema generation 등 현대적 개발 도구는 유지보수성과 생산성에 도움이 된다면 사용해도 된다.
9. 로그인 기능이 있어야 한다.
10. 로그인은 Google OAuth / Google Identity 기반이어야 한다.
11. 학교 도메인 메일 주소 사용자만 로그인 가능해야 한다.
12. 동영상은 YouTube만 사용한다.
13. 사진과 게임 파일은 무조건 Synology NAS에서 안전하게 호스팅되어야 한다.
14. 구현은 디자인보다 구조와 동작을 우선한다.
[추가 업로드/작품 자동 생성 요구사항]
15. 관리자 또는 권한이 있는 사용자에게 “작품 등록 업로드 기능”이 제공되어야 한다.
16. 업로드 폼에서 최소한 다음 정보를 입력/업로드할 수 있어야 한다.
   - 연도
   - 게임 제목
   - 작품 한 줄 소개 또는 설명(optional)
   - 참여 학생 이름
   - 참여 학생 학번
   - 포스터 이미지(대표 이미지)
   - 추가 이미지들(optional)
   - 게임 파일(optional, 배포 가능한 경우만)
   - YouTube 영상 URL(optional)
17. 사용자가 업로드 폼을 제출하면 다음이 자동으로 수행되어야 한다.
   - Synology NAS 저장소에 파일 저장
   - DB에 작품(Project) 레코드 생성
   - 참여 학생(ProjectMember) 레코드 생성
   - 업로드된 포스터/이미지/게임 파일의 Asset 메타데이터 생성
   - 해당 연도 페이지 목록에 자동 반영
18. 즉, “작품 등록”은 수동으로 DB를 직접 수정하는 방식이 아니라, 업로드 기능을 통해 완료되어야 한다.
19. 업로드 완료 후 작품 상세 페이지가 즉시 조회 가능해야 한다.
20. 기본적으로 새로 등록된 작품은 운영 안정성을 위해 `isPublished=false` 상태로 생성한 뒤, 관리자가 공개 전환할 수 있게 설계하는 것을 우선안으로 제안하라.
21. 단, 요구사항상 즉시 공개가 필요하다면 `autoPublish=true` 정책도 선택 가능하도록 구조를 설계하라.

[업로드 기능 설계 원칙]
1. 업로드는 반드시 백엔드 API를 통해 수행하라.
2. 브라우저가 NAS 파일시스템에 직접 쓰는 구조를 제안하지 마라.
3. 업로드 파일은 먼저 백엔드에서 검증한 뒤 NAS 저장소에 저장하라.
4. 업로드 중 일부 단계가 실패하면 DB와 파일 저장소 상태가 불일치하지 않도록 보상 처리 또는 트랜잭션에 준하는 흐름을 설계하라.
5. 하나의 작품 등록 요청은 “작품 메타데이터 + 멤버 목록 + 파일들”을 한 번에 처리할 수 있어야 한다.
6. 이름/학번은 여러 명 입력 가능해야 하며, 프론트와 API 모두 배열 구조로 설계하라.
7. 포스터는 대표 Asset으로 지정되어 목록 grid 카드에서 즉시 사용 가능해야 한다.
8. 파일명 충돌을 피하기 위해 원본 파일명 그대로 저장하지 말고, 내부 저장 키(storageKey)는 UUID 또는 해시 기반으로 생성하라.

[관리자 업로드 화면 요구]
최소한 다음 관리자 화면을 설계하라.
- /admin/projects/new
  - 연도 선택 또는 생성
  - 제목 입력
  - 설명 입력
  - 참여 학생 여러 명 추가/삭제
  - 포스터 업로드
  - 추가 이미지 업로드
  - 게임 파일 업로드
  - YouTube URL 입력
  - 저장 버튼
- /admin/projects/:id/edit
  - 기존 작품 수정
  - 포스터 교체
  - 이미지 추가/삭제
  - 게임 파일 교체/삭제
  - 공개 여부 전환

[DB 스키마 추가 요구]
기존 엔티티에 아래 개념을 반영하라.
- Project
  - posterAssetId(optional)
  - createdByUserId
  - status(draft|published|archived) 또는 isPublished
- ProjectMember
  - name
  - studentId
  - sortOrder
- Asset
  - kind(thumbnail|image|poster|game)
  - storageKey
  - originalName
  - mimeType
  - size
  - checksum(optional)
  - isPublic
  - uploadedByUserId
- UploadJob(optional)
  - 업로드 상태 추적이 필요하면 별도 엔티티로 제안 가능

[API 추가 요구]
최소한 아래 API를 추가 설계하라.
- POST /api/admin/projects/submit
  - 작품 메타데이터 + 멤버 목록 + 파일 업로드를 한 번에 처리
- POST /api/admin/uploads
  - 대용량 파일 업로드를 분리할 경우 사용 가능
- PATCH /api/admin/projects/:id/poster
  - 대표 포스터 교체
- POST /api/admin/projects/:id/members
  - 참여 학생 추가
- PATCH /api/admin/projects/:id/members/:memberId
  - 참여 학생 수정
- DELETE /api/admin/projects/:id/members/:memberId
  - 참여 학생 삭제
- DELETE /api/admin/assets/:assetId
  - 업로드 자산 삭제

각 업로드 관련 API에 대해 반드시 아래를 설명하라.
- multipart/form-data 사용 여부
- JSON + presigned-like 업로드 흐름 사용 여부
- 단일 요청 처리 방식과 단계별 처리 방식 중 무엇을 채택하는지
- 실패 시 롤백 또는 정리 방식
- 최대 파일 크기 제한
- 허용 확장자 및 MIME 검증 규칙

[자동 작품 생성 플로우]
작품 등록 시 다음 흐름을 기본안으로 설계하라.
1. 관리자 로그인 상태 확인
2. 입력값 validation
3. 파일 validation
4. 파일을 NAS 저장소에 저장
5. DB transaction 시작
6. Year 확인 또는 생성
7. Project 생성
8. ProjectMember들 생성
9. Asset 메타데이터 생성
10. posterAssetId 연결
11. commit
12. 성공 응답으로 상세 페이지 이동에 필요한 id/slug 반환
13. 프론트는 등록 완료 후 /projects/:id-or-slug 또는 /admin/projects/:id/edit 로 이동

[보안 및 운영 요구]
1. 업로드 가능한 파일 형식을 엄격히 제한하라.
2. 이미지와 게임 파일의 최대 용량 제한을 별도로 두어라.
3. 업로드한 실행 파일은 웹서버에서 임의 실행되지 않도록 단순 파일 저장/다운로드만 허용하라.
4. 업로드 디렉터리는 public static 경로와 분리하라.
5. 악성 파일 업로드, path traversal, content-type spoofing 방지를 고려하라.
6. 관리자 권한이 없는 사용자는 업로드 API에 접근할 수 없어야 한다.
7. 파일 삭제 시 DB와 스토리지 정합성을 유지하라.

[프론트엔드 동작 추가 요구]
1. 작품 등록 폼은 여러 명의 학생 이름/학번을 동적으로 추가/삭제할 수 있어야 한다.
2. 포스터 업로드 후 미리보기 기능이 있으면 좋지만, 필수는 아니다.
3. 업로드 성공 시 해당 작품이 연도 목록/상세에 반영되어야 한다.
4. 관리자 수정 후 public 데이터 재조회 또는 캐시 무효화 전략을 제안하라.

[출력 시 추가로 설명할 것]
- 업로드를 포함한 작품 등록 파이프라인 전체
- “작품 등록”과 “파일 저장”과 “공개 여부”를 어떻게 분리하는지
- 즉시 공개 방식과 검수 후 공개 방식의 장단점
- Synology NAS 볼륨 매핑 예시
- 업로드 파일 저장 디렉터리 구조 예시

[설계 원칙]
1. 프론트엔드와 백엔드를 강하게 분리하되, API 계약과 타입은 명확히 공유하라.
2. GitHub Pages는 정적 호스팅 전용으로 간주하고, 서버 렌더링 의존 기능을 프론트에 넣지 마라.
3. 브라우저에서 DB에 직접 접근하는 구조를 절대 사용하지 마라.
4. 인증, 권한 검사, 파일 접근 제어, 도메인 제한 검증은 모두 백엔드 책임으로 둬라.
5. 학교 도메인 제한은 프론트 표시용 옵션만으로 끝내지 말고, 백엔드에서 Google ID 토큰을 검증하고 허용 도메인을 다시 검사하라.
6. NAS 파일은 공용 폴더를 무차별 공개하지 말고, 공개 범위가 필요한 자산과 보호가 필요한 자산을 분리하라.
7. 썸네일/대표 이미지는 공개 URL 캐시를 허용할 수 있으나, 원본 이미지/게임 파일은 백엔드 승인 또는 만료형 다운로드 URL을 통해 전달하는 방향으로 설계하라.
8. 모든 외부 통신은 HTTPS 기준으로 설계하라.
9. 프론트와 API가 다른 origin이면 CORS, credentials, allowed origins를 정확히 설계하라.
10. 코드보다 먼저 “아키텍처 설명 → 데이터 모델 → API 명세 → 인증 흐름 → 파일 저장 전략 → 배포 구조 → 폴더 구조 → 구현 골격” 순서로 결과를 제시하라.

[권장 기술 방향]
- 프론트엔드:
  - React + TypeScript 기반
  - 정적 배포가 쉬운 구조
  - 라우팅, 상태관리, 데이터 fetching 캐시 라이브러리 사용 가능
- 백엔드:
  - Node.js + TypeScript 기반 REST API
  - 인증/인가/validation 분리
  - ORM 사용 가능
- DB:
  - PostgreSQL 우선 고려
- 파일 저장:
  - Synology NAS 내부 저장소
  - 파일 메타데이터는 DB에 저장
  - 실제 파일 경로는 백엔드에서만 해석
- 인프라:
  - Synology reverse proxy + containerized API/DB
  - GitHub Pages는 프론트 정적 결과물만 배포

[기본 권한 모델]
명시가 없으면 아래를 기본으로 설계하라.
- 공개 사용자:
  - 연도 목록 조회 가능
  - 연도별 작품 목록 조회 가능
  - 작품 상세 조회 가능
- 로그인 사용자(학교 도메인):
  - 본인 정보 조회 가능
  - 업로드 가능
- 관리자 또는 운영자:
  - 연도 생성/수정
  - 작품 생성/수정/삭제
  - 참여 학생 정보 수정
  - 썸네일/이미지 업로드
  - 게임 파일 업로드/교체
  - 공개 여부 전환

[필수 화면/라우트]
최소한 다음 라우트를 설계하라.
- /
  - 전시 소개 + 연도 목록 진입
- /years
  - 연도 목록
- /years/:year
  - 해당 연도 작품 grid
- /projects/:projectId 또는 /years/:year/:slug
  - 작품 상세
- /login
  - Google 로그인 진입
- /me
  - 로그인 상태/내 정보
- /admin/*
  - 관리자 기능 (구조만 제시해도 됨)

[연도 페이지 동작 요구]
- /years/:year 페이지는 그 해의 작품 목록을 서버에서 가져와 렌더링한다.
- 각 작품 카드는 최소한 다음을 가진다.
  - 대표 이미지(있다면)
  - 제목
  - 학생 이름 목록
  - 학번 목록
  - 자세히 보기 버튼
- 정렬 기준은 명시가 없으면 관리자 지정 순서 → 생성일 순서 보조 정렬로 설계하라.
- 빈 연도일 경우 “해당 연도 작품이 아직 등록되지 않았습니다” 상태를 제공하라.

[작품 상세 페이지 요구]
- 제목
- 한 줄 소개 또는 설명
- 참여 학생 목록(이름, 학번)
- YouTube 영상 임베드 URL
- 이미지 갤러리
- 게임 다운로드 버튼 또는 실행 파일 다운로드 섹션
- 공개 범위/접근 권한에 따른 다운로드 제어
- 관련 연도로 돌아가는 네비게이션

[인증/로그인 요구]
- 프론트는 Google 로그인 버튼을 제공한다.
- 로그인 성공 후 받은 credential 또는 ID token은 백엔드로 전달한다.
- 백엔드는 Google 토큰을 검증하고 사용자 정보를 생성/갱신한다.
- 허용된 학교 도메인 사용자가 아니면 로그인 실패 처리한다.
- 세션 방식은 아래 중 하나를 선택하고 이유를 설명하라.
  - HttpOnly secure cookie session
  - short-lived access token + refresh 전략
- 단, 브라우저 저장소에 민감한 장기 토큰을 무분별하게 저장하지 마라.
- 프론트에서 로그인 상태를 확인하는 /me 엔드포인트를 제공하라.

[파일 호스팅 요구]
- YouTube 영상은 DB에 YouTube URL 또는 videoId만 저장하고, 실제 영상 파일 업로드는 지원하지 마라.
- 이미지와 게임 파일은 Synology NAS 내부 저장소에 둔다.
- 파일 메타데이터는 DB에 저장하라.
- 실제 파일 제공 방식은 아래 원칙을 따르라.
  - 공개 썸네일: 캐시 가능한 정적/반정적 URL 가능
  - 보호된 원본 이미지: 백엔드 승인 후 제공 가능
  - 게임 다운로드 파일: 무조건 백엔드 통제 하에 다운로드시키는 방향 우선
- 디렉터리 listing 금지, 임의 경로 접근 방지, 파일명 충돌 방지, MIME/type 검증, size 제한, 확장자 화이트리스트를 고려하라.

[DB 설계 요구]
최소한 다음 엔티티를 제안하라.
- User
- Year
- Project
- ProjectMember
- Asset
- AuthSession 또는 RefreshToken(선택)
필요하면 아래 필드들을 포함하라.
- User: id, googleSub, email, name, role, createdAt, updatedAt, lastLoginAt
- Year: id, year, title(optional), isPublished, sortOrder
- Project: id, yearId, slug, title, summary, description, youtubeUrl, isPublished, sortOrder, createdAt, updatedAt
- ProjectMember: id, projectId, name, studentId, role(optional), sortOrder
- Asset: id, projectId, kind(image|thumbnail|game), storageKey, originalName, mimeType, size, checksum, isPublic, createdAt
스키마는 정규화와 운영 편의성의 균형을 맞춰라.

[API 설계 요구]
최소한 아래 REST API를 제시하라.
- GET /api/public/years
- GET /api/public/years/:year/projects
- GET /api/public/projects/:id-or-slug
- POST /api/auth/google
- POST /api/auth/logout
- GET /api/me
- GET /api/assets/:assetId
- POST /api/admin/years
- PATCH /api/admin/years/:id
- POST /api/admin/projects
- PATCH /api/admin/projects/:id
- DELETE /api/admin/projects/:id
- POST /api/admin/projects/:id/assets
각 API에 대해 다음을 작성하라.
- 목적
- 요청 파라미터
- 응답 타입
- 인증 필요 여부
- 실패 케이스
- 프론트에서 어떻게 사용하는지

[배포 구조 요구]
배포는 다음 구조를 기본으로 설계하라.
- GitHub Pages:
  - 프론트 정적 빌드 결과물 배포
- Synology NAS:
  - reverse proxy
  - API 컨테이너
  - PostgreSQL 컨테이너
  - 업로드 파일 저장 볼륨
가능하면 아래도 고려하라.
- 환경변수 분리
- dev / staging / production 구분
- DB backup
- 파일 백업
- migration 절차
- CORS origin allowlist
- rate limiting
- audit log 또는 최소한 관리자 변경 이력 고려

[결과 형식]
반드시 아래 순서로 답하라.
1. 전체 아키텍처 요약
2. 왜 이 구조가 요구사항에 맞는지 설명
3. 권장 기술 스택과 선택 이유
4. 프론트엔드 구조
5. 백엔드 구조
6. DB 스키마 초안
7. API 명세 초안
8. 인증 흐름
9. 파일 저장/다운로드 보안 전략
10. Synology + GitHub Pages 배포 구조
11. 폴더 구조 예시
12. 구현 우선순위
13. 최소 동작 MVP 범위
14. 이후 확장 포인트

[출력 품질 규칙]
- 디자인 미사여구 금지
- 구조적이고 실무적인 설명
- 추상적인 말 대신 실제 라우트명, 엔드포인트명, 엔티티명, 환경변수명 예시를 제시
- “브라우저가 DB에 직접 요청하는 구조”를 제안하지 마라
- “NAS 공유폴더를 그냥 공개 링크로 때우는 구조”를 기본안으로 제안하지 마라
- “학교 도메인 제한을 프론트에서만 검사하는 구조”를 제안하지 마라
- 구현 시 프론트와 백엔드의 계약(interface/schema)을 먼저 정의하는 방향으로 작성하라