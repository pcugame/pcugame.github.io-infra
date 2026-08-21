import type { createVideoProcessingWorker } from './worker.js';

export async function runVideoWorkerLoop(input: {
	worker: ReturnType<typeof createVideoProcessingWorker>;
	signal: AbortSignal;
	idleDelayMs?: number;
	delay?(ms: number, signal: AbortSignal): Promise<void>;
	onError?(error: unknown): void;
}): Promise<void> {
	const idleDelayMs = input.idleDelayMs ?? 2_000;
	const delay = input.delay ?? ((ms, signal) => new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		timer.unref();
		signal.addEventListener('abort', () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	}));
	while (!input.signal.aborted) {
		let claimed = 0;
		try {
			claimed = (await input.worker.runPass(input.signal)).claimed;
		} catch (error) {
			if (input.signal.aborted) break;
			input.onError?.(error);
		}
		if (!input.signal.aborted && claimed === 0) {
			await delay(idleDelayMs, input.signal);
		}
	}
}
