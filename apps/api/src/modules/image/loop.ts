import { waitForWorkerPoll } from '../../shared/worker-wait.js';
import type { ImageWorker } from './worker.js';

export async function runImageWorkerLoop(input: {
	worker: ImageWorker;
	signal: AbortSignal;
	idleMs?: number;
	onError?(error: unknown): void;
}): Promise<void> {
	while (!input.signal.aborted) {
		try {
			const result = await input.worker.runPass(input.signal);
			if (result.claimed === 0) await waitForWorkerPoll(input.idleMs ?? 1_000, input.signal);
		} catch (error) {
			if (input.signal.aborted) break;
			input.onError?.(error);
			await waitForWorkerPoll(input.idleMs ?? 1_000, input.signal);
		}
	}
}
