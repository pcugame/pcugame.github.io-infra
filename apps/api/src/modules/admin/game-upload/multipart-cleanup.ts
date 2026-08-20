import type { GameUploadServiceDependencies } from './ports.js';
import { safeLogError } from '../../../shared/safe-log-context.js';

export class UntrackedMultipartCleanupError extends Error {
	readonly code = 'UNTRACKED_MULTIPART_CLEANUP_FAILED';

	constructor() {
		super('Untracked multipart cleanup failed');
		this.name = 'UntrackedMultipartCleanupError';
	}
}

export class MultipartBusinessCleanupError extends Error {
	readonly code = 'BUSINESS_AND_MULTIPART_CLEANUP_FAILED';

	constructor() {
		super('Business operation and multipart cleanup failed');
		this.name = 'MultipartBusinessCleanupError';
	}
}

/**
 * Clean up a newly-created multipart upload that has not been committed to a
 * session or durable abort task. Failure of both channels is never best effort.
 */
export async function cleanupUntrackedMultipart(
	deps: GameUploadServiceDependencies,
	target: { key: string; uploadId: string; reason: string },
	request?: { signal?: AbortSignal },
): Promise<'aborted' | 'queued'> {
	try {
		await deps.storage.abortMultipart(target.key, target.uploadId, request);
		return 'aborted';
	} catch (abortError) {
		try {
			await deps.repository.queueAbortTask(target);
			deps.wakeMaintenance();
			return 'queued';
		} catch (queueError) {
			const cleanupError = new UntrackedMultipartCleanupError();
			deps.recordUntrackedMultipartCleanupFailure();
			deps.logger.fatal(
				{
					action: 'untracked_multipart_cleanup',
					result: 'unrecoverable',
					abortFailure: safeLogError(abortError),
					queueFailure: safeLogError(queueError),
				},
				'CRITICAL: untracked multipart abort and durable queue both failed',
			);
			throw cleanupError;
		}
	}
}

export function aggregateBusinessAndCleanupError(
	_businessError: unknown | readonly unknown[],
	_cleanupError: UntrackedMultipartCleanupError,
	_message: string,
): MultipartBusinessCleanupError {
	return new MultipartBusinessCleanupError();
}
