import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebglDeploymentKeys } from '../modules/webgl/paths.js';

const mocks = vi.hoisted(() => ({
	safeDeleteObject: vi.fn().mockResolvedValue(undefined),
	safeDeletePrefix: vi.fn().mockResolvedValue(0),
	logError: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({
		S3_BUCKET_PROTECTED: 'protected',
		S3_BUCKET_PUBLIC: 'public',
	}),
}));
vi.mock('../lib/logger.js', () => ({
	logger: () => ({ error: mocks.logError, warn: vi.fn() }),
}));
vi.mock('../object-deletion.js', () => ({
	safeDeleteObject: mocks.safeDeleteObject,
	safeDeletePrefix: mocks.safeDeletePrefix,
}));

import {
	deleteWebglDeployment,
	deleteWebglDeploymentByEntry,
	rollbackWebglPublicDeployment,
} from '../modules/webgl/deployment.js';

const deployment: WebglDeploymentKeys = {
	projectId: 7,
	deploymentId: '123e4567-e89b-42d3-a456-426614174000',
	deploymentPrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/',
	sourceKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/source.zip',
	sitePrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/',
	entryKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/index.html',
};

describe('WebGL deployment compensation boundaries', () => {
	beforeEach(() => vi.clearAllMocks());

	it('rolls back the public prefix without touching the protected recovery source', async () => {
		await rollbackWebglPublicDeployment(deployment, 'pointer-finalization-failed');

		expect(mocks.safeDeletePrefix).toHaveBeenCalledWith(
			'public',
			deployment.sitePrefix,
			'pointer-finalization-failed',
			{ projectId: 7, deploymentId: deployment.deploymentId },
		);
		expect(mocks.safeDeleteObject).not.toHaveBeenCalled();
	});

	it('deletes source and public output only through the explicit terminal operation', async () => {
		await deleteWebglDeployment(deployment, 'project-delete');

		expect(mocks.safeDeleteObject).toHaveBeenCalledWith(
			'protected',
			deployment.sourceKey,
			'project-delete-source',
			{ projectId: 7, deploymentId: deployment.deploymentId },
		);
		expect(mocks.safeDeletePrefix).toHaveBeenCalledWith(
			'public',
			deployment.sitePrefix,
			'project-delete-site',
			{ projectId: 7, deploymentId: deployment.deploymentId },
		);
	});

	it('propagates a durable deletion failure to the workflow caller', async () => {
		mocks.safeDeletePrefix.mockRejectedValueOnce(new Error('orphan queue unavailable'));

		await expect(rollbackWebglPublicDeployment(deployment, 'pointer-finalization-failed'))
			.rejects.toThrow('orphan queue unavailable');
	});

	it('rejects a malformed entry instead of silently losing the only deletion locator', async () => {
		await expect(deleteWebglDeploymentByEntry(7, 'webgl/not-a-valid-entry', 'project-delete'))
			.rejects.toThrow('Malformed WebGL entry key for project 7');
		expect(mocks.logError).toHaveBeenCalledWith(
			{ projectId: 7, entryKey: 'webgl/not-a-valid-entry', reason: 'project-delete' },
			'Refusing to delete malformed WebGL entry key',
		);
		expect(mocks.safeDeleteObject).not.toHaveBeenCalled();
		expect(mocks.safeDeletePrefix).not.toHaveBeenCalled();
	});
});
