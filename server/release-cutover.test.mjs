import { deploySource } from './deploy-source.test-helper.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
	assertControlWorkflowIdentity,
	assertPagesRepositoryBoundary,
} from './verify-github-release-boundaries.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const [dockerfile, packageJson, deploy, buildWorkflow, orchestration, cutover, smoke, releaseMigration] = await Promise.all([
	read('apps/api/Dockerfile'),
	read('apps/api/package.json'),
	deploySource(),
	read('.github/workflows/deploy-api.yml'),
	read('server/release-orchestrate.sh'),
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
assert.match(cutover, /^  workflow_dispatch:/m);
assert.match(cutover, /^    environment: production$/m);
assert.match(cutover, /group: production-object-cutover/);
assert.match(cutover, /cancel-in-progress: false/);
assert.match(cutover, /node server\/verify-release-source\.mjs/);
assert.match(cutover, /GITHUB_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
assert.match(cutover, /Preflight external Pages target and write access before maintenance/);
for (const retired of ['phase1_api_image', 'observation_exception_id', 'exception_profile', 'observation_started_at', 'observation_attestation', 'legacy-audit', 'apply-expand', 'mark-read-cutover', 'contract-preflight', 'authorize-phase1-rollback']) {
  assert.ok(!cutover.includes(retired), `retired transition entrypoint remains: ${retired}`);
}
const ordered = ['Build final web', 'Capture Pages recovery point', 'release-orchestrate.sh" preflight', 'release-orchestrate.sh" backup', 'release-orchestrate.sh" migrate', 'release-orchestrate.sh" activate', 'release-orchestrate.sh" health', 'peaceiris/actions-gh-pages', 'release-orchestrate.sh" smoke'];
let cursor = -1;
for (const marker of ordered) {
  const next = cutover.indexOf(marker, cursor + 1);
  assert.ok(next > cursor, `ordinary release order violation: ${marker}`);
  cursor = next;
}
assert.match(cutover, /steps\.migrate\.outcome == 'skipped'/);
assert.match(cutover, /steps\.restore-pages\.outcome == 'success'/);
assert.match(orchestration, /release-recovery\.mjs" recover/);
assert.doesNotMatch(orchestration, /rollback_tag|previous_image|START_DEDICATED_WORKERS=false/);
assert.ok(orchestration.indexOf('mark-migration') < orchestration.indexOf('release-migrate apply-contract'));

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
assert.match(orchestration, /podman exec gp-api wget[^\n]+api\/health[^\n]+ok[^\n]+true/);
assert.match(orchestration, /smoke-data-plane\.mjs/);
assert.ok(orchestration.includes('[ "$actual_source" = "$RELEASE_SOURCE_SHA" ]'));
assert.ok(orchestration.includes('[ "$actual_digest" = "${FINAL_IMAGE##*@}" ]'));
assert.match(orchestration, /deployed-\$\{RELEASE_SOURCE_SHA\}\.txt/);
const forwardFix = orchestration.slice(orchestration.indexOf('  forward-fix)'));
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
