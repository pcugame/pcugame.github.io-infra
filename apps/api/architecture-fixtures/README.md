# Architecture fixtures

`architecture-fixtures/` contains inputs for the architecture self-test, outside
the API build and runtime. Production scans and fixture scans use the same rule
implementations; fixture paths do not grant exemptions.

## Entry points and enforced scope

From the workspace root, `npm run architecture` runs:

1. `architecture:guard`: the existing API/worker data-plane guard plus runtime
   ownership checks, then the scoped layer guard.
2. `architecture:self-test`: data-plane and ownership fixtures, then scoped layer
   regressions (including isolated mutations of the self-test entry point).
3. The existing dependency-cruiser production scan, including circular imports.

`npm run architecture:self-test -w apps/api` runs the fixture checks alone.
The scripts require installed workspace dependencies, built contracts, and the
generated Prisma types. An unresolved dependency is a failure, not evidence of
a forbidden architecture edge.

The data-plane rules and their seven negative cases are retained. Ownership
checks apply to production TypeScript under `src`, excluding generated code,
tests and executable scripts. They reject direct runtime controller dependencies
on env/runtime/resource modules, feature runtime dependencies outside composition,
global Prisma repository imports, process-resource imports outside composition,
and immediate module-level creation of the recognized resource clients/factories.
Configuration type imports are allowed by these runtime ownership rules. This is
not a general detector for every mutable value or every possible resource factory.

`assets-boundary-guard.mjs` reuses the traversal and four rule IDs from
[PR #113, revision c95de4be](https://github.com/pcugame/pcugame.github.io-infra/pull/113).
That PR's business-module normalization is not present in this branch. The default
strict roots are explicitly limited to these existing independent boundaries:

- `src/modules/assets/delivery-policy.ts`
- `src/modules/admin/project/project-status.service.ts`
- `src/modules/admin/project/update.controller.ts`
- `src/modules/admin/project/update.service.ts`
- `src/modules/admin/project/update.policy.ts`
- `src/modules/admin/project/update.repository.ts`
- `src/modules/admin/project-access.policy.ts`

The strict rules follow local imports and re-exports transitively, including
barrels, type-only edges, literal dynamic imports and `import('...')` types.
External packages and generated Prisma code are terminal dependencies. Both
relative and package targets must resolve; malformed source, missing roots and
empty scopes fail. Explicit file/directory arguments use the same rules as the
default production roots. No per-violation exception list is used.

| Rule ID | Forbidden dependency | Allowed boundary |
| --- | --- | --- |
| `controller-repository` | Controller → repository, including through service/barrel types | HTTP parsing, auth middleware, response mapping, injected application ports |
| `service-adapter` | Service → repository, Prisma or HTTP authority | Contracts, pure policies, injected repository/resource ports |
| `repository-application` | Repository → service/controller | Prisma, locked snapshots, persistence and pure policy calls |
| `policy-adapter` | Policy → DB/HTTP/repository/service/controller | Plain records, contracts, pure calculations and application errors |

Composition may import factories and adapters to assemble the graph; this does
not exempt it from API/worker data-plane or module-level resource ownership rules.
The strict checker identifies authorities by the existing path/name patterns; it
does not prove runtime authorization, arbitrary alias resolution or lock safety.

The [project update path](../src/modules/admin/project/README.md) is covered by
these strict roots. Full strict coverage of assets, file-access, banned-IP,
project-access and the other admin/project operations remains deferred until
their ports and policy ownership are normalized. WebGL-network and project-change
also retain mixed responsibilities.
Do not extend the strict roots by moving authorization to an unlocked pre-read.
Use the same locked snapshot for policy and persistence, preserving lock order,
transaction retries, version fences and durable outbox writes. Business-module
normalization is a separate card; this change does not perform it.

## Fixture classification

| Existing case | Expected rule / classification | Positive contrast |
| --- | --- | --- |
| `controller-runtime` | `no-controller-runtime` | Injected controller ports; runtime assembly in composition |
| `controller-env` | `no-controller-env` | `loadEnv` in composition |
| `controller-stateful` | `no-controller-global-resource` | Limiter factory called inside composition |
| `repository-global-prisma` | `no-repository-global-prisma` | Required client parameter with generated type import |
| `feature-runtime` | `no-feature-runtime` | Runtime connection in composition |
| `renamed-singleton` (both files) | `no-stateful-module-singleton` | Aliased factory invocation inside an owned factory |
| `stateful-import` (alias and wildcard) | `no-noncomposition-stateful-import` | Real production factory imports in composition |
| Former `index-reexport` | Allowed; moved unchanged to `allowed/resource-factory/index.ts` | Factory re-export alone does not instantiate or hide a process singleton |

The stateful-import negative now references a local fixture exporting the retired
`processUploadLimiter` name. The real production module no longer exports it;
testing a nonexistent export would not establish the intended ownership boundary.
The global-Prisma and runtime negative graphs likewise use explicit local support
files. Positive graphs continue to import real production ports and factories.

Every ownership negative must resolve, exit with status 1 and report its expected
rule ID at the intended fixture file. A matching rule plus an unresolved import
still fails the self-test. Data-plane negatives also require successful resolution
and the intended guard/dependency-cruiser rule. Scoped negatives assert their rule
ID and reject resolution/parse errors as substitutes.

The runner compares ownership fixture files and data-plane case directories with
its explicit case inventory. Positive ownership imports must retain their expected
targets. Deleting a test registration or removing a real positive import therefore
fails, even if the remaining guards would pass. Scoped regressions also verify the
npm command chain and inject forbidden dependencies into isolated copies of the
default production roots, proving that fixtures and production use the same rules.

When adding a rule, add a resolving negative and an allowed contrast, and update
the case/edge inventory. Run the self-test and `npm run architecture`. Tests for
missing ports, omitted cases and broken imports mutate temporary copies only;
never edit a live application module just to exercise the guard.
