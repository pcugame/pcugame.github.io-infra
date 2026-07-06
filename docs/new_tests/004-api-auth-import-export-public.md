# 004 - API Auth, Import, Export, Public

## Goal

Cover authentication, import/export, and public-facing API behavior beyond the
existing narrow smoke checks.

## Work

- Auth: Google success, invalid payload, hosted-domain mismatch, name cleanup,
  studentId extraction, logout, `/api/me` authenticated/anonymous.
- Import: multipart extraction, JSON type/size errors, preview existing/new
  exhibitions, execute transaction, slug collisions, invalid project/member data.
- Export: progress transitions, result shape, missing assets, storage failures.
- Public: year/exhibition listing edge cases, detail not-found, archived/published
  filtering, poster redirect registration.

## Acceptance

- `npm test -w apps/api` passes.
- External Google and storage calls are mocked.
- Transaction behavior is covered at service level or in Docker integration.
