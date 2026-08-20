import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function repositoryFile(relativePath: string): string {
	return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

function pushPaths(workflow: string): string[] {
	const pushStart = workflow.indexOf('  push:\n');
	const dispatchStart = workflow.indexOf('  workflow_dispatch:', pushStart);
	if (pushStart < 0 || dispatchStart < 0) return [];
	return Array.from(
		workflow.slice(pushStart, dispatchStart).matchAll(/^\s{6}- '([^']+)'$/gm),
		(match) => match[1]!,
	);
}

describe('production deployment safety', () => {
	it('passes the single-hop proxy trust setting into the production API container', () => {
		const deployScript = repositoryFile('server/deploy.sh');
		const productionEnvExample = repositoryFile('server/.env.example');

		expect(deployScript).toContain('API_BIND_HOST="${API_BIND_HOST:-127.0.0.1}"');
		expect(deployScript).toContain('-e "TRUST_PROXY=${TRUST_PROXY:-1}" \\');
		expect(productionEnvExample).toMatch(/^TRUST_PROXY=1$/m);
	});

	it('deploys the breaking API and workers before allowing the matching Web cutover', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');
		const webWorkflow = repositoryFile('.github/workflows/deploy-web-pages.yml');
		const sshDeploy = apiWorkflow.indexOf('- name: SSH deploy to server');
		const apiGate = webWorkflow.indexOf('- name: Enforce API and workers before breaking-cutover Web');
		const webBuild = webWorkflow.indexOf('- name: Build');

		expect(sshDeploy).toBeGreaterThanOrEqual(0);
		expect(apiGate).toBeGreaterThanOrEqual(0);
		expect(webBuild).toBeGreaterThan(apiGate);
		expect(apiWorkflow).toContain('actions: read');
		expect(apiWorkflow).toContain('deploy.sh" cutover');
		expect(apiWorkflow).not.toContain('Wait for matching Web deployment');
		expect(webWorkflow).toContain('deploy-api.yml/runs');
		expect(webWorkflow).toContain('-f head_sha="${GITHUB_SHA}"');
		expect(webWorkflow).toContain('Matching API/worker deployment failed');
		expect(webWorkflow.indexOf('- name: Stamp release commit')).toBeLessThan(
			webWorkflow.indexOf('- name: Deploy to pcugame.github.io'),
		);
		expect(webWorkflow).toContain('dist/release-sha.txt');
	});

	it('uses an explicit maintenance gate for the breaking direct-only release', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');
		const cutoverDeclaration = repositoryFile(
			'.github/release-gates/cutover-maintenance/2026-08-control-plane-object-transfer.yml',
		);
		const apiPaths = pushPaths(repositoryFile('.github/workflows/deploy-api.yml'));
		const webPaths = pushPaths(repositoryFile('.github/workflows/deploy-web-pages.yml'));
		const releaseGatePath = '.github/release-gates/cutover-maintenance/**';

		expect(apiPaths).toContain(releaseGatePath);
		expect(webPaths).toContain(releaseGatePath);
		expect(webPaths).not.toContain('apps/api/**');
		expect(apiPaths).not.toContain('apps/web/**');
		expect(cutoverDeclaration).toContain('policy: api-workers-before-web-maintenance');
		expect(cutoverDeclaration).toContain('Old writers must be drained');
		expect(cutoverDeclaration).toContain('old API image must never');
		expect(apiWorkflow).not.toContain('previous_api_image');
	});

	it('does not offer a Web-first compatibility bypass for manual API deployment', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');

		expect(apiWorkflow).toContain('workflow_dispatch:');
		expect(apiWorkflow).not.toContain('require_web_first');
		expect(apiWorkflow).not.toContain('MANUAL_REQUIRE_WEB_FIRST');
	});

	it('installs a pinned age-based Garage incomplete-upload safety net without replacing exact cleanup tasks', () => {
		const deployScript = repositoryFile('server/deploy.sh');
		const cleanupScript = repositoryFile('server/garage-incomplete-upload-cleanup.sh');
		const productionEnvExample = repositoryFile('server/.env.example');
		const runbook = repositoryFile('docs/upload-lifecycle-runbook.md');
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');

		expect(deployScript).toContain('bucket cleanup-incomplete-uploads --help');
		expect(deployScript).toContain('INCOMPLETE_MULTIPART_MAX_AGE must exceed UPLOAD_SESSION_TTL_MINUTES');
		expect(deployScript).toContain('garage-incomplete-upload-cleanup.timer');
		expect(deployScript).toContain('OnUnitActiveSec=6h');
		expect(cleanupScript).toContain('bucket cleanup-incomplete-uploads --older-than "$max_age"');
		expect(cleanupScript).toContain('"$protected_bucket" "$staging_bucket"');
		expect(cleanupScript).toContain('>/dev/null 2>&1');
		expect(productionEnvExample).toMatch(/^INCOMPLETE_MULTIPART_MAX_AGE=2d$/m);
		expect(productionEnvExample).toMatch(/^GARAGE_MAINTENANCE_IMAGE=dxflrs\/garage:v1\.1\.0$/m);
		expect(apiWorkflow).toContain('garage-incomplete-upload-cleanup.sh');
		expect(apiWorkflow).toContain('chmod +x "${DEPLOY_DIR}/garage-incomplete-upload-cleanup.sh"');
		expect(runbook).toContain('DB의 exact-key/upload-ID abort task');
	});

	it('starts the aggregate integration suite from a fresh integration-only Compose volume', () => {
		const integrationRunner = repositoryFile('scripts/run-integration.mjs');
		const rootPackage = JSON.parse(repositoryFile('package.json')) as {
			scripts: Record<string, string>;
		};
		const resetStep = integrationRunner.indexOf("[npm, ['run', 'testenv:reset']]");
		const stopBackgroundWorkers = integrationRunner.indexOf(
			"'stop', 'validation-worker', 'export-worker'",
		);
		const firstPostgresTest = integrationRunner.indexOf(
			"[npm, ['run', 'test:integration:orphan-durability']]",
		);

		expect(resetStep).toBeGreaterThanOrEqual(0);
		expect(stopBackgroundWorkers).toBeGreaterThan(resetStep);
		expect(stopBackgroundWorkers).toBeLessThan(firstPostgresTest);
		expect(resetStep).toBeLessThan(firstPostgresTest);
		expect(integrationRunner).not.toContain("[npm, ['run', 'testenv:up']]");
		expect(rootPackage.scripts['testenv:reset']).toBe(
			'docker compose -f docker-compose.integration.yml down -v --remove-orphans && npm run testenv:up',
		);
		expect(rootPackage.scripts['testenv:reset']).not.toContain('DATABASE_URL');
		expect(integrationRunner).toContain(
			"'up', '-d', '--no-deps', '--wait', 'validation-worker'",
		);
		expect(integrationRunner).toContain(
			"'run', '--rm', '--no-deps', 'e2e'",
		);
		const integrationCompose = repositoryFile('docker-compose.integration.yml');
		expect(integrationCompose).toContain(
			'INTEGRATION_SIGNED_S3_INTERNAL_URL: http://upload-part-origin:8080',
		);
	});
});
