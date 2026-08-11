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

	it('deploys the matching Web commit before opening the API SSH deployment path', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');
		const webWorkflow = repositoryFile('.github/workflows/deploy-web-pages.yml');
		const webGate = apiWorkflow.indexOf('- name: Wait for matching Web deployment');
		const sshDeploy = apiWorkflow.indexOf('- name: SSH deploy to server');
		const gateBlock = apiWorkflow.slice(webGate, sshDeploy);

		expect(webGate).toBeGreaterThanOrEqual(0);
		expect(sshDeploy).toBeGreaterThan(webGate);
		expect(apiWorkflow).toContain('actions: read');
		expect(gateBlock).toContain("if: steps.release-order.outputs.require_web_first == 'true'");
		expect(gateBlock).toContain('deploy-web-pages.yml/runs');
		expect(gateBlock).toContain('-f head_sha="${GITHUB_SHA}"');
		expect(gateBlock).toContain('Web deployment succeeded: ${run_url}');
		expect(gateBlock).toContain('https://pcugame.github.io/release-sha.txt?expected=${GITHUB_SHA}');
		expect(gateBlock).toContain('if [ "${deployed_sha}" = "${GITHUB_SHA}" ]');
		expect(webWorkflow).not.toContain('Wait for matching API deployment');
		expect(webWorkflow).not.toContain('deploy-api.yml/runs');
		expect(webWorkflow.indexOf('- name: Stamp release commit')).toBeLessThan(
			webWorkflow.indexOf('- name: Deploy to pcugame.github.io'),
		);
		expect(webWorkflow).toContain('dist/release-sha.txt');
	});

	it('gates only explicitly declared compatibility releases', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');
		const releaseDeclaration = repositoryFile(
			'.github/release-gates/web-before-api/2026-08-upload-idempotency.yml',
		);
		const apiPaths = pushPaths(repositoryFile('.github/workflows/deploy-api.yml'));
		const webPaths = pushPaths(repositoryFile('.github/workflows/deploy-web-pages.yml'));
		const releaseGatePath = '.github/release-gates/web-before-api/**';

		expect(apiWorkflow).toContain('git diff --name-only "${BEFORE_SHA}" "${GITHUB_SHA}"');
		expect(apiWorkflow).toContain("grep -q '^\\.github/release-gates/web-before-api/'");
		expect(apiPaths).toContain(releaseGatePath);
		expect(webPaths).toContain(releaseGatePath);
		expect(webPaths).not.toContain('apps/api/**');
		expect(apiPaths).not.toContain('apps/web/**');
		expect(releaseDeclaration).toContain('Idempotency-Key');
	});

	it('keeps manual API hotfixes independent unless Web-first is requested', () => {
		const apiWorkflow = repositoryFile('.github/workflows/deploy-api.yml');

		expect(apiWorkflow).toContain('require_web_first:');
		expect(apiWorkflow).toContain('default: false');
		expect(apiWorkflow).toContain('MANUAL_REQUIRE_WEB_FIRST: ${{ inputs.require_web_first }}');
	});
});
