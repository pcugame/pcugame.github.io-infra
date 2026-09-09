# Master and production source alignment

`master` is the source for the currently supported Phase 1 runtime. Changes go
through a task PR, review and the existing PR checks before merging. The existing
API build workflow publishes and verifies the immutable image for that commit.
The existing **Update Phase 1 Runtime** CD workflow accepts only the exact
`master` commit used to dispatch it. A task-branch build is not a production
release authorization.

## Integration decisions (2026-09-09)

The earlier `582c9f8` merge recorded the Phase 1 branch as an ancestor but changed
only three files. Its resulting application tree still used the Phase 2 runtime.
This integration restores the reviewed Phase 1 application, web, contracts and
corresponding tests from deployed source `babf7bd1c50db2f514b90dea5c06ac3816550dad`.
It includes ordered videos, document/attachment uploads, canonical correction,
verified original-URL compatibility and the administrator response-serialization
fix. Source selection is deliberate; merge ancestry alone is not evidence of
runtime equivalence.

The existing master release workflows, release controls, protected download
proxy, security checks and historical migration files are retained. Temporary
image-staging workflows and the separate materials deployment script are not
imported. Materials support uses the existing additive Phase 1 CD path.

All existing migration SQL remains byte-identical. The video-order and material
migrations (`218`, `219`, `2191`) are additive. The `220` contract SQL remains in
Git for review and history, but is excluded from the Phase 1 image. The Phase 1
release CLI rejects contract application and Phase 2 runtime assertions. Do not
run unbounded `prisma migrate deploy` from the repository against production;
use the existing fenced release command through CD.

## Preserved work

- `preserve/phase2-canonical-materials` preserves the original working tree,
  including uncommitted Phase 2 materials and correction changes. It requires a
  separate reviewed transition; it is not the production release source.
- PR **#42**, `fix/d3-upload-source-identity`, remains pending. Its legacy-session
  migration cancels/fails in-flight sessions and needs a separate compatibility
  decision. It is not safely interchangeable with the current direct-upload
  source-identity implementation.
- `archive/pre-alignment-master-20260909` preserves the previous master snapshot.
- `archive/production-phase1-20260909` preserves the exact deployed source.
- `archive/abandoned-transfer-control-20260909` preserves the alternate,
  pre-canonical control-plane implementation; its session cleanup migration is
  intentionally excluded.
- `archive/superseded-widget-work-20260909` preserves the former dirty widget
  worktree, whose behavior is covered by the later recovery state machine.
- `archive/retired-stage-workflow-20260909` preserves the temporary staging
  workflow for audit only. It is not a supported deployment route.

Finished branches are removed only after ancestry, patch equivalence or an
explicit source disposition has been checked. Unique work is retained by the
refs above; the source working tree is not reset to make branch counts match.

## Deployment status

At integration preparation, production runs source
`babf7bd1c50db2f514b90dea5c06ac3816550dad`, image
`ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:051af32a9117ea63b36969f5c12b1b7cc65696f939a92232386968ab96af1266`.
Web source is `68a1519edb1da4cc019930767b0ca43b1308ca22` (Pages commit `aec70a6`).
The Phase 1 observation record began at `2026-09-09T06:38:04Z`.

Merging this integration and building its image does not itself redeploy the
application or execute Phase 2. A later deployment must use the established CD
workflow and record its actual source, digest and verification separately.

## Transitional architecture and migration evidence

The architecture gate retains its Phase 2 rules. A Phase 1 compatibility
inventory records only the existing byte/processing call nodes independently
matched to deployed `babf7bd`: exact file, rule, node hash and occurrence count.
It activates only with the Phase 1 marker; changed/new/duplicate edges and stale
inventory entries fail. Remove this inventory with the legacy multipart paths
when a separately reviewed Phase 2 runtime is integrated.

A read-only comparison with production found two historical checksum exceptions,
neither introduced by this integration. Migration `20260523_remove_draft_project_status`
has the literal receipt `manual`, so cryptographic identity cannot be asserted
for that receipt. Its Git SQL is unchanged between master and deployed source.
Migration `20260821400000_project_submission_draft_status` has comment-only drift
introduced on master by `5f89200`; production matches the original/deployed text
and the executed `ALTER TYPE` statement is identical. This integration rewrites
neither migration history nor database receipts.
