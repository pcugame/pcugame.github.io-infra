# First Quadlet adoption

Status: repository preparation only, based on `6444c19` and the supplied
production read-only findings. No production operation below has been performed.
Production has Podman 5.4.2, legacy `container-gp-*.service` and
`pod-graduationproject.service` owners, no installed Quadlets, and no operator
runtime env files. The NAS API/PostgreSQL stack's role is unresolved.

This is a separately reviewed host topology change, **not** `deploy.sh up`,
`drain`, `down`, `restart`, or `Deploy Release` on an unadopted host. Those paths
intentionally reject that host. Do not relax the adoption guard. There is no
new installer, orchestration framework, migration, or alternate release workflow.
The commands in the execution section are a future operator procedure, not
permission to execute them during repository preparation.

## Decisions and release prerequisites

Use the [Podman compatibility policy](COMPATIBILITY.md). Keep explicit
`continue` semantics through `PodmanArgs=--exit-policy=continue`; do not simply
remove the unsupported `ExitPolicy` key. Test the production package's actual
generator in a scratch directory before installation; do not invoke its generated
Podman commands. Generator success does not verify a live DB connection.

Merge the reviewed preparation through the existing task branch → PR → required
`PR Checks` (`verify`, `integration`) → approved `master` process. Confirm the
workflow definitions and actual required checks/approval state at that revision.
Select the immutable image verified for the exact merged source revision and
record its source SHA, digest, and current schema compatibility. A task branch
image is not a production release. Do not run Phase 2 contract migrations to make
adoption possible. If the selected image cannot run against the current DB,
prepare a compatible change and integration plan first; the normal app-only
workflow cannot bootstrap this host. A host topology execution window and its
recovery plan still require authorization. Existing production environment gates
continue to apply to the subsequent release; this runbook grants no exception.

## Read-only preflight and evidence

Use the same rootless user, UID, storage root, and user manager that currently
own production. Rootful/rootless stores are different. Record only non-secret
identity/status fields; never paste raw `podman inspect`, `systemctl cat`, env
files, process environments, or shell tracing into logs or the repository.

| Check | Required evidence / stop condition |
| --- | --- |
| Legacy ownership | Exact unit names, FragmentPath, enabled state, restart policy, pod/container IDs, pod membership, image IDs/digests and source revisions for API and all six workers plus PG. Inspect legacy ExecStop/ExecStopPost privately for implicit removal or volume flags. Identify timers, external supervisors and boot owners. Missing/ambiguous ownership blocks execution. |
| Existing database | `gp-postgres` must mount the existing named `gp_pg_data` at `/var/lib/postgresql/data`; record storage root, volume mountpoint, driver/options, PG major version, data directory, database identity, and attached containers. No second server may write the volume. Confirm PG image ID currently behind `postgres:16-alpine`; a mutable tag resolving to different bits blocks this topology-only adoption. |
| Pod/network | Record pod name/ID, port binding, current DB URL host class and shared networking. Confirm the target `postgres:127.0.0.1` alias is intentional. No credential URL output. |
| Artifact availability | Verify already available API and PostgreSQL image IDs against the reviewed artifacts, and infra-image behavior. Check for missing images before any stop. Image acquisition, if needed, belongs to a separately authorized release step, not this preparation. |
| Backups | Verify latest successful dump checksum, readable archive (`pg_restore --list`), source DB identity, retention and an isolated restore result/RPO. Have storage for a final quiesced dump. A file's existence alone is insufficient. |
| NAS stack | Establish whether NAS API/PG is active production, standby, backup, replica, historical stack or a client of this DB; identify traffic routes, writers, scheduled jobs, replication, volume identities and recovery dependencies. Resolve split-brain/duplicate writer risk with its operator. Do not stop, remove, reconfigure or delete the NAS stack. An unknown role is a blocker. |
| Host prerequisites | NAS and optional CA mounts, disk/memory/tmpfs capacity, SELinux labels, user-manager/linger and boot dependencies, Quadlet/systemd search paths and absence of conflicting drop-ins. Read-only checks only during preparation. |

## Runtime env mapping and comparison

