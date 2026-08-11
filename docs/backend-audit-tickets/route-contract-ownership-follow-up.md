# Route contract ownership follow-up

The crash-consistency work intentionally keeps the fail-closed central registry in
`apps/api/src/shared/http-route-schemas.ts`. Moving the contracts for more than two
hundred accumulated routes at the same time as storage lifecycle changes would make
the safety patch difficult to review and roll back.

A follow-up should move each runtime contract beside its feature controller, export a
typed registration fragment from that feature, and have the HTTP composition root
combine those fragments. The follow-up must preserve the existing duplicate/missing
route checks and runtime schema coverage before deleting the central registry.
