#!/usr/bin/env bash
# Read-only online evidence for a later Phase 2 contract cutover.  This does
# not drain writes, reset telemetry, alter the database, or modify Garage.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/graduationproject_v2}"
CUTOVER_STATE_DIR="${CUTOVER_STATE_DIR:-${DEPLOY_DIR}/cutover-state}"
API_CONTAINER="gp-api"
SOURCE_REVISION="${1:-}"

die() {
  echo "ERROR: $*" >&2
  exit 2
}

[[ $# -eq 1 ]] || die "usage: $0 <exact-lowercase-40-character-control-source-revision>"
[[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || die "control source revision must be an exact lowercase 40-character SHA"
[[ "$DEPLOY_DIR" = /* && "$CUTOVER_STATE_DIR" = /* ]] || die "DEPLOY_DIR and CUTOVER_STATE_DIR must be absolute paths"

umask 077
mkdir -p -m 700 "$CUTOVER_STATE_DIR"
chmod 700 "$CUTOVER_STATE_DIR"
AUDIT_DIR="$(mktemp -d "${CUTOVER_STATE_DIR}/online-preflight-${SOURCE_REVISION}-XXXXXXXX")"
chmod 700 "$AUDIT_DIR"

normalize_image_id() {
  local raw_id="$1"
  local image_id="${raw_id#sha256:}"
  [[ "$image_id" =~ ^[0-9a-f]{64}$ && ( "$raw_id" == "$image_id" || "$raw_id" == "sha256:${image_id}" ) ]] || return 1
  printf '%s\n' "$image_id"
}

capture_api_metadata() {
  local destination="$1" state raw_id image_id digest revision
  state="$(podman inspect --format '{{.State.Status}}' "$API_CONTAINER" 2>> "${AUDIT_DIR}/metadata-capture.stderr")" || return 1
  [[ "$state" == running ]] || return 1
  raw_id="$(podman inspect --format '{{.Image}}' "$API_CONTAINER" 2>> "${AUDIT_DIR}/metadata-capture.stderr")" || return 1
  image_id="$(normalize_image_id "$raw_id")" || return 1
  digest="$(podman image inspect "$raw_id" --format '{{.Digest}}' 2>> "${AUDIT_DIR}/metadata-capture.stderr")" || return 1
  revision="$(podman image inspect "$raw_id" --format '{{ index .Labels "org.opencontainers.image.revision" }}' 2>> "${AUDIT_DIR}/metadata-capture.stderr")" || return 1
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ && "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '{\n  "image_id": "%s",\n  "image_digest": "%s",\n  "image_revision": "%s"\n}\n' \
    "$image_id" "$digest" "$revision" > "$destination"
  chmod 600 "$destination"
}

print_runtime_summary() {
  local stage="$1" metadata="$2"
  RUNTIME_STAGE="$stage" RUNTIME_METADATA="$metadata" node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const value = JSON.parse(await readFile(process.env.RUNTIME_METADATA, 'utf8'));
const id = value?.image_id;
const digest = value?.image_digest;
const revision = value?.image_revision;
if (!/^[0-9a-f]{64}$/.test(id) || !/^sha256:[0-9a-f]{64}$/.test(digest) || !/^[0-9a-f]{40}$/.test(revision)) {
  throw new Error('invalid private runtime metadata');
}
console.log(`api_${process.env.RUNTIME_STAGE}_source_revision=${revision}`);
console.log(`api_${process.env.RUNTIME_STAGE}_image_digest=${digest}`);
console.log(`api_${process.env.RUNTIME_STAGE}_image_id=${id}`);
NODE
}

capture_observation() {
  local source="${CUTOVER_STATE_DIR}/phase1-observation"
  if [[ -f "$source" ]]; then
    cp -- "$source" "${AUDIT_DIR}/phase1-observation.raw"
    chmod 600 "${AUDIT_DIR}/phase1-observation.raw"
  fi
}

summarize_observation() {
  local runtime_metadata="$1"
  local raw_observation="${AUDIT_DIR}/phase1-observation.raw"
  OBSERVATION_FILE="$raw_observation" RUNTIME_METADATA="$runtime_metadata" node --input-type=module > "${AUDIT_DIR}/phase1-observation-summary.json" <<'NODE'
import { readFile } from 'node:fs/promises';

const safe = (value) => typeof value === 'string' ? value : '';
const result = { status: 'missing' };
try {
  const raw = await readFile(process.env.OBSERVATION_FILE, 'utf8');
  const fields = new Map();
  const expected = new Set([
    'read_cutover_at', 'phase1_api_image', 'migration_image', 'phase1_image_digest',
    'migration_image_digest', 'phase1_image_id', 'phase1_source_sha',
  ]);
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const index = line.indexOf('=');
    if (index <= 0) throw new Error('invalid');
    const key = line.slice(0, index);
    if (!expected.has(key) || fields.has(key)) throw new Error('invalid');
    fields.set(key, line.slice(index + 1));
  }
  if (fields.size !== expected.size || [...expected].some((key) => !fields.has(key))) throw new Error('invalid');
  const readCutoverAt = safe(fields.get('read_cutover_at'));
  const phase1Image = safe(fields.get('phase1_api_image'));
  const migrationImage = safe(fields.get('migration_image'));
  const phase1Digest = safe(fields.get('phase1_image_digest'));
  const migrationDigest = safe(fields.get('migration_image_digest'));
  const phase1Id = safe(fields.get('phase1_image_id'));
  const phase1Revision = safe(fields.get('phase1_source_sha'));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(readCutoverAt)
    || !Number.isFinite(Date.parse(readCutoverAt))
    || !/^ghcr\.io\/pcugame\/pcu-graduationproject-v2-api@sha256:[0-9a-f]{64}$/.test(phase1Image)
    || migrationImage !== phase1Image
    || !/^sha256:[0-9a-f]{64}$/.test(phase1Digest)
    || phase1Image.split('@')[1] !== phase1Digest
    || migrationDigest !== phase1Digest
    || !/^[0-9a-f]{64}$/.test(phase1Id)
    || !/^[0-9a-f]{40}$/.test(phase1Revision)) throw new Error('invalid');
  const runtime = JSON.parse(await readFile(process.env.RUNTIME_METADATA, 'utf8'));
  const match = runtime.image_id === phase1Id
    && runtime.image_digest === phase1Digest
    && runtime.image_revision === phase1Revision;
  Object.assign(result, { status: match ? 'match' : 'stale', read_cutover_at: readCutoverAt });
} catch {
  if (result.status !== 'missing') result.status = 'malformed';
  else {
    try { await readFile(process.env.OBSERVATION_FILE, 'utf8'); result.status = 'malformed'; } catch {}
  }
}
console.log(JSON.stringify(result));
NODE
  chmod 600 "${AUDIT_DIR}/phase1-observation-summary.json"
}

print_observation_summary() {
  OBSERVATION_SUMMARY="${AUDIT_DIR}/phase1-observation-summary.json" node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const value = JSON.parse(await readFile(process.env.OBSERVATION_SUMMARY, 'utf8'));
if (value.status === 'match' || value.status === 'stale') {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.read_cutover_at)) throw new Error('invalid private observation summary');
  console.log(`phase1_observation_read_cutover_at=${value.read_cutover_at}`);
  console.log(`phase1_observation_runtime=${value.status}`);
} else if (value.status === 'missing' || value.status === 'malformed') {
  console.log(`phase1_observation_runtime=${value.status}`);
} else {
  throw new Error('invalid private observation summary');
}
NODE
}

validate_report() {
  if ! REPORT_FILE="${AUDIT_DIR}/preflight.stdout" node --input-type=module > "${AUDIT_DIR}/report-summary.json" <<'NODE'
import { readFile } from 'node:fs/promises';

const blockerNames = [
  'legacyOnlyActiveAssets', 'unresolvedRepresentations', 'missingObjects', 'objectMetadataMismatches',
  'duplicateCanonicalOwnership', 'malformedWebglDeployments', 'legacyBridgeObservations',
  'playbackOrphans', 'unknownInventoryOwnership', 'activeLegacyUploadSessions',
  'bucketPolicyViolations', 'activeGarageMultipartUploads', 'pendingCleanupOutbox',
  'incompleteObjectRelocations',
];
const countNames = [
  'legacyRowsTotal', 'legacyRowsTerminal', 'backfilledCanonicalRows', 'verifiedCanonicalObjects',
  'verifiedRelocationSources', 'physicalCopies', 'generatedRenditions', 'unresolvedRows',
  'orphanObjects', 'duplicateOwnership', 'legacyFallbackReads',
];
const exactly = (object, names) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === names.length && names.every((name) => Object.hasOwn(object, name));
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
try {
  const report = JSON.parse(await readFile(process.env.REPORT_FILE, 'utf8'));
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || report.version !== 2 || !timestamp(report.startedAt) || !timestamp(report.finishedAt)
    || !exactly(report.inventorySnapshot, ['identity', 'capturedAt', 'objectCount'])
    || typeof report.inventorySnapshot.identity !== 'string' || !timestamp(report.inventorySnapshot.capturedAt)
    || !nonnegative(report.inventorySnapshot.objectCount)
    || !exactly(report.counts, countNames) || !countNames.every((name) => nonnegative(report.counts[name]))
    || !exactly(report.blockers, blockerNames)
    || !blockerNames.every((name) => {
      const blocker = report.blockers[name];
      return blocker && typeof blocker === 'object' && !Array.isArray(blocker)
        && exactly(blocker, ['count', 'samples']) && nonnegative(blocker.count)
        && Array.isArray(blocker.samples) && blocker.samples.every((sample) => typeof sample === 'string');
    })
    || typeof report.clean !== 'boolean' || typeof report.metricObservationReset !== 'boolean'
    || report.metricObservationReset !== false) throw new Error('invalid');
  const blockers = Object.fromEntries(blockerNames.map((name) => [name, report.blockers[name].count]));
  const clean = blockerNames.every((name) => blockers[name] === 0);
  if (report.clean !== clean) throw new Error('inconsistent');
  console.log(JSON.stringify({ clean, counts: report.counts, legacyFallbackReads: report.counts.legacyFallbackReads, blockers }));
} catch {
  console.error('ERROR: preflight report is missing, partial, or malformed');
  process.exitCode = 1;
}
NODE
  then
    return 1
  fi
  chmod 600 "${AUDIT_DIR}/report-summary.json"
}

print_report_summary() {
  REPORT_SUMMARY="${AUDIT_DIR}/report-summary.json" node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const summary = JSON.parse(await readFile(process.env.REPORT_SUMMARY, 'utf8'));
if (typeof summary.clean !== 'boolean' || !Number.isSafeInteger(summary.legacyFallbackReads)
  || summary.legacyFallbackReads < 0 || !summary.blockers || typeof summary.blockers !== 'object') {
  throw new Error('invalid private report summary');
}
for (const [name, count] of Object.entries(summary.blockers)) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid private report summary');
  console.log(`blocker_${name}=${count}`);
}
for (const [name, count] of Object.entries(summary.counts ?? {})) {
  if (!/^[A-Za-z]+$/.test(name) || !Number.isSafeInteger(count) || count < 0) throw new Error('invalid private report counts');
  console.log(`count_${name}=${count}`);
}
console.log(`legacyFallbackReads=${summary.legacyFallbackReads}`);
console.log(`preflight_clean=${summary.clean}`);
NODE
}

capture_observation
if ! capture_api_metadata "${AUDIT_DIR}/runtime-before.json"; then
  echo "Online preflight could not read the running gp-api metadata; audit_path=${AUDIT_DIR}" >&2
  exit 2
fi

set +e
podman exec "$API_CONTAINER" node dist-release/scripts/preflight-canonical-contract.js \
  --batch-size=5 --head-timeout-ms=5000 > "${AUDIT_DIR}/preflight.stdout" 2> "${AUDIT_DIR}/preflight.stderr"
CLI_STATUS=$?
set -e
chmod 600 "${AUDIT_DIR}/preflight.stdout" "${AUDIT_DIR}/preflight.stderr"

AFTER_AVAILABLE=true
if ! capture_api_metadata "${AUDIT_DIR}/runtime-after.json"; then
  AFTER_AVAILABLE=false
fi

echo "online_preflight_audit_path=${AUDIT_DIR}"
echo "control_source_revision=${SOURCE_REVISION}"
print_runtime_summary before "${AUDIT_DIR}/runtime-before.json"
if [[ "$AFTER_AVAILABLE" == true ]]; then
  print_runtime_summary after "${AUDIT_DIR}/runtime-after.json"
  summarize_observation "${AUDIT_DIR}/runtime-after.json"
else
  echo "api_after_runtime=unavailable"
  summarize_observation "${AUDIT_DIR}/runtime-before.json"
fi
print_observation_summary

if [[ "$AFTER_AVAILABLE" != true ]] || ! cmp -s "${AUDIT_DIR}/runtime-before.json" "${AUDIT_DIR}/runtime-after.json"; then
  echo "runtime_drift=detected" >&2
  echo "Online preflight evidence is invalid because gp-api changed during the audit; audit_path=${AUDIT_DIR}" >&2
  exit 2
fi
echo "runtime_drift=none"

case "$CLI_STATUS" in
  0|1) ;;
  2)
    echo "preflight_result=operational-error" >&2
    echo "Online preflight could not complete; inspect the private audit files at ${AUDIT_DIR}" >&2
    exit 2
    ;;
  *)
    echo "preflight_result=unexpected-exit" >&2
    echo "Online preflight returned an unexpected status; inspect the private audit files at ${AUDIT_DIR}" >&2
    exit 2
    ;;
esac

if ! validate_report; then
  echo "Online preflight report is invalid; inspect the private audit files at ${AUDIT_DIR}" >&2
  exit 2
fi
print_report_summary

REPORT_CLEAN="$(REPORT_SUMMARY="${AUDIT_DIR}/report-summary.json" node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const summary = JSON.parse(await readFile(process.env.REPORT_SUMMARY, 'utf8'));
process.stdout.write(summary.clean ? 'true' : 'false');
NODE
)"
if [[ "$CLI_STATUS" == 0 && "$REPORT_CLEAN" == true ]]; then
  exit 0
fi
if [[ "$CLI_STATUS" == 1 && "$REPORT_CLEAN" == false ]]; then
  exit 1
fi
echo "Online preflight exit status and validated report disagree; audit_path=${AUDIT_DIR}" >&2
exit 2
