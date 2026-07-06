# 002 - API Admin CRUD And Access

## Goal

Cover admin CRUD and access behavior that is currently only partially protected
by list-route tests.

## Work

- Exhibition routes/services: list, create duplicate, update, delete, poster
  replace/delete, role gates.
- Project routes/services: detail access, update, delete, set poster, bulk status,
  bulk delete, status transition restrictions.
- Member routes/services: add, update profile fields, delete, swap order, injected
  userId rejection.
- Settings and banned IP routes: valid/invalid patches, list, unban, in-memory ban
  cache removal.

## Acceptance

- `npm test -w apps/api` passes.
- Route tests use Fastify `inject`; service tests mock repositories/storage.
- Unauthorized and forbidden cases are covered where behavior differs by role.
