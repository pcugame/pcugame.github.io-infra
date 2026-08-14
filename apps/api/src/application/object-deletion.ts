import type { ObjectStorage, StorageRequestOptions } from './ports.js';
import { deletePrefixPages, PrefixDeletionPageBudgetError, PrefixDeletionStorageError } from './prefix-deletion.js';

export interface OrphanQueue {
	record(
		bucket: string,
		storageKey: string,
		reason: string,
		targetKind?: 'EXACT' | 'PREFIX',
	): Promise<void>;
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
		execution?: {
			request?: StorageRequestOptions;
			beforeList?: () => Promise<void> | void;
			beforeDelete?: () => Promise<void> | void;
		},
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

export class DurablePrefixDeletionError extends Error {
	constructor(readonly input: { bucket: string; prefix: string; reason: string; operationError: unknown; queueError: unknown }) {
		super(`Prefix deletion and durable orphan recording both failed for ${input.bucket}/${input.prefix}`, { cause: input.queueError });
		this.name = 'DurablePrefixDeletionError';
	}
}

/**
 * Coordinates non-transactional object deletion with the persistent orphan
 * queue. Storage itself deliberately knows nothing about database recovery.
 */
export function createObjectDeletionCoordinator(deps: {
	storage: Pick<ObjectStorage, 'delete' | 'listKeyPage' | 'deleteKeys'>;
	orphans: OrphanQueue;
	logger: DeletionLogger;
	prefixPageSize?: number;
	prefixMaxListPages?: number;
}): ObjectDeletionCoordinator {

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
		async deletePrefixOrQueue(bucket, prefix, reason, logContext = {}, execution = {}) {
			let prefixRecorded = false;
			try {
				return (await deletePrefixPages({
					storage: deps.storage,
					bucket,
					prefix,
					pageSize: deps.prefixPageSize,
					maxListPages: deps.prefixMaxListPages,
					request: execution.request,
					beforeList: execution.beforeList,
					beforeDelete: execution.beforeDelete,
					onFailures: async (failures) => {
						if (!prefixRecorded) {
							try {
								await deps.orphans.record(bucket, prefix, reason, 'PREFIX');
								prefixRecorded = true;
							} catch (queueError) {
								throw new DurablePrefixDeletionError({
									bucket,
									prefix,
									reason,
									operationError: failures[0],
									queueError,
								});
							}
						}
					},
				})).processed;
			} catch (err) {
				if (!(err instanceof PrefixDeletionStorageError || err instanceof PrefixDeletionPageBudgetError)) {
					throw err;
				}
				if (execution.request?.signal?.aborted) {
					throw execution.request.signal.reason ?? err;
				}
				deps.logger.error(
					{ err, bucket, prefix, reason, ...logContext },
					'Object prefix enumeration failed — queuing durable prefix retry',
				);
				if (!prefixRecorded) {
					try {
						await deps.orphans.record(bucket, prefix, reason, 'PREFIX');
					} catch (queueError) {
						throw new DurablePrefixDeletionError({ bucket, prefix, reason, operationError: err, queueError });
					}
				}
				return err.processed;
			}
		},
	};
}
