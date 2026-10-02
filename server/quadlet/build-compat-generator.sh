#!/usr/bin/env bash
# Build only the offline generator and verify vendored CLI scalar precedence.
# Requires curl, sha256sum, tar and Go >=1.22.8; no Podman/runtime access.
set -euo pipefail
[[ $# == 1 && $1 == /* && ! -e $1 ]] || { echo 'Expected a new absolute output directory' >&2; exit 1; }
quadlet_build_dir=$1
mkdir -m 700 "$quadlet_build_dir"
curl --fail --silent --show-error --location \
  https://github.com/containers/podman/archive/refs/tags/v5.4.2.tar.gz \
  --output "$quadlet_build_dir/source.tar.gz"
printf '%s  %s\n' 8da62c25956441b14d781099e803e38410a5753e5c7349bcd34615b9ca5ed4f2 \
  "$quadlet_build_dir/source.tar.gz" | sha256sum --check --status
tar -xzf "$quadlet_build_dir/source.tar.gz" -C "$quadlet_build_dir"
cd "$quadlet_build_dir/podman-5.4.2"
CGO_ENABLED=0 go build -mod=vendor -o "$quadlet_build_dir/quadlet" ./cmd/quadlet
cat > "$quadlet_build_dir/podman-5.4.2/quadlet-precedence-probe.go" <<'GO'
package main
import (
    "fmt"
    "github.com/spf13/pflag"
)
func main() {
    flags := pflag.NewFlagSet("offline-pod-create", pflag.ContinueOnError)
    var policy string
    // This is the same scalar registration used by cmd/podman/pods/create.go.
    flags.StringVarP(&policy, "exit-policy", "", "stop", "")
    if err := flags.Parse([]string{"--exit-policy=stop", "--exit-policy=continue"}); err != nil { panic(err) }
    if policy != "continue" { panic("last scalar flag did not win") }
    fmt.Println("Podman 5.4.2 vendored pflag: final --exit-policy=continue wins")
}
GO
CGO_ENABLED=0 go run -mod=vendor ./quadlet-precedence-probe.go
rm quadlet-precedence-probe.go
[[ $("$quadlet_build_dir/quadlet" --version) == 5.4.2 ]]
echo "Offline Quadlet 5.4.2 generator: $quadlet_build_dir/quadlet"
