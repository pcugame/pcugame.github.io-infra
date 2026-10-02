import { deploySource } from './deploy-source.test-helper.mjs';
import assert from 'node:assert/strict';
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
	deploySource(),
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

assert.match(buildWorkflow, /- 'server\/deploy\/\*\*'/);
assert.match(cutover, /source: server\/deploy\.sh,server\/deploy,server\/quadlet/);
assert.doesNotMatch(buildWorkflow, /^  deploy:/m, 'push/build workflow must never deploy');
assert.match(dockerfile, /LABEL org\.opencontainers\.image\.revision="\$\{RELEASE_SOURCE_SHA\}"/);
assert.match(buildWorkflow, /RELEASE_SOURCE_SHA=\$\{\{ github\.sha \}\}/);
assert.doesNotMatch(buildWorkflow, /:sha-\$\{\{ github\.sha \}\}/);
assert.doesNotMatch(webWorkflow, /^  push:/m, 'web publication must remain an explicit production release action');
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
assert.match(cutoverJob, /Preflight external Pages target and write access before maintenance/);
assert.match(cutover, /EXPECTED_IMAGE_REPO: ghcr\.io\/pcugame\/pcu-graduationproject-v2-api/);
assert.match(cutover, /final_api_image must be an immutable @sha256 digest/);
for (const retired of ['phase1_api_image', 'observation_exception_id', 'exception_profile', 'observation_started_at', 'observation_attestation', 'legacy-audit', 'apply-expand', 'mark-read-cutover', 'contract-preflight', 'authorize-phase1-rollback']) {
  assert.ok(!cutover.includes(retired), `retired transition entrypoint remains: ${retired}`);
}
const releaseBlock = cutover.slice(cutover.indexOf('- name: Prepare release maintenance window'));
assert.match(releaseBlock, /export API_IMAGE="\$\{FINAL_IMAGE\}"[\s\S]*export MIGRATION_IMAGE="\$\{FINAL_IMAGE\}"/);
const ordered = ['release-artifact-preflight phase2', 'release-assert phase2', 'release-db-snapshot.sh', 'release-recovery.mjs" capture', 'deploy.sh" drain', 'backup "release-', 'Publish exact final web', 'verify-final-web', 'release-migrate status', 'mark-migration', 'release-migrate apply-contract', 'RELEASE_SCHEMA_PHASE=phase2'];
let cursor = -1;
for (const marker of ordered) {
  const next = releaseBlock.indexOf(marker, cursor + 1);
  assert.ok(next > cursor, `ordinary release order violation: ${marker}`);
  cursor = next;
}
assert.match(cutover, /Test final web[\s\S]*Build final web[\s\S]*Stamp exact release commit[\s\S]*Prepare release maintenance window[\s\S]*peaceiris\/actions-gh-pages@v4/);
assert.match(cutover, /steps\.apply-contract\.outcome == 'skipped'/);
assert.match(cutover, /steps\.restore-pages\.outcome == 'success'/);
assert.match(cutover, /release-recovery\.mjs" recover/);

const destructiveBoundary = cutover.indexOf('# DESTRUCTIVE DDL BOUNDARY');
assert.ok(destructiveBoundary > cutover.indexOf('release-migrate apply-contract'));
const postContract = cutover.slice(destructiveBoundary);
assert.doesNotMatch(postContract, /rollback_tag|previous_image|START_DEDICATED_WORKERS=false/);
assert.match(postContract, /Automatic old-image rollback is forbidden/);
assert.doesNotMatch(cutover, /rollback_tag|previous_image|ROLLBACK_AUTH_NONCE/);

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
assert.match(releaseMigration, /phase2 runtime requires complete expand history, the contract migration DB record and project change migration DB record/);
assert.match(releaseMigration, /stagedMigrate\(latestMigration/);
assert.doesNotMatch(dockerfile, /rm -rf apps\/api\/prisma\/migrations\/20260822000000_canonical_asset_contract/);
assert.match(deploy, /RELEASE_SCHEMA_PHASE must explicitly be phase2/);
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
assert.doesNotMatch(deploy, /PCU_PHASE1_RUNTIME_V1|ROLLBACK_AUTH_NONCE|authorize-phase1-rollback\) do_authorize_phase1_rollback/);
assert.match(deploy, /must use an immutable @sha256 release digest/);
assert.match(deploy, /org\.opencontainers\.image\.revision/);
assert.match(await read('server/quadlet/templates/gp-api.container.in'), /Entrypoint=node\nExec=dist\/server\.js/);

for (const status of ['HEAD', '304', '206', '416']) assert.ok(smoke.includes(status), `data-plane smoke missing ${status}`);
// Per-request authorization fails closed when the API is unavailable. Production
// smoke must keep it healthy; outage injection belongs to isolated integration.
assert.doesNotMatch(cutover, /podman (?:stop|start) gp-api/);
assert.doesNotMatch(cutover, /API-down data-plane smoke/);
assert.match(smoke, /full\.headers\.get\('cache-control'\), 'private, no-store'/);
const finalSmokeStart = cutover.indexOf('            final_smoke() {');
assert.ok(finalSmokeStart > 0);
const finalSmoke = cutover.slice(finalSmokeStart, cutover.indexOf('\n            }', finalSmokeStart));
const finalApplyStart = cutover.indexOf('            # DESTRUCTIVE DDL BOUNDARY:');
assert.ok(finalApplyStart > 0);
const finalApply = cutover.slice(finalApplyStart);
for (const productionSmoke of [finalSmoke, finalApply]) {
	assert.match(productionSmoke, /podman exec gp-api wget[^\n]+api\/health[^\n]+ok[^\n]+true[\s\S]*smoke-data-plane\.mjs/);
	assert.ok(productionSmoke.includes('[ "$actual_source" = "$RELEASE_SOURCE_SHA" ]'));
	assert.ok(productionSmoke.includes('[ "$actual_digest" = "${FINAL_IMAGE##*@}" ]'));
	assert.match(productionSmoke, /deployed-\$\{RELEASE_SOURCE_SHA\}\.txt/);
}
const forwardFixStart = cutover.indexOf('            if [ "${RELEASE_PHASE}" = phase2-forward-fix ]; then');
assert.ok(forwardFixStart > 0);
const forwardFix = cutover.slice(forwardFixStart, cutover.indexOf('        env:', forwardFixStart));
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
	repository: { full_name: 'pcugame/pcugame.github.io', default_branch: 'master', archived: false, permissions: { push: true, admin: false } },
};
assert.doesNotThrow(() => assertPagesRepositoryBoundary(pagesBoundaryFixture));
for (const invalidBoundary of [
	{ repository: { ...pagesBoundaryFixture.repository, full_name: 'attacker/pages' } },
	{ repository: { ...pagesBoundaryFixture.repository, permissions: { push: false } } },
]) assert.throws(() => assertPagesRepositoryBoundary(invalidBoundary));

console.log('Production release ordering, artifacts, and recovery fence: OK');
