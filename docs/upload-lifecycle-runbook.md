# Upload lifecycle deployment runbook

The API and worker image never runs `prisma migrate deploy` as a startup side
effect. Pushes build and publish an OCI-revision-labeled image, and the build
summary exposes its immutable registry digest. Production release commands accept
that `@sha256` digest only; the mutable `latest` convenience tag is never release
authority. Schema changes use the protected **Authorized API Schema Cutover**
workflow and its `production` environment approval.

## Canonical asset Phase 1 (expand)

Provide the immutable `@sha256` Phase 1 API/worker image, its exact 40-character
source commit as `phase1_source_sha`, and dispatch `phase1`. Mutable tags,
including `sha-*`, are rejected. The pulled manifest digest must equal the input
digest and its OCI `org.opencontainers.image.revision` label must equal the
attested source commit before any mutation process is stopped.
The same image is used for API, workers, expand migration, backfill, inventory,
and reconciliation. It must execute `dist/phase1-release-manifest.js` and print
exactly `PCU_PHASE1_RUNTIME_V1`; this and the five Phase 1 worker entries are
verified before the current deployment is stopped. Phase 1 deliberately does not
start the project-publication worker and keeps the master-compatible
`projects.status = PUBLISHED` default. Keep the existing legacy-compatible web
deployed throughout the observation window. The workflow
performs, in order:

1. drain API and every worker while leaving PostgreSQL online;
2. write a legacy-row audit, a PostgreSQL custom-format backup plus SHA-256, and a
   Garage object/multipart inventory snapshot;
3. verify the master migration baseline and apply only the expand migration;
4. start the Phase 1 API/workers, then drain them for a dry-run and resumable apply
   backfill;
5. take a new Garage inventory and verify reconciliation (only the newly reset
   24-hour fallback-observation window may remain blocked);
6. restart Phase 1, verify canonical-first reads, and persist the exact observation
   start in `cutover-state/phase1-observation`.

Backfill progress, failures, and reports live under `cutover-state/`. Do not delete
them between retries. The compiled CLI is idempotent and resumes from its progress
file; do not use the TypeScript source runner in production.

## Canonical asset Phase 2 (contract)

After at least 24 hours with zero fallback telemetry, dispatch `phase2` with the
final API/worker `@sha256` digest from the exact contract commit. Do not publish
the final web first. The protected cutover workflow verifies the final artifact,
drains API and all workers, takes the backup and inventory, then builds, tests,
stamps, and publishes the final web from its own `GITHUB_SHA` while mutations
remain drained. Only that same authorized workflow execution may proceed to the
web marker gate, contract preflight, destructive DDL, final runtime, and smoke.
Its root
`release-sha.txt` must contain exactly the 40-character commit SHA followed by one
LF. The server rejects redirects, HTML/error bodies, added whitespace, wrong
lengths, non-200 responses, and responses that exceed the five-second timeout.
The workflow retries this exact check for at most five minutes to allow Pages
publication to converge; expiry leaves the API/workers drained and does not apply
the contract.
Both this workflow and the standalone **Deploy Web to GitHub Pages** workflow use
the repository-wide `production-object-cutover` concurrency group with
`cancel-in-progress: false` and the production environment approval. Therefore a
standalone publication cannot replace `release-sha.txt` between exact-SHA
verification and contract DDL. Contract preflight and destructive DDL remain
blocked until the marker matches.

Both production workflows fail unless they run in
`pcugame/pcugame.github.io-infra` from its exact `master` default branch. Before
publishing, they also query the GitHub API and fail closed unless
`pcugame/pcugame.github.io` is active with `master` as its default branch and
classic branch protection restricts pushes to one actor. Configure the repository
variable `PAGES_DEPLOY_ACTOR` to the login owning `PAGES_DEPLOY_TOKEN`; that token
must be able to read repository/branch-protection metadata and publish contents.
Protection must apply to administrators, forbid deletion, allow the sole actor's
force publication, and contain exactly that user with no team or app push actor.
This is required because the external Pages repository does not share this
repository's workflow concurrency lock.

Then copy the exact server-side
`read_cutover_at` value into the Phase 2 workflow input and enter
`I_ATTEST_24H_ZERO_FALLBACK`. The workflow rejects timestamps under 24 hours, stale
attestations, or values that differ from the server record. After any production
environment approval delay, the server re-reads the record and recomputes the age
from its own clock immediately before drain; it accepts only 24 hours through 31
days. It then drains again,
takes another DB backup and Garage snapshot, runs the object-aware contract
preflight, applies the contract, verifies its durable `_prisma_migrations` record,
and starts the Phase 2 runtime with all six workers, including project
publication. The contract changes the project default to `DRAFT` only after the
final web has been verified; a Phase 1 observation can therefore never expose the
new submission lifecycle to an incompatible web build.

The Phase 1 observation record stores both `phase1_api_image` and
`migration_image`, their resolved digests, the local image ID, and the OCI source revision. Recording
fails unless API and migration references are identical, and Phase 2 checks both
reference and resolved-digest equality again before draining. It also requires
the currently running Phase 1 API to retain that exact image ID and source label.
`--reset-observation` atomically zeroes every
existing non-empty compatibility metric scope and refreshes its observation time,
while also ensuring a `scope=''` seed exists for every known producer. A stale or
nonzero scope therefore cannot survive reset unnoticed.

