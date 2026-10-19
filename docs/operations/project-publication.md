# Project publication

`Project.publicationStatus` is the access decision. New projects are PRIVATE. Upload session,
submission and placement-job states describe processing, independently of publication.
The legacy status/visibility fields remain for wire compatibility; writes through those fields
are translated to the same publication command and cannot bypass readiness.

PUBLIC requires a title, participants, nonblank summary, platform, verified poster derivatives,
verified native game and a video with READY playback. WebGL does not substitute for a native game.
Only ADMIN can waive content requirements, with a nonblank reason. The same transaction records
actor, project version and waived requirements in `publication_exceptions`; file validation and
write permission are still enforced. Bulk publication has no exception option.

The editor saves information, processes selected files, then requests publication. A pending
placement job does not expose private bytes. Completion rechecks the request version, actor and
current files. Unpublishing or stopping uploads clears the request. File completion alone cannot
publish a project. Required content on a public project must not deteriorate; unpublish before
explicitly removing it. A replacement is uploaded before the queued old asset is deleted.

Stopping uploads preserves the project ID and completed assets. Failed/abandoned manifest entries
and storage cleanup references remain as history. Recovery navigates to the saved editor; lost
create responses replay the persisted idempotency key and exact request. An explicit duplicate-title
choice is required to create another project with the same author, exhibition and title.

## Rollout and recovery

Follow [the deployment runbook](deployment.md). This change does not authorize a release.
Drain old API and publication workers at cutover: old binaries do not understand PRIVATE and must
not serve requests against the expanded schema. Deploy the reviewed merged revision and verified
immutable image, including the publication worker. Old Web clients may remain cached; the new API
routes their legacy writes through the publication policy.

The additive `20261019000000_project_publication_expand` migration preserves existing public and
archived publications (excluding STAFF visibility) and records them as LEGACY, separately from ADMIN
exceptions. It hides historical DRAFT/CANCELLED projects from management lists and counts, preserving
submission and storage records. It does not delete or merge projects. Existing public projects retain
missing requirements, but cannot lose requirements they already satisfy. After unpublishing, normal
readiness or a new ADMIN exception is required to publish again.

Do not restore old binaries after migration. Use the deployment runbook's forward recovery process.
The migration is transactional; PostgreSQL tests inject failure before COMMIT and verify rollback
of both DDL and data before retrying it. Prisma migration history controls normal replay.

## Reviewed empty-project transition

Run from `apps/api` in the reviewed source environment with the intended database configuration:

```sh
npx tsx scripts/transition-project-publication.ts preview publication-transition.json
npx tsx scripts/transition-project-publication.ts apply publication-transition.json
```

Preview creates a new manifest without overwriting an existing file. Only IDs 214 and 215 with no
asset, deployment or upload references qualify. Inspect the manifest before applying. Application
locks each project and compares version, update time, publication state, title and references again.
A changed or repaired project is skipped. Reapplication reports `already-applied`; audits and files
are retained. Neither command has been executed against production as part of implementation.

## Verification

The publication PostgreSQL HTTP suite covers authenticated empty/populated serialization, role
checks, ADMIN exceptions, duplicate/idempotent creation, version conflicts, required-file deletion,
legacy preservation, hidden cancellation records, worker/unpublish races and conditional transition
replay. File-access tests check raw paths and previously issued anonymous playback grants after
unpublishing. Existing submission tests exercise immutable placement, cancellation and generation
fences with explicit audited fixture exceptions.

Browser QA uses the mock backend, desktop/mobile layouts and light/dark CSS tokens. The current
application's theme switch remains disabled by existing product policy. Nginx/Garage end-to-end
behavior is covered by the integration CI rather than claimed from mock-browser QA.

Existing per-project file-count limits remain. At the five-video limit, a queued upload-before-delete
replacement will be rejected by capacity validation; explicitly remove an extra video in a separate
save first (the server still refuses removal of the last playable required video while public).
