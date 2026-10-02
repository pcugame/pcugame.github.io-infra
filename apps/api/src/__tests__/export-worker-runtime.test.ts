import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExportWorkerLoop } from '../modules/admin/export/worker-loop.js';

const dependencies = vi.hoisted(() => ({
	graph: vi.fn(),
	destroy: vi.fn(),
	disconnect: vi.fn(),
}));
vi.mock('../config/env.js', () => ({ loadEnv: () => ({ NAS_EXPORT_ROOT: '/private/exports' }) }));
vi.mock('../shared/worker-capacity.js', () => ({ assertExportWorkerCapacity: vi.fn() }));
vi.mock('../infrastructure/production-ports.js', () => ({ createCryptoIdGenerator: () => ({ next: () => 'id' }) }));
vi.mock('../lib/logger.js', () => ({ createRootLogger: () => ({ child: () => ({ error: vi.fn() }) }) }));
vi.mock('../lib/prisma-client.js', () => ({ createPrismaClientForDatabase: () => ({ $disconnect: dependencies.disconnect }) }));
vi.mock('../lib/s3.js', () => ({ createS3Client: () => ({ destroy: dependencies.destroy }) }));
vi.mock('../lib/storage.js', () => ({ createObjectStorage: () => ({}) }));
vi.mock('../modules/admin/export/processing.composition.js', () => ({ createExportProcessingGraph: dependencies.graph }));

import { runExportWorker } from '../export-worker.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((next) => { resolve = next; });
	return { promise, resolve };
}

describe('export worker process shutdown', () => {
	const listeners = new Map<string, () => void>();
	beforeEach(() => {
		vi.clearAllMocks();
		listeners.clear();
		dependencies.disconnect.mockResolvedValue(undefined);
		const once = process.once.bind(process);
		vi.spyOn(process, 'once').mockImplementation((event, listener) => {
			if (event === 'SIGTERM' || event === 'SIGINT') {
				listeners.set(event, listener);
				return process;
			}
			return once(event, listener);
		});
		const off = process.off.bind(process);
		vi.spyOn(process, 'off').mockImplementation((event, listener) => {
			if (event === 'SIGTERM' || event === 'SIGINT') {
				if (listeners.get(event) === listener) listeners.delete(event);
				return process;
			}
			return off(event, listener);
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it.each(['SIGTERM', 'SIGINT'])('aborts startup work on %s and drains before closing storage', async (signal) => {
		const entered = deferred();
		const release = deferred();
		let passSignal: AbortSignal | undefined;
		const loop = createExportWorkerLoop({
			pollIntervalMs: 60_000,
			logger: { error: vi.fn() },
			async runPass(activeSignal) {
				passSignal = activeSignal;
				entered.resolve();
				await release.promise;
				return 0;
			},
		});
		const close = vi.spyOn(loop, 'close');
		dependencies.graph.mockReturnValue({ loop });
		const work = runExportWorker();
		await entered.promise;
		try {
			listeners.get(signal)!();
			await vi.waitFor(() => expect(passSignal?.aborted).toBe(true), { timeout: 200 });
			expect(dependencies.destroy).not.toHaveBeenCalled();
			expect(dependencies.disconnect).not.toHaveBeenCalled();
			release.resolve();
			await work;
			expect(close).toHaveBeenCalledOnce();
			expect(dependencies.destroy).toHaveBeenCalledOnce();
			expect(dependencies.disconnect).toHaveBeenCalledOnce();
			expect(listeners.size).toBe(0);
		} finally {
			// Also stop the real loop when this regression is run against old code.
			release.resolve();
			await loop.close();
		}
	});

	it('closes once on a signal after startup', async () => {
		const start = vi.fn().mockResolvedValue(undefined);
		const close = vi.fn().mockResolvedValue(undefined);
		dependencies.graph.mockReturnValue({ loop: { start, close } });
		const work = runExportWorker();
		await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
		listeners.get('SIGTERM')!();
		listeners.get('SIGINT')!();
		await work;
		expect(close).toHaveBeenCalledOnce();
		expect(dependencies.destroy).toHaveBeenCalledBefore(dependencies.disconnect);
		expect(listeners.size).toBe(0);
	});

	it('closes the loop and resources when startup rejects', async () => {
		const error = new Error('startup failed');
		const close = vi.fn().mockResolvedValue(undefined);
		dependencies.graph.mockReturnValue({ loop: { start: vi.fn().mockRejectedValue(error), close } });
		await expect(runExportWorker()).rejects.toBe(error);
		expect(close).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledBefore(dependencies.destroy);
		expect(dependencies.disconnect).toHaveBeenCalledOnce();
		expect(listeners.size).toBe(0);
	});

	it('cleans resources and propagates a loop close failure', async () => {
		const error = new Error('close failed');
		const close = vi.fn().mockRejectedValue(error);
		dependencies.graph.mockReturnValue({ loop: { start: vi.fn().mockResolvedValue(undefined), close } });
		const work = runExportWorker();
		const rejected = expect(work).rejects.toBe(error);
		listeners.get('SIGTERM')!();
		await rejected;
		expect(close).toHaveBeenCalledOnce();
		expect(dependencies.destroy).toHaveBeenCalledOnce();
		expect(dependencies.disconnect).toHaveBeenCalledOnce();
		expect(listeners.size).toBe(0);
	});
});
