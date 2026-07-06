# 005 - Web Clients, Hooks, And Submission

## Goal

Cover browser client utilities and submission hooks that currently drive critical
user flows without direct tests.

## Work

- API client: JSON body, FormData body, envelope unwrap, 204, structured errors,
  text fallback, `getApiErrorCode`, `getApiErrorMessage`.
- XHR upload client: no-file behavior, upload progress, processing state, success,
  error, abort, network failure.
- Game upload client: create/status/list/cancel requests, chunk retry/backoff,
  resume, progress reporting, abort, finalize failure.
- Submission hooks: user/admin default member, upload-locked exhibition, admin
  userId linking, query invalidation, navigation, game-file progress transition.
- File hook: preview URL lifecycle, clear handlers, oversized image/video/game
  rejection, appended video behavior.

## Acceptance

- `npm test -w apps/web` passes.
- Fetch/XHR mocks are deterministic and reset after each test.
- Hook tests use a small QueryClient/router wrapper.
