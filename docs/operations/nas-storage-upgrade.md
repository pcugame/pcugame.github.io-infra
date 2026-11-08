# NAS storage security upgrade

The application release workflow does not deploy the NAS Garage or nginx
containers. A NAS-only manual cutover needs an explicit release-process exception
under `AGENTS.md`; requesting an ordinary release does not waive its gates.
This document records the prepared operation, not a completed deployment.

## Exact images

- Garage: `dxflrs/garage:v2.5.0@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5`
- Gateways: `nginx:1.30.6-alpine@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311`

The local Compose stack, integration stack, Garage init binary and nginx fixtures
use these same images. Garage 2.5.0 restricts lifecycle configuration to bucket
owners. Its release notes prohibit downgrading migrated metadata to an older
binary. The v2 administration API differs from v1; application storage operations
use S3 and the initialization scripts use the CLI.

## Existing evidence (2026-11-08)

On the NAS, `~/garage-validation-20261108/validation-summary.json` records:

- An offline full Garage backup (configuration, identity, metadata including WAL,
  and object blocks), with all 77,542 files / 79,280,775,205 bytes SHA-256 matched.
- Original-version restore followed by 1.1.0 to 2.5.0 migration on an isolated
  copy, using Docker network isolation and no published ports.
- Unchanged inventories for 1,653 public and 774 protected objects; matching
  content hashes for 40 sampled S3 objects, plus multipart upload, GET, HEAD,
  Range and delete checks, and SQLite quick_check.
- Removal of the temporary test key and bucket from the migrated copy.

The backup is a Btrfs reflink copy on the same NAS, not an offsite backup. It does
not include the application's PostgreSQL database. Full object reads through
S3 and authenticated application end-to-end workflows were not performed. Keep
the pristine backup separate from the migrated test copy; never deploy the test
copy as production. A future cutover must confirm the originals remained stopped
since this backup or take and verify a fresh backup.

## Prepared NAS-only cutover

1. Review the task PR and required checks. Record the merged source SHA and any
   explicitly authorized exception, including which normal release gates it
   replaces. Do not trigger an unrelated Web/API release to update the NAS.
2. Preserve both existing Compose files and runtime inspection data. Prepare
   candidate files that change only the Garage image and the three gateway
   images. Keep original project directories, environment files, mounts,
   network aliases and credentials. Validate Compose without printing secrets.
3. Pull the exact digests. Verify the stopped original containers, backup
   manifest and available capacity. Record a migration-attempt marker before
   starting Garage with the new binary against its original production mounts.
4. Recreate only the Garage service with `--no-deps`, check its version, layout,
   health and existing bucket inventory. Recreate only the three gateway
   services after Garage is healthy; validate their generated nginx configuration.
5. Check real public image GET/HEAD, conditional and Range responses. Check
   protected download and upload behavior through the API where authorized
   credentials are available. A rejection response alone is not a successful
   authenticated flow test. Record any untested boundaries.
6. Record source SHA, all running image identities, service health and public
   response evidence. Keep the original backups and migration receipt.

After migration is attempted, do not automatically start Garage 1.1.0 against
migrated metadata. Diagnose while preserving evidence and prefer a forward fix.
Restoring the pre-upgrade backup is a separate recovery decision that must account
for any writes since cutover; it restores configuration, node identity, metadata
and object state together. Do not alter Web/API binaries as part of this NAS task.

References: [Garage 2.5.0 release notes](https://git.deuxfleurs.fr/Deuxfleurs/garage/releases/tag/v2.5.0),
[Garage v1 to v2 migration](https://garagehq.deuxfleurs.fr/documentation/working-documents/migration-2/),
[nginx security advisories](https://nginx.org/en/security_advisories.html).
