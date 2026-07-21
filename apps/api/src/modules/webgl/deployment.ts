import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
	downloadObject,
	safeDeleteObject,
	safeDeletePrefix,
} from '../../lib/storage.js';
import { badRequest } from '../../shared/errors.js';
import { validateWebglZipArchiveObject } from '../assets/upload/zip-validation.js';
import { analyzeWebglArchive, uploadWebglArchive } from './archive.js';
import {
	parseWebglEntryKey,
	parseWebglSourceKey,
	type WebglDeploymentKeys,
} from './paths.js';

export async function deployWebglSource(
	projectId: number,
	sourceKey: string,
	sizeBytes: number,
): Promise<WebglDeploymentKeys> {
	const keys = parseWebglSourceKey(projectId, sourceKey);
	if (!keys) throw badRequest('WebGL upload has an invalid deployment key');

	const cfg = env();
	const summary = await validateWebglZipArchiveObject(
		cfg.S3_BUCKET_PROTECTED,
		sourceKey,
		sizeBytes,
	);
	const layout = analyzeWebglArchive(summary);
	const tempDir = await fsp.mkdtemp(join(tmpdir(), 'pcu-webgl-'));
	const archivePath = join(tempDir, 'source.zip');
	let uploadedKeys: string[] = [];

	try {
		await downloadObject(cfg.S3_BUCKET_PROTECTED, sourceKey, archivePath);
		await uploadWebglArchive(
			archivePath,
			cfg.S3_BUCKET_PUBLIC,
			keys.sitePrefix,
			layout,
			(key) => uploadedKeys.push(key),
		);
		if (!uploadedKeys.includes(keys.entryKey)) {
			throw badRequest('WebGL ZIP did not deploy index.html');
		}
		return keys;
	} catch (err) {
		// Enumerate the whole prefix so an upload that reached object storage but whose
		// client response was interrupted cannot escape the rollback callback tracking.
		await safeDeletePrefix(
			cfg.S3_BUCKET_PUBLIC,
			keys.sitePrefix,
			'webgl-deploy-rollback',
			{ projectId, deploymentId: keys.deploymentId },
		).catch((cleanupErr) => {
			logger().error(
				{ err: cleanupErr, projectId, sitePrefix: keys.sitePrefix },
				'Failed to enumerate failed WebGL deployment for rollback',
			);
		});
		throw err;
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true }).catch((err) => {
			logger().warn({ err, tempDir, projectId }, 'Failed to remove WebGL deployment temp directory');
		});
	}
}

/** Remove both the protected source ZIP and every hosted object for a deployment. */
export async function cleanupWebglDeployment(
	keys: WebglDeploymentKeys,
	reason: string,
): Promise<void> {
	const cfg = env();
	await Promise.all([
		safeDeleteObject(cfg.S3_BUCKET_PROTECTED, keys.sourceKey, `${reason}-source`, {
			projectId: keys.projectId,
			deploymentId: keys.deploymentId,
		}).catch((err) => {
			logger().error({ err, ...keys, reason }, 'Failed to queue WebGL source cleanup');
		}),
		safeDeletePrefix(cfg.S3_BUCKET_PUBLIC, keys.sitePrefix, `${reason}-site`, {
			projectId: keys.projectId,
			deploymentId: keys.deploymentId,
		}).catch((err) => {
			logger().error({ err, ...keys, reason }, 'Failed to enumerate WebGL deployment prefix for cleanup');
		}),
	]);
}

export async function cleanupWebglEntry(
	projectId: number,
	entryKey: string,
	reason: string,
): Promise<void> {
	const keys = parseWebglEntryKey(projectId, entryKey);
	if (!keys) {
		logger().error({ projectId, entryKey, reason }, 'Refusing to clean malformed WebGL entry key');
		return;
	}
	await cleanupWebglDeployment(keys, reason);
}
