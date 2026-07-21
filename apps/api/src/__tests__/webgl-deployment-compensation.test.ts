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
});
