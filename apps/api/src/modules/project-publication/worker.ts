import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';
import type {
	ProjectPublicationRepository,
	ProjectPublicationStorage,
	ValidatedProjectPublicationJob,
} from './ports.js';

export class ProjectPublicationInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectPublicationInvariantError';
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown project publication error';
}

async function assertObject(
	storage: ProjectPublicationStorage,
	bucket: string,
	key: string,
	size: number,
	checksum: string,
	signal?: AbortSignal,
) {
	const head = await storage.head(bucket, key, signal);
	return head?.size === size && head.checksumSha256?.toLowerCase() === checksum.toLowerCase();
}

export async function copyProjectPublicationObjects(input: {
	job: ValidatedProjectPublicationJob;
	storage: ProjectPublicationStorage;
	assertOwned(): Promise<void>;
	signal?: AbortSignal;
}): Promise<void> {
	for (const object of input.job.plan.objects) {
		await input.assertOwned();
		const size = Number(object.sizeBytes);
		if (!Number.isSafeInteger(size) || size < 0) throw new ProjectPublicationInvariantError('Publication object size is unsafe');
		const target = await input.storage.head(object.targetBucket, object.targetObjectKey, input.signal);
		if (target) {
			if (target.size !== size || target.checksumSha256?.toLowerCase() !== object.checksumSha256.toLowerCase()) {
				throw new ProjectPublicationInvariantError('Immutable publication target already exists with different bytes');
			}
			continue;
		}
		if (!await assertObject(input.storage, object.sourceBucket, object.sourceObjectKey, size, object.checksumSha256, input.signal)) {
			throw new ProjectPublicationInvariantError('Publication staging source failed size/checksum verification');
		}
		const source = await input.storage.stream(object.sourceBucket, object.sourceObjectKey, input.signal);
		if (source.size !== size) throw new ProjectPublicationInvariantError('Publication source changed after HEAD');
		await input.storage.upload({
			bucket: object.targetBucket,
			key: object.targetObjectKey,
			body: source.body,
			contentType: object.mimeType,
			contentLength: size,
			checksumSha256: object.checksumSha256,
			...(object.contentEncoding ? { contentEncoding: object.contentEncoding } : {}),
			cacheControl: object.cacheControl,
			...(input.signal ? { signal: input.signal } : {}),
		});
		await input.assertOwned();
		if (!await assertObject(input.storage, object.targetBucket, object.targetObjectKey, size, object.checksumSha256, input.signal)) {
			throw new ProjectPublicationInvariantError('Copied publication target failed size/checksum verification');
		}
	}
}

export function createProjectPublicationWorker(deps: {
	repository: ProjectPublicationRepository;
	storage: ProjectPublicationStorage;
	ids: { next(): string };
	logger: { error(value: Record<string, unknown>, message: string): void; warn(value: Record<string, unknown>, message: string): void };
	leaseMs?: number;
	heartbeatMs?: number;
	retryDelayMs?: number;
}) {
	const leaseMs = deps.leaseMs ?? 120_000;
	const heartbeatMs = deps.heartbeatMs ?? 30_000;
	const retryDelayMs = deps.retryDelayMs ?? 5_000;
	return {
		async runPass(signal?: AbortSignal) {
			if (signal?.aborted) return { claimed: 0, completed: 0, retried: 0, failed: 0, cancelled: 0 };
			const token = deps.ids.next();
			const job = await deps.repository.claim({ token, leaseMs });
			if (!job) return { claimed: 0, completed: 0, retried: 0, failed: 0, cancelled: 0 };
			const claim = createClaimHeartbeatGuard({
				heartbeatMs,
				lostMessage: 'Project publication lease lost',
				outerSignal: signal,
				renew: () => deps.repository.renew(job.id, token, leaseMs).then((owned) => ({ count: owned ? 1 : 0 })),
				logHeartbeatFailure: (error) => deps.logger.error({ error, jobId: job.id }, 'Project publication heartbeat failed'),
			});
			let validatedJob: ValidatedProjectPublicationJob | undefined;
			try {
				const validated = await deps.repository.validatePlan(job, token);
				if (validated.status !== 'VALID') {
					return validated.status === 'FAILED'
						? { claimed: 1, completed: 0, retried: 0, failed: 1, cancelled: 0 }
						: { claimed: 1, completed: 0, retried: 0, failed: 0, cancelled: 1 };
				}
				validatedJob = validated.job;
				await copyProjectPublicationObjects({
					job: validated.job,
					storage: deps.storage,
					assertOwned: claim.assertOwned,
					signal: claim.signal,
				});
				await claim.assertOwned();
				const result = await deps.repository.complete(validated.job, token);
				return result === 'COMPLETED'
					? { claimed: 1, completed: 1, retried: 0, failed: 0, cancelled: 0 }
					: { claimed: 1, completed: 0, retried: 0, failed: 0, cancelled: 1 };
			} catch (error) {
				// A deleted job can make complete() fail before the next heartbeat
				// notices lease loss. Requeue after storage I/O has stopped in either
				// case, using only a plan verified against the canonical DB snapshot.
				await deps.repository.queueCancelledCleanup(job.id, validatedJob?.plan).catch((cleanupError) => {
					deps.logger.error({ error: cleanupError, jobId: job.id }, 'Failed to requeue cancelled publication cleanup');
				});
				if (claim.isLost()) {
					return { claimed: 1, completed: 0, retried: 0, failed: 0, cancelled: 1 };
				}
				if (error instanceof ProjectPublicationInvariantError) {
					const failed = await deps.repository.fail(job.id, token, errorMessage(error));
					return { claimed: 1, completed: 0, retried: 0, failed: failed ? 1 : 0, cancelled: failed ? 0 : 1 };
				}
				await deps.repository.release(job.id, token, errorMessage(error), retryDelayMs);
				deps.logger.warn({ error, jobId: job.id }, 'Project publication will retry');
				return { claimed: 1, completed: 0, retried: 1, failed: 0, cancelled: 0 };
			} finally {
				claim.stop();
			}
		},
	};
}

export type ProjectPublicationWorker = ReturnType<typeof createProjectPublicationWorker>;
