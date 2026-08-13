# Architecture fixtures

`architecture-fixtures/` is a self-test input set for the API architecture
checks. It is not included by the API TypeScript build, production runtime, or
the production architecture scan.

`forbidden/` contains deliberately invalid dependency graphs. Each case must
continue to fail the relevant `architecture-guard` rule and, where applicable,
the corresponding dependency-cruiser rule. Do not remove, exclude, or repair
these inputs to make a check pass.

`allowed/` is the contrasting valid graph. Its imports intentionally reference
real production modules. The self-test asserts that each intended edge exists
with its exact resolved target and has no unresolved dependency, in addition to
satisfying the existing architecture rules. It is not a collection of stubs: a
missing target or missing intended edge is a self-test failure even when no
forbidden rule matches it.

Run `npm run architecture:self-test -w apps/api` to exercise both fixture
sets. `npm run architecture` (and the CI architecture check) runs that
self-test in addition to the production guard and dependency-cruiser scan.

When adding an architecture rule, add a focused `forbidden/` case and keep an
appropriate `allowed/` contrast when the rule has a valid boundary. Update the
self-test case mapping at the same time, including the expected guard and
dependency-cruiser rule names. Verify both paths: run the self-test normally,
then temporarily change one real `allowed/` import to a nonexistent module and
confirm that the self-test fails specifically with its unresolved-dependency
diagnostic. Restore the import and rerun the self-test before committing.
