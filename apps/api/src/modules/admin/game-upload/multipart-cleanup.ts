import type { GameUploadServiceDependencies } from './ports.js';

export class UntrackedMultipartCleanupError extends AggregateError {
	readonly key: string;
	readonly uploadId!: string;
	readonly reason: string;
	readonly abortError!: unknown;
	readonly queueError!: unknown;

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
		this.reason = input.reason;
		Object.defineProperties(this, {
			uploadId: { value: input.uploadId, enumerable: false },
			abortError: { value: input.abortError, enumerable: false },
			queueError: { value: input.queueError, enumerable: false },
		});
	}
}

export class MultipartBusinessCleanupError extends AggregateError {
	readonly businessError!: unknown;
	readonly businessErrors!: readonly unknown[];
	readonly cleanupError!: UntrackedMultipartCleanupError;

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
		Object.defineProperties(this, {
			businessError: { value: businessErrors[0], enumerable: false },
			businessErrors: { value: businessErrors, enumerable: false },
			cleanupError: { value: cleanupError, enumerable: false },
		});
	}
}

function sanitizedErrorDescriptor(error: unknown, secrets: readonly string[]): {
	name: string;
	code?: string;
	message: string;
} {
	const candidate = error && typeof error === 'object'
		? error as { name?: unknown; code?: unknown; message?: unknown }
		: {};
	let message = typeof candidate.message === 'string'
		? candidate.message
		: 'Non-Error failure';
	for (const secret of secrets) {
		if (secret) message = message.replaceAll(secret, '[redacted]');
	}
	message = message
		.replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
		.replace(/(?:X-Amz-(?:Signature|Credential)|uploadId)=[^&\s]+/gi, '[redacted-query]')
		.slice(0, 300);
	return {
		name: typeof candidate.name === 'string' ? candidate.name : 'UnknownError',
		...(typeof candidate.code === 'string' ? { code: candidate.code.slice(0, 100) } : {}),
		message,
	};
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
					key: target.key,
					reason: target.reason,
					abortFailure: sanitizedErrorDescriptor(abortError, [target.uploadId]),
					queueFailure: sanitizedErrorDescriptor(queueError, [target.uploadId]),
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
