import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
	downloadObject,
} from '../../lib/storage.js';
import { safeDeleteObject, safeDeletePrefix } from '../../object-deletion.js';
import { badRequest } from '../../shared/errors.js';
import { validateWebglZipArchiveObject } from '../assets/upload/zip-validation.js';
import { analyzeWebglArchive, uploadWebglArchive } from './archive.js';
import {
	parseWebglEntryKey,
	parseWebglSourceKey,
	type WebglDeploymentKeys,
	type WebglProtectedSourceKeys,
	type WebglPublicDeploymentKeys,
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
		await rollbackWebglPublicDeployment(keys, 'webgl-deploy-rollback');
		throw err;
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true }).catch((err) => {
			logger().warn({ err, tempDir, projectId }, 'Failed to remove WebGL deployment temp directory');
		});
	}
}

/**
 * Roll back only the replaceable public output. The protected source is deliberately
 * absent from this port so a transient pointer failure cannot destroy recovery input.
 */
export async function rollbackWebglPublicDeployment(
	keys: WebglPublicDeploymentKeys,
	reason: string,
): Promise<void> {
	const cfg = env();
	await safeDeletePrefix(cfg.S3_BUCKET_PUBLIC, keys.sitePrefix, reason, {
		projectId: keys.projectId,
		deploymentId: keys.deploymentId,
	}).catch((err) => {
		logger().error(
			{ err, ...keys, reason },
			'Failed to enumerate WebGL public deployment prefix for rollback',
		);
	});
}

/** Delete the protected source only after the upload is intentionally terminal. */
export async function deleteWebglProtectedSource(
	keys: WebglProtectedSourceKeys,
	reason: string,
): Promise<void> {
	const cfg = env();
	await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, keys.sourceKey, reason, {
		projectId: keys.projectId,
		deploymentId: keys.deploymentId,
	}).catch((err) => {
		logger().error({ err, ...keys, reason }, 'Failed to queue WebGL protected source deletion');
	});
}

/** Explicit terminal deletion: remove both recovery input and hosted output. */
export async function deleteWebglDeployment(
	keys: WebglDeploymentKeys,
	reason: string,
): Promise<void> {
	await Promise.all([
		deleteWebglProtectedSource(keys, `${reason}-source`),
		rollbackWebglPublicDeployment(keys, `${reason}-site`),
	]);
}

export async function deleteWebglDeploymentByEntry(
	projectId: number,
	entryKey: string,
	reason: string,
): Promise<void> {
	const keys = parseWebglEntryKey(projectId, entryKey);
	if (!keys) {
		logger().error({ projectId, entryKey, reason }, 'Refusing to delete malformed WebGL entry key');
		return;
	}
	await deleteWebglDeployment(keys, reason);
}
