import type { createGameUploadValidationWorker } from './validation-worker.service.js';

/** Worker process loop adapter. It is intentionally not registered by Fastify. */
export function createGameUploadValidationLoop(worker: ReturnType<typeof createGameUploadValidationWorker>, intervalMs = 5_000) {
	return {
		async run(signal?: AbortSignal): Promise<void> {
			while (!signal?.aborted) {
				await worker.runPass(signal);
				await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
			}
		},
	};
}
