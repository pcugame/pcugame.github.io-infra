# Upload lifecycle deployment runbook

The upload-lifecycle migration introduces database claims that old API processes do
not understand. Use this order for production deployment:

1. Deploy the Web client first. The old API safely ignores `Idempotency-Key`.
2. Drain every old API instance so old and new upload writers never serve traffic
   at the same time.
3. Apply the Prisma migration, then start only the new API version. Each
   `BackendContext` owns exactly one `UploadLifecycleRuntime`; its startup,
   periodic maintenance, wake coalescing, abort signal, and shutdown drain cover
   orphan deletion, stale completion, expired sessions, upload intents,
   multipart-abort tasks, and untracked-multipart recovery.
4. Wait at least 60 minutes after the final API replacement before running
   `reconcile-orphans.ts --apply`. Reconcile is dry-run by default; review a dry-run
   before every apply run.

GitHub Actions expresses this ordering only for releases that need it. Add an
immutable declaration under `.github/release-gates/web-before-api/` in the same
compatibility-breaking change. That declaration triggers both component workflows,
and the API deploy job waits for a successful Web deployment of the exact push SHA
and for the production Pages endpoint to serve that SHA from `release-sha.txt`
before opening the SSH deployment channel. The declaration affects only the push
that adds or changes it; later independent API or Web changes remain independent.

For a manually staged compatibility release, dispatch the Web workflow for the
target ref first, then dispatch the API workflow for the same ref with
`require_web_first=true`. The default `false` preserves independent manual API
hotfixes. Do not select the independent path for a contract-breaking API release.

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
