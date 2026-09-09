import type { GameUploadServiceDependencies } from './ports.js';

export class UntrackedMultipartCleanupError extends AggregateError {
	readonly key: string;
	readonly uploadId: string;
	readonly reason: string;
	readonly abortError: unknown;
	readonly queueError: unknown;

	constructor(input: {
		key: string;
		uploadId: string;
		reason: string;
		abortError: unknown;
		queueError: unknown;
	}) {
		super(
			[input.abortError, input.queueError],
			`Untracked multipart upload could not be aborted or durably queued: ${input.key}`,
		);
		this.name = 'UntrackedMultipartCleanupError';
		this.key = input.key;
		this.uploadId = input.uploadId;
		this.reason = input.reason;
		this.abortError = input.abortError;
		this.queueError = input.queueError;
	}
}

export class MultipartBusinessCleanupError extends AggregateError {
	readonly businessError: unknown;
	readonly businessErrors: readonly unknown[];
	readonly cleanupError: UntrackedMultipartCleanupError;

	constructor(
		businessError: unknown | readonly unknown[],
		cleanupError: UntrackedMultipartCleanupError,
		message: string,
	) {
		const businessErrors = Array.isArray(businessError)
			? businessError
			: [businessError];
		super([...businessErrors, cleanupError], message);
		this.name = 'MultipartBusinessCleanupError';
		this.businessError = businessErrors[0];
		this.businessErrors = businessErrors;
		this.cleanupError = cleanupError;
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
			const cleanupError = new UntrackedMultipartCleanupError({
				...target,
				abortError,
				queueError,
			});
			deps.recordUntrackedMultipartCleanupFailure();
			deps.logger.fatal(
				{
					event: 'untracked_multipart_cleanup_unrecoverable',
					cleanupError,
					abortError,
					queueError,
					key: target.key,
					uploadId: target.uploadId,
					reason: target.reason,
				},
				'CRITICAL: untracked multipart abort and durable queue both failed',
			);
			throw cleanupError;
		}
	}
}

export function aggregateBusinessAndCleanupError(
	businessError: unknown | readonly unknown[],
	cleanupError: UntrackedMultipartCleanupError,
	message: string,
): MultipartBusinessCleanupError {
	return new MultipartBusinessCleanupError(businessError, cleanupError, message);
}