The complete key mapping and legacy defaults are in the
[env inventory](README.md#operator-managed-runtime-env-inventory):

* `common.env`: application DB/session/OAuth/CORS/origin/storage settings,
  feature flags, limits and logging; shared by API and all six workers.
* `api.env`: proxy, auto IP ban, session/cookie and drain settings; API only.
* `postgres.env`: exactly `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`;
  PG only. On an existing initialized volume these variables do **not** reset
  roles/passwords or rename a database. Verify against existing DB credentials.
* Keep renderer-owned `NODE_ENV`, `PORT`, `NAS_EXPORT_ROOT` and optional
  `NODE_EXTRA_CA_CERTS` out of all three files. Keep release controls in the
  existing deployment configuration, not runtime env files.

An operator must prepare the three distinct, non-aliased files outside git in
an authorized step, with private parent directory (0700), files (0600), correct
ownership and no unrelated ACL access. Use literal `KEY=value`, explicitly
including defaults and intentional empty values. Do not source shell `.env`,
copy quoted shell expressions, interpolate passwords, or rotate credentials as
part of adoption. Resolve per-worker drift; one shared file cannot preserve
conflicting values. Do not run `runtime-env.py` directly in a terminal: its
legacy deployment interface emits shell assignments including secrets.

After files exist, compare them to all eight live containers without storing or
printing raw inspect output. Run from the repository root with shell tracing
disabled; use `pipefail` so failed inspection cannot be mistaken for success:

```bash
set -o pipefail
podman inspect gp-api gp-worker-game-validation gp-worker-webgl \
  gp-worker-video gp-worker-image gp-worker-export \
  gp-worker-project-publication gp-postgres |
  python3 server/quadlet/runtime-env-check.py \
    /srv/graduationproject_v2/runtime-env/common.env \
    /srv/graduationproject_v2/runtime-env/api.env \
    /srv/graduationproject_v2/runtime-env/postgres.env \
    --nas-export-root /nas
```

Use the actual reviewed export path and add `--garage-ca` only when the rendered
CA bind is selected. The checker reads files/stdin only and reports fixed
container/key names and comparison status. Unknown or malformed input gets a
value-free diagnostic. Missing/different values block adoption. A separately
reported `postgres-loopback-equivalent` URL is only a structural equivalence:
credentials, port, DB and query must be identical; only the reviewed legacy
`postgres` versus loopback host differs. It does not prove authentication,
DNS, DB readiness, schema compatibility, or env file permissions. Verify those
separately. Repeat comparison after adoption; expect exact equality then.

## Authorized execution sequence (not executed)

Stop on any failed gate. Maintain an operator receipt of each checkpoint and
non-secret IDs, checksums, source SHA and image digest. Preserve legacy unit files
and their previous enablement state for investigation; never delete them or the
DB volume. Do not rely on `--replace` to displace a live legacy container.

1. **Reconfirm identity and backup.** Repeat the preflight immediately before
   maintenance. Confirm the existing verified backup and recovery owner before
   stopping any application. Freeze release automation for the window. Record
   the exact legacy unit list; do not use a broad `container-*` stop wildcard.
2. **Stop legacy applications.** Fence external traffic/mutation entry points
   using the existing maintenance procedure; stop the seven identified legacy
   app services and verify every app container is stopped with no restart owner
   or external writer. Keep legacy PG running. Do not use `deploy.sh drain`:
   its guard requires completed adoption. Obtain and verify a final quiesced
   `pg_dump -Fc` plus checksum while PG is still up, and preserve the earlier
   isolated restore evidence. Do not fabricate the release drain marker to
   bypass the guard. The ordinary backup command also assumes adopted app units.
3. **Release legacy PG/pod ownership.** Disable the identified legacy boot
   owners and stop PG cleanly, then the legacy pod service, according to the
   privately reviewed unit stop semantics. Verify inactivity and no surviving
   PG process. Quarantine legacy restart paths (mask exact legacy unit names
   after preserving their files if necessary). Any removal required to release
   stopped container/pod names must target the recorded IDs, use no force and
   no volume removal flags, and receive operator review before execution.
   Re-inspect `gp_pg_data`: identity/mountpoint unchanged and no attachments
   from a running PG. Never run `volume rm`, prune, initdb, or an empty-volume
   fallback. If the volume is absent, stop: the Quadlet volume unit could
   otherwise create an empty one.
4. **Stage app startup gates and install.** Before installing or reloading,
   runtime-mask these **new** service names (not the legacy names):

   ```bash
   systemctl --user mask --runtime gp-api.service \
     gp-worker-game-validation.service gp-worker-webgl.service \
     gp-worker-video.service gp-worker-image.service gp-worker-export.service \
     gp-worker-project-publication.service
   ```

   Verify all seven masks. Install only the ten reviewed rendered definitions
   into the selected Quadlet directory and perform the authorized user
   daemon-reload. Verify foundation SourcePath/FragmentPath and inspect the generated graph
   files before starting anything. Masked app units resolve to `/dev/null` in
   `systemctl show`; verify their generated files offline now and their live
   SourcePath/FragmentPath after each unmask and again at step 9. `StartWithPod=true` adds Wants for all children, and
   `After` is only ordering; without masks a pod start would bypass readiness.
   Do not modify definitions to `StartWithPod=false` or add persistent drop-ins.
5. **Start Quadlet PG on the existing volume.** Start
   `graduationproject-pod.service`; its wanted `gp-postgres.service` may start,
   while app units remain masked. Confirm both foundation units active, all
   seven apps absent/stopped, and PG mounted to the recorded `gp_pg_data` with
   the recorded image and database identity. Mask-related app start failures
   are expected at this step, not evidence that applications passed readiness.
6. **Verify PostgreSQL and the hostname.** Check `pg_isready`, authenticated
   read-only SQL, actual DB identity, and `postgres` resolving to `127.0.0.1`
   inside the new pod. Run an ephemeral diagnostic using the already verified
   API image, `--pull=never`, the same pod and the literal common env file. This
   is a future container operation and is not run during repository preparation:

   ```bash
   podman run --rm --pull=never --pod graduationproject \
     --env-file /srv/graduationproject_v2/runtime-env/common.env \
     --entrypoint node "$API_IMAGE" --input-type=module -e '
   import dns from "node:dns/promises";
   import pg from "pg";
   let client;
   try {
     const url = new URL(process.env.DATABASE_URL);
     if (url.hostname !== "postgres") throw new Error();
     const addresses = await dns.lookup("postgres", {all: true});
     if (!addresses.length || addresses.some(x => x.address !== "127.0.0.1")) throw new Error();
     client = new pg.Client({connectionString: process.env.DATABASE_URL,
       connectionTimeoutMillis: 5000, statement_timeout: 5000,
       options: "-c default_transaction_read_only=on"});
     await client.connect();
     await client.query("SELECT 1");
     console.log("postgres hostname and authenticated read-only SQL: PASS");
   } catch { console.error("postgres connection check: FAIL"); process.exitCode = 1; }
   finally { if (client) await client.end().catch(() => {}); }
   '
   ```

   This uses the real application URL without rewriting or displaying it.
   For an intentionally retained loopback URL, separately test the alias with
   the same credentials and record both results; do not claim this strict probe
   passed. Follow image-specific TLS requirements if the DB uses TLS. Never
   substitute a bare `pg_isready` result for authenticated success.
7. **Start API and verify health.** Unmask only `gp-api.service`, start it,
   check its immutable image/source identity and the existing `/api/health`
   gate, then an authenticated read-only success response through the public
   route. Check actual response serialization and DB-backed behavior with a
   designated existing test account; never log tokens or response private data.
   All workers remain masked until this succeeds.
8. **Start workers sequentially.** For each of game-validation, webgl, video,
   image, export, project-publication: unmask just that service, start it,
   verify active/running, image/source identity and workload-specific readiness
   without generating production write fixtures, then proceed to the next.
   If any fails, stop progression and retain the remaining masks.
9. **Verify the adoption guard.** Ensure all seven temporary masks are removed
   and no temporary Quadlet/systemd drop-ins remain. Invoke the existing guard
   without invoking release artifact pulls, migration or activation. From the
   repository root, with reviewed renderer structural settings exported:

   ```bash
   bash -euo pipefail -c '
     DEPLOY_SCRIPT_DIR="$PWD/server"
     source server/deploy/common.sh
     source server/deploy/lifecycle.sh
     load_runtime_env
     assert_quadlet_adopted
   '
   ```

   This reads operator env files privately, renders a temporary expected tree,
   checks installed source parity/generated ownership and active pod/PG, and
   probes PG readiness. Set `API_IMAGE` to the reviewed digest and `DEPLOY_DIR`,
   `QUADLET_DIR`, paths/ports/CA/NAS structural inputs to the installed settings;
   no shell deployment `.env` is sourced here. Keep guard diagnostics private:
   the existing PG readiness helper may print PostgreSQL logs on failure. Record
   only its exit status and reviewed non-secret evidence, not raw failure logs.
   Repeat the env comparison.
10. **Verify reboot/autostart and app-only drain.** Check generated
    `default.target.wants` → pod and pod Wants → all eight containers, existing
    linger/user-manager startup, and legacy owners disabled. In an authorized
    reboot window verify the same volume and source/digest return, all units
    recover and readiness/authenticated API checks pass. A new pod/container ID
    after reboot is expected. Then exercise the established app-only drain:
    record pod/PG IDs before/after, ensure all seven app units stopped, PG/pod
    remain active with the same IDs, and PG remains readable. Resume API with
    its health gate followed by workers; verify reboot-autostart has no leftover
    masks. Clear maintenance through the established procedure only after all
    checks pass. No reboot test means autostart remains an explicit open blocker.

## Failure boundary and completion evidence

Before ownership handoff, a reviewed abort may restore only captured legacy app
state if no migration or DB compatibility change occurred. After PG/pod handoff,
keep one DB owner, preserve volume/backups and diagnose or forward-fix; do not
start legacy and Quadlet PG together or automatically restore old binaries.
A failed DB gate keeps apps masked; a failed API gate keeps workers masked.
Do not reboot with incomplete runtime masks: those masks disappear at reboot,
and installed boot Wants could start all apps. The operator must fence boot
activation or remove/quarantine the newly installed boot definitions under the
reviewed recovery plan before leaving a failed adoption unattended.

Adoption is complete only with recorded volume/DB identity, backup checksum and
restore evidence, env comparison, hostname/authenticated SQL result, API health
and authenticated response, worker checks, adoption guard, reboot/autostart and
retained-PG app-drain results. Record the deployed source commit and immutable
image digest independently of GitHub CI success. Until then, the production
compatibility, env provisioning, NAS role, live hostname connection and lifecycle
checks remain blockers. A subsequent app-only release uses the existing
`Deploy Release` workflow unchanged.
