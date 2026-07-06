# 001 - Contracts And Test Infrastructure

## Goal

Give `@pcu/contracts` its own test entrypoint and reduce duplicated setup across
API and Web tests.

## Work

- Add `test` script to `packages/contracts/package.json`.
- Add schema tests for enums, project payloads, exhibition payloads, bulk actions,
  auth payloads, and game-upload session creation payloads.
- Keep API/Web schema tests as alignment tests only where server/client behavior
  intentionally differs through coercion or additional validation.
- Add or extend shared helpers only when at least two tests use the same setup.

## Acceptance

- `npm test -w @pcu/contracts` passes.
- `npm test` includes the contracts workspace.
- No public contract shape changes unless explicitly required by failing tests.
