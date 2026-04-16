# DB Migration Guide

이 프로젝트는 Prisma `@@map`/`@map`으로 모델명과 실제 DB 테이블/칼럼명이 다르다.

```
Prisma Model      →  DB Table            예시 칼럼
ProjectMember     →  project_members     studentId → student_id
GameUploadSession →  game_upload_sessions
```

## 스키마 변경 시

```bash
# 1. schema.prisma 수정
# 2. 마이그레이션 자동 생성 (Prisma가 올바른 이름으로 SQL 생성)
npx prisma migrate dev --name 변경_설명
# 3. 커밋 & 푸시 → CI가 프로덕션에 prisma migrate deploy 실행
```

## 데이터 마이그레이션

스키마가 아닌 데이터 변환(더미값 치환 등)은 seed 스크립트로 처리한다.
마이그레이션 SQL에 넣지 말 것.

## 금지 사항

- **migration.sql 직접 작성 금지** — @@map 불일치로 프로덕션 장애 발생 전례 있음 (2026-04-16)
- **빈 마이그레이션 디렉터리 커밋 금지** — prisma migrate deploy 크래시
- **로컬에서 `prisma db push`만 사용 금지** — 마이그레이션 히스토리 불일치

## 리셋

```bash
# 로컬
npx prisma migrate reset --force

# 프로덕션 (DB volume 삭제 후 deploy.sh up)
```
