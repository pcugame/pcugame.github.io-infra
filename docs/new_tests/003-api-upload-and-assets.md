# 003 - API Upload And Assets

## Goal

Cover upload and asset lifecycle paths that interact with temp files, S3, and
chunk sessions.

## Work

- `UploadPipeline`: success, validation failure, upload failure rollback, temp
  cleanup, playback upload failure cleanup.
- Asset deletion: mark deleting/deleted, poster clearing, playback deletion,
  not-found handling.
- Game upload session lifecycle: create size limits, upload-disabled exhibition,
  draining state, replaced session abort, complete missing chunks, duplicate
  completion, invalid ZIP, size mismatch, cleanup after failed completion.
- Image/PDF processing: supported conversion path and error translation using
  small fixtures or mocks.

## Acceptance

- `npm test -w apps/api` passes.
- File-system tests write only temp files and clean them up.
- S3/storage behavior is mocked except in Docker integration tests.
