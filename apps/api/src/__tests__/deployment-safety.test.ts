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

	it('publishes a tested API image and records its immutable digest without an implicit production cutover', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');
		expect(apiWorkflow).toContain('actions: read');
		expect(apiWorkflow).toContain('npm test --workspace=apps/api');
		expect(apiWorkflow).toContain('npm run build --workspace=apps/api');
		expect(apiWorkflow).toContain('id: release-image');
		expect(apiWorkflow).toContain('RELEASE_SOURCE_SHA=${{ github.sha }}');
		expect(apiWorkflow).toContain('${{ steps.release-image.outputs.digest }}');
		expect(apiWorkflow).not.toContain(':sha-${{ github.sha }}');
		expect(apiWorkflow).not.toContain('SSH deploy to server');
	});

	it('keeps cutover state and release tooling out of the image-publishing workflow', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');
		const apiPaths = pushPaths(repositoryFile('.github/workflows/deploy-api.yml'));
		const releaseGatePath = '.github/release-gates/web-before-api/**';

		expect(apiPaths).toContain(releaseGatePath);
		expect(apiPaths).not.toContain('apps/web/**');
		expect(apiWorkflow).not.toMatch(/release-migrate(?:\.js)?[\s"']+(?:apply-expand|apply-contract)/);
		expect(apiWorkflow).not.toContain('contract-migrate');
	});

	it('leaves production release authorization to the explicit server cutover procedure', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');
		const deployScript = repositoryFile('server/deploy.sh');

		expect(apiWorkflow).toContain('workflow_dispatch:');
		expect(deployScript).toContain('assert_mutation_drained');
		expect(deployScript).toContain('require_immutable_release_images');
		expect(deployScript).toContain('validate_production_boundaries');
	});
});
