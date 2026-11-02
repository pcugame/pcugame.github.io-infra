import type { WorkGate } from '../../runtime/work-gate.js';
import { waitForWorkerPoll } from '../../shared/worker-wait.js';
import type { createVideoProcessingWorker } from './worker.js';

export async function runVideoWorkerLoop(input: {
	worker: ReturnType<typeof createVideoProcessingWorker>;
	signal: AbortSignal;
	gate?: WorkGate;
	idleDelayMs?: number;
	delay?(ms: number, signal: AbortSignal): Promise<void>;
	onError?(error: unknown): void;
}): Promise<void> {
	const idleDelayMs = input.idleDelayMs ?? 2_000;
	const delay = input.delay ?? waitForWorkerPoll;
	while (!input.signal.aborted) {
		let claimed = 0;
		try {
			claimed = (await (input.gate ? input.gate.run(() => input.worker.runPass(input.signal), { claimed: 0, ready: 0, rejected: 0, retried: 0 }) : input.worker.runPass(input.signal))).claimed;
		} catch (error) {
			if (input.signal.aborted) break;
			input.onError?.(error);
		}
		if (!input.signal.aborted && claimed === 0) {
			await delay(idleDelayMs, input.signal);
		}
	}
}
