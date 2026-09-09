import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForWorkerPoll } from '../shared/worker-wait.js';

afterEach(() => vi.useRealTimers());

describe('worker polling shutdown listener lifetime', () => {
	it('keeps listener count bounded through repeated idle polls', async () => {
		vi.useFakeTimers();
		const abort = new AbortController();
		for (let pass = 0; pass < 25; pass++) {
			const idle = waitForWorkerPoll(1000, abort.signal);
			expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1000);
			await idle;
			expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it('clears both resources on shutdown and does not register after shutdown', async () => {
		vi.useFakeTimers();
		const abort = new AbortController();
		const idle = waitForWorkerPoll(1000, abort.signal);
		abort.abort();
		await idle;
		await waitForWorkerPoll(1000, abort.signal);
		expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
