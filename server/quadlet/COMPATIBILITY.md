# Quadlet compatibility policy

The minimum supported Podman/Quadlet pair is **5.4.2**, with cgroup v2.
No host upgrade is required for the pod exit policy. Versions below 5.4.2 are
unverified and unsupported. Newer versions must pass the same native-generator
parity and isolated lifecycle checks before deployment; version comparison alone
does not establish compatibility. Distribution-patched generators must be tested
using their actual binary, supplied through `QUADLET_GENERATOR`.

`graduationproject.pod` intentionally uses
`PodmanArgs=--exit-policy=continue`. Do not delete it or replace it with
`ExitPolicy=continue` while supporting 5.4.2. The unmodified upstream 5.4.2
generator rejects the latter key, exits nonzero, and does not generate the pod
service. Its pod-create command contains its default `--exit-policy=stop`, then
appends `PodmanArgs`, so the final scalar flag is `--exit-policy=continue`.
Podman's CLI registers this option as a pflag string: the last occurrence wins.
The build helper verifies that behavior using the exact vendored pflag version.

This preserves the infra container when the final workload exits, so intentional
application drains do not terminate the pod or PostgreSQL. `Restart=always` is
owned by each workload service; an explicit systemd stop suppresses restart.
The generator graph also matters: the pod **Wants** workloads, workloads bind to
the pod, API is ordered after PostgreSQL, and workers after API. Ordering alone
does not prove PostgreSQL readiness or API health. Pod-wide starts can enqueue
every workload; first adoption therefore needs the staged procedure in
[first-adoption runbook](ADOPTION.md), including application masks until each readiness gate.

## Reproduce without runtime access

Run on a development/CI machine, not in a production unit directory. The helper
downloads the pinned upstream source archive, checks SHA-256, builds only
`cmd/quadlet` with vendored dependencies and CGO disabled, and runs the parser
probe. It never invokes Podman, pulls an image, installs units, or loads systemd.
Go >=1.22.8, curl, tar and sha256sum are required. Select a new absolute temporary
directory; the helper refuses to overwrite one.

```sh
bash server/quadlet/build-compat-generator.sh /tmp/quadlet-5.4.2-check
QUADLET_GENERATOR=/tmp/quadlet-5.4.2-check/quadlet \
  QUADLET_EXPECT_VERSION=5.4.2 python3 server/quadlet/parity.test.py
```

The source archive SHA-256 is
`8da62c25956441b14d781099e803e38410a5753e5c7349bcd34615b9ca5ed4f2`.
The production-version CI gate builds this generator and sets both variables;
an unavailable executable or incorrect version is a failure, never a silent
skip. Without explicit selection, ordinary local parity tests may run without
a generator; that result does not satisfy this compatibility gate.

Tests generate all ten services and the sole pod autostart link into temporary
directories with private fixture environment. They verify the effective final
exit-policy argument, `--add-host postgres:127.0.0.1`, volume identity
`gp_pg_data`, workload pod membership and dependencies, and restart policy.
They also reproduce the unsupported native `ExitPolicy` key failure in 5.4.2.
These are generator/CLI-parser checks; they do not prove a running container's
hostname resolution or DB connection.

On an isolated development machine with user systemd, the additional surrogate
test runs harmless uniquely named transient services and never executes generated
Podman commands. It starts/stops its own fixtures only:

```sh
QUADLET_GENERATOR=/tmp/quadlet-5.4.2-check/quadlet \
  QUADLET_EXPECT_VERSION=5.4.2 RUN_QUADLET_LIFECYCLE_TESTS=1 \
  python3 server/quadlet/lifecycle.test.py
```

For syntax verification only, the generator's `PODMAN` executable path is set to
`true`; native flags and dependencies remain unchanged and are never executed.
The surrogate validates pod startup with unavailable workload Wants, restart, explicit app-only drain, PostgreSQL survival,
and PostgreSQL restart/start during drain. It does not validate actual containers,
DB readiness, host reboot, or production autostart. Those remain adoption gates.

Upstream references: [5.4.2 Quadlet manual](https://docs.podman.io/en/v5.4.2/markdown/podman-systemd.unit.5.html),
[5.4.2 pod-create manual](https://docs.podman.io/en/v5.4.2/markdown/podman-pod-create.1.html),
[generator implementation](https://github.com/containers/podman/blob/v5.4.2/pkg/systemd/quadlet/quadlet.go),
and [CLI flag registration](https://github.com/containers/podman/blob/v5.4.2/cmd/podman/pods/create.go).
