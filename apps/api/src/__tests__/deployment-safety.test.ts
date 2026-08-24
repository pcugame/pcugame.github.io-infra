import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function repositoryFile(relativePath: string): string {
	return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('production deployment safety', () => {
	it('passes the single-hop proxy trust setting into the production API container', () => {
		const deployScript = repositoryFile('server/deploy.sh');
		const productionEnvExample = repositoryFile('server/.env.example');

		expect(deployScript).toContain('API_BIND_HOST="${API_BIND_HOST:-127.0.0.1}"');
		expect(deployScript).toContain('-e "TRUST_PROXY=${TRUST_PROXY:-1}" \\');
		expect(productionEnvExample).toMatch(/^TRUST_PROXY=1$/m);
	});

	it('keeps the Phase 1 image workflow outside every production deployment path', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');

		expect(apiWorkflow).toMatch(/^on:\n  workflow_dispatch:\n\npermissions:/m);
		expect(apiWorkflow).not.toContain('\n  push:');
		expect(apiWorkflow).not.toContain('\n  deploy:');
		expect(apiWorkflow).not.toContain('SSH deploy to server');
		expect(apiWorkflow).not.toContain('appleboy/');
		expect(apiWorkflow).not.toContain('podman');
		expect(apiWorkflow).not.toContain('deploy.sh');
		expect(apiWorkflow).not.toContain(':latest');
	});

	it('publishes and verifies only the immutable Phase 1 image identity', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');

		expect(apiWorkflow).toContain('id: build');
		expect(apiWorkflow).toContain('VCS_REF=${{ github.sha }}');
		expect(apiWorkflow).toContain('IMAGE_DIGEST: ${{ steps.build.outputs.digest }}');
		expect(apiWorkflow).toContain('immutable_image="${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"');
		expect(apiWorkflow).toContain('docker pull "${immutable_image}"');
		expect(apiWorkflow).toContain('org.opencontainers.image.revision');
		expect(apiWorkflow).toContain('test "${revision}" = "${SOURCE_SHA}"');
		expect(apiWorkflow).toContain('PCU_PHASE1_RUNTIME_V1');
		expect(apiWorkflow).toContain('${GITHUB_STEP_SUMMARY}');
	});
});
