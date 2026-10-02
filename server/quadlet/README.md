# Quadlet runtime definitions and release integration

Quadlet owns the runtime topology and systemd owns process lifecycle and
restart. `../deploy.sh` updates the immutable application digest and requests
systemd operations on an already adopted host. It does not install Quadlet for
the first time or migrate legacy units. Production adoption and operation have
not been verified; repository edits do not activate these definitions.

For first installation, use the separately gated [first-adoption runbook](ADOPTION.md)
and [Podman compatibility policy](COMPATIBILITY.md). Normal releases cannot adopt
a legacy host.

## Responsibilities and rendering

The renderer owns topology: image references, fixed names, pod networking,
mounts, process entrypoints, resource mounts, restart policy, and paths to
external runtime configuration. It never sources deployment `.env`, reads or
writes operator runtime env files, or reads/transforms `DATABASE_URL` or other
runtime settings. The wrapper gives Python a clean environment containing only
the structural allowlist below. Python also accesses only those known fields.
It executes neither `deploy.sh`, Podman, nor systemctl.

Operators own the three distinct runtime env files, their values, permissions,
and updates. Protect them as credentials, outside the repository. The renderer
produces exactly ten unit definitions, with no env files: one pod, one existing
named volume, and eight containers. It accepts absent or unreadable external
files because rendering does not inspect them; those files must be available to
Podman when units eventually start. Editing a runtime env file takes effect on
the next container recreation, not in an already running process.

Requires Bash and Python 3. Choose a new absolute output directory whose parent
already exists, outside active Quadlet search directories:

```sh
API_IMAGE='ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:<64-lowercase-hex>' \
  DEPLOY_DIR=/srv/graduationproject_v2 \
  bash server/quadlet/render.sh /private/path/quadlet-review
python3 server/quadlet/parity.test.py
RUN_QUADLET_LIFECYCLE_TESTS=1 QUADLET_GENERATOR=/absolute/path/to/quadlet \
  python3 server/quadlet/lifecycle.test.py
```

The digest placeholder must be replaced with the actual authorized image
reference. The renderer validates its format and repository, not the artifact's
contents, source commit, or availability. It creates a mode 0700 directory and
mode 0600 files. No runtime secret belongs in a structural setting or output path.
Invalid input diagnostics do not echo supplied values.

| Structural input | Default / requirement |
| --- | --- |
| `API_IMAGE` | Required immutable digest in `ghcr.io/pcugame/pcu-graduationproject-v2-api` |
| `DEPLOY_DIR` | `/srv/graduationproject_v2` (path prefix only; `.env` is ignored) |
| `API_BIND_HOST` | `127.0.0.1` |
| `API_PORT` | `4000`; decimal 1–65535 |
| `NAS_EXPORT_HOST_PATH` | `/mnt/nas/pcu_storage/GraduationGame` |
| `NAS_EXPORT_PATH` | `/nas` |
| `S3_TLS_CA_HOST_PATH` | Empty; optional CA bind source |
| `APP_RUNTIME_ENV_FILE` | `${DEPLOY_DIR}/runtime-env/common.env` |
| `API_RUNTIME_ENV_FILE` | `${DEPLOY_DIR}/runtime-env/api.env` |
| `POSTGRES_RUNTIME_ENV_FILE` | `${DEPLOY_DIR}/runtime-env/postgres.env` |

Unset or empty structural values use defaults. Public binding requires an
explicit `API_BIND_HOST=0.0.0.0`; an empty value does not request all interfaces.
Paths must be absolute, without colons, backslashes, line breaks, or edge
whitespace. Env-file paths are quoted as Quadlet word lists. Volume/port values
are raw single values. `%` and `$` are escaped for systemd. Pod/container names,
PostgreSQL image, and volume name are fixed; inherited overrides are ignored.
The three env paths must be textually distinct; operators must also avoid
symlinks or aliases that accidentally share their contents.

## Operator managed runtime env inventory

