import type { ImageWorker } from './worker.js';

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		const abort = () => { clearTimeout(timer); resolve(); };
		signal.addEventListener('abort', abort, { once: true });
		timer.unref();
	});
}

export async function runImageWorkerLoop(input: {
	worker: ImageWorker;
	signal: AbortSignal;
	idleMs?: number;
	onError?(error: unknown): void;
}): Promise<void> {
	while (!input.signal.aborted) {
		try {
			const result = await input.worker.runPass(input.signal);
			if (result.claimed === 0) await wait(input.idleMs ?? 1_000, input.signal);
		} catch (error) {
			if (input.signal.aborted) break;
			input.onError?.(error);
			await wait(input.idleMs ?? 1_000, input.signal);
		}
	}
}
