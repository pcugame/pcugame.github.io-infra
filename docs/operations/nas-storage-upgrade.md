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

## Restart after NAS reboot or package update

Garage and the three NAS gateways use `restart: always`. Docker restarts these
containers when its daemon starts, including containers explicitly stopped before
the daemon restart. `unless-stopped` preserves that stopped state instead.
The inspected Container Manager 24.0.2-1707 startup script also includes containers
with an `always` policy in its saved automatic-start list, and the package is enabled.

Update an existing running container with `docker update --restart=always NAME`;
this changes the policy without recreating it. Keep the NAS Compose definition
in sync so the policy survives future recreation. Apply this only to Garage and
the public, protected-download and upload-part gateways, not unrelated NAS services.

For planned maintenance that must survive a NAS/Docker restart, temporarily set
`--restart=no` on the affected containers before stopping them and avoid Compose
recreation until maintenance is finished. Restore `always` and start the services
when ready. A normal manual stop alone lasts only until Docker restarts (and the
Synology package may explicitly start `always` containers).

This policy depends on Container Manager starting and the storage volumes being
available. It does not repair corrupt storage or invalid configuration. Policy
inspection and non-disruptive health checks verify the configuration; an actual
NAS reboot/update acceptance test is a separate operation.

Applied to the four running production containers and both NAS Compose files on
2026-11-08 without changing their IDs, image IDs or start times. The private NAS
audit directory `/var/services/homes/gamedata/nas-autostart-20261108/` contains the
previous Compose files, before/after inspection and `receipt.json`. Garage health
and all three gateway health checks passed; no NAS reboot was performed.

Reference: [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/).
