# PCU Graduation Project V2

배재대학교 졸업작품 전시 사이트 모노레포입니다.

## Current Status

> [!WARNING]
> 이 저장소는 현재 **코드 공개 목적**으로 먼저 열어 둔 상태입니다.
> 운영용 데이터베이스가 아직 완성되지 않아 **메인 페이지를 포함한 일부 화면에서 오류가 발생할 수 있습니다.**
> 즉, 현재 공개 상태는 "서비스가 완전히 정상 동작한다"는 의미가 아니라
> "코드와 구조를 먼저 공개한다"는 의미에 가깝습니다.

### Known Limitation

- 현재 DB 상태가 미완성이므로 실제 API 응답 기준으로는 메인 페이지가 정상 렌더링되지 않을 수 있습니다.
- 이 이슈는 프론트엔드 레이아웃 자체보다 데이터 준비 상태의 영향이 큽니다.
- UI 확인이 목적이라면 `apps/web`의 mock 모드로 확인하는 편이 낫습니다.

## TODO

현재 공개 저장소 기준으로 우선 정리해야 할 작업은 아래 문서에 기록해 두었습니다.

- [Repository TODO](docs/TODO.md)

## Repository Layout

- `apps/api`: Fastify + TypeScript + Prisma API
- `apps/web`: React + Vite + TypeScript web app
- `apps/db`: 보조 DB 스크립트와 예시 데이터
- `server`: 운영 보조 스크립트와 레거시 예시 데이터
- `.github/workflows`: 배포 워크플로

## Local Development

### API

```bash
cd apps/api
npm install
npm run dev
```

### Web

```bash
cd apps/web
npm install
npm run dev
```

### Web Mock Mode

DB 상태와 무관하게 화면 확인이 필요하면:

```bash
cd apps/web
npm install
npm run dev:mock
```

## Quality Checks

```bash
cd apps/api && npm test && npm run lint
cd apps/web && npm test && npm run lint
```

## Contributions

- 변경 사항이 있으면 브랜치를 pull 받은 뒤 수정해서 PR로 보내 주세요.
- PR을 올리면 확인하겠습니다.
- 더 빠른 확인이 필요하면 Instagram `@gluemylifeplease` 로 연락해 주세요.
- 오프라인으로는 `C302호`에 와서 `송지한`을 찾아도 됩니다.

## Before Opening An Issue

- 현재 DB 미완성으로 인해 발생하는 메인 페이지 오류인지 먼저 확인해 주세요.
- 데이터 준비 상태와 무관한 코드/구현 문제라고 판단될 때 이슈를 열어 주세요.
