import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
	ObjectStorage,
	StorageRequestOptions,
} from '../../application/ports.js';
import type { ObjectDeletionCoordinator } from '../../application/object-deletion.js';
import { badRequest } from '../../shared/errors.js';
import { safeOperationalLogContext } from '../../shared/safe-log-context.js';
import { validateWebglZipArchiveObject } from '../assets/upload/zip-validation.js';
import { analyzeWebglArchive, uploadWebglArchive } from './archive.js';
import {
	bindWebglDeploymentKeys,
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
	storage: Pick<ObjectStorage, 'stream' | 'upload'>;
	fileSystem: Pick<
		FileSystem,
		'temporaryDirectory' | 'createWriteStream' | 'readRange' | 'remove'
	>;
	ids: IdGenerator;
	deletion: Pick<
		ObjectDeletionCoordinator,
		| 'deleteOrQueue'
		| 'deletePrefixOrQueue'
	>;
	logger: Pick<AppLogger, 'warn' | 'error'>;
	storageRequest?: StorageRequestOptions;
}

export interface WebglRollbackOptions {
	storageRequest?: StorageRequestOptions;
	assertClaimOwned?: () => Promise<void>;
}

function combineStorageRequests(
	base?: StorageRequestOptions,
	request?: StorageRequestOptions,
): StorageRequestOptions | undefined {
	if (!base && !request) return undefined;
	const signals = [base?.signal, request?.signal].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	return {
		...(request?.requestTimeoutMs !== undefined
			? { requestTimeoutMs: request.requestTimeoutMs }
			: base?.requestTimeoutMs !== undefined
				? { requestTimeoutMs: base.requestTimeoutMs }
				: {}),
		...(signals.length === 1 ? { signal: signals[0] } : {}),
		...(signals.length > 1 ? { signal: AbortSignal.any(signals) } : {}),
	};
}

function assertRequestActive(request?: StorageRequestOptions): void {
	if (request?.signal?.aborted) {
		throw request.signal.reason ?? new Error('WebGL deployment was aborted');
	}
}

/**
 * Build the WebGL deployment adapter from one BackendContext's ports. Factory
 * creation performs no filesystem or object-storage work.
 */
