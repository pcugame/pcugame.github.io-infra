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

The object data-plane fixtures intentionally exercise structural bypasses rather
than method-name search alone: a direct route annotated with a readable body, a
direct service calling UploadPart, a direct completion function colocated in a
generically named completion service, an object read through a delivery dependency,
a feature-local AWS SDK import, a Node HTTP asset proxy, an over-privileged signer
port, an unrelated multipart completer, and signed capability data passed to a
logger. Public image/WebGL delivery and UploadPart byte relays have no debt
allowlist: any application object read used for client delivery, or any game-upload
service invocation of UploadPart, fails the production guard.
The completion fixture also proves that a legitimate control-plane function
allowlisted for HEAD/ListParts cannot gain full-object `stream` authority merely
by colocating the call inside that same function.
