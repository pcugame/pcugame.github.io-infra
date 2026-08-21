import { ImageRejectedError, imageErrorMessage } from './errors.js';
import type { ImageWorkerRepository } from './ports.js';
import type { ImageProcessor } from './processor.js';

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
			const token = deps.ids.next();
			const sessions = await deps.repository.claimVerifying(['IMAGE', 'POSTER'], deps.batchSize ?? 2, token, leaseMs);
			const stats = { claimed: sessions.length, ready: 0, rejected: 0, retried: 0 };
			for (const session of sessions) {
				let owned = true;
				const renew = async () => {
					owned = await deps.repository.renewLease(session.id, token, leaseMs);
					if (!owned) throw new Error('Image processing lease lost');
				};
				const heartbeat = setInterval(() => void renew().catch((error) => {
					owned = false;
					deps.logger.error({ error, sessionId: session.id }, 'Image worker lease heartbeat failed');
				}), heartbeatMs);
				heartbeat.unref();
				try {
					await deps.processor.process(session, token, signal, async () => {
						if (!owned) throw new Error('Image processing lease lost');
						await renew();
					});
					stats.ready++;
				} catch (error) {
					if (error instanceof ImageRejectedError && owned) {
						const rejected = await deps.repository.reject({
							session, token, reason: `${error.code}: ${error.message}`.slice(0, 500),
						});
						if (rejected) stats.rejected++;
						else stats.retried++;
					} else {
						stats.retried++;
						deps.logger.warn({ error: imageErrorMessage(error), sessionId: session.id },
							'Image processing will retry after lease expiry');
					}
				} finally { clearInterval(heartbeat); }
			}
			return stats;
		},
	};
}

export type ImageWorker = ReturnType<typeof createImageWorker>;