Each file uses Podman's plain `KEY=value` syntax. Values are literal: do not use
`export`, Bash quoting, command substitution, variable interpolation, or shell
default expressions. A Bash deployment `.env` is not interchangeable with these
files. For example, write a complete literal database URL rather than
`${POSTGRES_PASSWORD}` inside a URL. No conversion helper or secret generation
framework is provided. The read-only `runtime-env-check.py` comparison described
in [first adoption](ADOPTION.md#runtime-env-mapping-and-comparison) reports key
status without printing values; it does not create or convert env files. Supply every key below, including the documented
legacy `deploy.sh` fallback values where appropriate; the renderer does not fill runtime
defaults. An empty value is written as `KEY=`.

`common.env` is shared by API and all six workers, never PostgreSQL:

| Key(s) | Legacy `deploy.sh` default |
| --- | --- |
| `SESSION_SECRET`, `GOOGLE_CLIENT_IDS`, `DATABASE_URL` | Required |
| `S3_ENDPOINT`, `S3_PUBLIC_SIGNING_ENDPOINT`, `S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT`, `PUBLIC_ASSET_ORIGIN` | Required |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Required |
| `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `CORS_ALLOWED_ORIGINS` | Required |
| `DIRECT_UPLOAD_PART_URL_REFRESH_MAX`, `UPLOAD_USER_GAME_MAX_MB`, `UPLOAD_PRIVILEGED_GAME_MAX_MB` | Required |
| `DIRECT_UPLOAD_WORKER_TEMP_MAX_MB`, `EXPORT_WORKER_MAX_OBJECT_BYTES`, `EXPORT_WORKER_MAX_JOB_BYTES` | Required |
| `FILE_GATEWAY_SECRET` | Empty |
| `LOG_LEVEL` | `info` |
| `S3_REGION` | `garage` |
| `S3_BUCKET_PUBLIC` | `pcu-public` |
| `S3_BUCKET_PROTECTED` | `pcu-protected` |
| `S3_FORCE_PATH_STYLE` | `true` |
| `WEBGL_EXTERNAL_CONNECTIONS_ENABLED`, `WEBGL_PLAY_ENABLED` | `false` |

`api.env` is API-only and loaded after `common.env`:

| Key | Legacy `deploy.sh` default |
| --- | --- |
| `TRUST_PROXY` | `false` |
| `DOWNLOAD_AUTO_IP_BAN_ENABLED` | `false` |
| `SESSION_COOKIE_NAME` | `sid` |
| `SESSION_IDLE_MS` | `7200000` |
| `SESSION_ABSOLUTE_MS` | `1209600000` |
| `SESSION_TOUCH_MIN_INTERVAL_MS` | `300000` |
| `SHUTDOWN_DRAIN_MS` | `15000` |
| `COOKIE_SECURE` | `true` |
| `COOKIE_SAME_SITE` | `none` |
| `ALLOWED_GOOGLE_HD` | Empty |

`postgres.env` is PostgreSQL-only: `POSTGRES_DB`, `POSTGRES_USER`, and
`POSTGRES_PASSWORD` are all required, with no defaults. Do not place application
credentials in that file. Do not duplicate common keys in `api.env`, where the
later env-file value would override them.

The remaining environment values from `deploy.sh` are structural and reserved:
`NODE_ENV=production` in all seven app containers, `PORT=4000` in API,
`NAS_EXPORT_ROOT=${NAS_EXPORT_PATH}` in export, and, when the CA bind is selected,
`NODE_EXTRA_CA_CERTS=/run/secrets/garage-ca.pem` in all seven app containers.
Explicit Podman `--env` values override env-file values; keep these keys out of
the operator files (including `NODE_EXTRA_CA_CERTS` when the CA bind is absent).
Release/migration, deployment validation, capacity, and cutover settings are not
long-running container env inputs and remain responsibilities of the established
release flow.

## Database addressing and preserved process configuration

The pod has `AddHost=postgres:127.0.0.1`. Podman manages the shared pod
`/etc/hosts`, so the existing runtime `DATABASE_URL` hostname `postgres`
resolves to shared loopback without parsing or rewriting a credential URL. All
eight containers share that network namespace; literal loopback URLs continue
to work. This alias does not provide external DNS or change the runtime URL.
See the official [pod-create hosts behavior](https://docs.podman.io/en/latest/markdown/podman-pod-create.1.html)
and [Quadlet reference](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html).

| Definition | Entrypoint / command | Explicit `/tmp` tmpfs | Additional storage |
| --- | --- | --- | --- |
| PostgreSQL | image default | none | existing `gp_pg_data:/var/lib/postgresql/data:Z` |
| API | `node dist/server.js` | none | optional CA only |
| GAME validation | `node dist/game-validation-worker.js` | `rw,noexec,nosuid,size=6g` | optional CA only |
| WebGL | `node dist/webgl-worker.js` | `rw,noexec,nosuid,size=6g` | optional CA only |
| VIDEO | `node dist/video-worker.js` | `rw,noexec,nosuid,size=2g` | optional CA only |
| IMAGE/PDF | `node dist/image-worker.js` | `rw,noexec,nosuid,size=512m` | optional CA only |
| export | `node dist/export-worker.js` | none | `${NAS_EXPORT_HOST_PATH}:${NAS_EXPORT_PATH}:rw,Z` plus optional CA |
| project publication | `node dist/project-publication-worker.js` | none | optional CA only |

Only the pod publishes `${API_BIND_HOST}:${API_PORT}:4000`. GAME and WebGL each
own an independent 6 GiB tmpfs. All fixed pod/container names remain identical
to `deploy.sh`. The `.volume` explicitly reuses `gp_pg_data`. The optional CA
mount is `${S3_TLS_CA_HOST_PATH}:/run/secrets/garage-ca.pem:ro,Z`.

## Lifecycle ownership and operational groups

The pod is the sole boot owner with `[Install] WantedBy=default.target`.
Containers use `StartWithPod=true`; the generator makes the pod want all eight
container services. No separate runtime target or orchestration service is
introduced. All eight long-running containers use `Restart=always`, covering
clean unexpected workload exits as well as failures. An explicit systemd stop
suppresses this restart policy. The pod uses `Restart=on-failure`, retaining
`RestartSec=15`, burst 10 per 300 seconds, and explicit `continue` semantics
via `PodmanArgs=--exit-policy=continue` (Podman 5.4.2 compatibility); each
container retains `StopTimeout=10`. Podman Quadlet 5.8.2 generates the pod with
`Restart=on-failure` regardless of a source `Restart=always` setting. A clean
infra-process exit is therefore not a workload restart guarantee. The compatibility
policy verifies the final effective Podman CLI flag without patching generated units.

Peer dependencies are ordering-only `After`: PostgreSQL → API → workers.
Stopping API does not stop workers or PostgreSQL. Generated containers bind to
the pod; stopping the pod stops its containers, while stopping an individual
child does not propagate a stop back to the pod. A normal user-manager shutdown
stops services; a later user-manager boot starts the enabled pod and its children.
Host reboot autostart also depends on the host's existing user-manager/linger
configuration, which this change does not inspect or modify.

The runtime group is API plus six workers. The database group is PostgreSQL;
the pod owns both. Commands below describe the unit groups;
they have not been executed against production and do not replace release drain
markers, backups, schema checks, migration, or deployment gates:

```sh
# Stop the complete runtime, preserving the named PostgreSQL volume.
systemctl --user stop graduationproject-pod.service
# Start or restart the pod and its runtime group.
systemctl --user start graduationproject-pod.service
systemctl --user restart graduationproject-pod.service
# Drain app processes explicitly; PostgreSQL and the pod remain up.
systemctl --user stop gp-api.service gp-worker-game-validation.service \
  gp-worker-webgl.service gp-worker-video.service gp-worker-image.service \
  gp-worker-export.service gp-worker-project-publication.service
# Resume only the stopped app group, retaining PostgreSQL.
systemctl --user start gp-api.service gp-worker-game-validation.service \
  gp-worker-webgl.service gp-worker-video.service gp-worker-image.service \
  gp-worker-export.service gp-worker-project-publication.service
```

An explicit stop stays stopped within the current user-manager session;
reboot/pod restart deliberately restores the pod's wanted children. Restarting
PostgreSQL while apps are drained leaves them stopped; drain leaves PostgreSQL
running. These relationships were verified using isolated substitute services,
not production containers. `After`
does not establish readiness. Do not install alongside the existing generated
services or containers with the same names.

## Release integration on an adopted host

`QUADLET_DIR` defaults to `$HOME/.config/containers/systemd`. The installed ten
source definitions must match the repository topology, except for the seven
application `Image=` digests. The pod and PostgreSQL must already be active and
the services must come from the Quadlet generator. Non-image topology changes
and legacy generated services require a separately planned host change. The
adoption guard conservatively rejects Quadlet drop-in directories across the
user-manager and release process search roots, including shared roots; hosts
using such overrides need a separate topology review before this release path.

The release path keeps existing source/digest, artifact, boundary and capacity
validation. It checks adoption before maintenance, stops the app group, updates
the seven immutable application image references, requests
`systemctl --user daemon-reload`, checks PostgreSQL readiness and schema, starts API, waits for API
health, then starts workers. It never restarts the pod or PostgreSQL during an
application release. One-shot release/migration containers remain release tasks.
There is no `latest` fallback for production API images.

`drain` stops all seven app units and writes the drain marker only after success.
`down` asks systemd to stop the runtime; the named database volume is retained.
Stopping the full runtime requires separate host startup before another release;
`up` intentionally requires the pod and PostgreSQL to be running. Neither command
uses direct Podman lifecycle operations or silently ignores systemd failures.

Operator env files provide runtime values used by the deployment gates; the
shell `.env` continues to provide release controls, topology and capacity
attestations. The deploy-side reader uses literal assignments without shell
execution. The renderer remains separate: it sees only its topology allowlist
and never reads, copies or rewrites credentials. Keep operator files consistent
with the installed runtime before a release.

Pre-migration recovery also uses systemd. It discovers the adopted source
directory from the API unit when no `QUADLET_DIR` is explicitly provided. It verifies the captured unit/config
and immutable image identities, then starts API and checks health before
resuming captured workers. Container IDs may change because Quadlet removes
containers on stop. The existing previous-Pages and no-migration-attempt gates
remain required; drift or a startup failure leaves recovery incomplete.

## Offline verification and remaining differences

Parity tests compare rendered units against an explicit runtime topology
contract. Deployment tests exercise `do_up`, drain and down with command
doubles and innocuous fixtures. Renderer subprocesses use
an explicit clean environment. Inherited secret sentinels exist only in test
memory/process environments and are checked against the entire temporary tree
and captured diagnostics. Tests cover image/port/mount/process/tmpfs parity,
external file separation, opaque env-file handling, reserved structural env,
and lifecycle directives. No production `.env`, service, or container is used.

The lifecycle test is skipped unless `RUN_QUADLET_LIFECYCLE_TESTS=1` is set.
It requires a user systemd manager and an installed generator selected via
`QUADLET_GENERATOR=/absolute/path/to/quadlet` (or discovered on `PATH`). It
inspects generated units and runs uniquely named, non-enabled transient fixture
services carrying the generated dependency/restart policy. It never executes
the generated Podman start/stop commands. Local offline generation and isolated
fixture lifecycle checks passed with Podman Quadlet **5.8.2** and systemd
**260.2**, including PG restart/stop/start while apps remained drained. These
surrogate checks do not verify production application/database behavior. A generator can also be inspected manually in
an inactive temporary output directory:

```sh
quadlet_verify_dir="$(mktemp -d)"
QUADLET_UNIT_DIRS=/private/path/quadlet-review /path/to/quadlet --user "$quadlet_verify_dir"
SYSTEMD_UNIT_PATH="$quadlet_verify_dir:" systemd-analyze --user verify "$quadlet_verify_dir"/*.service
```

Residual differences and blockers include:

* Container `Restart=always` intentionally replaces the legacy generated
  `on-failure` policy and direct `unless-stopped` behavior. The pod retains the
  native generator's `on-failure` policy, including the clean infra-exit
  limitation. The explicit systemd stop/reboot expectations above define the
  candidate policy.
* Quadlet owns create/remove, injects `--replace`/`--rm`, and uses different unit
  names. Generated `--cgroups=split`/`--sdnotify=conmon` behavior differs from
  direct runs. Conmon notification is not application readiness.
* PostgreSQL readiness, API health, worker checks, schema compatibility,
  capacity attestations, NAS/CA mount existence, immutable artifact/source
  validation, release drain/backup/migration, smoke tests, and deployment
  receipts remain outside these definitions. PostgreSQL pull/first creation
  semantics need host verification.
* The pod hosts alias replaces `deploy.sh`'s URL transformation. It requires
  host/runtime validation with the actual database URL and an authenticated
  API success path before production adoption. Plain env-file content must be
  reviewed by operators; rendering proves no runtime values or credentials.

Initial adoption still requires the existing master/PR/CI/CD release process
and production verification. No production installation, activation, enablement
or cutover was performed as part of this repository change.