The contract is a destructive DDL boundary. After it is recorded, old-image
automatic rollback is forbidden even if health or smoke tests fail. Recover with a
forward fix, or with an explicitly authorized PostgreSQL backup restore followed
by Garage state reconciliation. The workflow permits an old-image rollback only
when the additive Phase 1 runtime fails before contract. A fresh database, a
master-only database, or a mismatched runtime/schema phase fails closed.
For a corrected image after this boundary, dispatch `phase2-forward-fix` with
`I_ACKNOWLEDGE_CONTRACT_FORWARD_FIX`; that path first verifies the contract's DB
record and never executes legacy preflight code or an old-image rollback.

The sole pre-contract rollback is also identity-fenced. Immediately after the
Phase 1 artifact preflight, the workflow records the currently running API image
ID and a random cutover nonce in a mode-0600 server file. A rollback must present
that nonce and resolve its local convenience tag to the exact recorded image ID;
the authorization is atomically consumed before replacement begins and deleted
after success. A forged or retargeted `rollback-*` tag has no authority, and a
consumed nonce cannot be retried.

Final smoke tests exercise the NAS public origin with GET, HEAD, 304, 206, and 416,
then repeat the byte checks while the Fastify API container is stopped. This proves
public bytes do not depend on the control plane.

Protected downloads use a distinct browser origin configured by
`S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT`. The API authorizes the request and
issues a short-lived GetObject capability, but never relays object bytes. The NAS
protected-download proxy preserves the escaped path, signed Host, SigV4 query,
Range, and conditional headers while accepting only GET/HEAD object paths under
the exact protected bucket. It logs no query parameters and marks successes and
errors `private, no-store`. A capability issued before an API outage continues to
work directly through this proxy only until its signed TTL; new capability
issuance still requires the API. Keep this origin distinct from internal Garage,
UploadPart, the public website origin, Garage admin, and raw NAS filesystems.

Configure the S3-compatible bucket lifecycle to expire incomplete multipart uploads
after an operator-approved retention period. This is defense in depth for uploads
that die before an `uploadId` reaches PostgreSQL; it does not replace the application
abort-task worker or its alerting.

During rollback, do not restore an old writer while the new schema's claim workers
are active. Stop and drain the new API first, disable maintenance, and only then
switch traffic. Preserve `upload_intents`, `multipart_abort_tasks`, and
`orphan_objects`; deleting those tables or rows can turn recoverable objects into
untracked storage residue.

## Worker and request-path expectations

Business transactions commit pointer changes and their deletion/abort outbox rows
atomically. After commit, request handlers only call the context-owned wake method;
they do not wait for the global backlog. Repeated wakes are coalesced into one
active worker and at most one pending pass. Worker failures are emitted through the
context logger and retried by later wakes or the periodic maintenance schedule.

Persisted ownership leases use the PostgreSQL clock as their sole source of
truth. Claim, active-lease checks, renewal, takeover, and token-fenced final
mutations must compare against `clock_timestamp()`, and lease deadlines must be
derived as database time plus a duration in the same statement or transaction.
Application `Clock` values remain valid for business TTLs, retry/backoff
scheduling, and observations, but must never decide whether a persisted owner is
still active. Consequently, changing an API process clock must neither steal nor
revive an upload-intent, multipart-abort, idempotency, game-upload part,
game-upload completion/recovery, or orphan-deletion lease.

An expired token is stale even when no replacement owner has claimed the row
yet. Renewal and every token-owned final mutation must fail closed after database
expiry. Operators must not clear or extend lease columns manually to recover a
worker; allow the normal PostgreSQL-time takeover path to fence the previous
token or generation.

Orphan and upload-intent workers claim at most 50 rows and collect one immutable
reference inventory for the entire claimed batch. A malformed WebGL pointer makes
the affected buckets fail closed. Do not bypass this check to clear a backlog;
repair the pointer first and allow a later worker pass to converge.

## Critical untracked multipart cleanup failure

Alert on either of these context-local signals:

- log event `untracked_multipart_cleanup_unrecoverable` at fatal level;
- `untrackedMultipartCleanupFailureCount()` increasing above zero.

This event means a newly created multipart upload could neither be aborted in
object storage nor recorded in `multipart_abort_tasks`. The originating request is
failed and its `key`, `uploadId`, `reason`, storage error, and database error are
preserved in the log event. Treat it as storage residue with no application queue
record:

1. Record the exact bucket, key, and upload ID from the fatal event.
2. Restore PostgreSQL and object-storage connectivity before retrying cleanup.
3. Abort that exact multipart upload using the storage administration interface,
   then verify it no longer appears in the multipart listing.
4. If an immediate abort is unsafe or unavailable, insert an operator-reviewed
   durable abort task for the exact target and verify the maintenance worker claims
   it. Do not substitute a broad prefix deletion.
5. Correlate the failed HTTP mutation and confirm that no session/pointer row was
   committed for the untracked upload.

Prompt abort failures logged with
`tracking=durable-abort-task-committed` are different: the repository transaction
already committed the exact durable abort task. Verify the task remains queued and
the worker is progressing; those failures do not by themselves invalidate the
already committed business response.
