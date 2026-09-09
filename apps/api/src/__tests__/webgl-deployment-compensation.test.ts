import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createWebglDeployment } from '../modules/webgl/deployment.js';
import type { WebglDeploymentKeys } from '../modules/webgl/paths.js';

const deployment: WebglDeploymentKeys = {
	projectId: 7,
	deploymentId: '123e4567-e89b-42d3-a456-426614174000',
	deploymentPrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/',
	sourceKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/source.zip',
	sitePrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/',
	entryKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/index.html',
};

function harness() {
	const deletion = {
		deleteOrQueue: vi.fn().mockResolvedValue(undefined),
		deletePrefixOrQueue: vi.fn().mockResolvedValue(0),
	};
	const logError = vi.fn();
	const adapter = createWebglDeployment({
		config: { protectedBucket: 'protected', publicBucket: 'public' },
		storage: {
			readRange: vi.fn(),
			stream: vi.fn(),
			upload: vi.fn(),
		},
		fileSystem: {
			temporaryDirectory: () => '/tmp',
			createWriteStream: () => new Writable({
				write(_chunk, _encoding, callback) {
					callback();
				},
			}),
			remove: vi.fn(),
		},
		ids: { next: () => '123e4567-e89b-42d3-a456-426614174999' },
		deletion,
		logger: { warn: vi.fn(), error: logError },
	});
	return { adapter, deletion, logError };
}

describe('WebGL deployment compensation boundaries', () => {
	it('rolls back the public prefix without touching the protected recovery source', async () => {
		const { adapter, deletion } = harness();
		await adapter.rollbackPublicDeployment(deployment, 'pointer-finalization-failed');

		expect(deletion.deletePrefixOrQueue).toHaveBeenCalledWith(
			'public',
			deployment.sitePrefix,
			'pointer-finalization-failed',
			{ projectId: 7, deploymentId: deployment.deploymentId },
		);
		expect(deletion.deleteOrQueue).not.toHaveBeenCalled();
	});

	it('deletes source and public output only through the explicit terminal operation', async () => {
		const { adapter, deletion } = harness();
		await adapter.deleteDeployment(deployment, 'project-delete');

		expect(deletion.deleteOrQueue).toHaveBeenCalledWith(
			'protected',
			deployment.sourceKey,
			'project-delete-source',
			{ projectId: 7, deploymentId: deployment.deploymentId },
		);
		expect(deletion.deletePrefixOrQueue).toHaveBeenCalledWith(
			'public',
			deployment.sitePrefix,
			'project-delete-site',
			{ projectId: 7, deploymentId: deployment.deploymentId },
		);
	});

	it('propagates a durable deletion failure to the workflow caller', async () => {
		const { adapter, deletion } = harness();
		deletion.deletePrefixOrQueue.mockRejectedValueOnce(
			new Error('orphan queue unavailable'),
		);

		await expect(adapter.rollbackPublicDeployment(
			deployment,
			'pointer-finalization-failed',
		)).rejects.toThrow('orphan queue unavailable');
	});

	it('rejects a malformed entry instead of silently losing the only deletion locator', async () => {
		const { adapter, deletion, logError } = harness();
		await expect(adapter.deleteDeploymentByEntry(
			7,
			'webgl/not-a-valid-entry',
			'project-delete',
		)).rejects.toThrow('Malformed WebGL entry key for project 7');
		expect(logError).toHaveBeenCalledWith(
			{ projectId: 7, entryKey: 'webgl/not-a-valid-entry', reason: 'project-delete' },
			'Refusing to delete malformed WebGL entry key',
		);
		expect(deletion.deleteOrQueue).not.toHaveBeenCalled();
		expect(deletion.deletePrefixOrQueue).not.toHaveBeenCalled();
	});
});
