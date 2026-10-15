import { createWorkGate } from '../../runtime/work-gate.js';
import type { createGameUploadValidationWorker } from './validation-worker.service.js';

/** Worker process loop adapter. It is intentionally not registered by Fastify. */
export function createGameUploadValidationLoop(worker: ReturnType<typeof createGameUploadValidationWorker>, intervalMs = 5_000) {
	const gate = createWorkGate();
	return {
		gate,
		async run(signal?: AbortSignal): Promise<void> {
			while (!signal?.aborted) {
				await gate.run(() => worker.runPass(signal, () => !gate.status().paused), undefined);
				await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
			}
		},
	};
}
