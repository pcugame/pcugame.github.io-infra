import type { ObjectStorage } from './ports.js';

export interface OrphanQueue {
	record(bucket: string, storageKey: string, reason: string): Promise<void>;
}

export interface DeletionLogger {
	error(context: Record<string, unknown>, message: string): void;
}

export interface ObjectDeletionCoordinator {
	deleteOrQueue(
		bucket: string,
		key: string,
		reason: string,
		logContext?: Record<string, unknown>,
	): Promise<void>;
	deletePrefixOrQueue(
		bucket: string,
		prefix: string,
		reason: string,
		logContext?: Record<string, unknown>,
	): Promise<number>;
}

/**
 * Coordinates non-transactional object deletion with the persistent orphan
 * queue. Storage itself deliberately knows nothing about database recovery.
 */
export function createObjectDeletionCoordinator(deps: {
	storage: Pick<ObjectStorage, 'delete' | 'listKeys'>;
	orphans: OrphanQueue;
	logger: DeletionLogger;
	deleteConcurrency?: number;
}): ObjectDeletionCoordinator {
	const deleteConcurrency = deps.deleteConcurrency ?? 25;

	async function deleteOrQueue(
		bucket: string,
		key: string,
		reason: string,
		logContext: Record<string, unknown> = {},
	): Promise<void> {
		try {
			await deps.storage.delete(bucket, key);
		} catch (err) {
			deps.logger.error(
				{ err, bucket, storageKey: key, reason, ...logContext },
				'Object delete failed — queuing for orphan reaper',
			);
			await deps.orphans.record(bucket, key, reason);
		}
	}

	return {
		deleteOrQueue,
		async deletePrefixOrQueue(bucket, prefix, reason, logContext = {}) {
			const keys = await deps.storage.listKeys(bucket, prefix);
			for (let offset = 0; offset < keys.length; offset += deleteConcurrency) {
				await Promise.all(keys.slice(offset, offset + deleteConcurrency).map((key) =>
					deleteOrQueue(bucket, key, reason, { ...logContext, prefix }),
				));
			}
			return keys.length;
		},
	};
}
