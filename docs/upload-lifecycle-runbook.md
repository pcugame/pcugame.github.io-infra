# Upload lifecycle deployment runbook

The upload-lifecycle migration introduces database claims that old API processes do
not understand. Use this order for production deployment:

1. Deploy the Web client first. The old API safely ignores `Idempotency-Key`.
2. Drain every old API instance so old and new upload writers never serve traffic
   at the same time.
3. Apply the Prisma migration, then start only the new API version. Its periodic
   maintenance worker owns stale completion, expired session, upload-intent,
   multipart-abort, and untracked-multipart recovery.
4. Wait at least 60 minutes after the final API replacement before running
   `reconcile-orphans.ts --apply`. Reconcile is dry-run by default; review a dry-run
   before every apply run.

Configure the S3-compatible bucket lifecycle to expire incomplete multipart uploads
after an operator-approved retention period. This is defense in depth for uploads
that die before an `uploadId` reaches PostgreSQL; it does not replace the application
abort-task worker or its alerting.

During rollback, do not restore an old writer while the new schema's claim workers
are active. Stop and drain the new API first, disable maintenance, and only then
switch traffic. Preserve `upload_intents`, `multipart_abort_tasks`, and
`orphan_objects`; deleting those tables or rows can turn recoverable objects into
untracked storage residue.
