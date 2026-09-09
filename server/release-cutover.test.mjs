import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
	assertControlWorkflowIdentity,
	assertPagesRepositoryBoundary,
} from './verify-github-release-boundaries.mjs';

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
assert.match(dockerfile, /LABEL org\.opencontainers\.image\.revision="\$\{RELEASE_SOURCE_SHA\}"/);
assert.match(buildWorkflow, /RELEASE_SOURCE_SHA=\$\{\{ github\.sha \}\}/);
assert.doesNotMatch(buildWorkflow, /:sha-\$\{\{ github\.sha \}\}/);
assert.doesNotMatch(webWorkflow, /^  push:/m, 'master pushes must not publish the Phase 2 web during Phase 1 observation');
assert.match(webWorkflow, /^  workflow_dispatch:/m);
assert.match(webWorkflow, /^    environment: production$/m);
assert.match(webWorkflow, /printf '%s\\n' "\$\{GITHUB_SHA\}" > dist\/release-sha\.txt/);
for (const workflow of [webWorkflow, cutover]) {
	assert.match(workflow, /group: production-object-cutover/);
	assert.match(workflow, /cancel-in-progress: false/);
	assert.match(workflow, /node server\/verify-github-release-boundaries\.mjs control/);
	assert.match(workflow, /GITHUB_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
	assert.match(workflow, /\[ "\$\{GITHUB_REPOSITORY\}" = pcugame\/pcugame\.github\.io-infra \]/);
	assert.match(workflow, /\[ "\$\{GITHUB_DEFAULT_BRANCH\}" = master \]/);
	assert.match(workflow, /\[ "\$\{GITHUB_REF\}" = refs\/heads\/master \]/);
	assert.match(workflow, /node server\/verify-github-release-boundaries\.mjs pages/);
	const pagesPublish = workflow.indexOf('peaceiris/actions-gh-pages@v4');
	const pagesBoundary = workflow.lastIndexOf('node server/verify-github-release-boundaries.mjs pages', pagesPublish);
	assert.ok(pagesBoundary >= 0 && pagesPublish > pagesBoundary, 'Pages repository boundary must be re-verified immediately before publication');
}
const cutoverJob = cutover.slice(cutover.indexOf('  cutover:'));
assert.match(cutoverJob, /environment: production[\s\S]*Re-verify production control repository and default branch/);
assert.match(cutoverJob, /Preflight external Pages single-writer boundary before maintenance/);
assert.match(cutover, /EXPECTED_IMAGE_REPO: ghcr\.io\/pcugame\/pcu-graduationproject-v2-api/);
assert.match(cutover, /final_api_image must be an immutable @sha256 digest/);
assert.match(cutover, /phase1_api_image must be an immutable @sha256 digest/);
for (const marker of [
	'drain', 'legacy-audit', 'backup "phase1-', 'garage-before-expand-',
	'apply-expand', 'backfill --apply', 'phase1-reconciliation', 'mark-read-cutover',
	'I_ATTEST_24H_ZERO_FALLBACK', 'garage-before-contract-', 'contract-preflight',
	'apply-contract', 'RELEASE_SCHEMA_PHASE=phase2',
]) assert.ok(cutover.includes(marker), `cutover workflow missing ${marker}`);

const ordered = [
	'export API_IMAGE="${PHASE1_IMAGE}"',
	'export MIGRATION_IMAGE="${PHASE1_IMAGE}"',
	'export RELEASE_SOURCE_SHA="${PHASE1_SOURCE_SHA}"',
	'release-artifact-preflight phase1',
	'authorize-phase1-rollback "${rollback_nonce}"',
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
assert.match(
	phase1Block,
	/podman run --rm --pod graduationproject \\\n\s+--user 0:0 \\\n\s+-v "\$\{CUTOVER_STATE_DIR\}:\/release-state:ro,Z"/,
	'observation-start verifier must read rootless release-state files as the deploy user mapping',
);
assert.ok(
	phase1Block.indexOf('release-artifact-preflight phase1') < phase1Block.indexOf('"${DEPLOY_DIR}/deploy.sh" drain'),
	'Phase 1 marker/worker validation must precede the first mutation drain',
);
const phase2Block = cutover.slice(cutover.indexOf('- name: Prepare atomic Phase 2 maintenance window'));
assert.match(phase2Block, /export API_IMAGE="\$\{FINAL_IMAGE\}"[\s\S]*export MIGRATION_IMAGE="\$\{FINAL_IMAGE\}"/);
assert.match(phase2Block, /\[ "\$\{phase1_api_image\}" = "\$\{migration_image\}" \]/);
assert.match(phase2Block, /\[ "\$\{phase1_image_digest\}" = "\$\{migration_image_digest\}" \]/);
assert.match(phase2Block, /current_phase1_image_id[\s\S]*phase1_image_id/);
assert.match(phase2Block, /raw_current_phase1_image_id[\s\S]*normalize_podman_image_id[\s\S]*current_phase1_image_id/);
assert.match(phase2Block, /current_phase1_source_sha[\s\S]*phase1_source_sha/);

const normalizerStartMarker = '# BEGIN PHASE1_IMAGE_ID_NORMALIZER (exercised from the release test)';
const normalizerEndMarker = '# END PHASE1_IMAGE_ID_NORMALIZER';
const normalizerStart = cutover.indexOf(normalizerStartMarker);
const normalizerEnd = cutover.indexOf(normalizerEndMarker, normalizerStart);
assert.ok(normalizerStart >= 0 && normalizerEnd > normalizerStart, 'workflow image ID normalizer markers are missing');
const workflowNormalizer = cutover
	.slice(normalizerStart + normalizerStartMarker.length, normalizerEnd)
	.split('\n')
	.map((line) => line.replace(/^ {12}/, ''))
	.join('\n');
const imageIdHex = 'a'.repeat(64);
for (const acceptedImageId of [imageIdHex, `sha256:${imageIdHex}`]) {
	const accepted = spawnSync('bash', ['-c', [
		'set -euo pipefail',
		workflowNormalizer,
		`[ "$(normalize_podman_image_id '${acceptedImageId}')" = '${imageIdHex}' ]`,
	].join('\n')], { encoding: 'utf8' });
	assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
}
for (const malformedImageId of [`sha512:${imageIdHex}`, `sha256:${imageIdHex}0`, imageIdHex.toUpperCase()]) {
	const rejected = spawnSync('bash', ['-c', [
		'set -euo pipefail',
		workflowNormalizer,
		`normalize_podman_image_id '${malformedImageId}'`,
	].join('\n')], { encoding: 'utf8' });
	assert.notEqual(rejected.status, 0, `${malformedImageId} unexpectedly passed workflow normalization`);
	assert.match(`${rejected.stdout}\n${rejected.stderr}`, /malformed image ID/);
}

const attestedPhase2 = phase2Block.indexOf('[ "${OBSERVATION_ATTESTATION}" = I_ATTEST_24H_ZERO_FALLBACK ]');
const phase2Drain = phase2Block.indexOf('"${DEPLOY_DIR}/deploy.sh" drain', attestedPhase2);
const finalArtifactPreflight = phase2Block.indexOf('release-artifact-preflight phase2', attestedPhase2);
const serverObservationWindow = phase2Block.indexOf('verify-observation-window "${OBSERVATION_STARTED_AT}"', finalArtifactPreflight);
const finalWebPublish = phase2Block.indexOf('- name: Publish exact final web while mutations remain drained');
const finalWebGate = phase2Block.indexOf('verify-final-web "${RELEASE_SOURCE_SHA}"');
const phase2Preflight = phase2Block.indexOf('"${DEPLOY_DIR}/deploy.sh" contract-preflight', finalWebGate);
const phase2Contract = phase2Block.indexOf('release-migrate apply-contract');
const phase2Runtime = phase2Block.indexOf('RELEASE_SCHEMA_PHASE=phase2 "${DEPLOY_DIR}/deploy.sh" up', phase2Contract);
assert.ok(finalArtifactPreflight >= 0 && finalArtifactPreflight < phase2Drain, 'final artifact preflight must precede downtime');
assert.ok(
	finalArtifactPreflight < serverObservationWindow && serverObservationWindow < phase2Drain,
	'server observation age must be re-read and checked after approval, immediately before drain',
);
assert.ok(phase2Drain < finalWebPublish && finalWebPublish < finalWebGate, 'same-SHA final web must publish after drain and before its exact marker gate');
assert.ok(finalWebGate < phase2Preflight && phase2Preflight < phase2Contract, 'final web gate must precede contract preflight and DDL');
assert.ok(phase2Contract < phase2Runtime, 'final runtime must start only after contract DDL');
assert.match(phase2Block.slice(phase2Drain, phase2Contract), /Test final web[\s\S]*Build final web[\s\S]*Stamp exact cutover commit[\s\S]*peaceiris\/actions-gh-pages@v4/);

const destructiveBoundary = cutover.indexOf('# DESTRUCTIVE DDL BOUNDARY');
assert.ok(destructiveBoundary > cutover.indexOf('release-migrate apply-contract'));
const postContract = cutover.slice(destructiveBoundary);
assert.doesNotMatch(postContract, /rollback_tag|previous_image|START_DEDICATED_WORKERS=false/);
assert.match(postContract, /Automatic old-image rollback is forbidden/);
assert.match(cutover.slice(0, destructiveBoundary), /pre-contract boundary permits[\s\S]*rollback/);

for (const marker of ['BASELINE_MIGRATION', 'apply-expand', 'assert-runtime']) {
	assert.ok(releaseMigration.includes(marker), `release fence missing ${marker}`);
}
for (const migration of [
	'20260821000000_canonical_asset_expand',
	'20260821400000_project_submission_draft_status',
	'20260821500000_project_submission_expand',
]) assert.ok(releaseMigration.includes(migration), `Phase 1 bundle omits ${migration}`);
assert.match(releaseMigration, /stagedMigrate\(PHASE1_MIGRATION_CEILING/);
assert.match(releaseMigration, /assert-runtime requires phase1 or phase2/);
assert.match(releaseMigration, /phase2 runtime requires complete expand history and the contract migration DB record/);
assert.match(releaseMigration, /stagedMigrate\(CONTRACT_MIGRATION/);
assert.doesNotMatch(dockerfile, /rm -rf apps\/api\/prisma\/migrations\/20260822000000_canonical_asset_contract/);
assert.match(deploy, /RELEASE_SCHEMA_PHASE must explicitly be phase1 or phase2/);
assert.match(deploy, /mutation drain marker is absent/);
const releaseCommonArgs = deploy.slice(
	deploy.indexOf('release_common_args() {'),
	deploy.indexOf('assert_postgres_running() {'),
);
assert.match(
	releaseCommonArgs,
	/--user 0:0/,
	'release CLIs must map to the rootless Podman host user when writing release state',
);
for (const name of [
	'SESSION_SECRET',
	'GOOGLE_CLIENT_IDS',
	'CORS_ALLOWED_ORIGINS',
	'API_PUBLIC_URL',
	'WEB_PUBLIC_URL',
]) {
	assert.ok(
		releaseCommonArgs.includes(`-e "${name}=\${${name}}"`),
		`release containers must receive ${name}`,
	);
}
assert.match(deploy, /dist\/phase1-release-manifest\.js/);
assert.match(deploy, /PCU_PHASE1_RUNTIME_V1/);
assert.match(deploy, /refusing to record a mixed-image Phase 1 observation/);
assert.match(deploy, /phase1_api_image=\$\{API_IMAGE\}[\s\S]*migration_image=\$\{MIGRATION_IMAGE\}/);
assert.match(deploy, /phase1_image_digest=\$\(release_image_digest "\$API_IMAGE"\)/);
assert.match(deploy, /phase1_image_id=\$\(release_image_id "\$API_IMAGE"\)/);
assert.match(deploy, /phase1_source_sha=\$\{RELEASE_SOURCE_SHA\}/);
assert.match(deploy, /must use an immutable @sha256 release digest/);
assert.match(deploy, /org\.opencontainers\.image\.revision/);
assert.match(deploy, /authorize-phase1-rollback\) do_authorize_phase1_rollback/);
assert.match(deploy, /ROLLBACK_AUTH_NONCE/);
assert.match(deploy, /rollback image tag no longer resolves to the authorized image ID/);
assert.match(deploy, /mv "\$ROLLBACK_AUTH_FILE" "\$ROLLBACK_CONSUMED_FILE"/);
assert.match(deploy, /--entrypoint node \\\n\s+"\$API_IMAGE" dist\/server\.js/);

for (const status of ['HEAD', '304', '206', '416']) assert.ok(smoke.includes(status), `data-plane smoke missing ${status}`);
assert.match(cutover, /podman stop gp-api[\s\S]*smoke-data-plane\.mjs[\s\S]*podman start gp-api/);
const forwardFix = cutover.slice(cutover.indexOf('phase2-forward-fix ]; then'), cutover.indexOf('[ "${OBSERVATION_ATTESTATION}" = I_ATTEST_24H_ZERO_FALLBACK ]', cutover.indexOf('phase2-forward-fix ]; then')));
assert.match(forwardFix, /release-assert phase2/);
assert.doesNotMatch(forwardFix, /rollback_tag|previous_image/);

assert.doesNotThrow(() => assertControlWorkflowIdentity({
	repository: 'pcugame/pcugame.github.io-infra',
	ref: 'refs/heads/master',
	defaultBranch: 'master',
}));
for (const context of [
	{ repository: 'fork/pcugame.github.io-infra', ref: 'refs/heads/master', defaultBranch: 'master' },
	{ repository: 'pcugame/pcugame.github.io-infra', ref: 'refs/heads/salvage/object-transfer-v2', defaultBranch: 'master' },
	{ repository: 'pcugame/pcugame.github.io-infra', ref: 'refs/heads/master', defaultBranch: 'main' },
]) assert.throws(() => assertControlWorkflowIdentity(context));

const pagesBoundaryFixture = {
	repository: { full_name: 'pcugame/pcugame.github.io', default_branch: 'master', archived: false },
	authenticatedUser: { login: 'release-bot' },
	expectedActor: 'release-bot',
	protection: {
		enforce_admins: { enabled: true },
		allow_deletions: { enabled: false },
		allow_force_pushes: { enabled: true },
		restrictions: { users: [{ login: 'release-bot' }], teams: [], apps: [] },
	},
};
assert.doesNotThrow(() => assertPagesRepositoryBoundary(pagesBoundaryFixture));
for (const invalidBoundary of [
	{ ...pagesBoundaryFixture, repository: { ...pagesBoundaryFixture.repository, full_name: 'attacker/pages' } },
	{ ...pagesBoundaryFixture, authenticatedUser: { login: 'another-writer' } },
	{ ...pagesBoundaryFixture, protection: { ...pagesBoundaryFixture.protection, enforce_admins: { enabled: false } } },
	{ ...pagesBoundaryFixture, protection: { ...pagesBoundaryFixture.protection, allow_force_pushes: { enabled: false } } },
	{ ...pagesBoundaryFixture, protection: { ...pagesBoundaryFixture.protection, restrictions: undefined } },
	{ ...pagesBoundaryFixture, protection: {
		...pagesBoundaryFixture.protection,
		restrictions: { users: [{ login: 'release-bot' }, { login: 'second-writer' }], teams: [], apps: [] },
	} },
]) assert.throws(() => assertPagesRepositoryBoundary(invalidBoundary));

console.log('Two-phase release ordering, artifacts, and rollback fence: OK');
