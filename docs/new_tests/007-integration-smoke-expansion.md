# 007 - Integration Smoke Expansion

## Goal

Expand Docker smoke tests so the full API/web/storage/database stack catches
contract regressions that unit tests intentionally mock.

## Work

- Keep the current health, web root, public years, dev login, `/api/me`, and
  public asset redirect checks.
- Add admin exhibition create/update/delete flow.
- Add multipart project submit with small poster/image and verify admin list plus
  public detail.
- Add protected asset access checks for anonymous, owner, and admin where seeded
  data allows.
- Add import preview/execute with a tiny JSON payload.
- Add small ZIP chunk upload create/upload/complete using Garage.

## Acceptance

- `npm run test:integration` passes on a clean Docker environment.
- Smoke failures print the failing endpoint and status/body.
- Scenarios stay fast enough for local pre-release validation.
