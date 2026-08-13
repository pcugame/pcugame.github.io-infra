import type { ObjectStorage } from '../../application/ports.js';
import { createClaimToken } from '../../shared/claim-token.js';
import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';
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
				claimToken,
				CLAIM_LEASE_MS,
			);
			let resolved = 0;
			let failed = 0;
			for (const task of tasks) {
				if (signal?.aborted) break;
				const claim = createClaimHeartbeatGuard({
					heartbeatMs: CLAIM_HEARTBEAT_MS,
					lostMessage: 'Multipart abort task claim was lost',
					outerSignal: signal,
					renew: () => repository.renew(
						task.id,
						claimToken,
						CLAIM_LEASE_MS,
					),
					logHeartbeatFailure: (error) => deps.logger.error(
						{ error, taskId: task.id },
						'Multipart abort claim heartbeat failed',
					),
				});
				try {
					await claim.assertOwned();
					await deps.storage.abortMultipart(
						task.bucket,
						task.storageKey,
						task.uploadId,
						{ signal: claim.signal },
					);
					await claim.assertOwned();
					await repository.resolve(task.id, claimToken, now);
					resolved++;
				} catch (error) {
					if (claim.isLost()) {
						deps.logger.error(
							{ error, taskId: task.id },
							'Multipart abort stopped after claim loss',
						);
						failed++;
						continue;
					}
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
					claim.stop();
				}
			}
			return { tried: tasks.length, resolved, failed };
		},
	};
}
