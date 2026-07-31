import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
	ObjectStorage,
} from '../../application/ports.js';
import type { ObjectDeletionCoordinator } from '../../application/object-deletion.js';
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

export interface WebglDeploymentDependencies {
	config: {
		publicBucket: string;
		protectedBucket: string;
	};
	storage: Pick<ObjectStorage, 'readRange' | 'stream' | 'upload'>;
	fileSystem: Pick<
		FileSystem,
		'temporaryDirectory' | 'createWriteStream' | 'remove'
	>;
	ids: IdGenerator;
	deletion: Pick<
		ObjectDeletionCoordinator,
		| 'deleteOrQueue'
		| 'deletePrefixOrQueue'
		| 'deleteDurablyQueued'
		| 'deleteDurablyQueuedPrefix'
	>;
	logger: Pick<AppLogger, 'warn' | 'error'>;
}

/**
 * Build the WebGL deployment adapter from one BackendContext's ports. Factory
 * creation performs no filesystem or object-storage work.
 */
export function createWebglDeployment(deps: WebglDeploymentDependencies) {
	async function rollbackPublicDeployment(
		keys: WebglPublicDeploymentKeys,
		reason: string,
	): Promise<void> {
		await deps.deletion.deletePrefixOrQueue(
			deps.config.publicBucket,
			keys.sitePrefix,
			reason,
			{
				projectId: keys.projectId,
				deploymentId: keys.deploymentId,
			},
		);
	}

	async function deploySource(
		projectId: number,
		sourceKey: string,
		sizeBytes: number,
	): Promise<WebglDeploymentKeys> {
		const keys = parseWebglSourceKey(projectId, sourceKey);
		if (!keys) throw badRequest('WebGL upload has an invalid deployment key');

		const summary = await validateWebglZipArchiveObject(
			sizeBytes,
			(start, end) => deps.storage.readRange(
				deps.config.protectedBucket,
				sourceKey,
				start,
				end,
			),
		);
		const layout = analyzeWebglArchive(summary);
		const tempId = deps.ids.next().replace(/[^a-zA-Z0-9-]/g, '');
		if (!tempId) throw new Error('WebGL deployment ID generator returned an unsafe value');
		const archivePath = join(
			deps.fileSystem.temporaryDirectory(),
			`pcu-webgl-${tempId}.zip`,
		);
		const uploadedKeys: string[] = [];

		try {
			const source = await deps.storage.stream(
				deps.config.protectedBucket,
				sourceKey,
			);
			if (!source) throw badRequest('WebGL source object was not found');
			await pipeline(source.body, deps.fileSystem.createWriteStream(archivePath));
			await uploadWebglArchive(
				archivePath,
				deps.config.publicBucket,
				keys.sitePrefix,
				layout,
				(bucket, key, body, contentType, contentLength, options) => (
					deps.storage.upload(
						bucket,
						key,
						body,
						contentType,
						contentLength,
						options,
					)
				),
				(key) => uploadedKeys.push(key),
			);
			if (!uploadedKeys.includes(keys.entryKey)) {
				throw badRequest('WebGL ZIP did not deploy index.html');
			}
			return keys;
		} catch (error) {
			// Enumerate the whole prefix so an upload that reached object storage
			// but whose response was interrupted cannot escape compensation.
			await rollbackPublicDeployment(keys, 'webgl-deploy-rollback');
			throw error;
		} finally {
			await deps.fileSystem.remove(archivePath).catch((error) => {
				deps.logger.warn(
					{ err: error, archivePath, projectId },
					'Failed to remove WebGL deployment temp archive',
				);
			});
		}
	}

	async function deleteProtectedSource(
		keys: WebglProtectedSourceKeys,
		reason: string,
	): Promise<void> {
		await deps.deletion.deleteOrQueue(
			deps.config.protectedBucket,
			keys.sourceKey,
			reason,
			{
				projectId: keys.projectId,
				deploymentId: keys.deploymentId,
			},
		);
	}

	async function deleteDeployment(
		keys: WebglDeploymentKeys,
		reason: string,
	): Promise<void> {
		await Promise.all([
			deleteProtectedSource(keys, `${reason}-source`),
			rollbackPublicDeployment(keys, `${reason}-site`),
		]);
	}

	async function deleteDeploymentByEntry(
		projectId: number,
		entryKey: string,
		reason: string,
	): Promise<void> {
		const keys = parseWebglEntryKey(projectId, entryKey);
		if (!keys) {
			deps.logger.error(
				{ projectId, entryKey, reason },
				'Refusing to delete malformed WebGL entry key',
			);
			throw new Error(`Malformed WebGL entry key for project ${projectId}`);
		}
		await deleteDeployment(keys, reason);
	}

	/** Cleanup after the same transaction persisted source+prefix outbox rows. */
	async function deleteDurablyQueuedDeployment(
		keys: WebglDeploymentKeys,
		reason: string,
	): Promise<void> {
		await Promise.all([
			deps.deletion.deleteDurablyQueued(
				deps.config.protectedBucket,
				keys.sourceKey,
				`${reason}-source`,
				{
					projectId: keys.projectId,
					deploymentId: keys.deploymentId,
				},
			),
			deps.deletion.deleteDurablyQueuedPrefix(
				deps.config.publicBucket,
				keys.sitePrefix,
				`${reason}-site`,
				{
					projectId: keys.projectId,
					deploymentId: keys.deploymentId,
				},
			),
		]);
	}

	async function deleteDurablyQueuedDeploymentByEntry(
		projectId: number,
		entryKey: string,
		reason: string,
	): Promise<void> {
		const keys = parseWebglEntryKey(projectId, entryKey);
		if (!keys) {
			deps.logger.error(
				{ projectId, entryKey, reason },
				'Refusing to delete malformed WebGL entry key',
			);
			throw new Error(`Malformed WebGL entry key for project ${projectId}`);
		}
		await deleteDurablyQueuedDeployment(keys, reason);
	}

	return {
		deploySource,
		rollbackPublicDeployment,
		deleteProtectedSource,
		deleteDeployment,
		deleteDeploymentByEntry,
		deleteDurablyQueuedDeployment,
		deleteDurablyQueuedDeploymentByEntry,
	};
}
