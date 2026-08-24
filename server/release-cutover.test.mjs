import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const [dockerfile, packageJson, deploy, buildWorkflow, webWorkflow, cutover, smoke, releaseMigration] = await Promise.all([
	read('apps/api/Dockerfile'),
	read('apps/api/package.json'),
	read('server/deploy.sh'),
	read('.github/workflows/deploy-api.yml'),
	read('.github/workflows/deploy-web-pages.yml'),
	read('.github/workflows/release-api-cutover.yml'),
	read('server/smoke-data-plane.mjs'),
	read('apps/api/scripts/release-migrate.ts'),
]);

assert.doesNotMatch(dockerfile, /CMD[^\n]+prisma\s+migrate\s+deploy/);
assert.match(dockerfile, /COPY --from=builder \/app\/apps\/api\/dist-release/);
for (const cli of ['release:backfill', 'release:preflight', 'release:inventory', 'release:migrate']) {
	assert.ok(JSON.parse(packageJson).scripts[cli]?.startsWith('node dist-release/'), `missing compiled ${cli}`);
}

assert.doesNotMatch(buildWorkflow, /^  deploy:/m, 'push/build workflow must never deploy');
assert.doesNotMatch(webWorkflow, /^  push:/m, 'master pushes must not publish the Phase 2 web during Phase 1 observation');
assert.match(webWorkflow, /^  workflow_dispatch:/m);
assert.match(webWorkflow, /^    environment: production$/m);
assert.match(webWorkflow, /printf '%s\\n' "\$\{GITHUB_SHA\}" > dist\/release-sha\.txt/);
for (const marker of [
	'drain', 'legacy-audit', 'backup "phase1-', 'garage-before-expand-',
	'apply-expand', 'backfill --apply', 'phase1-reconciliation', 'mark-read-cutover',
	'I_ATTEST_24H_ZERO_FALLBACK', 'garage-before-contract-', 'contract-preflight',
	'apply-contract', 'RELEASE_SCHEMA_PHASE=phase2',
]) assert.ok(cutover.includes(marker), `cutover workflow missing ${marker}`);

const ordered = [
	'export API_IMAGE="${PHASE1_IMAGE}"',
	'export MIGRATION_IMAGE="${PHASE1_IMAGE}"',
	'release-artifact-preflight phase1',
	'"${DEPLOY_DIR}/deploy.sh" drain',
	'"${DEPLOY_DIR}/deploy.sh" legacy-audit',
	'"${DEPLOY_DIR}/deploy.sh" backup "phase1-',
	'garage-before-expand-',
	'release-migrate apply-expand',
	'RELEASE_SCHEMA_PHASE=phase1 "${DEPLOY_DIR}/deploy.sh" up',
	'"${DEPLOY_DIR}/deploy.sh" backfill --apply',
	'garage-after-backfill-',
	'phase1-reconciliation.json',
	'"${DEPLOY_DIR}/deploy.sh" mark-read-cutover',
];
let cursor = -1;
for (const marker of ordered) {
	const next = cutover.indexOf(marker, cursor + 1);
	assert.ok(next > cursor, `Phase 1 order violation at ${marker}`);
	cursor = next;
}

const phase1Block = cutover.slice(
	cutover.indexOf('if [ "${RELEASE_PHASE}" = phase1 ]; then'),
	cutover.indexOf('export API_IMAGE="${FINAL_IMAGE}"'),
);
assert.match(phase1Block, /export API_IMAGE="\$\{PHASE1_IMAGE\}"[\s\S]*export MIGRATION_IMAGE="\$\{PHASE1_IMAGE\}"/);
assert.doesNotMatch(phase1Block, /MIGRATION_IMAGE="\$\{FINAL_IMAGE\}"/);
assert.ok(
	phase1Block.indexOf('release-artifact-preflight phase1') < phase1Block.indexOf('"${DEPLOY_DIR}/deploy.sh" drain'),
	'Phase 1 marker/worker validation must precede the first mutation drain',
);
const phase2Block = cutover.slice(cutover.indexOf('export API_IMAGE="${FINAL_IMAGE}"'));
assert.match(phase2Block, /export API_IMAGE="\$\{FINAL_IMAGE\}"[\s\S]*export MIGRATION_IMAGE="\$\{FINAL_IMAGE\}"/);
assert.match(phase2Block, /\[ "\$\{phase1_api_image\}" = "\$\{migration_image\}" \]/);

