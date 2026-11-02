# UE metadata inspector (certification incomplete)

The GAME worker invokes this fixed local .NET process after source identity and
common ZIP validation. It uses CUE4Parse revision
`605672df7a993a90094bad92d30c388d87ae6c1a`, fetched at build time with an archive
SHA-256 check. Both NuGet lockfiles are enforced. The sole dependency override
pins Microsoft.Bcl.Memory to 10.0.10 to address GHSA-73j8-2gch-69rq; parser source
is unchanged. Apache-2.0 LICENSE and upstream NOTICE accompany the image.

This is a structural inspection implementation, **not completed UE automatic
acceptance**. No format is certified for PASS. Existing review approval can accept
an inconclusive inspection of the same source; explicit damage is rejected before
approval is considered. HTTP contracts and database schema are unchanged.

| Format | Implemented checks | Remaining certification |
| --- | --- | --- |
| Standard Pak 1–11, non-frozen | Footer recognized by parser; primary SHA-1; v10–11 path/directory SHA-1; virtual mount; entry/header/compression-block ranges | Cooked payload summaries, codecs, payload hashes and executable/project binding |
| Standard IoStore TOC 1–5 | Header/table budgets; required UCAS partitions; chunk/block/method/partition references; directory paths | Container/package metadata connection, chunk integrity and executable/project binding |
| Versioned UE4 loose package, legacy -7 | Summary/export range implementation present but disabled by an empty certified-version registry | Actual loose export fixture, bulk-data declarations/ranges and executable/project binding |

Encrypted, custom, unversioned and unsupported layouts remain REVIEW. Generic
parser exceptions are inconclusive, not evidence of corruption. Confirmed range,
index-hash, unsafe virtual path and required partition failures are REJECT.
The parser does not decode game objects or initialize/download codecs. Uploaded
binaries, DLLs, scripts and codecs are never executed or loaded. CUE4Parse's
explicit UE4.26/UE5.0 standard container interpretations are used only for
structural facts, never as inferred engine versions for automatic acceptance.

## Protocol and limits

The sole argument is an absolute request JSON path. Version 1 input contains
`analysisBytes` and `files: [{path, localPath, bytes}]`; the original ZIP namespace
is data, while local paths are worker-generated opaque numbered files. Output is
one JSON object with `version`, `inspector`, `parserRevision`, and one fact per
Pak/UTOC/package: `{path, format, status, evidence, reasons}`. Status is deliberately
limited to `review | reject`. CLI logs are never searched to decide an outcome.
The TypeScript adapter checks revision, field limits and exact file inventory.
Nonzero exit, unavailable executable and invalid output use infrastructure retry.

The worker reserves source ZIP plus all selected copies and 1 MiB protocol space
before materializing, and checks filesystem free space. It streams each selected
entry once without using repeated ZIP range reads. Materialization shares the
lease cancellation signal. Its private directory is removed after success,
failure or cancellation. The existing stale workspace cleanup covers crashes.
Execution has a 60-second deadline, a combined 1 MiB stdout/stderr limit, and
process-group termination. Managed GC heap is limited to 256 MiB in runtimeconfig;
remaining common semantic budget (at most 32 MiB) is passed to the parser.

## Reproduction

From the repository root, with Python 3.12+, .NET SDK 10.0.402 and Linux x64:

```sh
python3 tools/ue-inspector/prepare.py
dotnet restore tools/ue-inspector/UeInspector.csproj --locked-mode -p:RestorePackagesWithLockFile=true -p:CUE4PARSE_SKIP_NATIVE=true
dotnet publish tools/ue-inspector/UeInspector.csproj --no-restore -c Release -r linux-x64 --self-contained true -p:CUE4PARSE_SKIP_NATIVE=true -o tools/ue-inspector/publish
python3 tools/ue-inspector/test.py tools/ue-inspector/publish/UeInspector
UE_7ZZ=/absolute/path/to/7zz python3 scripts/build-fixtures/unreal.py
python3 tools/ue-inspector/test.py tools/ue-inspector/publish/UeInspector /tmp/pcu-ue-exports/tanks-linux
UE_INSPECTOR_PATH="$PWD/tools/ue-inspector/publish/UeInspector" node --import tsx scripts/build-fixtures/unreal-check.mts tanks-linux tanks-windows shooter-windows
```

`unreal.json` pins original URLs, release, engine provenance, sizes and hashes.
7z is converted to ZIP only in fixture preparation. Fixtures and third-party
binaries are not committed or redistributed. Their upstream licenses apply.
The synthetic CLI checks test damage classification, not export certification.
Loose summary parsing stays disabled until an actual export certifies its version;
unverified interpreter output cannot reject a user package.
The final API image can also be checked without a database:

```sh
docker build -f apps/api/Dockerfile -t pcu-api:ue-local .
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m -v "$PWD/tools/ue-inspector/image-smoke.mjs:/smoke.mjs:ro" --entrypoint node pcu-api:ue-local /smoke.mjs
```

This checks the packaged inspector through the image's compiled common runner,
its managed heap configuration, its default UID and a real hash rejection.
Linux amd64 is locally tested; arm64 publishing is wired with a locked RID graph
but its runtime has not been tested here.

The real-export script runs the actual GAME worker, validates source identity,
executes the installed inspector, verifies REVIEW dispatch and workspace cleanup.

## Observed real exports

Local checks on 2026-10-16 (not production or CI certification):

- TanksUnreal 2.0 Linux: ELF; Pak v11, 1,305 entries; IoStore v5, 828 chunks,
  8,880 compression blocks, 377 directory entries. Worker result REVIEW.
- TanksUnreal 2.0 Windows: PE; Pak v11, 1,306 entries; IoStore v5, 1,339 chunks,
  9,550 blocks, 379 directory entries. Worker result REVIEW.
- Both include a global IoStore container (1 chunk, 25 blocks).
- ShooterGame benchmark-v1.3 Windows: PE and Pak v11 with encrypted index.
  Worker result REVIEW with `ue-encrypted-index`.
- Independent repak v0.2.3 confirmed Linux Pak v11, mount `../../../`, Oodle,
  1,305 entries. retoc v0.1.5 confirmed v5, 828 chunks, 344 packages,
  LocalizedPackages container header, Oodle. These facts agree with the structural
  parser output. `retoc verify` also completed successfully on that IoStore.
  Service payload certification remains separate.

Independent tool release archives used locally (never used by the service):
`repak_cli-x86_64-unknown-linux-gnu.tar.xz` v0.2.3 SHA-256
`933bdb8e26f34e8fd70ea50201efca39df041de58aa83b1cd6eb83da124a2046`;
`retoc_cli-x86_64-unknown-linux-gnu.tar.xz` v0.1.5 SHA-256
`3c309a4aea0c6d0a5c6ee31b1d1b32768eb86ac67e3a1890d677eabe6ce26b36`.

A real loose export has not been acquired. No Unreal Editor, UnrealPak or RunUAT
was found in the checked local Desktop/Downloads/opt locations. A licensed UE
export environment is a prerequisite for that fixture if no suitable public
export is available. Do not enable any UE automatic verdict until real Pak,
IoStore and loose payload validation, damage cases and executable/project binding
have passed the planned certification gates. HTML5 and Pixel Streaming are
outside this implementation.
