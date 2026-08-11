import type { ObjectStorage } from '../../application/ports.js';
import { createClaimToken } from '../../shared/claim-token.js';
import type { MultipartAbortRepository } from './ports.js';

const CLAIM_LEASE_MS = 2 * 60 * 1000;
const CLAIM_HEARTBEAT_MS = 30 * 1000;

export function createMultipartAbortService(deps: {
	repository: MultipartAbortRepository;
	storage: Pick<ObjectStorage, 'abortMultipart'>;
	clock: { now(): Date };
	ids?: { next(): string };
	logger: { error(context: Record<string, unknown>, message: string): void };
}) {
	const repository = deps.repository;
	return {
		queue: repository.queue,
		async run(signal?: AbortSignal): Promise<{ tried: number; resolved: number; failed: number }> {
			if (signal?.aborted) return { tried: 0, resolved: 0, failed: 0 };
			const now = deps.clock.now();
			const claimToken = deps.ids?.next() ?? createClaimToken();
			const tasks = await repository.claim(
				50,
				now,
				claimToken,
				new Date(now.getTime() + CLAIM_LEASE_MS),
			);
			let resolved = 0;
			let failed = 0;
			for (const task of tasks) {
				if (signal?.aborted) break;
				const heartbeat = setInterval(() => {
					const heartbeatNow = deps.clock.now();
					void repository.renew(
						task.id,
						claimToken,
						heartbeatNow,
						new Date(heartbeatNow.getTime() + CLAIM_LEASE_MS),
					).catch((error) => deps.logger.error(
						{ error, taskId: task.id },
						'Multipart abort claim heartbeat failed',
					));
				}, CLAIM_HEARTBEAT_MS);
				heartbeat.unref();
				try {
					await deps.storage.abortMultipart(
						task.bucket,
						task.storageKey,
						task.uploadId,
						{ signal },
					);
					await repository.resolve(task.id, claimToken, now);
					resolved++;
				} catch (error) {
					const backoff = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(task.attemptCount, 8)));
					await repository.fail(
						task.id,
						claimToken,
						error,
						new Date(now.getTime() + backoff),
					).catch((writeError) => deps.logger.error(
						{ error: writeError, taskId: task.id },
						'Failed to persist multipart abort retry',
					));
					failed++;
				} finally {
					clearInterval(heartbeat);
				}
			}
			return { tried: tasks.length, resolved, failed };
		},
	};
}
