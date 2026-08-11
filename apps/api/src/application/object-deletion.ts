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
	deleteDurablyQueued(
		bucket: string,
		key: string,
		reason: string,
		logContext?: Record<string, unknown>,
	): Promise<void>;
	deleteDurablyQueuedPrefix(
		bucket: string,
		prefix: string,
		reason: string,
		logContext?: Record<string, unknown>,
	): Promise<number>;
}

/**
 * Deletion is allowed to return successfully only when the object is gone or a
 * durable orphan row exists. This error means neither guarantee could be made.
 */
export class DurableObjectDeletionError extends Error {
	readonly bucket: string;
	readonly storageKey: string;
	readonly reason: string;
	readonly deleteError: unknown;
	readonly queueError: unknown;

	constructor(input: {
		bucket: string;
		storageKey: string;
		reason: string;
		deleteError: unknown;
		queueError: unknown;
	}) {
		super(`Object deletion and durable orphan recording both failed for ${input.bucket}/${input.storageKey}`, {
			cause: input.queueError,
		});
		this.name = 'DurableObjectDeletionError';
		this.bucket = input.bucket;
		this.storageKey = input.storageKey;
		this.reason = input.reason;
		this.deleteError = input.deleteError;
		this.queueError = input.queueError;
	}
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
	/**
	 * Runs the claimed, fresh-reference-checking reaper after an outbox row has
	 * already committed. Production graphs provide this hook; direct deletion is
	 * retained only for legacy/fake graphs that do not expose the claim schema.
	 */
	reapDurablyQueued?: () => Promise<{ failed: number }>;
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
			try {
				await deps.orphans.record(bucket, key, reason);
			} catch (queueError) {
				deps.logger.error(
					{ err: queueError, deleteError: err, bucket, storageKey: key, reason, ...logContext },
					'Object delete and durable orphan recording both failed',
				);
				throw new DurableObjectDeletionError({
					bucket,
					storageKey: key,
					reason,
					deleteError: err,
					queueError,
				});
			}
		}
	}

	return {
		deleteOrQueue,
		async deletePrefixOrQueue(bucket, prefix, reason, logContext = {}) {
			let keys: string[];
			try {
				keys = await deps.storage.listKeys(bucket, prefix);
			} catch (err) {
				deps.logger.error(
					{ err, bucket, prefix, reason, ...logContext },
					'Object prefix enumeration failed — queuing durable prefix retry',
				);
				await deps.orphans.record(bucket, prefix, reason);
				return 0;
			}
			for (let offset = 0; offset < keys.length; offset += deleteConcurrency) {
				await Promise.all(keys.slice(offset, offset + deleteConcurrency).map((key) =>
					deleteOrQueue(bucket, key, reason, { ...logContext, prefix }),
				));
			}
			return keys.length;
		},
		async deleteDurablyQueued(bucket, key, reason, logContext = {}) {
			if (deps.reapDurablyQueued) {
				const result = await deps.reapDurablyQueued();
				if (result.failed > 0) {
					throw new Error(`Claimed orphan reaper reported ${result.failed} failed deletion(s)`);
				}
				return;
			}
			try {
				await deps.storage.delete(bucket, key);
			} catch (err) {
				deps.logger.error(
					{ err, bucket, storageKey: key, reason, ...logContext },
					'Object delete failed — durable orphan outbox retained',
				);
			}
		},
		async deleteDurablyQueuedPrefix(bucket, prefix, reason, logContext = {}) {
			if (deps.reapDurablyQueued) {
				const result = await deps.reapDurablyQueued();
				if (result.failed > 0) {
					throw new Error(`Claimed orphan reaper reported ${result.failed} failed deletion(s)`);
				}
				return 0;
			}
			try {
				const keys = await deps.storage.listKeys(bucket, prefix);
				for (let offset = 0; offset < keys.length; offset += deleteConcurrency) {
					await Promise.all(keys.slice(offset, offset + deleteConcurrency).map(async (key) => {
						try {
							await deps.storage.delete(bucket, key);
						} catch (err) {
							deps.logger.error(
								{ err, bucket, storageKey: key, prefix, reason, ...logContext },
								'Queued prefix object delete failed — durable prefix outbox retained',
							);
						}
					}));
				}
				return keys.length;
			} catch (err) {
				deps.logger.error(
					{ err, bucket, prefix, reason, ...logContext },
					'Queued prefix enumeration failed — durable prefix outbox retained',
				);
				return 0;
			}
		},
	};
}
