# Release orchestration

`../deploy.sh` is the deployment facade. It loads source-only Bash
modules in one shell with `set -euo pipefail`; configuration, arrays and functions
are shared in that context. Call stage functions directly, not from Bash `if`,
`!`, `&&` or `||` conditions that disable `errexit` through nested calls.

- `preflight.sh`: runtime boundaries, capacity, Quadlet adoption and immutable
  digest/source-revision verification before any application changes.
- `backup.sh`: drained PostgreSQL dump; failed or empty dumps fail the command.
- `migrate.sh`: explicit release CLI, runtime receipt checks and inventory.
- `activate.sh`: replace application definitions and start the API, then workers.
- `smoke.sh`: API health gate before workers and exact final web revision check.
- `common.sh`, `lifecycle.sh`: shared environment/container context and lifecycle.

The `Deploy Release` workflow owns production gates and calls
`../release-orchestrate.sh` for preflight, backup/drain, migration, activation,
complete runtime health and final smoke. Web publication follows runtime health;
final smoke verifies its exact served source SHA before recording deployed evidence.
The release responsibilities below describe the complete order and recovery
boundary. `up` and `restart` only run activation preflight followed by activation;
neither applies migrations or provides old-binary rollback. A failed stage exits
nonzero and prevents subsequent workflow commands. Once migration is attempted,
failure requires forward recovery or explicit database restore and object-store
reconciliation under the existing procedure.

## Release responsibilities

`PR Checks` owns repository verification and isolated integration tests. `Build API
Release Image` tests and builds the API, verifies the image against its exact
checkout, and publishes a source-bound immutable digest manifest. It never deploys.

`Deploy Release` is the only production publication entry point. Run it on the
exact merged `master` revision in `pcugame/pcugame.github.io-infra`, using
`operation=release`. It verifies checkout identity, reuses the verified image for
that SHA (or invokes the artifact-only build), then enters the `production`
environment under the shared `production-object-cutover` lock.

The normal release order is: source verification → image digest acquisition →
production gate → preflight → backup/drain → migration → API and worker activation
→ complete runtime health → Web publication → final smoke and deployed evidence.
Web tests/build and the initial Pages write-access check run before maintenance.
Pages access is rechecked immediately before publication. Web publication has no
independent workflow and cannot run after a failed migration, activation or health
step. Final smoke verifies the exact served Web SHA, API health and data-plane
behavior, then records the deployed source and image digest on the host.

`server/release-orchestrate.sh` invokes the deployment facade for operational
phases; SQL history, schema receipts and runtime details remain in repository
scripts. `deploy.sh` still gates worker startup on API health. The release health
step additionally verifies all application services and their source/digest.

Before migration, failure recovery retains the captured Pages verification and
runtime identity checks. A read-only host check gates Pages recovery on the absence
of the persisted migration-attempt marker, even if the migration step's initial
status check failed. Runtime recovery rechecks that marker after Pages verification.
A persistent, fsynced migration-attempt marker is written
before applying SQL. Once migration is attempted, failures never automatically
restore Pages or the previous runtime. Investigate and forward-fix; explicit DB
restoration and object inventory reconciliation require their existing procedure.
The earlier web-before-migration declarations under `.github/release-gates/` are
historical records, not active ordering policy for this release workflow.

`operation=snapshot` only captures and verifies an isolated DB restore.
`operation=forward-fix` retains the forward-only API/worker recovery operation;
it does not migrate or publish Web. Supply `final_api_image` as an immutable digest
from the authorized API repository for the exact workflow source, and
`forward_fix_acknowledgement=I_ACKNOWLEDGE_CONTRACT_FORWARD_FIX`. Normal release and
snapshot reject both manual-image and acknowledgement inputs. The retired initial
schema transition operations remain unavailable.

First Quadlet installation is a separate [host adoption procedure](../quadlet/ADOPTION.md).
Legacy hosts must complete its PostgreSQL/pod ownership and readiness gates
before entering this app-only release path.
