import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';
import { errorMessage, VideoRejectedError } from './errors.js';
import type { VideoWorkerRepository } from './ports.js';
import type { createVideoProcessor } from './processor.js';

const VIDEO_VALIDATION_LEASE_MS = 120_000;

export interface VideoWorkerPassResult {
	claimed: number;
	ready: number;
	rejected: number;
	retried: number;
}

export function createVideoProcessingWorker(deps: {
	repository: VideoWorkerRepository;
	processor: ReturnType<typeof createVideoProcessor>;
	ids: { next(): string };
	logger: {
		error(context: Record<string, unknown>, message: string): void;
		warn(context: Record<string, unknown>, message: string): void;
	};
	wakeDeletionWorker?(): void;
	claimLimit?: number;
}) {
	return {
		async runPass(signal?: AbortSignal): Promise<VideoWorkerPassResult> {
			if (signal?.aborted) return { claimed: 0, ready: 0, rejected: 0, retried: 0 };
			const token = deps.ids.next();
			const sessions = await deps.repository.claimVideoVerifying(
				deps.claimLimit ?? 2,
				token,
				VIDEO_VALIDATION_LEASE_MS,
			);
			const result: VideoWorkerPassResult = {
				claimed: sessions.length,
				ready: 0,
				rejected: 0,
				retried: 0,
			};
			for (const session of sessions) {
				if (signal?.aborted) break;
				const claim = createClaimHeartbeatGuard({
					heartbeatMs: 30_000,
					lostMessage: 'VIDEO processing lease was lost',
					outerSignal: signal,
					renew: () => deps.repository.renewVideoLease(
						session.id,
						token,
						VIDEO_VALIDATION_LEASE_MS,
					).then((owned) => ({ count: owned ? 1 : 0 })),
					logHeartbeatFailure: (error) => deps.logger.error(
						{ error, sessionId: session.id },
						'VIDEO processing heartbeat failed',
					),
				});
				try {
					await deps.processor.process(session, token, claim.signal, claim.assertOwned);
					result.ready++;
				} catch (error) {
					if (claim.isLost() || signal?.aborted) {
						result.retried++;
						continue;
					}
					if (error instanceof VideoRejectedError) {
						try {
							const rejected = await deps.repository.rejectVideo({
								session,
								token,
								reason: `${error.code}: ${error.message}`,
							});
							if (rejected) {
								result.rejected++;
								deps.wakeDeletionWorker?.();
							} else result.retried++;
						} catch (rejectError) {
							deps.logger.error(
								{ error: rejectError, sessionId: session.id, validationError: errorMessage(error) },
								'VIDEO rejection commit failed; lease recovery will retry',
							);
							result.retried++;
						}
					} else {
						deps.logger.error(
							{ error, sessionId: session.id },
							'Direct VIDEO processing will retry after lease expiry',
						);
						result.retried++;
					}
				} finally {
					claim.stop();
				}
			}
			return result;
		},
	};
}
