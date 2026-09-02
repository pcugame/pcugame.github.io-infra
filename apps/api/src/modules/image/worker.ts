import { ImageRejectedError, imageErrorMessage } from './errors.js';
import type { ImageWorkerRepository } from './ports.js';
import type { ImageProcessor } from './processor.js';
import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';
import {
	isWorkerSourceObjectMissing,
	MAX_WORKER_VALIDATION_ATTEMPTS,
	retryBudgetReason,
	WorkerGenerationFencedError,
} from '../upload-lifecycle/worker-errors.js';

export function createImageWorker(deps: {
	repository: ImageWorkerRepository;
	processor: ImageProcessor;
	ids: { next(): string };
	logger: { error(value: Record<string, unknown>, message: string): void; warn(value: Record<string, unknown>, message: string): void };
	leaseMs?: number;
	heartbeatMs?: number;
	batchSize?: number;
}) {
	const leaseMs = deps.leaseMs ?? 120_000;
	const heartbeatMs = deps.heartbeatMs ?? 30_000;
	return {
		async runPass(signal?: AbortSignal) {
			if (signal?.aborted) return { claimed: 0, ready: 0, rejected: 0, retried: 0 };
			const token = deps.ids.next();
			const sessions = await deps.repository.claimVerifying(['IMAGE', 'POSTER'], deps.batchSize ?? 2, token, leaseMs);
			const stats = { claimed: sessions.length, ready: 0, rejected: 0, retried: 0 };
			for (const session of sessions) {
				if (signal?.aborted) break;
				const claim = createClaimHeartbeatGuard({
					heartbeatMs,
					lostMessage: 'Image processing lease lost',
					outerSignal: signal,
					renew: () => deps.repository.renewLease(session.id, token, leaseMs)
						.then((owned) => ({ count: owned ? 1 : 0 })),
					logHeartbeatFailure: (error) => deps.logger.error(
						{ error, sessionId: session.id }, 'Image worker lease heartbeat failed'),
				});
				try {
					await deps.processor.process(session, token, claim.signal, claim.assertOwned);
					stats.ready++;
				} catch (error) {
					if (claim.isLost() || signal?.aborted) {
						stats.retried++;
						continue;
					}
					const terminal = error instanceof ImageRejectedError
						|| error instanceof WorkerGenerationFencedError
						|| isWorkerSourceObjectMissing(error);
					if (terminal || (session.validationAttemptCount ?? 0) >= MAX_WORKER_VALIDATION_ATTEMPTS) {
						try {
							await claim.assertOwned();
							const reason = terminal
								? `${error instanceof ImageRejectedError ? `${error.code}: ` : ''}${imageErrorMessage(error)}`
								: retryBudgetReason(session.kind, error);
							const rejected = await deps.repository.reject({
								session, token, reason: reason.slice(0, 500),
							});
							if (rejected) stats.rejected++;
							else stats.retried++;
						} catch (rejectError) {
							stats.retried++;
							deps.logger.error({ error: rejectError, sessionId: session.id },
								'Image terminal outcome lost its lease; takeover will converge it');
						}
					} else {
						stats.retried++;
						deps.logger.warn({ error: imageErrorMessage(error), sessionId: session.id },
							'Image processing will retry after lease expiry');
					}
				} finally { claim.stop(); }
			}
			return stats;
		},
	};
}

export type ImageWorker = ReturnType<typeof createImageWorker>;
