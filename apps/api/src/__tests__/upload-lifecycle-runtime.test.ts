import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../application/ports.js';
import { createUploadLifecycleMetrics } from '../lib/upload-lifecycle-metrics.js';
import { createUploadLifecycleRuntime } from '../modules/upload-lifecycle/runtime.js';
import { createTestUploadLifecycleRuntime } from './helpers/upload-lifecycle.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function runtimeHarness() {
	const ports = createTestUploadLifecycleRuntime();
	const logger: AppLogger = {
		child: () => logger,
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	const runOrphanReaper = vi.fn(async (_signal?: AbortSignal) => ({
		tried: 0,
		resolved: 0,
		failed: 0,
	}));
	const runtime = createUploadLifecycleRuntime({
		idempotency: ports.idempotency,
		uploadIntents: ports.uploadIntents,
		orphanDeletions: ports.orphanDeletions,
		multipartAborts: ports.multipartAborts,
		gameUploads: ports.gameUploads,
		orphans: {
			recordOrphan: vi.fn(async () => undefined),
			runOrphanReaper,
		},
		clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
		logger,
		metrics: createUploadLifecycleMetrics(),
	});
	return { runtime, ports, logger, runOrphanReaper };
}

describe('context-owned upload lifecycle runtime', () => {
	it('coalesces concurrent deletion wakes into one active flight and one pending pass', async () => {
		const { runtime, runOrphanReaper } = runtimeHarness();
		await runtime.start();
		runOrphanReaper.mockClear();

		const gate = deferred();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		runOrphanReaper
			.mockImplementationOnce(async () => {
				entered();
				await gate.promise;
				return { tried: 0, resolved: 0, failed: 0 };
			})
			.mockResolvedValue({ tried: 0, resolved: 0, failed: 0 });

		expect(runtime.wakeDeletionWorker()).toBeUndefined();
		await started;
		for (let index = 0; index < 100; index += 1) runtime.wakeDeletionWorker();
		expect(runOrphanReaper).toHaveBeenCalledOnce();

		gate.resolve();
		await vi.waitFor(() => expect(runOrphanReaper).toHaveBeenCalledTimes(2));
		await runtime.close();
	});

	it('returns from a request wake before a backlog larger than one batch drains', async () => {
		const { runtime, runOrphanReaper } = runtimeHarness();
		await runtime.start();
		runOrphanReaper.mockClear();
		const gate = deferred();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		runOrphanReaper
			.mockImplementationOnce(async () => {
				entered();
				await gate.promise;
				return { tried: 50, resolved: 50, failed: 0 };
			})
			.mockResolvedValueOnce({ tried: 1, resolved: 1, failed: 0 });

		const wakeResult = runtime.wakeDeletionWorker();
		expect(wakeResult).toBeUndefined();
		await started;
		expect(runOrphanReaper).toHaveBeenCalledOnce();
		gate.resolve();
		await vi.waitFor(() => expect(runOrphanReaper).toHaveBeenCalledTimes(2));
		await runtime.close();
	});

	it('logs scheduled worker failures without creating an unhandled rejection', async () => {
		const { runtime, logger, runOrphanReaper } = runtimeHarness();
		await runtime.start();
		runOrphanReaper.mockClear();
		const failure = new Error('orphan storage unavailable');
		runOrphanReaper.mockRejectedValueOnce(failure);

		runtime.wakeDeletionWorker();
		await vi.waitFor(() => {
			expect(logger.error).toHaveBeenCalledWith(
				{ error: failure },
				'Context-owned orphan deletion worker failed',
			);
		});
		await runtime.close();
	});

	it('aborts and drains an active worker during close', async () => {
		const { runtime, runOrphanReaper } = runtimeHarness();
		await runtime.start();
		runOrphanReaper.mockClear();
		let observedSignal: AbortSignal | undefined;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		runOrphanReaper.mockImplementationOnce(async (signal) => {
			observedSignal = signal;
			entered();
			if (!signal?.aborted) {
				await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), {
					once: true,
				}));
			}
			return { tried: 0, resolved: 0, failed: 0 };
		});

		runtime.wakeDeletionWorker();
		await started;
		await expect(runtime.close()).resolves.toBeUndefined();
		expect(observedSignal?.aborted).toBe(true);
	});
});
