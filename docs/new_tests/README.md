# New Test Coverage Plan

This directory tracks the larger test-coverage work that should be split across
multiple implementation passes. Each ticket is intended to be independently
reviewable and should finish with the relevant workspace tests passing.

## Execution Order

1. `001-contracts-and-test-infra.md`
2. `002-api-admin-crud-and-access.md`
3. `003-api-upload-and-assets.md`
4. `004-api-auth-import-export-public.md`
5. `005-web-clients-hooks-and-submission.md`
6. `006-web-pages-admin-and-public.md`
7. `007-integration-smoke-expansion.md`

## Commands

- Contracts: `npm test -w @pcu/contracts`
- API: `npm test -w apps/api`
- Web: `npm test -w apps/web`
- All unit tests: `npm test`
- Docker smoke: `npm run test:integration`

## Completion Criteria

- New tests are behavior-focused and avoid snapshot-only coverage.
- Tests use existing Vitest/Fastify/Testing Library patterns before adding new tools.
- Any production refactor needed for testability is kept small and documented in the ticket.
- Existing dirty worktree changes are preserved.
