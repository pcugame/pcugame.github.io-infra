# Selective PR verification

`PR Checks` always creates the required `verify` and `integration` checks. It has
no workflow-level path filter. Selection changes the steps inside those jobs,
so a documentation change can pass both checks without installing workspaces,
building Quadlet, or starting Docker services.

The dependency-free classifier compares the exact PR event base SHA with the
checked-out GitHub merge commit using `git diff --name-only -z --no-renames`.
This checks the tree being tested, conservatively including changes from an
advanced base that entered the merge commit. NUL records preserve spaces and
newlines; disabling rename detection includes both old and new paths. Git's
complete diff avoids the file-count limits of API responses and workflow path
filters. Missing event details, unavailable/truncated diff output, empty diffs,
manual dispatch, unknown events, and unclassified paths select the full baseline.

| Changed paths | Workspace verification | Release controls | Service integration |
| --- | --- | --- | --- |
| `apps/web/src/**`, `apps/web/public/**` | Web and contracts | No | No |
| Other `apps/web/**`, including startup/configuration/scripts | Full | Yes | Yes |
| `apps/api/**`, including Prisma and release scripts | API and contracts | Yes | Yes |
| `apps/db/**`, `server/**` | API and contracts | Yes | Yes |
| `packages/**`, any workspace manifest or root lockfile | Full | Yes | Yes |
| `scripts/**`, integration Compose, workflow files | Full | Yes | Yes |
| `README.md`, Markdown under `docs/**` | No | No | No |
| Mixed API and Web, unknown paths, uncertainty, manual dispatch | Full | Yes | Yes |

Every selection runs classifier/workflow regression tests, integration-runner
unit tests, and the migration-history policy guard. A workspace selection uses
root `npm ci --include-workspace-root`, builds/tests contracts, and audits the
whole installed dependency tree. API selections generate Prisma and run API
tests, lint, architecture checks and builds. Web selections run Web tests, lint
and builds. Full selections retain root `npm test`, `npm run lint`, and
`npm run build`, so new workspaces remain included in the baseline.

Web source changes do not select service integration because its Web check only
fetches the root HTML and requires HTTP success; it does not execute browser
source. Web startup configuration still selects the full baseline. API tests
read deployment scripts, environment examples, Quadlet definitions, and workflow
files, while PostgreSQL visibility tests execute deployment controls. These
cross-dependencies keep API verification selected for server/data-plane changes.
Markdown outside the explicit documentation destinations remains subject to its
subsystem or unknown-path classification because it may be an executable fixture.

The integration job runs even when `verify` fails. Its first step requires a
successful `verify` result and an explicit `true` or `false` integration output.
Failure, cancellation, missing output, or invalid output fails this gate. An
intentional `false` passes with a skip explanation; `true` runs all existing
integration suites, gateway TLS checks, and cleanup with the 25-minute timeout.
The classifier also writes selected flags and reasons to the run summary.

## Historical constraints and release behavior

- [Workspace conversion fix](https://github.com/pcugame/pcugame.github.io-infra/commit/8c5e1f28cc07aa03beb630c4a5a2d009b07e1f51)
  added shared contracts and root manifests to earlier deployment filters after
  stale application lockfiles broke installation.
- [Native dependency fix](https://github.com/pcugame/pcugame.github.io-infra/commit/f4a98a92ef0c6d1054410f8b6a83fc0b23ea19e1)
  documents why API installation must include all workspaces: filtered installs
  omitted Sharp's platform-specific optional dependencies.
- [Infrastructure normalization PR](https://github.com/pcugame/pcugame.github.io-infra/pull/82)
  established separate artifact builds and manual production releases, with
  required `verify` and `integration` checks retained.

Selective CI does not change either release workflow. A successful image build
is still an artifact build. Production uses the exact merged `master` source,
its verified immutable image, the existing production gate, ordered deployment
stages and health checks, Web publication, and final smoke. Migration-attempt
recovery boundaries and first Quadlet adoption prerequisites remain unchanged.

## Local checks

```sh
node --test scripts/classify-ci-changes.test.mjs scripts/pr-checks-workflow.test.mjs scripts/run-integration.test.mjs
actionlint .github/workflows/pr-checks.yml
```

Git regression fixtures cover renames, deletion, spaces/newlines, more than 300
changed files, advanced-base merges, missing refs, and uncertain event data.
Workflow tests execute the actual inline integration gate for successful skips,
failures, cancellation and malformed outputs, and check selected command wiring.
GitHub remains the verification environment for workflow scheduling and the full
Docker integration baseline.