const attestedPhase2 = phase2Block.indexOf('[ "${OBSERVATION_ATTESTATION}" = I_ATTEST_24H_ZERO_FALLBACK ]');
const phase2Drain = phase2Block.indexOf('"${DEPLOY_DIR}/deploy.sh" drain', attestedPhase2);
const finalWebGate = phase2Block.indexOf('verify-final-web "${GITHUB_SHA}"');
const phase2Preflight = phase2Block.indexOf('"${DEPLOY_DIR}/deploy.sh" contract-preflight', finalWebGate);
const phase2Contract = phase2Block.indexOf('release-migrate apply-contract');
assert.ok(phase2Drain >= 0 && phase2Drain < finalWebGate, 'final web gate must run after the Phase 2 drain');
assert.ok(finalWebGate < phase2Preflight && phase2Preflight < phase2Contract, 'final web gate must precede contract preflight and DDL');

const destructiveBoundary = cutover.indexOf('# DESTRUCTIVE DDL BOUNDARY');
assert.ok(destructiveBoundary > cutover.indexOf('release-migrate apply-contract'));
const postContract = cutover.slice(destructiveBoundary);
assert.doesNotMatch(postContract, /rollback_tag|previous_image|START_DEDICATED_WORKERS=false/);
assert.match(postContract, /Automatic old-image rollback is forbidden/);
assert.match(cutover.slice(0, destructiveBoundary), /pre-contract boundary permits[\s\S]*rollback/);

for (const marker of ['BASELINE_MIGRATION', 'apply-expand', 'apply-contract', 'assert-runtime']) {
	assert.ok(releaseMigration.includes(marker), `release fence missing ${marker}`);
}
for (const migration of [
	'20260821000000_canonical_asset_expand',
	'20260821400000_project_submission_draft_status',
	'20260821500000_project_submission_expand',
]) assert.ok(releaseMigration.includes(migration), `Phase 1 bundle omits ${migration}`);
assert.match(releaseMigration, /stagedMigrate\(PHASE1_TARGET_MIGRATION/);
assert.match(deploy, /RELEASE_SCHEMA_PHASE must explicitly be phase1 or phase2/);
assert.match(deploy, /mutation drain marker is absent/);
assert.match(deploy, /dist\/phase1-release-manifest\.js/);
assert.match(deploy, /PCU_PHASE1_RUNTIME_V1/);
assert.match(deploy, /refusing to record a mixed-image Phase 1 observation/);
assert.match(deploy, /phase1_api_image=\$\{API_IMAGE\}[\s\S]*migration_image=\$\{MIGRATION_IMAGE\}/);
assert.match(deploy, /--entrypoint node \\\n\s+"\$API_IMAGE" dist\/server\.js/);

for (const status of ['HEAD', '304', '206', '416']) assert.ok(smoke.includes(status), `data-plane smoke missing ${status}`);
assert.match(cutover, /podman stop gp-api[\s\S]*smoke-data-plane\.mjs[\s\S]*podman start gp-api/);
const forwardFix = cutover.slice(cutover.indexOf('phase2-forward-fix ]; then'), cutover.indexOf('[ "${OBSERVATION_ATTESTATION}" = I_ATTEST_24H_ZERO_FALLBACK ]', cutover.indexOf('phase2-forward-fix ]; then')));
assert.match(forwardFix, /release-assert phase2/);
assert.doesNotMatch(forwardFix, /rollback_tag|previous_image/);

console.log('Two-phase release ordering, artifacts, and rollback fence: OK');
