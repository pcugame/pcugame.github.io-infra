# Release orchestration

`../deploy.sh` is the only executable entry point. It loads source-only Bash
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

The `Deploy Release` workflow continues to own the release sequence and gates:
preflight, drain, backup, web verification, contract migration, activation and
production smoke. Separate commands preserve its intervening approval and web
publication gates. `up` and `restart` only run activation preflight followed by
activation; neither applies migrations or provides old-binary rollback. A failed
stage exits nonzero, preventing subsequent workflow commands. Contract migration
followed by activation failure requires forward recovery or explicit database
restore and object-store reconciliation, as specified in the existing workflow.
