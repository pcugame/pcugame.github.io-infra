import type { WorkGate } from '../../runtime/work-gate.js';
import { waitForWorkerPoll } from '../../shared/worker-wait.js';
import type { ImageWorker } from './worker.js';

export async function runImageWorkerLoop(input: {
	worker: ImageWorker;
	signal: AbortSignal;
	gate?: WorkGate;
	idleMs?: number;
	onError?(error: unknown): void;
}): Promise<void> {
	while (!input.signal.aborted) {
		try {
			const result = await (input.gate ? input.gate.run(() => input.worker.runPass(input.signal), { claimed: 0, ready: 0, rejected: 0, retried: 0 }) : input.worker.runPass(input.signal));
			if (result.claimed === 0) await waitForWorkerPoll(input.idleMs ?? 1_000, input.signal);
		} catch (error) {
			if (input.signal.aborted) break;
			input.onError?.(error);
			await waitForWorkerPoll(input.idleMs ?? 1_000, input.signal);
		}
	}
}