export function createWebglDeployment(deps: WebglDeploymentDependencies) {
	async function rollbackPublicDeployment(
		keys: WebglPublicDeploymentKeys,
		reason: string,
		options: WebglRollbackOptions = {},
	): Promise<void> {
		const storageRequest = combineStorageRequests(deps.storageRequest, options.storageRequest);
		const assertDeletionClaim = async () => {
			assertRequestActive(storageRequest);
			await options.assertClaimOwned?.();
			assertRequestActive(storageRequest);
		};
		const context = { projectId: keys.projectId, deploymentId: keys.deploymentId };
		if (!storageRequest && !options.assertClaimOwned) {
			await deps.deletion.deletePrefixOrQueue(
				deps.config.publicBucket, keys.sitePrefix, reason, context,
			);
			return;
		}
		await deps.deletion.deletePrefixOrQueue(
			deps.config.publicBucket,
			keys.sitePrefix,
			reason,
			context,
			{ request: storageRequest, beforeList: assertDeletionClaim, beforeDelete: assertDeletionClaim },
		);
	}

	async function deployArchive(
		projectId: number,
		sourceKey: string,
		deploymentId: string,
		archivePath: string,
		sizeBytes: number,
		request?: StorageRequestOptions,
		assertClaimOwned?: () => Promise<void>,
	): Promise<WebglDeploymentKeys> {
		const sourceKeys = parseWebglSourceKey(projectId, sourceKey);
		if (!sourceKeys) throw badRequest('WebGL upload has an invalid protected source key');
		const keys = bindWebglDeploymentKeys(sourceKeys, deploymentId);
		const storageRequest = combineStorageRequests(deps.storageRequest, request);
		assertRequestActive(storageRequest);
		await assertClaimOwned?.();

		const summary = await validateWebglZipArchiveObject(
			sizeBytes,
			(start, end) => deps.fileSystem.readRange(archivePath, start, end),
		);
		assertRequestActive(storageRequest);
		await assertClaimOwned?.();
		const layout = analyzeWebglArchive(summary);
		const uploadedKeys: string[] = [];

		try {
			await uploadWebglArchive(
				archivePath,
				deps.config.publicBucket,
				keys.sitePrefix,
				layout,
				async (bucket, key, body, contentType, contentLength, options) => {
					assertRequestActive(storageRequest);
					return deps.storage.upload(
						bucket,
						key,
						body,
						contentType,
						contentLength,
						options,
						storageRequest,
					);
				},
				(key) => uploadedKeys.push(key),
			);
			assertRequestActive(storageRequest);
			await assertClaimOwned?.();
			if (!uploadedKeys.includes(keys.entryKey)) {
				throw badRequest('WebGL ZIP did not deploy index.html');
			}
			return keys;
		} catch (error) {
			// The public generation was persisted by the processing repository
			// before this method was called. Retaining partial immutable output lets
			// restart retry the same exact prefix; terminal failure owns durable
			// exact-prefix cleanup in the same transaction as its state change.
			deps.logger.warn(
				safeOperationalLogContext({
					err: error,
					projectId,
					generation: deploymentId,
					action: 'deploy_webgl',
					result: 'interrupted',
				}),
				'WebGL deployment was interrupted; retaining its durable prefix for retry',
			);
			throw error;
		}
	}

	/**
	 * Compatibility adapter for internal callers that do not already own a
	 * worker-local archive. It performs one sequential protected-object GET and
	 * all ZIP metadata/decode work against that immutable local copy.
	 */
	async function deploySource(
		projectId: number,
		sourceKey: string,
		deploymentId: string,
		sizeBytes: number,
		request?: StorageRequestOptions,
		assertClaimOwned?: () => Promise<void>,
	): Promise<WebglDeploymentKeys> {
		const storageRequest = combineStorageRequests(deps.storageRequest, request);
		const tempId = deps.ids.next().replace(/[^a-zA-Z0-9-]/g, '');
		if (!tempId) throw new Error('WebGL deployment ID generator returned an unsafe value');
		const archivePath = join(
			deps.fileSystem.temporaryDirectory(),
			`pcu-webgl-${tempId}.zip`,
		);
		try {
			assertRequestActive(storageRequest);
			await assertClaimOwned?.();
			const source = await deps.storage.stream(
				deps.config.protectedBucket,
				sourceKey,
				undefined,
				storageRequest,
			);
			if (!source || 'kind' in source) throw badRequest('WebGL source object was not found');
			await pipeline(source.body, deps.fileSystem.createWriteStream(archivePath), {
				...(storageRequest?.signal ? { signal: storageRequest.signal } : {}),
			});
			if (source.size !== sizeBytes) throw badRequest('WebGL source object size changed');
			await assertClaimOwned?.();
			return await deployArchive(
				projectId,
				sourceKey,
				deploymentId,
				archivePath,
				sizeBytes,
				storageRequest,
				assertClaimOwned,
			);
		} finally {
			await deps.fileSystem.remove(archivePath).catch((error) => {
				deps.logger.warn(
					safeOperationalLogContext({
						err: error,
						projectId,
						generation: deploymentId,
						action: 'remove_webgl_temp',
						result: 'failed',
					}),
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
				deploymentId: keys.sourceDeploymentId ?? 'protected-source',
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
				safeOperationalLogContext({
					projectId,
					action: 'delete_webgl_deployment',
					result: 'malformed_pointer',
				}),
				'Refusing to delete malformed WebGL entry key',
			);
			throw new Error(`Malformed WebGL entry key for project ${projectId}`);
		}
		await deleteDeployment(keys, reason);
	}

	return {
		deployArchive,
		deploySource,
		rollbackPublicDeployment,
		deleteProtectedSource,
		deleteDeployment,
		deleteDeploymentByEntry,
	};
}
