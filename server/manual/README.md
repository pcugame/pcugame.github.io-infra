# Manual container definitions

Start with the [operator guide](../../docs/guide/README.md).

- `rootless/`: dedicated account's Quadlet files; edit application image digests.
- `rootful/`: host-network TLS termination on 443.
- `config/`: human-edited environment, JSON, Garage and Nginx examples.
- `sql/`: explicit empty-database guard, bucket registry and first administrator transaction.
- `verify-*.mjs`: disposable Docker verification fixtures for a development host, never installers.

The original API/worker entrypoints and release renderer remain in place.
Do not mix these manual files into an existing managed Quadlet installation.
See the guide's [verification record](../../docs/guide/verification.md) for tested
behavior and the remaining Debian/Podman and two-host acceptance checks.
